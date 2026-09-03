import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, CheckoutSessionId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutCartServices } from "../../cart/api/runtime";
import type { CheckoutCartLineRow } from "../../cart/read-model/queries";
import {
  applyCartReadinessToLines,
  cartReadinessDecisionsFromSnapshot,
  validateCartReadinessSnapshot,
  type CartReadinessDecisionInput,
  type CartReadinessFulfillmentGroup,
  type CartReadinessSnapshot,
} from "../../cart/domain/readiness";
import {
  CheckoutDomainError,
  createCheckoutProductDescriptor,
  normalizeShippingOption,
  type CartLineId,
  type CheckoutVersionSchema,
  type ShippingOption,
} from "../../../support/runtime-support/common";
import {
  decideCheckoutSession,
  evolveCheckoutSession,
  initialCheckoutSessionState,
  retainedOrderCartCleanup,
  type CheckoutSessionCommand,
  type CheckoutSessionEvent,
  type CheckoutSessionLine,
  type CheckoutSessionReservation,
  type CheckoutShippingAddress,
  type CheckoutOptimizationGoal,
  type CheckoutSessionState,
  type CheckoutSplitGroupHandoff,
} from "../domain/domain";
import type { CheckoutFulfillmentPreview } from "../domain/fulfillment-preview";
import { checkoutDeliveryServiceabilityIssue } from "../domain/delivery-serviceability";
import { buildCheckoutSessionProjectionHandlers } from "../read-model/projection";
import { getCheckoutSession, type CheckoutSessionRow } from "../read-model/queries";
import {
  listCheckoutSavedPaymentInstruments,
  type CheckoutSavedPaymentInstrumentRow,
} from "../integrations/payments/payment-affordance-queries";
import {
  getCheckoutPaymentSummary,
  type CheckoutPaymentSummaryRow,
} from "../integrations/payments/payment-summary-queries";
import {
  exposeCheckoutPaymentConfirmation,
  getCheckoutPaymentConfirmationProjection,
  type CheckoutPaymentConfirmation,
} from "../integrations/payments/payment-confirmation-queries";
import { assertCheckoutLinesHaveAssignedFulfillment, unresolvedFulfillmentError } from "./checkout-fulfillment-runtime";
import type { CheckoutSourceCommitPosition } from "../domain/domain";
import {
  verifyCheckoutShippingAddress,
  type AddressVerificationDecision,
  type CheckoutAddressVerificationOutcome,
} from "./address-verification";

export type CheckoutSessionMutationResult = Readonly<{
  sessionId: string;
  session: CheckoutSessionRow;
  commitPosition?: string;
  commitEventIds?: readonly string[];
  commitPositions?: readonly {
    sourceContextName: string;
    maxGlobalPosition: string;
    eventIds: readonly string[];
  }[];
}>;

/** Safe at HTTP/UCP boundaries: never retain a key-bearing lower-layer cause. */
export class OrderCartCleanupError extends CheckoutDomainError {
  constructor(readonly commitMetadata: Omit<CheckoutSessionMutationResult, "sessionId" | "session"> = {}) {
    super("Cart cleanup could not finish. Retry checkout.");
  }
}

export type CheckoutSessionCreateResult = Readonly<{
  sessionId: CheckoutSessionId;
  commitPosition?: string;
  commitEventIds?: readonly string[];
  commitPositions?: readonly {
    sourceContextName: string;
    maxGlobalPosition: string;
    eventIds: readonly string[];
  }[];
}>;

export type CheckoutSessionRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  cart: CheckoutCartServices;
  addressVerificationProvider?: PostageLabelProvider | null;
  paymentProcessorPublicConfiguration?: Readonly<{ publishableKey: string | null }>;
}>;

