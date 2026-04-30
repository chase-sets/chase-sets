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
import type {
  AccountId,
  CheckoutSessionId,
  OrderId,
  PaymentId,
} from "@chase-sets/primitives/typed-ids";
import type { CheckoutCartServices } from "../../cart/api/runtime";
import type { CheckoutCartLineRow } from "../../cart/read-model/queries";
import {
  CheckoutDomainError,
  createCheckoutProductDescriptor,
  normalizeShippingOption,
  type CheckoutVersionSchema,
  type ShippingOption,
} from "../../../support/runtime-support/common";
import {
  decideCheckoutSession,
  evolveCheckoutSession,
  initialCheckoutSessionState,
  type CheckoutSessionCommand,
  type CheckoutSessionEvent,
  type CheckoutSessionLine,
  type CheckoutSessionState,
} from "../domain/domain";
import { buildCheckoutSessionProjectionHandlers } from "../read-model/projection";
import { getCheckoutSession } from "../read-model/queries";

export type CheckoutSessionRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  cart: CheckoutCartServices;
}>;

export type CheckoutSessionServices = Readonly<{
  commandHandler: CommandHandler<
    CheckoutSessionCommand,
    CheckoutSessionState,
    CheckoutSessionEvent
  >;
  createFromCart: (
    params: Readonly<{
      buyerAccountId: AccountId;
      shippingOption?: string;
      sessionIdOverride?: CheckoutSessionId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: CheckoutSessionId }>;
  createBuyNow: (
    params: Readonly<{
      buyerAccountId: AccountId;
      listingId: string;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      itemSubtitle: string | null;
      selectedOptions: readonly { dimensionId: string; optionId: string }[];
      productSummary: string | null;
      quantity: number;
      shippingOption?: string;
      sessionIdOverride?: CheckoutSessionId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: CheckoutSessionId }>;
  selectShippingOption: (
    params: Readonly<{
      sessionId: string;
      buyerAccountId: AccountId;
      shippingOption: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: string }>;
  recordOrdersCreated: (
    params: Readonly<{
      sessionId: string;
      buyerAccountId: AccountId;
      orderIds: readonly string[];
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: string }>;
  recordPaymentStarted: (
    params: Readonly<{
      sessionId: string;
      buyerAccountId: AccountId;
      paymentId: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: string }>;
  getSession: (
    sessionId: string,
    buyerAccountId: string,
  ) => ReturnType<typeof getCheckoutSession>;
  projectors: readonly Projector[];
}>;

function cartLineToSessionLine(line: CheckoutCartLineRow): CheckoutSessionLine {
  return {
    listingId: null,
    cartLineId: line.line_id,
    catalogItemId: line.catalog_catalog_item_id,
    productId: line.product_id,
    itemTitle: line.item_title,
    itemSubtitle: line.item_subtitle,
    selectedOptions: [...line.selected_options],
    productSummary: line.product_summary,
    quantity: line.quantity,
  };
}

export function createCheckoutSessionRuntime(
  deps: CheckoutSessionRuntimeDeps,
): CheckoutSessionServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<CheckoutSessionEvent>(),
      initialState: () => initialCheckoutSessionState,
      evolve: evolveCheckoutSession,
    }),
    evolve: evolveCheckoutSession,
    decide: decideCheckoutSession,
  });

  async function validateCatalogSelection(params: Readonly<{
    catalogItemId: string;
    productId: string;
    selectedOptions: readonly { dimensionId: string; optionId: string }[];
  }>) {
    const result = await deps.db.query<{
      catalog_item_id: string;
      status: string;
      product_schema: unknown;
    }>(
      `SELECT catalog_item_id, status, product_schema
       FROM checkout_catalog_items
       WHERE catalog_item_id = $1`,
      [params.catalogItemId],
    );
    const catalogItem = result.rows[0];
    if (!catalogItem) {
      throw new CheckoutDomainError("Catalog item not found.");
    }
    if (catalogItem.status !== "active") {
      throw new CheckoutDomainError(
        "Checkout lines may only reference active catalog items.",
      );
    }

    const descriptor = createCheckoutProductDescriptor({
      catalogItemId: params.catalogItemId,
      productSchema:
        typeof catalogItem.product_schema === "object" &&
        catalogItem.product_schema !== null
          ? (catalogItem.product_schema as CheckoutVersionSchema)
          : null,
      selection: params.selectedOptions,
    });
    if (params.productId.trim() !== descriptor.productId) {
      throw new CheckoutDomainError(
        "Checkout line product id does not match the selected options.",
      );
    }
    return descriptor;
  }

  async function startSession(params: Readonly<{
    buyerAccountId: AccountId;
    sourceType: "cart" | "buy-now";
    shippingOption: ShippingOption;
    lines: readonly CheckoutSessionLine[];
    sessionIdOverride?: CheckoutSessionId;
  }>, context: EventStoreContext) {
    const sessionId = params.sessionIdOverride ?? createId("chk") as CheckoutSessionId;
    await commandHandler({
      streamId: `checkout.session-${sessionId}`,
      command: {
        type: "StartCheckoutSession",
        sessionId,
        buyerAccountId: params.buyerAccountId,
        sourceType: params.sourceType,
        shippingOption: params.shippingOption,
        lines: params.lines,
        createdAt: new Date().toISOString(),
      },
      context,
    });
    return { sessionId };
  }

  return {
    commandHandler,
    createFromCart: async (params, context) => {
      const cartLines = await deps.cart.listCartLines(params.buyerAccountId);
      if (cartLines.length === 0) {
        throw new CheckoutDomainError("Cart must contain at least one line.");
      }

      return startSession(
        {
          buyerAccountId: params.buyerAccountId,
          sourceType: "cart",
          shippingOption: normalizeShippingOption(params.shippingOption ?? "standard"),
          lines: cartLines.map(cartLineToSessionLine),
          sessionIdOverride: params.sessionIdOverride,
        },
        context,
      );
    },
    createBuyNow: async (params, context) => {
      const descriptor = await validateCatalogSelection(params);
      return startSession(
        {
          buyerAccountId: params.buyerAccountId,
          sourceType: "buy-now",
          shippingOption: normalizeShippingOption(params.shippingOption ?? "standard"),
          sessionIdOverride: params.sessionIdOverride,
          lines: [
            {
              listingId: params.listingId,
              cartLineId: null,
              catalogItemId: params.catalogItemId,
              productId: descriptor.productId,
              itemTitle: params.itemTitle,
              itemSubtitle: params.itemSubtitle,
              selectedOptions: descriptor.selection,
              productSummary: params.productSummary,
              quantity: params.quantity,
            },
          ],
        },
        context,
      );
    },
    selectShippingOption: async (params, context) => {
      const session = await getCheckoutSession(
        deps.db,
        params.sessionId,
        params.buyerAccountId,
      );
      if (!session) {
        throw new CheckoutDomainError("Checkout session not found.");
      }

      await commandHandler({
        streamId: `checkout.session-${params.sessionId}`,
        command: {
          type: "SelectShippingOption",
          shippingOption: normalizeShippingOption(params.shippingOption),
          selectedAt: new Date().toISOString(),
        },
        context,
      });
      return { sessionId: params.sessionId };
    },
    recordOrdersCreated: async (params, context) => {
      const session = await getCheckoutSession(
        deps.db,
        params.sessionId,
        params.buyerAccountId,
      );
      if (!session) {
        throw new CheckoutDomainError("Checkout session not found.");
      }

      await commandHandler({
        streamId: `checkout.session-${params.sessionId}`,
        command: {
          type: "RecordOrdersCreated",
          orderIds: params.orderIds as OrderId[],
          recordedAt: new Date().toISOString(),
        },
        context,
      });

      if (session.source_type === "cart") {
        await deps.cart.checkout(params.buyerAccountId, context);
      }

      return { sessionId: params.sessionId };
    },
    recordPaymentStarted: async (params, context) => {
      const session = await getCheckoutSession(
        deps.db,
        params.sessionId,
        params.buyerAccountId,
      );
      if (!session) {
        throw new CheckoutDomainError("Checkout session not found.");
      }

      await commandHandler({
        streamId: `checkout.session-${params.sessionId}`,
        command: {
          type: "RecordPaymentStarted",
          paymentId: params.paymentId as PaymentId,
          recordedAt: new Date().toISOString(),
        },
        context,
      });
      return { sessionId: params.sessionId };
    },
    getSession: (sessionId, buyerAccountId) =>
      getCheckoutSession(deps.db, sessionId, buyerAccountId),
    projectors: [
      createProjector({
        projectorName: "checkout.session-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildCheckoutSessionProjectionHandlers(deps.db),
      }),
    ],
  };
}
