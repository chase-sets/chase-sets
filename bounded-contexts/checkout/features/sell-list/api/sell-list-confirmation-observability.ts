import type { CheckoutApiEnv } from "../../../api";
import {
  recordCheckoutObservabilityTelemetry,
  type CheckoutObservabilityTelemetry,
} from "../../sessions/api/checkout-observability-telemetry";
import type { CheckoutSellListConfirmationRow } from "../read-model/queries";

type CheckoutActor = CheckoutApiEnv["Variables"]["actor"];

function sellConfirmationActorMode(actor: CheckoutActor) {
  return actor?.roleKey === "guest-buyer" ? "guest" : "signed-in";
}

function sellConfirmationDownstreamStatus(confirmation: CheckoutSellListConfirmationRow) {
  const sideEffectStatuses = Object.values(confirmation.handoff_summary.sideEffects ?? {});
  if (sideEffectStatuses.includes("failed")) {
    return "failed";
  }

  if (sideEffectStatuses.includes("handoff-recorded") && sideEffectStatuses.includes("pending-downstream")) {
    return "handoff-recorded-pending-downstream";
  }

  if (sideEffectStatuses.includes("handoff-recorded")) {
    return "handoff-recorded";
  }

  if (sideEffectStatuses.includes("pending-downstream")) {
    return "pending-downstream";
  }

  return "recorded";
}

export function recordSellListConfirmationActivity(
  checkoutObservabilityTelemetry: CheckoutObservabilityTelemetry | undefined,
  actor: CheckoutActor,
  confirmation: CheckoutSellListConfirmationRow,
) {
  if (!checkoutObservabilityTelemetry) {
    return;
  }

  recordCheckoutObservabilityTelemetry(checkoutObservabilityTelemetry, {
    state: "seller-confirmation-activity",
    entrySource: "sell-list-readiness",
    actorMode: sellConfirmationActorMode(actor),
    scenarioState: "pending-downstream",
    visibleState: "seller-confirmation-visible",
    sideEffectStatus: "pending-downstream",
    readinessContract: "checkout.sell-list-readiness.v1",
    readinessSnapshotState: "recorded",
    sourceRevisionState: "recorded",
    freshWriteReceiptPresence: "not-provided",
    supportReferencePresent: true,
    performanceBudgetId: "seller-confirmation-load",
    providerCategory: "marketplace",
    riskCategory: "none",
    downstreamStatus: sellConfirmationDownstreamStatus(confirmation),
    capabilityDecision: "enabled",
    freshStateScanResult: "not-applicable",
  });
}
