import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId, type AccountId, type CheckoutSessionId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutCartServices } from "../../cart/api/runtime";
import type { CheckoutCartLineRow } from "../../cart/read-model/queries";
import {
  applyCartReadinessToLines,
  validateCartReadinessSnapshot,
  type CartReadinessDecisionInput,
  type CartReadinessSnapshot,
} from "../../cart/domain/readiness";
import {
  CheckoutDomainError,
  createCheckoutProductDescriptor,
  normalizeShippingOption,
  type CheckoutVersionSchema,
  type ShippingOption,
} from "../../../support/runtime-support/common";
import {
  type CheckoutSessionCommand,
  type CheckoutSessionEvent,
  type CheckoutSessionLine,
  type CheckoutSessionState,
  type CheckoutOptimizationGoal,
} from "../domain/domain";
import type { CheckoutFulfillmentPreview } from "../domain/fulfillment-preview";
import { unresolvedFulfillmentError } from "./checkout-fulfillment-runtime";
import type { CheckoutSessionCreateResult, CheckoutSessionRuntimeDeps, CheckoutSessionServices } from "./runtime";

type SessionRepository = Readonly<{
  load: (streamId: string) => Promise<{ state: CheckoutSessionState }>;
}>;

type SessionEntryDeps = Readonly<{
  eventStore: EventStore;
  db: CheckoutSessionRuntimeDeps["db"];
  cart: CheckoutCartServices;
  commandHandler: CommandHandler<CheckoutSessionCommand, CheckoutSessionState, CheckoutSessionEvent>;
  repository: SessionRepository;
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

export function commitMetadataFromStoredEvents(
  events: readonly { eventId: unknown; globalPosition: unknown; streamId: string }[],
) {
  const eventIds = events.map((event) => String(event.eventId));
  const commitPosition = events.reduce<string | undefined>((current, event) => {
    const globalPosition = String(event.globalPosition);
    return !current || BigInt(globalPosition) > BigInt(current) ? globalPosition : current;
  }, undefined);
  const positions = new Map<string, { eventIds: string[]; maxGlobalPosition: string }>();
  for (const event of events) {
    const sourceContextName = event.streamId.split(".", 1)[0] ?? event.streamId;
    const globalPosition = String(event.globalPosition);
    const current = positions.get(sourceContextName);
    if (!current) {
      positions.set(sourceContextName, { eventIds: [String(event.eventId)], maxGlobalPosition: globalPosition });
      continue;
    }
    current.eventIds.push(String(event.eventId));
    if (BigInt(globalPosition) > BigInt(current.maxGlobalPosition)) current.maxGlobalPosition = globalPosition;
  }
  return {
    ...(commitPosition ? { commitPosition } : {}),
    commitEventIds: eventIds,
    commitPositions: [...positions.entries()].map(([sourceContextName, position]) => ({
      sourceContextName,
      maxGlobalPosition: position.maxGlobalPosition,
      eventIds: position.eventIds,
    })),
  };
}

export async function acceptedPresentedAnonymousCartId(
  cart: Pick<CheckoutCartServices, "resolveCartSourceAuthority">,
  actingOwnerKey: string,
  presentedAnonymousCartId: string | null | undefined,
) {
  const presented = presentedAnonymousCartId ?? null;
  if (!presented) return null;
  const authority = await cart.resolveCartSourceAuthority({ actingOwnerKey, presentedAnonymousCartId: presented });
  return authority.status === "accepted" ? presented : null;
}

function assertBuyNowHandoffReady(
  params: Readonly<{ listingId: string; lockedListingId: string; fulfillmentPreviewRevision: string }>,
) {
  const listingId = params.listingId.trim();
  if (listingId && listingId !== params.lockedListingId.trim()) {
    throw new CheckoutDomainError(
      "Selected listing changed. Review item availability before checkout.",
      "readiness_snapshot_stale",
    );
  }
  if (!params.fulfillmentPreviewRevision.trim()) throw unresolvedFulfillmentError();
}

export function createCheckoutSessionEntryServices(
  deps: SessionEntryDeps,
): Pick<CheckoutSessionServices, "createFromCart" | "createBuyNow" | "createOfferIntent"> {
  async function validateCatalogSelection(
    params: Readonly<{
      catalogItemId: string;
      productId: string;
      selectedOptions: readonly { dimensionId: string; optionId: string }[];
    }>,
  ) {
    const result = await deps.db.query<{ catalog_item_id: string; status: string; product_schema: unknown }>(
      `SELECT catalog_item_id, status, product_schema
       FROM checkout_catalog_items
       WHERE catalog_item_id = $1`,
      [params.catalogItemId],
    );
    const catalogItem = result.rows[0];
    if (!catalogItem) throw new CheckoutDomainError("Catalog item not found.");
    if (catalogItem.status !== "active")
      throw new CheckoutDomainError("Checkout lines may only reference active catalog items.");
    const descriptor = createCheckoutProductDescriptor({
      catalogItemId: params.catalogItemId,
      productSchema:
        typeof catalogItem.product_schema === "object" && catalogItem.product_schema !== null
          ? (catalogItem.product_schema as CheckoutVersionSchema)
          : null,
      selection: params.selectedOptions,
    });
    if (params.productId.trim() !== descriptor.productId)
      throw new CheckoutDomainError("Checkout line product id does not match the selected options.");
    return descriptor;
  }

  async function startSession(
    params: Readonly<{
      accountId: AccountId;
      sourceType: "cart" | "buy-now" | "offer-intent";
      optimizationGoal?: CheckoutOptimizationGoal;
      fulfillmentPreviewRevision?: string | null;
      fulfillmentPreviewSnapshot?: CheckoutFulfillmentPreview | null;
      handoffExpiresAt?: string | null;
      createdAt?: string;
      cartReadinessSnapshot?: CartReadinessSnapshot | null;
      presentedAnonymousCartId?: string | null;
      shippingOption: ShippingOption;
      lines: readonly CheckoutSessionLine[];
      sessionIdOverride?: CheckoutSessionId;
    }>,
    context: EventStoreContext,
  ): Promise<CheckoutSessionCreateResult> {
    let sessionId = params.sessionIdOverride ?? (createId("chk") as CheckoutSessionId);
    let streamId = `checkout.session-${sessionId}`;
    async function existingStartedSession(candidateSessionId: CheckoutSessionId, candidateStreamId: string) {
      if (!params.sessionIdOverride || candidateSessionId !== params.sessionIdOverride) return null;
      const storedEvents = await readCompleteStream(deps.eventStore, { streamId: candidateStreamId });
      const started = storedEvents.find((event) => event.eventType === "checkout.session.started");
      if (!started) return null;
      const payload = started.payload as { sessionId?: unknown; buyerAccountId?: unknown; sourceType?: unknown };
      if (
        payload.sessionId !== candidateSessionId ||
        payload.buyerAccountId !== params.accountId ||
        payload.sourceType !== params.sourceType
      ) {
        throw new CheckoutDomainError("Checkout session not found.");
      }
      const loaded = await deps.repository.load(candidateStreamId);
      return {
        result: { sessionId: candidateSessionId, ...commitMetadataFromStoredEvents(storedEvents) },
        state: loaded.state,
      };
    }

    const existing = await existingStartedSession(sessionId, streamId);
    if (
      existing &&
      (params.sourceType !== "buy-now" ||
        existing.state.orderIds.length === 0 ||
        existing.state.paymentId ||
        existing.state.submittedOfferId)
    )
      return existing.result;
    if (existing) {
      sessionId = createId("chk") as CheckoutSessionId;
      streamId = `checkout.session-${sessionId}`;
    }
    let result: Awaited<ReturnType<typeof deps.commandHandler>>;
    try {
      result = await deps.commandHandler({
        streamId,
        command: {
          type: "StartCheckoutSession",
          sessionId,
          buyerAccountId: params.accountId,
          sourceType: params.sourceType,
          optimizationGoal: params.optimizationGoal,
          fulfillmentPreviewRevision: params.fulfillmentPreviewRevision,
          fulfillmentPreviewSnapshot: params.fulfillmentPreviewSnapshot,
          cartReadinessSnapshot: params.cartReadinessSnapshot,
          presentedAnonymousCartId: params.presentedAnonymousCartId,
          shippingOption: params.shippingOption,
          lines: params.lines,
          handoffExpiresAt: params.handoffExpiresAt,
          createdAt: params.createdAt ?? new Date().toISOString(),
        },
        context,
      });
    } catch (error) {
      if (
        !params.sessionIdOverride ||
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === "concurrency_conflict"
        )
      )
        throw error;
      const replayed = await existingStartedSession(
        params.sessionIdOverride,
        `checkout.session-${params.sessionIdOverride}`,
      );
      if (replayed) return replayed.result;
      throw error;
    }
    return { sessionId, ...commitMetadataFromStoredEvents(result.storedEvents) };
  }

  return {
    createFromCart: async (params, context) => {
      const presentedAnonymousCartId = await acceptedPresentedAnonymousCartId(
        deps.cart,
        params.accountId,
        params.presentedAnonymousCartId,
      );
      const cartLines = await deps.cart.listAuthorizedCartLines(
        presentedAnonymousCartId
          ? { accountId: params.accountId, presentedAnonymousCartId }
          : { accountId: params.accountId },
      );
      if (cartLines.length === 0) throw new CheckoutDomainError("Cart must contain at least one line.", "cart_empty");
      const readiness = validateCartReadinessSnapshot(
        cartLines,
        {
          snapshotId: params.readinessSnapshotId,
          sourceRevision: params.readinessSourceRevision,
          decisions: params.readinessDecisions ?? undefined,
        },
        presentedAnonymousCartId ? { accountId: params.accountId, presentedAnonymousCartId } : undefined,
      );
      if (!readiness.valid)
        throw new CheckoutDomainError(
          "Cart readiness changed. Review your cart before checkout.",
          "readiness_snapshot_stale",
        );
      if (readiness.current.status !== "ready" || readiness.current.unresolvedLineIds.length > 0)
        throw new CheckoutDomainError("Resolve item availability before checkout starts.", "unresolved_fulfillment");
      return startSession(
        {
          accountId: params.accountId,
          sourceType: "cart",
          shippingOption: normalizeShippingOption(params.shippingOption ?? "standard"),
          optimizationGoal: params.optimizationGoal,
          cartReadinessSnapshot: readiness.current,
          presentedAnonymousCartId,
          lines: applyCartReadinessToLines(cartLines, readiness.current).map(cartLineToSessionLine),
          sessionIdOverride: params.sessionIdOverride,
        },
        context,
      );
    },
    createBuyNow: async (params, context) => {
      const lockedListingId = params.lockedListingId?.trim() || params.listingId.trim() || null;
      if (!lockedListingId) throw unresolvedFulfillmentError();
      assertBuyNowHandoffReady({
        listingId: params.listingId,
        lockedListingId,
        fulfillmentPreviewRevision: params.fulfillmentPreviewRevision,
      });
      const descriptor = await validateCatalogSelection(params);
      return startSession(
        {
          accountId: params.accountId,
          sourceType: "buy-now",
          shippingOption: normalizeShippingOption(params.shippingOption ?? "standard"),
          optimizationGoal: params.optimizationGoal,
          fulfillmentPreviewRevision: params.fulfillmentPreviewRevision,
          fulfillmentPreviewSnapshot: params.fulfillmentPreviewSnapshot,
          handoffExpiresAt: params.handoffExpiresAt,
          createdAt: params.createdAt,
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
              fulfillmentMode:
                params.fulfillmentMode === "locked-listing" || lockedListingId ? "locked-listing" : "optimize",
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
              offerPriceCurrencyCode: params.offerPriceCurrencyCode,
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
  };
}