export type CheckoutSessionServices = Readonly<{
  commandHandler: CommandHandler<CheckoutSessionCommand, CheckoutSessionState, CheckoutSessionEvent>;
  createFromCart: (
    params: Readonly<{
      accountId: AccountId;
      shippingOption?: string;
      optimizationGoal?: CheckoutOptimizationGoal;
      readinessSnapshotId: string;
      readinessSourceRevision: string;
      readinessDecisions?: CartReadinessDecisionInput | null;
      presentedAnonymousCartId?: string | null;
      sessionIdOverride?: CheckoutSessionId;
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionCreateResult>;
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
      fulfillmentPreviewRevision: string;
      fulfillmentPreviewSnapshot?: CheckoutFulfillmentPreview | null;
      sessionIdOverride?: CheckoutSessionId;
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionCreateResult>;
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
  ) => Promise<CheckoutSessionCreateResult>;
  selectShippingOption: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      shippingOption: string;
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  selectOptimizationGoal: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      optimizationGoal: CheckoutOptimizationGoal;
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  recordFulfillmentPreview: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      fulfillmentPreviewRevision: string;
      fulfillmentPreviewSnapshot?: CheckoutFulfillmentPreview | null;
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  setShippingAddress: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      shippingAddress: CheckoutShippingAddress;
      addressVerificationDecision?: AddressVerificationDecision;
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  verifyShippingAddress: (
    address: CheckoutShippingAddress,
    decision?: AddressVerificationDecision,
  ) => Promise<CheckoutAddressVerificationOutcome>;
  selectAuthenticityCheckOptIn: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      selected: boolean;
      quoteFingerprint?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  recordOrdersCreated: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      orderIds: readonly string[];
      fulfilledLineKeys?: readonly string[];
      orderWriteCommitPositions?: readonly CheckoutSourceCommitPosition[];
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  resumeOrderCartCleanup: (
    params: Readonly<{ sessionId: string; accountId: AccountId }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  recordCheckoutReservations: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      reservations: readonly CheckoutSessionReservation[];
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  assertReadyForOrderCreation: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
    }>,
  ) => Promise<CheckoutSessionRow>;
  recordPaymentStarted: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      paymentId: string;
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  recordOfferSubmitted: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      offerId: string;
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  cancelSession: (
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  getSession: (sessionId: string, accountId: string) => ReturnType<typeof getCheckoutSession>;
  getPaymentSummary: (paymentId: string) => Promise<CheckoutPaymentSummaryRow | null>;
  getPaymentConfirmation: (sessionId: string, accountId: string) => Promise<CheckoutPaymentConfirmation | null>;
  listSavedPaymentInstruments: (accountId: AccountId) => Promise<CheckoutSavedPaymentInstrumentRow[]>;
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

function stateToCheckoutSessionRow(state: CheckoutSessionState): CheckoutSessionRow {
  if (!state.sessionId || !state.buyerAccountId || !state.sourceType || !state.createdAt || !state.updatedAt) {
    throw new CheckoutDomainError("Checkout session not found.");
  }

  return {
    session_id: state.sessionId,
    buyer_account_id: state.buyerAccountId,
    source_type: state.sourceType,
    optimization_goal: state.optimizationGoal,
    fulfillment_preview_revision: state.fulfillmentPreviewRevision,
    fulfillment_preview_snapshot: state.fulfillmentPreviewSnapshot,
    cart_readiness_snapshot: state.cartReadinessSnapshot,
    split_group_handoff: state.splitGroupHandoff,
    shipping_option: state.shippingOption,
    shipping_address_id: state.shippingAddress?.shippingAddressId ?? null,
    shipping_address: state.shippingAddress,
    authenticity_check_opt_in: state.authenticityCheckOptIn,
    lines: [...state.lines],
    order_ids: [...state.orderIds],
    order_write_commit_positions: [...state.orderWriteCommitPositions],
    checkout_reservations: [...state.checkoutReservations],
    payment_id: state.paymentId,
    submitted_offer_id: state.submittedOfferId,
    cancelled_at: state.cancelledAt,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
  };
}

function hasCommittedSessionSideEffects(session: CheckoutSessionRow) {
  return Boolean(
    session.cancelled_at ||
    session.payment_id ||
    session.submitted_offer_id ||
    (Array.isArray(session.order_ids) && session.order_ids.length > 0),
  );
}

function sessionPageIsBehindCommittedAggregate(
  session: CheckoutSessionRow,
  aggregateSession: CheckoutSessionRow | null,
) {
  if (!aggregateSession || !hasCommittedSessionSideEffects(aggregateSession)) {
    return false;
  }

  if (aggregateSession.cancelled_at && aggregateSession.cancelled_at !== session.cancelled_at) {
    return true;
  }

  if (aggregateSession.payment_id && aggregateSession.payment_id !== session.payment_id) {
    return true;
  }

  if (aggregateSession.submitted_offer_id && aggregateSession.submitted_offer_id !== session.submitted_offer_id) {
    return true;
  }

  if (aggregateSession.order_ids.length > 0) {
    const projectedOrderIds = new Set(session.order_ids);
    const missingOrder = aggregateSession.order_ids.some((orderId) => !projectedOrderIds.has(orderId));
    if (missingOrder) {
      return true;
    }

    return aggregateSession.order_write_commit_positions.length > session.order_write_commit_positions.length;
  }

  return false;
}

function readinessStaleError(code = "readiness_snapshot_stale") {
  return new CheckoutDomainError("Cart readiness changed. Review your cart before checkout.", code);
}

function buyNowHandoffStaleError() {
  return new CheckoutDomainError(
    "Selected listing changed. Review item availability before checkout.",
    "readiness_snapshot_stale",
  );
}

function assertBuyerDeliveryAddressServiceable(address: CheckoutShippingAddress | null | undefined) {
  const issue = checkoutDeliveryServiceabilityIssue(address);
  if (issue) {
    throw new CheckoutDomainError(issue.message, issue.code);
  }
}

function normalizedFulfillmentGroups(groups: readonly CartReadinessFulfillmentGroup[]) {
  return groups
    .map((group) => ({
      groupId: group.groupId,
      lineIds: [...group.lineIds].sort(),
      listingIds: [...group.listingIds].sort(),
      sellerAccountId: group.sellerAccountId,
      sellerDisplayName: group.sellerDisplayName,
      itemCount: group.itemCount,
      packageCount: group.packageCount,
      deliveryPromise: group.deliveryPromise,
      shippingAmount: group.shippingAmount,
      supportReference: group.supportReference,
      downstreamReferenceStatus: group.downstreamReferenceStatus,
    }))
    .sort((left, right) => left.groupId.localeCompare(right.groupId));
}

function splitGroupHandoffMatches(
  handoff: CheckoutSplitGroupHandoff | null | undefined,
  currentGroups: readonly CartReadinessFulfillmentGroup[],
) {
  return (
    handoff?.status === "ready" &&
    JSON.stringify(normalizedFulfillmentGroups(handoff.groups)) ===
      JSON.stringify(normalizedFulfillmentGroups(currentGroups))
  );
}

function assertOrderableSessionFulfillmentAssigned(
  state: Readonly<{
    sourceType: "cart" | "buy-now" | "offer-intent" | null;
    lines: readonly CheckoutSessionLine[];
  }>,
) {
  if (state.sourceType === "offer-intent") {
    return;
  }

  assertCheckoutLinesHaveAssignedFulfillment(state.lines);
}

function assertSessionNotCancelled(state: Pick<CheckoutSessionState, "cancelledAt">) {
  if (state.cancelledAt) {
    throw new CheckoutDomainError("Cancelled checkout sessions cannot create orders.", "checkout_cancelled");
  }
}

async function assertCurrentCartReadinessForUncommittedSession(
  state: Readonly<{
    sourceType: "cart" | "buy-now" | "offer-intent" | null;
    orderIds: readonly string[];
    paymentId: string | null;
    submittedOfferId: string | null;
    cancelledAt?: string | null;
    cartReadinessSnapshot: CartReadinessSnapshot | null | undefined;
    presentedAnonymousCartId: string | null | undefined;
    splitGroupHandoff: CheckoutSplitGroupHandoff | null | undefined;
  }>,
  accountId: AccountId | string,
  cart: CheckoutCartServices,
) {
  if (state.sourceType !== "cart") {
    return;
  }

  if (state.paymentId || state.orderIds.length > 0 || state.submittedOfferId) {
    return;
  }
  if (state.cancelledAt) {
    return;
  }

  const storedReadiness = state.cartReadinessSnapshot;
  if (!storedReadiness) {
    throw readinessStaleError();
  }

  const presentedAnonymousCartId = state.presentedAnonymousCartId ?? null;
  const cartLines = presentedAnonymousCartId
    ? await cart.listCartLines(accountId as AccountId, presentedAnonymousCartId)
    : await cart.listCartLines(accountId as AccountId);
  const readiness = validateCartReadinessSnapshot(
    cartLines,
    {
      snapshotId: storedReadiness.snapshotId,
      sourceRevision: storedReadiness.sourceRevision,
      decisions: cartReadinessDecisionsFromSnapshot(storedReadiness),
    },
    presentedAnonymousCartId ? { accountId: String(accountId), presentedAnonymousCartId } : undefined,
  );
  if (!readiness.valid) {
    throw readinessStaleError();
  }

  if (readiness.current.status !== "ready" || readiness.current.unresolvedLineIds.length > 0) {
    throw unresolvedFulfillmentError();
  }

  if (!splitGroupHandoffMatches(state.splitGroupHandoff, readiness.current.fulfillmentGroups)) {
    throw readinessStaleError("split_group_handoff_stale");
  }
}

function commitMetadataFromStoredEvents(
  events: readonly { eventId: unknown; globalPosition: unknown; streamId: string }[],
) {
  const eventIds = events.map((event) => String(event.eventId));
  const commitPosition = events.reduce<string | undefined>((current, event) => {
    const globalPosition = String(event.globalPosition);
    return !current || BigInt(globalPosition) > BigInt(current) ? globalPosition : current;
  }, undefined);
  const positions = new Map<string, { eventIds: string[]; maxGlobalPosition: string }>();

  for (const event of events) {
    const sourceContextName = sourceContextNameFromStreamId(event.streamId);
    const globalPosition = String(event.globalPosition);
    const current = positions.get(sourceContextName);
    if (!current) {
      positions.set(sourceContextName, { eventIds: [String(event.eventId)], maxGlobalPosition: globalPosition });
      continue;
    }

    current.eventIds.push(String(event.eventId));
    if (BigInt(globalPosition) > BigInt(current.maxGlobalPosition)) {
      current.maxGlobalPosition = globalPosition;
    }
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

function sourceContextNameFromStreamId(streamId: string) {
  const separatorIndex = streamId.indexOf(".");
  return separatorIndex > 0 ? streamId.slice(0, separatorIndex) : streamId;
}

function isEventStoreConcurrencyConflict(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "concurrency_conflict",
  );
}

export function createCheckoutSessionRuntime(deps: CheckoutSessionRuntimeDeps): CheckoutSessionServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<CheckoutSessionEvent>(),
    initialState: () => initialCheckoutSessionState,
    evolve: evolveCheckoutSession,
    decide: decideCheckoutSession,
  });
  const sessionProjector = createProjectionHandlerSet({
    projectionName: "checkout.session-projection",
    handlers: buildCheckoutSessionProjectionHandlers(deps.db),
    streamPrefixes: ["checkout.session-"],
    checkpointBatchSize: 1,
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

  async function loadSessionStateForBuyer(sessionId: string, accountId: AccountId): Promise<CheckoutSessionState> {
    const loaded = await repository.load(`checkout.session-${sessionId}`);
    if (loaded.state.sessionId !== sessionId || loaded.state.buyerAccountId !== accountId) {
      throw new CheckoutDomainError("Checkout session not found.");
    }

    retainedOrderCartCleanup(loaded.state);
    return loaded.state;
  }

  async function loadSessionStateForBuyerOrNull(
    sessionId: string,
    accountId: AccountId | string,
  ): Promise<CheckoutSessionState | null> {
    const loaded = await repository.load(`checkout.session-${sessionId}`);
    if (loaded.state.sessionId !== sessionId || loaded.state.buyerAccountId !== accountId) {
      return null;
    }

    retainedOrderCartCleanup(loaded.state);
    return loaded.state;
  }

  function assertBuyNowHandoffReady(
    params: Readonly<{
      listingId: string;
      lockedListingId: string;
      fulfillmentPreviewRevision: string;
    }>,
  ) {
    const listingId = params.listingId.trim();
    const lockedListingId = params.lockedListingId.trim();
    if (listingId && listingId !== lockedListingId) {
      throw buyNowHandoffStaleError();
    }

    if (!params.fulfillmentPreviewRevision.trim()) {
      throw unresolvedFulfillmentError();
    }
  }

  async function applySessionCommandForBuyer(
    params: Readonly<{
      sessionId: string;
      accountId: AccountId;
      command: CheckoutSessionCommand;
    }>,
    context: EventStoreContext,
  ): Promise<CheckoutSessionMutationResult> {
    await loadSessionStateForBuyer(params.sessionId, params.accountId);
    const result = await commandHandler({
      streamId: `checkout.session-${params.sessionId}`,
      command: params.command,
      context,
    });
    return {
      sessionId: params.sessionId,
      session: stateToCheckoutSessionRow(result.state),
      ...commitMetadataFromStoredEvents(result.storedEvents),
    };
  }

  function assertCleanupContext(accountId: AccountId, context: EventStoreContext) {
    if (!context?.tenantId || !context.audit?.performedByUserId || context.audit.forAccountId !== accountId) {
      throw new CheckoutDomainError("Checkout buyer context is required.");
    }
  }

  async function cleanupCommitMetadata(sessionId: string, state: CheckoutSessionState) {
    const events = await readCompleteStream(deps.eventStore, { streamId: `checkout.session-${sessionId}` });
    const metadata = commitMetadataFromStoredEvents(events);
    return { ...metadata, commitPositions: [...metadata.commitPositions, ...state.orderWriteCommitPositions] };
  }

  const resumeOrderCartCleanup: CheckoutSessionServices["resumeOrderCartCleanup"] = async (params, context) => {
    assertCleanupContext(params.accountId, context);
    let metadata: OrderCartCleanupError["commitMetadata"] = {};
    try {
      const state = await loadSessionStateForBuyer(params.sessionId, params.accountId);
      const cleanup = retainedOrderCartCleanup(state);
      metadata = await cleanupCommitMetadata(params.sessionId, state);
      if (!cleanup || cleanup.status === "complete") {
        return { sessionId: params.sessionId, session: stateToCheckoutSessionRow(state), ...metadata };
      }
      for (const ownerKey of cleanup.plan.sourceOwnerKeys) {
        for (const lineId of cleanup.plan.lineIds) {
          try {
            await deps.cart.removeLine({ accountId: ownerKey as AccountId, lineId: lineId as CartLineId }, context);
          } catch (error) {
            if (!(error instanceof CheckoutDomainError && error.message === "Cart line not found.")) throw error;
          }
        }
      }
      const completed = await applySessionCommandForBuyer(
        {
          ...params,
          command: { type: "CompleteOrderCartCleanup", completedAt: new Date().toISOString() },
        },
        context,
      );
      const current = await loadSessionStateForBuyer(params.sessionId, params.accountId);
      return { ...completed, ...(await cleanupCommitMetadata(params.sessionId, current)) };
    } catch {
      // Completion may have committed before its acknowledgement was lost.
      try {
        const current = await loadSessionStateForBuyer(params.sessionId, params.accountId);
        metadata = await cleanupCommitMetadata(params.sessionId, current);
      } catch {
        /* Preserve the last known committed metadata while the store remains unavailable. */
      }
      throw new OrderCartCleanupError(metadata);
    }
  };

  async function startSession(
    params: Readonly<{
      accountId: AccountId;
      sourceType: "cart" | "buy-now" | "offer-intent";
      optimizationGoal?: CheckoutOptimizationGoal;
      fulfillmentPreviewRevision?: string | null;
      fulfillmentPreviewSnapshot?: CheckoutFulfillmentPreview | null;
      cartReadinessSnapshot?: CartReadinessSnapshot | null;
      presentedAnonymousCartId?: string | null;
      shippingOption: ShippingOption;
      lines: readonly CheckoutSessionLine[];
      sessionIdOverride?: CheckoutSessionId;
    }>,
    context: EventStoreContext,
  ) {
    let sessionId = params.sessionIdOverride ?? (createId("chk") as CheckoutSessionId);
    let streamId = `checkout.session-${sessionId}`;
    async function existingStartedSession(
      candidateSessionId: CheckoutSessionId,
      candidateStreamId: string,
    ): Promise<Readonly<{ result: CheckoutSessionCreateResult; state: CheckoutSessionState }> | null> {
      if (!params.sessionIdOverride || candidateSessionId !== params.sessionIdOverride) {
        return null;
      }

      const storedEvents = await readCompleteStream(deps.eventStore, { streamId: candidateStreamId });
      const started = storedEvents.find((event) => event.eventType === "checkout.session.started");
      if (!started) {
        return null;
      }

      const payload = started.payload as { sessionId?: unknown; buyerAccountId?: unknown; sourceType?: unknown };
      if (
        payload.sessionId !== candidateSessionId ||
        payload.buyerAccountId !== params.accountId ||
        payload.sourceType !== params.sourceType
      ) {
        throw new CheckoutDomainError("Checkout session not found.");
      }

      const loaded = await repository.load(candidateStreamId);
      return {
        result: {
          sessionId: candidateSessionId,
          ...commitMetadataFromStoredEvents(storedEvents),
        },
        state: loaded.state,
      };
    }

    const existing = await existingStartedSession(sessionId, streamId);
    if (existing) {
      if (
        params.sourceType !== "buy-now" ||
        existing.state.orderIds.length === 0 ||
        existing.state.paymentId ||
        existing.state.submittedOfferId
      ) {
        return existing.result;
      }

      sessionId = createId("chk") as CheckoutSessionId;
      streamId = `checkout.session-${sessionId}`;
    }

    let result: Awaited<ReturnType<typeof commandHandler>>;
    try {
      result = await commandHandler({
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
          createdAt: new Date().toISOString(),
        },
        context,
      });
    } catch (error) {
      if (!params.sessionIdOverride || !isEventStoreConcurrencyConflict(error)) {
        throw error;
      }

      if (sessionId !== params.sessionIdOverride) {
        throw error;
      }

      const replayed = await existingStartedSession(
        params.sessionIdOverride,
        `checkout.session-${params.sessionIdOverride}`,
      );
      if (replayed) {
        return replayed.result;
      }

      throw error;
    }

    return {
      sessionId,
      ...commitMetadataFromStoredEvents(result.storedEvents),
    };
  }

  return {
    commandHandler,
    createFromCart: async (params, context) => {
      const presentedAnonymousCartId = params.presentedAnonymousCartId ?? null;
      const cartLines = presentedAnonymousCartId
        ? await deps.cart.listCartLines(params.accountId, presentedAnonymousCartId)
        : await deps.cart.listCartLines(params.accountId);
      if (cartLines.length === 0) {
        throw new CheckoutDomainError("Cart must contain at least one line.", "cart_empty");
      }
      const readiness = validateCartReadinessSnapshot(
        cartLines,
        {
          snapshotId: params.readinessSnapshotId,
          sourceRevision: params.readinessSourceRevision,
          decisions: params.readinessDecisions ?? undefined,
        },
        presentedAnonymousCartId ? { accountId: params.accountId, presentedAnonymousCartId } : undefined,
      );
      if (!readiness.valid) {
        throw new CheckoutDomainError(
          "Cart readiness changed. Review your cart before checkout.",
          "readiness_snapshot_stale",
        );
      }
      if (readiness.current.status !== "ready" || readiness.current.unresolvedLineIds.length > 0) {
        throw new CheckoutDomainError("Resolve item availability before checkout starts.", "unresolved_fulfillment");
      }
      const checkoutLines = applyCartReadinessToLines(cartLines, readiness.current);

      return startSession(
        {
          accountId: params.accountId,
          sourceType: "cart",
          shippingOption: normalizeShippingOption(params.shippingOption ?? "standard"),
          optimizationGoal: params.optimizationGoal,
          cartReadinessSnapshot: readiness.current,
          presentedAnonymousCartId,
          lines: checkoutLines.map(cartLineToSessionLine),
          sessionIdOverride: params.sessionIdOverride,
        },
        context,
      );
    },
    createBuyNow: async (params, context) => {
      const lockedListingId = params.lockedListingId?.trim() || params.listingId.trim() || null;
      if (!lockedListingId) {
        throw unresolvedFulfillmentError();
      }

      assertBuyNowHandoffReady({
        listingId: params.listingId,
        lockedListingId,
        fulfillmentPreviewRevision: params.fulfillmentPreviewRevision,
      });
      const descriptor = await validateCatalogSelection(params);
      const fulfillmentMode =
        params.fulfillmentMode === "locked-listing" || lockedListingId ? "locked-listing" : "optimize";
      return startSession(
        {
          accountId: params.accountId,
          sourceType: "buy-now",
          shippingOption: normalizeShippingOption(params.shippingOption ?? "standard"),
          optimizationGoal: params.optimizationGoal,
          fulfillmentPreviewRevision: params.fulfillmentPreviewRevision,
          fulfillmentPreviewSnapshot: params.fulfillmentPreviewSnapshot,
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
      return applySessionCommandForBuyer(
        {
          sessionId: params.sessionId,
          accountId: params.accountId,
          command: {
            type: "SelectShippingOption",
            shippingOption: normalizeShippingOption(params.shippingOption),
            selectedAt: new Date().toISOString(),
          },
        },
        context,
      );
    },
    selectOptimizationGoal: async (params, context) => {
      return applySessionCommandForBuyer(
        {
          sessionId: params.sessionId,
          accountId: params.accountId,
          command: {
            type: "SelectOptimizationGoal",
            optimizationGoal: params.optimizationGoal,
            selectedAt: new Date().toISOString(),
          },
        },
        context,
      );
    },
    recordFulfillmentPreview: async (params, context) => {
      return applySessionCommandForBuyer(
        {
          sessionId: params.sessionId,
          accountId: params.accountId,
          command: {
            type: "RecordFulfillmentPreview",
            fulfillmentPreviewRevision: params.fulfillmentPreviewRevision,
            fulfillmentPreviewSnapshot: params.fulfillmentPreviewSnapshot,
            recordedAt: new Date().toISOString(),
          },
        },
        context,
      );
    },
    setShippingAddress: async (params, context) => {
      const verification = params.shippingAddress.verification
        ? ({ status: "accepted", shippingAddress: params.shippingAddress } as const)
        : await verifyCheckoutShippingAddress(
            deps.addressVerificationProvider,
            params.shippingAddress,
            params.addressVerificationDecision ?? null,
          );
      if (verification.status === "choice-required") {
        throw new CheckoutDomainError(
          "Confirm the suggested shipping address before continuing.",
          "address_choice_required",
        );
      }
      if (verification.status !== "accepted") {
        throw new CheckoutDomainError(
          "Confirm the suggested shipping address before continuing.",
          "address_choice_required",
        );
      }
      return applySessionCommandForBuyer(
        {
          sessionId: params.sessionId,
          accountId: params.accountId,
          command: {
            type: "SetShippingAddress",
            shippingAddress: verification.shippingAddress,
            selectedAt: new Date().toISOString(),
          },
        },
        context,
      );
    },
    verifyShippingAddress: (address, decision) =>
      verifyCheckoutShippingAddress(deps.addressVerificationProvider, address, decision ?? null),
    selectAuthenticityCheckOptIn: async (params, context) => {
      return applySessionCommandForBuyer(
        {
          sessionId: params.sessionId,
          accountId: params.accountId,
          command: {
            type: "SelectAuthenticityCheckOptIn",
            selected: params.selected,
            quoteFingerprint: params.quoteFingerprint ?? null,
            selectedAt: new Date().toISOString(),
          },
        },
        context,
      );
    },
    assertReadyForOrderCreation: async (params) => {
      const state = await loadSessionStateForBuyer(params.sessionId, params.accountId);
      assertSessionNotCancelled(state);
      await assertCurrentCartReadinessForUncommittedSession(state, params.accountId, deps.cart);
      assertOrderableSessionFulfillmentAssigned(state);
      assertBuyerDeliveryAddressServiceable(state.shippingAddress);
      return stateToCheckoutSessionRow(state);
    },
    resumeOrderCartCleanup,
    recordOrdersCreated: async (params, context) => {
      assertCleanupContext(params.accountId, context);
      const state = await loadSessionStateForBuyer(params.sessionId, params.accountId);
      if (state.orderIds.length > 0) return resumeOrderCartCleanup(params, context);
      assertSessionNotCancelled(state);
      await assertCurrentCartReadinessForUncommittedSession(state, params.accountId, deps.cart);
      assertOrderableSessionFulfillmentAssigned(state);
      assertBuyerDeliveryAddressServiceable(state.shippingAddress);
      let result: CheckoutSessionMutationResult;
      try {
        result = await applySessionCommandForBuyer(
          {
            sessionId: params.sessionId,
            accountId: params.accountId,
            command: {
              type: "RecordOrdersCreated",
              orderIds: params.orderIds as OrderId[],
              fulfilledLineKeys: params.fulfilledLineKeys,
              orderWriteCommitPositions: params.orderWriteCommitPositions,
              recordedAt: new Date().toISOString(),
            },
          },
          context,
        );
      } catch {
        // An append can commit and lose its acknowledgement. Recover only actual stored metadata.
        let metadata: OrderCartCleanupError["commitMetadata"] = {};
        try {
          const current = await loadSessionStateForBuyer(params.sessionId, params.accountId);
          metadata = await cleanupCommitMetadata(params.sessionId, current);
        } catch {
          /* The next authorized retry reloads durable intent if the store is unavailable. */
        }
        throw new OrderCartCleanupError(metadata);
      }
      if (
        result.session.source_type === "cart" &&
        !result.session.lines.some((line) => line.cartLineId) &&
        (params.fulfilledLineKeys?.length ?? 0) === 0 &&
        result.commitEventIds?.length
      ) {
        await deps.cart.checkout(state.buyerAccountId!, context);
        return result;
      }
      return resumeOrderCartCleanup(params, context);
    },
    recordCheckoutReservations: async (params, context) => {
      const state = await loadSessionStateForBuyer(params.sessionId, params.accountId);
      await assertCurrentCartReadinessForUncommittedSession(state, params.accountId, deps.cart);
      assertOrderableSessionFulfillmentAssigned(state);
      return applySessionCommandForBuyer(
        {
          sessionId: params.sessionId,
          accountId: params.accountId,
          command: {
            type: "RecordCheckoutReservations",
            reservations: params.reservations,
            recordedAt: new Date().toISOString(),
          },
        },
        context,
      );
    },
    recordPaymentStarted: async (params, context) => {
      return applySessionCommandForBuyer(
        {
          sessionId: params.sessionId,
          accountId: params.accountId,
          command: {
            type: "RecordPaymentStarted",
            paymentId: params.paymentId as PaymentId,
            recordedAt: new Date().toISOString(),
          },
        },
        context,
      );
    },
    recordOfferSubmitted: async (params, context) => {
      return applySessionCommandForBuyer(
        {
          sessionId: params.sessionId,
          accountId: params.accountId,
          command: {
            type: "RecordOfferSubmitted",
            offerId: params.offerId,
            recordedAt: new Date().toISOString(),
          },
        },
        context,
      );
    },
    cancelSession: async (params, context) => {
      return applySessionCommandForBuyer(
        {
          sessionId: params.sessionId,
          accountId: params.accountId,
          command: {
            type: "CancelCheckoutSession",
            cancelledAt: new Date().toISOString(),
          },
        },
        context,
      );
    },
    getSession: async (sessionId, accountId) => {
      const projectedSession = await getCheckoutSession(deps.db, sessionId, accountId);
      const aggregateState =
        !projectedSession ||
        !hasCommittedSessionSideEffects(projectedSession) ||
        (projectedSession.source_type === "cart" &&
          Boolean(projectedSession.cancelled_at) &&
          !projectedSession.payment_id &&
          !projectedSession.submitted_offer_id &&
          projectedSession.order_ids.length === 0)
          ? await loadSessionStateForBuyerOrNull(sessionId, accountId)
          : null;
      const aggregateSession = aggregateState ? stateToCheckoutSessionRow(aggregateState) : null;
      const session =
        projectedSession && !sessionPageIsBehindCommittedAggregate(projectedSession, aggregateSession)
          ? projectedSession
          : aggregateSession;
      if (!session) {
        return null;
      }

      if (session.source_type !== "cart") {
        return session;
      }

      await assertCurrentCartReadinessForUncommittedSession(
        {
          sourceType: session.source_type,
          orderIds: session.order_ids,
          paymentId: session.payment_id,
          submittedOfferId: session.submitted_offer_id,
          cartReadinessSnapshot: session.cart_readiness_snapshot ?? null,
          presentedAnonymousCartId: aggregateState?.presentedAnonymousCartId ?? null,
          splitGroupHandoff: session.split_group_handoff ?? null,
        },
        accountId,
        deps.cart,
      );

      return session;
    },
    getPaymentSummary: (paymentId) => getCheckoutPaymentSummary(deps.db, paymentId),
    getPaymentConfirmation: async (sessionId, accountId) => {
      const payment = await getCheckoutPaymentConfirmationProjection(deps.db, sessionId, accountId);
      if (!payment) {
        return null;
      }

      return exposeCheckoutPaymentConfirmation(payment, deps.paymentProcessorPublicConfiguration);
    },
    listSavedPaymentInstruments: (accountId) => listCheckoutSavedPaymentInstruments(deps.db, accountId),
    projectors: [sessionProjector],
  };
}
