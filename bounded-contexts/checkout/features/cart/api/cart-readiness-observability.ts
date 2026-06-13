import type { CheckoutApiEnv } from "../../../api";
import type { CartReadinessSnapshot } from "../domain/readiness";
import {
  recordCheckoutObservabilityTelemetry,
  type CheckoutObservabilityTelemetry,
} from "../../sessions/api/checkout-observability-telemetry";

type CheckoutActor = CheckoutApiEnv["Variables"]["actor"];
type CartReadinessActorMode = "guest" | "signed-in";

function cartReadinessActorMode(actor: CheckoutActor, fallback: CartReadinessActorMode) {
  return actor?.roleKey === "guest-buyer" ? "guest" : fallback;
}

function cartReadinessSnapshotState(snapshot: CartReadinessSnapshot) {
  return snapshot.status;
}

function cartReadinessSupportReferencePresent(snapshot: CartReadinessSnapshot) {
  return (snapshot.fulfillmentGroups ?? []).some((group) => Boolean(group.supportReference.trim()));
}

function cartReadinessUnassignedScenario(snapshot: CartReadinessSnapshot) {
  const hasUnassignedFulfillment = snapshot.lineOutcomes.some(
    (outcome) => outcome.outcome === "checkout" && outcome.reason === "unassigned-fulfillment",
  );
  if (!hasUnassignedFulfillment) {
    return null;
  }

  return snapshot.status === "blocked" ? "blocked" : "unassigned-fulfillment";
}

function cartReadinessOptimizationScenario(snapshot: CartReadinessSnapshot) {
  if (!snapshot.optimization.available) {
    return null;
  }

  if (snapshot.optimization.decision === "accepted") {
    return "optimization-accepted";
  }

  if (snapshot.optimization.decision === "declined") {
    return "optimization-declined";
  }

  return "optimization-available";
}

export function recordCartReadinessObservability(
  checkoutObservabilityTelemetry: CheckoutObservabilityTelemetry | undefined,
  snapshot: CartReadinessSnapshot,
  options: Readonly<{
    actor: CheckoutActor;
    fallbackActorMode: CartReadinessActorMode;
  }>,
) {
  if (!checkoutObservabilityTelemetry) {
    return;
  }

  const actorMode = cartReadinessActorMode(options.actor, options.fallbackActorMode);
  const supportReferencePresent = cartReadinessSupportReferencePresent(snapshot);
  const common = {
    entrySource: "buy-cart-readiness",
    actorMode,
    sideEffectStatus: "not-attempted",
    readinessContract: snapshot.schemaVersion,
    readinessSnapshotState: cartReadinessSnapshotState(snapshot),
    sourceRevisionState: "current",
    freshWriteReceiptPresence: "not-provided",
    supportReferencePresent,
    performanceBudgetId: "buy-cart-readiness-evaluation",
    providerCategory: "fulfillment",
    riskCategory: "none",
    downstreamStatus: "not-started",
    freshStateScanResult: "not-applicable",
  } as const;

  const unassignedScenario = cartReadinessUnassignedScenario(snapshot);
  if (unassignedScenario) {
    recordCheckoutObservabilityTelemetry(checkoutObservabilityTelemetry, {
      ...common,
      state: "buy-readiness-unassigned-fulfillment",
      scenarioState: unassignedScenario,
      visibleState:
        snapshot.status === "blocked" ? "cart-readiness-blocked-visible" : "cart-readiness-recovery-visible",
      capabilityDecision: "blocked",
    });
  }

  const optimizationScenario = cartReadinessOptimizationScenario(snapshot);
  if (optimizationScenario) {
    recordCheckoutObservabilityTelemetry(checkoutObservabilityTelemetry, {
      ...common,
      state: "buy-readiness-optimization",
      scenarioState: optimizationScenario,
      visibleState: "cart-readiness-optimization-visible",
      capabilityDecision: "enabled",
    });
  }
}
