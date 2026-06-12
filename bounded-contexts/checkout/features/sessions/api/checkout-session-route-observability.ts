import type { CheckoutApiEnv } from "../../../api";
import type { CheckoutSessionRow } from "../read-model/queries";
import {
  recordCheckoutObservabilityTelemetry,
  type CheckoutObservabilityTelemetry,
} from "./checkout-observability-telemetry";

type CheckoutActor = CheckoutApiEnv["Variables"]["actor"];

function checkoutActorMode(actor: CheckoutActor) {
  return actor?.roleKey === "guest-buyer" ? "guest" : "signed-in";
}

function checkoutEntrySource(session: CheckoutSessionRow) {
  if (session.source_type === "buy-now") {
    return "buy-now";
  }

  if (session.source_type === "cart") {
    return "buy-cart-readiness";
  }

  return "offer-intent";
}

function checkoutReadinessContract(session: CheckoutSessionRow) {
  return session.source_type === "cart" ? "checkout.cart-readiness.v1" : "checkout.session-read-model";
}

function checkoutReadinessSnapshotState(session: CheckoutSessionRow) {
  if (session.source_type !== "cart") {
    return "not-applicable";
  }

  return session.cart_readiness_snapshot ? "fresh" : "missing";
}

export function recordBuyCheckoutReviewRendered(
  checkoutObservabilityTelemetry: CheckoutObservabilityTelemetry | undefined,
  actor: CheckoutActor,
  session: CheckoutSessionRow,
) {
  if (session.source_type === "offer-intent") {
    return;
  }

  const actorMode = checkoutActorMode(actor);
  recordCheckoutObservabilityTelemetry(checkoutObservabilityTelemetry, {
    state: actorMode === "guest" ? "guest-buy-checkout" : "signed-in-buy-checkout",
    entrySource: checkoutEntrySource(session),
    actorMode,
    scenarioState: "normal",
    visibleState: "checkout-review-visible",
    sideEffectStatus: "forbidden-before-confirm",
    readinessContract: checkoutReadinessContract(session),
    readinessSnapshotState: checkoutReadinessSnapshotState(session),
    sourceRevisionState: "current",
    freshWriteReceiptPresence: "not-provided",
    supportReferencePresent: false,
    performanceBudgetId: "checkout-entry-review-render",
    providerCategory: "none",
    riskCategory: "none",
    downstreamStatus: "not-started",
    launchRegisterDecision: "not-required",
    freshStateScanResult: "not-applicable",
  });
}

export function recordActiveSessionStaleRecovery(
  checkoutObservabilityTelemetry: CheckoutObservabilityTelemetry | undefined,
  actor: CheckoutActor,
  code: string,
) {
  if (code !== "readiness_snapshot_stale" && code !== "split_group_handoff_stale") {
    return;
  }

  recordCheckoutObservabilityTelemetry(checkoutObservabilityTelemetry, {
    state: "active-session-stale-recovery",
    entrySource: "active-session",
    actorMode: checkoutActorMode(actor),
    scenarioState: "active-session-stale",
    visibleState: "checkout-permanent-recovery-visible",
    sideEffectStatus: "not-attempted",
    readinessContract: "checkout.session-read-model",
    readinessSnapshotState: "stale",
    sourceRevisionState: "stale",
    freshWriteReceiptPresence: "not-provided",
    supportReferencePresent: false,
    performanceBudgetId: "active-session-reload",
    providerCategory: "none",
    riskCategory: "none",
    downstreamStatus: "not-started",
    launchRegisterDecision: "blocked",
    freshStateScanResult: "not-applicable",
  });
}

