import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { CartLineId } from "../../../support/runtime-support/common";
import {
  OrderingDomainError,
  createOrderingProductDescriptor,
  type OrderingVersionSchema,
} from "../../../support/runtime-support/common";
import {
  decideOrderingCart,
  evolveOrderingCart,
  initialOrderingCartState,
  type OrderingCartCommand,
  type OrderingCartEvent,
  type OrderingCartState,
} from "../domain/domain";
import { buildOrderingCartProjectionHandlers } from "../read-model/projection";
import { listCartLines } from "../read-model/queries";

export type OrderingCartRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type OrderingCartServices = Readonly<{
  commandHandler: CommandHandler<
    OrderingCartCommand,
    OrderingCartState,
    OrderingCartEvent
  >;
  addLine: (
    params: Readonly<{
      buyerAccountId: AccountId;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      itemSubtitle: string | null;
      selectedOptions: readonly { dimensionId: string; optionId: string }[];
      productSummary: string | null;
      quantity: number;
    }>,
    context: EventStoreContext,
  ) => Promise<{ lineId: CartLineId; version: number }>;
  setLineQuantity: (
    params: Readonly<{
      buyerAccountId: AccountId;
      lineId: CartLineId;
      quantity: number;
    }>,
    context: EventStoreContext,
  ) => Promise<{ lineId: CartLineId; version: number }>;
  removeLine: (
    params: Readonly<{
      buyerAccountId: AccountId;
      lineId: CartLineId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ lineId: CartLineId; version: number }>;
  checkout: (
    buyerAccountId: AccountId,
    context: EventStoreContext,
  ) => Promise<{ version: number }>;
  listCartLines: (buyerAccountId: string) => ReturnType<typeof listCartLines>;
  projectors: readonly Projector[];
}>;

export function createOrderingCartRuntime(
  deps: OrderingCartRuntimeDeps,
): OrderingCartServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<OrderingCartEvent>(),
      initialState: () => initialOrderingCartState,
      evolve: evolveOrderingCart,
    }),
    evolve: evolveOrderingCart,
    decide: decideOrderingCart,
  });

  async function getCatalogItemSnapshot(catalogItemId: string) {
    const result = await deps.db.query<{
      catalog_item_id: string;
      status: string;
      product_schema: unknown;
    }>(
      `SELECT catalog_item_id, status, product_schema
       FROM ordering_catalog_items
       WHERE catalog_item_id = $1`,
      [catalogItemId],
    );

    return result.rows[0] ?? null;
  }

  return {
    commandHandler,
    addLine: async (params, context) => {
      const catalogItem = await getCatalogItemSnapshot(params.catalogItemId);
      if (!catalogItem) {
        throw new OrderingDomainError("Catalog item not found.");
      }

      if (catalogItem.status !== "active") {
        throw new OrderingDomainError(
          "Cart lines may only reference active catalog items.",
        );
      }

      const catalogVersion = createOrderingProductDescriptor({
        catalogItemId: params.catalogItemId,
        productSchema:
          typeof catalogItem.product_schema === "object" &&
          catalogItem.product_schema !== null
            ? (catalogItem.product_schema as OrderingVersionSchema)
            : null,
        selection: params.selectedOptions,
      });

      if (params.productId.trim() !== catalogVersion.productId) {
        throw new OrderingDomainError(
          "Cart line product id does not match the selected options.",
        );
      }

      const lineId = createId("cli") as CartLineId;
      const result = await commandHandler({
        streamId: `ordering.cart-${params.buyerAccountId}`,
        command: {
          type: "AddCartLine",
          buyerAccountId: params.buyerAccountId,
          lineId,
          catalogItemId: params.catalogItemId,
          productId: catalogVersion.productId,
          itemTitle: params.itemTitle,
          itemSubtitle: params.itemSubtitle,
          selectedOptions: catalogVersion.selection,
          productSummary: params.productSummary,
          quantity: params.quantity,
        },
        context,
      });

      return { lineId, version: result.version };
    },
    setLineQuantity: async (params, context) => {
      const result = await commandHandler({
        streamId: `ordering.cart-${params.buyerAccountId}`,
        command: {
          type: "SetCartLineQuantity",
          lineId: params.lineId,
          quantity: params.quantity,
        },
        context,
      });

      return { lineId: params.lineId, version: result.version };
    },
    removeLine: async (params, context) => {
      const result = await commandHandler({
        streamId: `ordering.cart-${params.buyerAccountId}`,
        command: {
          type: "RemoveCartLine",
          lineId: params.lineId,
        },
        context,
      });

      return { lineId: params.lineId, version: result.version };
    },
    checkout: async (buyerAccountId, context) => {
      const result = await commandHandler({
        streamId: `ordering.cart-${buyerAccountId}`,
        command: {
          type: "CheckoutCart",
          checkedOutAt: new Date().toISOString(),
        },
        context,
      });

      return { version: result.version };
    },
    listCartLines: (buyerAccountId) => listCartLines(deps.db, buyerAccountId),
    projectors: [
      createProjector({
        projectorName: "ordering-cart-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildOrderingCartProjectionHandlers(deps.db),
      }),
    ],
  };
}
