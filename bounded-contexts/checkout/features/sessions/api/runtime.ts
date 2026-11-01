import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
import type { AccountId, CheckoutSessionId, PaymentId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutCartServices } from "../../cart/api/runtime";
import type { CartReadinessDecisionInput } from "../../cart/domain/readiness";
import { CheckoutDomainError, normalizeShippingOption } from "../../../support/runtime-support/common";
import {
  decideCheckoutSession,
  evolveCheckoutSession,
  initialCheckoutSessionState,
  retainedOrderCartCleanup,
  type CheckoutSessionCommand,
  type CheckoutSessionEvent,
  type CheckoutSessionReservation,
  type CheckoutSessionState,
  type CheckoutShippingAddress,
  type CheckoutOptimizationGoal,
  type CheckoutSourceCommitPosition,
} from "../domain/domain";
import { checkoutDeliveryServiceabilityIssue } from "../domain/delivery-serviceability";
import type { CheckoutFulfillmentPreview } from "../domain/fulfillment-preview";
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
import {
  verifyCheckoutShippingAddress,
  type AddressVerificationDecision,
  type CheckoutAddressVerificationOutcome,
} from "./address-verification";
import { commitMetadataFromStoredEvents, createCheckoutSessionEntryServices } from "./session-entry";
import { createCheckoutSessionCleanupService, OrderCartCleanupError } from "./session-cleanup";
import {
  assertCurrentCartReadinessForUncommittedSession,
  assertOrderableSessionFulfillmentAssigned,
  createCheckoutSessionReadServices,
  stateToCheckoutSessionRow,
} from "./session-read";

