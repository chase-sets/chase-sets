import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, CheckoutSessionId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
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
  type CheckoutShippingAddress,
  type CheckoutOptimizationGoal,
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
  commandHandler: CommandHandler<CheckoutSessionCommand, CheckoutSessionState, CheckoutSessionEvent>;
  createFromCart: (
    params: Readonly<{
      accountId: AccountId;
      shippingOption?: string;
      optimizationGoal?: CheckoutOptimizationGoal;
      sessionIdOverride?: CheckoutSessionId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: CheckoutSessionId }>;
  createBuyNow: (
    params: Readonly<{
      accountId: AccountId;
      listingId: string;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      itemSubtitle: string | null;
      selectedOptions: readonly { dimensionId: string; optionId: string }[];
      productSummary: string | null;
      quantity: number;
      fulfillmentMode?: "optimize" | "locked-listing";
      lockedListingId?: string | null;
      sellerPreferenceId?: string | null;
      optimizationGoal?: CheckoutOptimizationGoal;
      shippingOption?: string;
      sessionIdOverride?: CheckoutSessionId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: CheckoutSessionId }>;
  createOfferIntent: (
    params: Readonly<{
      accountId: AccountId;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      itemSubtitle: string | null;
      selectedOptions: readonly { dimensionId: string; optionId: string }[];
      productSummary: string | null;
      offerPriceAmount: string;
      quantity: number;
      optimizationGoal?: CheckoutOptimizationGoal;
      shippingOption?: string;
      sessionIdOverride?: CheckoutSessionId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: CheckoutSessionId }>;
  selectShippingOption: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      shippingOption: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: string }>;
  selectOptimizationGoal: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      optimizationGoal: CheckoutOptimizationGoal;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: string }>;
  recordFulfillmentPreview: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      fulfillmentPreviewRevision: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: string }>;
  setShippingAddress: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      shippingAddress: CheckoutShippingAddress;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: string }>;
  recordOrdersCreated: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      orderIds: readonly string[];
      fulfilledLineKeys?: readonly string[];
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: string }>;
  recordPaymentStarted: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      paymentId: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: string }>;
  recordOfferSubmitted: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      offerId: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ sessionId: string }>;
  getSession: (sessionId: string, accountId: string) => ReturnType<typeof getCheckoutSession>;
  projectors: readonly ProjectionHandlerSet[];
}>;

function cartLineToSessionLine(line: CheckoutCartLineRow): CheckoutSessionLine {
  return {
    listingId: line.locked_listing_id,
    cartLineId: line.line_id,
    catalogItemId: line.catalog_catalog_item_id,
    productId: line.product_id,
    itemTitle: line.item_title,
    itemSubtitle: line.item_subtitle,
    selectedOptions: [...line.selected_options],
    productSummary: line.product_summary,
    quantity: line.quantity,
    fulfillmentMode: line.fulfillment_mode,
    lockedListingId: line.locked_listing_id,
    sellerPreferenceId: line.seller_preference_id,
    availabilityState: line.availability_state,
  };
}

