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
  CheckoutDomainError,
  createCheckoutProductDescriptor,
  type CheckoutVersionSchema,
} from "../../../support/runtime-support/common";
import {
  decideCheckoutCart,
  evolveCheckoutCart,
  initialCheckoutCartState,
  type CheckoutCartCommand,
  type CheckoutCartEvent,
  type CheckoutCartState,
} from "../domain/domain";
import { buildCheckoutCartProjectionHandlers } from "../read-model/projection";
import { listCartLines } from "../read-model/queries";

export type CheckoutCartRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type CheckoutCartServices = Readonly<{
  commandHandler: CommandHandler<
    CheckoutCartCommand,
    CheckoutCartState,
    CheckoutCartEvent
  >;
  addLine: (
    params: Readonly<{
      accountId: AccountId;
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
      accountId: AccountId;
      lineId: CartLineId;
      quantity: number;
    }>,
    context: EventStoreContext,
  ) => Promise<{ lineId: CartLineId; version: number }>;
  removeLine: (
    params: Readonly<{
      accountId: AccountId;
      lineId: CartLineId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ lineId: CartLineId; version: number }>;
  checkout: (
    accountId: AccountId,
    context: EventStoreContext,
  ) => Promise<{ version: number }>;
  listCartLines: (accountId: string) => ReturnType<typeof listCartLines>;
  projectors: readonly Projector[];
}>;

export function createCheckoutCartRuntime(
  deps: CheckoutCartRuntimeDeps,
): CheckoutCartServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<CheckoutCartEvent>(),
      initialState: () => initialCheckoutCartState,
      evolve: evolveCheckoutCart,
    }),
    evolve: evolveCheckoutCart,
    decide: decideCheckoutCart,
  });

  async function getCatalogItemSnapshot(catalogItemId: string) {
    const result = await deps.db.query<{
      catalog_item_id: string;
      status: string;
      product_schema: unknown;
    }>(
      `SELECT catalog_item_id, status, product_schema
       FROM checkout_catalog_items
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
        throw new CheckoutDomainError("Catalog item not found.");
      }

      if (catalogItem.status !== "active") {
        throw new CheckoutDomainError(
          "Cart lines may only reference active catalog items.",
        );
      }

      const catalogVersion = createCheckoutProductDescriptor({
        catalogItemId: params.catalogItemId,
        productSchema:
          typeof catalogItem.product_schema === "object" &&
          catalogItem.product_schema !== null
            ? (catalogItem.product_schema as CheckoutVersionSchema)
            : null,
        selection: params.selectedOptions,
      });

      if (params.productId.trim() !== catalogVersion.productId) {
        throw new CheckoutDomainError(
          "Cart line product id does not match the selected options.",
        );
      }

      const lineId = createId("cli") as CartLineId;
      const result = await commandHandler({
        streamId: `checkout.cart-${params.accountId}`,
        command: {
          type: "AddCartLine",
          buyerAccountId: params.accountId,
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
        streamId: `checkout.cart-${params.accountId}`,
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
        streamId: `checkout.cart-${params.accountId}`,
        command: {
          type: "RemoveCartLine",
          lineId: params.lineId,
        },
        context,
      });

      return { lineId: params.lineId, version: result.version };
    },
    checkout: async (accountId, context) => {
      const result = await commandHandler({
        streamId: `checkout.cart-${accountId}`,
        command: {
          type: "CheckoutCart",
          checkedOutAt: new Date().toISOString(),
        },
        context,
      });

      return { version: result.version };
    },
    listCartLines: (accountId) => listCartLines(deps.db, accountId),
    projectors: [
      createProjector({
        projectorName: "checkout.cart-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildCheckoutCartProjectionHandlers(deps.db),
      }),
    ],
  };
}
