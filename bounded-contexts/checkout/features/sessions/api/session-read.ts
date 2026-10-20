import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutCartServices } from "../../cart/api/runtime";
import {
  cartReadinessDecisionsFromSnapshot,
  validateCartReadinessSnapshot,
  type CartReadinessFulfillmentGroup,
  type CartReadinessSnapshot,
} from "../../cart/domain/readiness";
import { CheckoutDomainError } from "../../../support/runtime-support/common";
import { type CheckoutSessionLine, type CheckoutSessionState, type CheckoutSplitGroupHandoff } from "../domain/domain";
import { checkoutDeliveryServiceabilityIssue } from "../domain/delivery-serviceability";
import { assertCheckoutLinesHaveAssignedFulfillment, unresolvedFulfillmentError } from "./checkout-fulfillment-runtime";
import { getCheckoutSession, type CheckoutSessionRow } from "../read-model/queries";
import type { CheckoutSessionMutationResult, CheckoutSessionServices } from "./runtime";
import { acceptedPresentedAnonymousCartId } from "./session-entry";

export type CheckoutSessionReadDeps = Readonly<{
  db: PgQueryable;
  cart: CheckoutCartServices;
  loadSessionStateForBuyer: (sessionId: string, accountId: AccountId) => Promise<CheckoutSessionState>;
  loadSessionStateForBuyerOrNull: (
    sessionId: string,
    accountId: AccountId | string,
  ) => Promise<CheckoutSessionState | null>;
}>;

export function stateToCheckoutSessionRow(state: CheckoutSessionState): CheckoutSessionRow {
  if (!state.sessionId || !state.buyerAccountId || !state.sourceType || !state.createdAt || !state.updatedAt)
    throw new CheckoutDomainError("Checkout session not found.");
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
    handoff_expires_at: state.handoffExpiresAt,
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
  if (!aggregateSession || !hasCommittedSessionSideEffects(aggregateSession)) return false;
  if (aggregateSession.cancelled_at && aggregateSession.cancelled_at !== session.cancelled_at) return true;
  if (aggregateSession.payment_id && aggregateSession.payment_id !== session.payment_id) return true;
  if (aggregateSession.submitted_offer_id && aggregateSession.submitted_offer_id !== session.submitted_offer_id)
    return true;
  if (aggregateSession.order_ids.length > 0) {
    const projectedOrderIds = new Set(session.order_ids);
    if (aggregateSession.order_ids.some((orderId) => !projectedOrderIds.has(orderId))) return true;
    return aggregateSession.order_write_commit_positions.length > session.order_write_commit_positions.length;
  }
  return false;
}

function readinessStaleError(code = "readiness_snapshot_stale") {
  return new CheckoutDomainError("Cart readiness changed. Review your cart before checkout.", code);
}

export function assertBuyerDeliveryAddressServiceable(address: CheckoutSessionState["shippingAddress"]) {
  const issue = checkoutDeliveryServiceabilityIssue(address);
  if (issue) throw new CheckoutDomainError(issue.message, issue.code);
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

export function assertOrderableSessionFulfillmentAssigned(
  state: Readonly<{ sourceType: "cart" | "buy-now" | "offer-intent" | null; lines: readonly CheckoutSessionLine[] }>,
) {
  if (state.sourceType === "offer-intent") return;
  assertCheckoutLinesHaveAssignedFulfillment(state.lines);
}

export function assertSessionNotCancelled(state: Pick<CheckoutSessionState, "cancelledAt">) {
  if (state.cancelledAt)
    throw new CheckoutDomainError("Cancelled checkout sessions cannot create orders.", "checkout_cancelled");
}

export function assertCheckoutHandoffNotExpired(
  state: Pick<CheckoutSessionState, "handoffExpiresAt" | "orderIds">,
  now = new Date(),
) {
  if (state.orderIds.length === 0 && state.handoffExpiresAt && now.getTime() >= Date.parse(state.handoffExpiresAt))
    throw new CheckoutDomainError("This checkout handoff has expired. Start a new checkout.", "checkout_expired");
}

export async function assertCurrentCartReadinessForUncommittedSession(
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
  if (
    state.sourceType !== "cart" ||
    state.paymentId ||
    state.orderIds.length > 0 ||
    state.submittedOfferId ||
    state.cancelledAt
  )
    return;
  const storedReadiness = state.cartReadinessSnapshot;
  if (!storedReadiness) throw readinessStaleError();
  // Stored provenance is re-evaluated on every pass, never trusted because an
  // earlier request accepted it. A key claimed by someone else after the
  // session started, or one whose authority cannot be read right now, refuses
  // here -- before any cart line is read and before any command is applied, so
  // the session appends no reservation, order, or cart side effect and the
  // refusal names no owner.
  const presentedAnonymousCartId = await acceptedPresentedAnonymousCartId(
    cart,
    String(accountId),
    state.presentedAnonymousCartId,
  );
  if (state.presentedAnonymousCartId && !presentedAnonymousCartId) throw readinessStaleError();

  // The authorized read, not the raw union: it re-decides every alias-derived
  // candidate against its own Cart aggregate on this pass too, so a source the
  // session never presented cannot be revalidated by the claim alias alone.
  const cartLines = await cart.listAuthorizedCartLines(
    presentedAnonymousCartId
      ? { accountId: String(accountId), presentedAnonymousCartId }
      : { accountId: String(accountId) },
  );
  const readiness = validateCartReadinessSnapshot(
    cartLines,
    {
      snapshotId: storedReadiness.snapshotId,
      sourceRevision: storedReadiness.sourceRevision,
      decisions: cartReadinessDecisionsFromSnapshot(storedReadiness),
    },
    presentedAnonymousCartId ? { accountId: String(accountId), presentedAnonymousCartId } : undefined,
  );
  if (!readiness.valid) throw readinessStaleError();
  if (readiness.current.status !== "ready" || readiness.current.unresolvedLineIds.length > 0)
    throw unresolvedFulfillmentError();
  if (!splitGroupHandoffMatches(state.splitGroupHandoff, readiness.current.fulfillmentGroups))
    throw readinessStaleError("split_group_handoff_stale");
}

export function createCheckoutSessionReadServices(
  deps: CheckoutSessionReadDeps,
): Pick<CheckoutSessionServices, "assertReadyForOrderCreation" | "getSession" | "getLastRecordedQuote"> {
  return {
    assertReadyForOrderCreation: async (params) => {
      const state = await deps.loadSessionStateForBuyer(params.sessionId, params.accountId);
      assertSessionNotCancelled(state);
      assertCheckoutHandoffNotExpired(state);
      await assertCurrentCartReadinessForUncommittedSession(state, params.accountId, deps.cart);
      assertOrderableSessionFulfillmentAssigned(state);
      assertBuyerDeliveryAddressServiceable(state.shippingAddress);
      return stateToCheckoutSessionRow(state);
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
          ? await deps.loadSessionStateForBuyerOrNull(sessionId, accountId)
          : null;
      const aggregateSession = aggregateState ? stateToCheckoutSessionRow(aggregateState) : null;
      const session =
        projectedSession && !sessionPageIsBehindCommittedAggregate(projectedSession, aggregateSession)
          ? projectedSession
          : aggregateSession;
      if (!session) return null;
      if (session.source_type !== "cart") return session;
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
    getLastRecordedQuote: async (sessionId, accountId) =>
      (await deps.loadSessionStateForBuyerOrNull(sessionId, accountId))?.lastRecordedQuote ?? null,
  };
}