export type CheckoutSessionMutationResult = Readonly<{
  sessionId: string;
  session: CheckoutSessionRow;
  commitPosition?: string;
  commitEventIds?: readonly string[];
  commitPositions?: readonly { sourceContextName: string; maxGlobalPosition: string; eventIds: readonly string[] }[];
}>;
export { OrderCartCleanupError };
export type CheckoutSessionCancellationRead = Readonly<{
  status: "already-cancelled" | "cancellable";
  session: CheckoutSessionRow;
}>;
export type CheckoutSessionCreateResult = Readonly<{
  sessionId: CheckoutSessionId;
  commitPosition?: string;
  commitEventIds?: readonly string[];
  commitPositions?: readonly { sourceContextName: string; maxGlobalPosition: string; eventIds: readonly string[] }[];
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
      handoffExpiresAt?: string | null;
      createdAt?: string;
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
      offerPriceCurrencyCode: string;
      quantity: number;
      optimizationGoal?: CheckoutOptimizationGoal;
      shippingOption?: string;
      sessionIdOverride?: CheckoutSessionId;
    }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionCreateResult>;
  selectShippingOption: (
    params: Readonly<{ sessionId: string; accountId: AccountId; shippingOption: string }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  selectOptimizationGoal: (
    params: Readonly<{ sessionId: string; accountId: AccountId; optimizationGoal: CheckoutOptimizationGoal }>,
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
    params: Readonly<{ sessionId: string; accountId: AccountId; selected: boolean; quoteFingerprint?: string | null }>,
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
    params: Readonly<{ sessionId: string; accountId: AccountId; reservations: readonly CheckoutSessionReservation[] }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  assertReadyForOrderCreation: (
    params: Readonly<{ sessionId: string; accountId: AccountId }>,
  ) => Promise<CheckoutSessionRow>;
  recordPaymentStarted: (
    params: Readonly<{ sessionId: string; accountId: AccountId; paymentId: string }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  recordOfferSubmitted: (
    params: Readonly<{ sessionId: string; accountId: AccountId; offerId: string }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  cancelSession: (
    params: Readonly<{ sessionId: string; accountId: AccountId }>,
    context: EventStoreContext,
  ) => Promise<CheckoutSessionMutationResult>;
  /**
   * The buyer's own session read from its stream, not the page projection, for
   * owner cancellation: already cancelled, or holding only reservations. Throws
   * `checkout_session_not_cancellable` once orders, payment or purchase intent
   * exist; those holds belong to Ordering and Payments.
   */
  readSessionForCancellation: (
    params: Readonly<{ sessionId: string; accountId: AccountId }>,
  ) => Promise<CheckoutSessionCancellationRead>;
  getSession: (sessionId: string, accountId: string) => ReturnType<typeof getCheckoutSession>;
  /** The buyer's session's last recorded quote, read from its stream; null when unknown or never quoted. */
  getLastRecordedQuote: (sessionId: string, accountId: string) => Promise<CheckoutFulfillmentPreview | null>;
  getPaymentSummary: (paymentId: string) => Promise<CheckoutPaymentSummaryRow | null>;
  getPaymentConfirmation: (sessionId: string, accountId: string) => Promise<CheckoutPaymentConfirmation | null>;
  listSavedPaymentInstruments: (accountId: AccountId) => Promise<CheckoutSavedPaymentInstrumentRow[]>;
  projectors: readonly ProjectionHandlerSet[];
}>;

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
  const loadSessionStateForBuyer = async (sessionId: string, accountId: AccountId): Promise<CheckoutSessionState> => {
    const loaded = await repository.load(`checkout.session-${sessionId}`);
    if (loaded.state.sessionId !== sessionId || loaded.state.buyerAccountId !== accountId)
      throw new CheckoutDomainError("Checkout session not found.");
    retainedOrderCartCleanup(loaded.state);
    return loaded.state;
  };
  const loadSessionStateForBuyerOrNull = async (sessionId: string, accountId: AccountId | string) => {
    const loaded = await repository.load(`checkout.session-${sessionId}`);
    if (loaded.state.sessionId !== sessionId || loaded.state.buyerAccountId !== accountId) return null;
    retainedOrderCartCleanup(loaded.state);
    return loaded.state;
  };
  const applySessionCommandForBuyer = async (
    params: Readonly<{ sessionId: string; accountId: AccountId; command: CheckoutSessionCommand }>,
    context: EventStoreContext,
  ): Promise<CheckoutSessionMutationResult> => {
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
  };
  const entry = createCheckoutSessionEntryServices({
    eventStore: deps.eventStore,
    db: deps.db,
    cart: deps.cart,
    commandHandler,
    repository,
  });
  const reads = createCheckoutSessionReadServices({
    db: deps.db,
    cart: deps.cart,
    loadSessionStateForBuyer,
    loadSessionStateForBuyerOrNull,
  });
  const cleanup = createCheckoutSessionCleanupService({
    eventStore: deps.eventStore,
    cart: deps.cart,
    repository,
    loadSessionStateForBuyer,
    applySessionCommandForBuyer,
    stateToCheckoutSessionRow,
  });
  return {
    commandHandler,
    ...entry,
    ...reads,
    ...cleanup,
    selectShippingOption: async (params, context) =>
      applySessionCommandForBuyer(
        {
          ...params,
          command: {
            type: "SelectShippingOption",
            shippingOption: normalizeShippingOption(params.shippingOption),
            selectedAt: new Date().toISOString(),
          },
        },
        context,
      ),
    selectOptimizationGoal: (params, context) =>
      applySessionCommandForBuyer(
        {
          ...params,
          command: {
            type: "SelectOptimizationGoal",
            optimizationGoal: params.optimizationGoal,
            selectedAt: new Date().toISOString(),
          },
        },
        context,
      ),
    recordFulfillmentPreview: (params, context) =>
      applySessionCommandForBuyer(
        {
          ...params,
          command: {
            type: "RecordFulfillmentPreview",
            fulfillmentPreviewRevision: params.fulfillmentPreviewRevision,
            fulfillmentPreviewSnapshot: params.fulfillmentPreviewSnapshot,
            recordedAt: new Date().toISOString(),
          },
        },
        context,
      ),
    setShippingAddress: async (params, context) => {
      const verification = params.shippingAddress.verification
        ? ({ status: "accepted", shippingAddress: params.shippingAddress } as const)
        : await verifyCheckoutShippingAddress(
            deps.addressVerificationProvider,
            params.shippingAddress,
            params.addressVerificationDecision ?? null,
          );
      if (verification.status !== "accepted")
        throw new CheckoutDomainError(
          "Confirm the suggested shipping address before continuing.",
          "address_choice_required",
        );
      const serviceabilityIssue = checkoutDeliveryServiceabilityIssue(verification.shippingAddress);
      if (serviceabilityIssue) {
        throw new CheckoutDomainError(serviceabilityIssue.message, serviceabilityIssue.code);
      }
      return applySessionCommandForBuyer(
        {
          ...params,
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
    selectAuthenticityCheckOptIn: (params, context) =>
      applySessionCommandForBuyer(
        {
          ...params,
          command: {
            type: "SelectAuthenticityCheckOptIn",
            selected: params.selected,
            quoteFingerprint: params.quoteFingerprint ?? null,
            selectedAt: new Date().toISOString(),
          },
        },
        context,
      ),
    recordCheckoutReservations: async (params, context) => {
      const state = await loadSessionStateForBuyer(params.sessionId, params.accountId);
      await assertCurrentCartReadinessForUncommittedSession(state, params.accountId, deps.cart);
      assertOrderableSessionFulfillmentAssigned(state);
      return applySessionCommandForBuyer(
        {
          ...params,
          command: {
            type: "RecordCheckoutReservations",
            reservations: params.reservations,
            recordedAt: new Date().toISOString(),
          },
        },
        context,
      );
    },
    recordPaymentStarted: (params, context) =>
      applySessionCommandForBuyer(
        {
          ...params,
          command: {
            type: "RecordPaymentStarted",
            paymentId: params.paymentId as PaymentId,
            recordedAt: new Date().toISOString(),
          },
        },
        context,
      ),
    recordOfferSubmitted: (params, context) =>
      applySessionCommandForBuyer(
        {
          ...params,
          command: { type: "RecordOfferSubmitted", offerId: params.offerId, recordedAt: new Date().toISOString() },
        },
        context,
      ),
    cancelSession: (params, context) =>
      applySessionCommandForBuyer(
        { ...params, command: { type: "CancelCheckoutSession", cancelledAt: new Date().toISOString() } },
        context,
      ),
    readSessionForCancellation: async (params) => {
      const state = await loadSessionStateForBuyer(params.sessionId, params.accountId);
      const session = stateToCheckoutSessionRow(state);
      if (state.cancelledAt) {
        return { status: "already-cancelled", session };
      }
      if (state.paymentId || state.orderIds.length > 0 || state.submittedOfferId) {
        throw new CheckoutDomainError(
          "This checkout already created orders or started payment, so cancel it from your purchases instead.",
          "checkout_session_not_cancellable",
        );
      }
      return { status: "cancellable", session };
    },
    getPaymentSummary: (paymentId) => getCheckoutPaymentSummary(deps.db, paymentId),
    getPaymentConfirmation: async (sessionId, accountId) => {
      const payment = await getCheckoutPaymentConfirmationProjection(deps.db, sessionId, accountId);
      return payment ? exposeCheckoutPaymentConfirmation(payment, deps.paymentProcessorPublicConfiguration) : null;
    },
    listSavedPaymentInstruments: (accountId) => listCheckoutSavedPaymentInstruments(deps.db, accountId),
    projectors: [sessionProjector],
  };
}