export function createCheckoutSessionRuntime(deps: CheckoutSessionRuntimeDeps): CheckoutSessionServices {
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
  const sessionProjector = createProjectionHandlerSet({
    projectionName: "checkout.session-projection",
    handlers: buildCheckoutSessionProjectionHandlers(deps.db),
  });

  async function validateCatalogSelection(
    params: Readonly<{
      catalogItemId: string;
      productId: string;
      selectedOptions: readonly { dimensionId: string; optionId: string }[];
    }>,
  ) {
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
      throw new CheckoutDomainError("Checkout lines may only reference active catalog items.");
    }

    const descriptor = createCheckoutProductDescriptor({
      catalogItemId: params.catalogItemId,
      productSchema:
        typeof catalogItem.product_schema === "object" && catalogItem.product_schema !== null
          ? (catalogItem.product_schema as CheckoutVersionSchema)
          : null,
      selection: params.selectedOptions,
    });
    if (params.productId.trim() !== descriptor.productId) {
      throw new CheckoutDomainError("Checkout line product id does not match the selected options.");
    }
    return descriptor;
  }

  async function startSession(
    params: Readonly<{
      accountId: AccountId;
      sourceType: "cart" | "buy-now" | "offer-intent";
      optimizationGoal?: CheckoutOptimizationGoal;
      fulfillmentPreviewRevision?: string | null;
      shippingOption: ShippingOption;
      lines: readonly CheckoutSessionLine[];
      sessionIdOverride?: CheckoutSessionId;
    }>,
    context: EventStoreContext,
  ) {
    const sessionId = params.sessionIdOverride ?? (createId("chk") as CheckoutSessionId);
    await commandHandler({
      streamId: `checkout.session-${sessionId}`,
      command: {
        type: "StartCheckoutSession",
        sessionId,
        buyerAccountId: params.accountId,
        sourceType: params.sourceType,
        optimizationGoal: params.optimizationGoal,
        fulfillmentPreviewRevision: params.fulfillmentPreviewRevision,
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
      const cartLines = await deps.cart.listCartLines(params.accountId);
      if (cartLines.length === 0) {
        throw new CheckoutDomainError("Cart must contain at least one line.");
      }

      return startSession(
        {
          accountId: params.accountId,
          sourceType: "cart",
          shippingOption: normalizeShippingOption(params.shippingOption ?? "standard"),
          optimizationGoal: params.optimizationGoal,
          lines: cartLines.map(cartLineToSessionLine),
          sessionIdOverride: params.sessionIdOverride,
        },
        context,
      );
    },
    createBuyNow: async (params, context) => {
      const descriptor = await validateCatalogSelection(params);
      const lockedListingId = params.lockedListingId?.trim() || params.listingId.trim() || null;
      const fulfillmentMode =
        params.fulfillmentMode === "locked-listing" || lockedListingId ? "locked-listing" : "optimize";
      return startSession(
        {
          accountId: params.accountId,
          sourceType: "buy-now",
          shippingOption: normalizeShippingOption(params.shippingOption ?? "standard"),
          optimizationGoal: params.optimizationGoal,
          sessionIdOverride: params.sessionIdOverride,
          lines: [
            {
              listingId: lockedListingId,
              cartLineId: null,
              catalogItemId: params.catalogItemId,
              productId: descriptor.productId,
              itemTitle: params.itemTitle,
              itemSubtitle: params.itemSubtitle,
              selectedOptions: descriptor.selection,
              productSummary: params.productSummary,
              quantity: params.quantity,
              fulfillmentMode,
              lockedListingId,
              sellerPreferenceId: params.sellerPreferenceId?.trim() || null,
              availabilityState: "available",
            },
          ],
        },
        context,
      );
    },
    createOfferIntent: async (params, context) => {
      const descriptor = await validateCatalogSelection(params);
      return startSession(
        {
          accountId: params.accountId,
          sourceType: "offer-intent",
          shippingOption: normalizeShippingOption(params.shippingOption ?? "standard"),
          optimizationGoal: params.optimizationGoal,
          sessionIdOverride: params.sessionIdOverride,
          lines: [
            {
              listingId: null,
              cartLineId: null,
              catalogItemId: params.catalogItemId,
              productId: descriptor.productId,
              itemTitle: params.itemTitle,
              itemSubtitle: params.itemSubtitle,
              selectedOptions: descriptor.selection,
              productSummary: params.productSummary,
              offerPriceAmount: params.offerPriceAmount,
              quantity: params.quantity,
              fulfillmentMode: "optimize",
              lockedListingId: null,
              sellerPreferenceId: null,
              availabilityState: "waiting-for-supply",
            },
          ],
        },
        context,
      );
    },
    selectShippingOption: async (params, context) => {
      const session = await getCheckoutSession(deps.db, params.sessionId, params.accountId);
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
    selectOptimizationGoal: async (params, context) => {
      const session = await getCheckoutSession(deps.db, params.sessionId, params.accountId);
      if (!session) {
        throw new CheckoutDomainError("Checkout session not found.");
      }

      await commandHandler({
        streamId: `checkout.session-${params.sessionId}`,
        command: {
          type: "SelectOptimizationGoal",
          optimizationGoal: params.optimizationGoal,
          selectedAt: new Date().toISOString(),
        },
        context,
      });
      return { sessionId: params.sessionId };
    },
    recordFulfillmentPreview: async (params, context) => {
      const session = await getCheckoutSession(deps.db, params.sessionId, params.accountId);
      if (!session) {
        throw new CheckoutDomainError("Checkout session not found.");
      }

      await commandHandler({
        streamId: `checkout.session-${params.sessionId}`,
        command: {
          type: "RecordFulfillmentPreview",
          fulfillmentPreviewRevision: params.fulfillmentPreviewRevision,
          recordedAt: new Date().toISOString(),
        },
        context,
      });
      return { sessionId: params.sessionId };
    },
    setShippingAddress: async (params, context) => {
      const session = await getCheckoutSession(deps.db, params.sessionId, params.accountId);
      if (!session) {
        throw new CheckoutDomainError("Checkout session not found.");
      }

      await commandHandler({
        streamId: `checkout.session-${params.sessionId}`,
        command: {
          type: "SetShippingAddress",
          shippingAddress: params.shippingAddress,
          selectedAt: new Date().toISOString(),
        },
        context,
      });
      return { sessionId: params.sessionId };
    },
    recordOrdersCreated: async (params, context) => {
      const session = await getCheckoutSession(deps.db, params.sessionId, params.accountId);
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
        const fulfilledLineKeys = new Set(params.fulfilledLineKeys ?? []);
        const fulfilledCartLineIds = session.lines
          .map((line) => line.cartLineId)
          .filter((lineId): lineId is string =>
            Boolean(lineId && (fulfilledLineKeys.size === 0 || fulfilledLineKeys.has(lineId))),
          );

        if (fulfilledCartLineIds.length > 0) {
          for (const lineId of fulfilledCartLineIds) {
            await deps.cart.removeLine(
              {
                accountId: params.accountId,
                lineId: lineId as never,
              },
              context,
            );
          }
        } else if (fulfilledLineKeys.size === 0) {
          await deps.cart.checkout(params.accountId, context);
        }
      }

      return { sessionId: params.sessionId };
    },
    recordPaymentStarted: async (params, context) => {
      const session = await getCheckoutSession(deps.db, params.sessionId, params.accountId);
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
    recordOfferSubmitted: async (params, context) => {
      const session = await getCheckoutSession(deps.db, params.sessionId, params.accountId);
      if (!session) {
        throw new CheckoutDomainError("Checkout session not found.");
      }

      await commandHandler({
        streamId: `checkout.session-${params.sessionId}`,
        command: {
          type: "RecordOfferSubmitted",
          offerId: params.offerId,
          recordedAt: new Date().toISOString(),
        },
        context,
      });
      return { sessionId: params.sessionId };
    },
    getSession: (sessionId, accountId) => getCheckoutSession(deps.db, sessionId, accountId),
    projectors: [sessionProjector],
  };
}