export function recordAddressServiceabilityFailure(
  checkoutObservabilityTelemetry: CheckoutObservabilityTelemetry | undefined,
  actor: CheckoutActor,
  code: string,
) {
  if (
    code !== "shipping_address_required" &&
    code !== "shipping_address_unsupported" &&
    code !== "shipping_address_restricted"
  ) {
    return;
  }

  recordCheckoutObservabilityTelemetry(checkoutObservabilityTelemetry, {
    state: "address-serviceability-failure",
    entrySource: "active-session",
    actorMode: checkoutActorMode(actor),
    scenarioState: "blocked",
    visibleState: "checkout-permanent-recovery-visible",
    sideEffectStatus: "not-attempted",
    readinessContract: "checkout.session-read-model",
    readinessSnapshotState: "fresh",
    sourceRevisionState: "current",
    freshWriteReceiptPresence: "not-provided",
    supportReferencePresent: false,
    performanceBudgetId: "totals-refresh",
    providerCategory: "fulfillment",
    riskCategory: "none",
    downstreamStatus: "not-started",
    launchRegisterDecision: "blocked",
    freshStateScanResult: "not-applicable",
  });
}

export function recordUnsupportedCustomerEconomicsInput(
  checkoutObservabilityTelemetry: CheckoutObservabilityTelemetry | undefined,
  actor: CheckoutActor,
  code: string,
) {
  if (code !== "checkout_economics_unsupported") {
    return;
  }

  recordCheckoutObservabilityTelemetry(checkoutObservabilityTelemetry, {
    state: "promo-credit-gift-card-state",
    entrySource: "active-session",
    actorMode: checkoutActorMode(actor),
    scenarioState: "deferred-capability",
    visibleState: "checkout-review-visible",
    sideEffectStatus: "not-attempted",
    readinessContract: "checkout.session-read-model",
    readinessSnapshotState: "not-applicable",
    sourceRevisionState: "current",
    freshWriteReceiptPresence: "not-provided",
    supportReferencePresent: false,
    performanceBudgetId: "totals-refresh",
    providerCategory: "payments",
    riskCategory: "none",
    downstreamStatus: "not-started",
    launchRegisterDecision: "deferred",
    freshStateScanResult: "not-applicable",
    promotionDecision: "deferred",
  });
}

export function recordChangedEconomicsReview(
  checkoutObservabilityTelemetry: CheckoutObservabilityTelemetry | undefined,
  actor: CheckoutActor,
  session: CheckoutSessionRow,
  sourceRevisionState: string,
) {
  if (session.source_type === "offer-intent") {
    return;
  }

  recordCheckoutObservabilityTelemetry(checkoutObservabilityTelemetry, {
    state: "changed-economics-review",
    entrySource: checkoutEntrySource(session),
    actorMode: checkoutActorMode(actor),
    scenarioState: "blocked",
    visibleState: "checkout-review-visible",
    sideEffectStatus: "not-attempted",
    readinessContract: checkoutReadinessContract(session),
    readinessSnapshotState: checkoutReadinessSnapshotState(session),
    sourceRevisionState,
    freshWriteReceiptPresence: "not-provided",
    supportReferencePresent: false,
    performanceBudgetId: "totals-refresh",
    providerCategory: "none",
    riskCategory: "none",
    downstreamStatus: "not-started",
    launchRegisterDecision: "blocked",
    freshStateScanResult: "not-applicable",
  });
}

export function recordConfirmationPendingHandoff(
  checkoutObservabilityTelemetry: CheckoutObservabilityTelemetry | undefined,
  actor: CheckoutActor,
  session: CheckoutSessionRow,
  downstreamStatus: string,
) {
  if (session.source_type === "offer-intent") {
    return;
  }

  recordCheckoutObservabilityTelemetry(checkoutObservabilityTelemetry, {
    state: "reconciliation-pending",
    entrySource: checkoutEntrySource(session),
    actorMode: checkoutActorMode(actor),
    scenarioState: "pending-downstream",
    visibleState: "support-safe-status-visible",
    sideEffectStatus: "pending-downstream",
    readinessContract: "downstream-owned-fact",
    readinessSnapshotState: checkoutReadinessSnapshotState(session),
    sourceRevisionState: "current",
    freshWriteReceiptPresence: "not-provided",
    supportReferencePresent: true,
    performanceBudgetId: "support-lookup",
    providerCategory: "payments",
    riskCategory: "none",
    downstreamStatus,
    launchRegisterDecision: "enabled",
    freshStateScanResult: "not-applicable",
  });
}
