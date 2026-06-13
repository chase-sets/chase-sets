import {
  checkoutObservabilityProfiles,
  type CheckoutObservabilityAlertClass,
  type CheckoutObservabilityTelemetryClass,
} from "./checkout-observability-contract";
import type { CheckoutLaunchScenarioState } from "./checkout-launch-evidence-matrix";
import type { CheckoutVisualTargetKey } from "./checkout-visual-targets";

export type CheckoutObservabilityTelemetryEvent = Readonly<{
  eventName: `checkout.${string}`;
  telemetryClass: CheckoutObservabilityTelemetryClass;
  alertClass: CheckoutObservabilityAlertClass;
  entrySource: string;
  actorMode: string;
  scenarioState: CheckoutLaunchScenarioState;
  visibleState: string;
  sideEffectStatus: string;
  releaseHealthRequired: boolean;
  readinessContract?: string | null;
  readinessSnapshotState?: string | null;
  sourceRevisionState?: string | null;
  freshWriteReceiptPresence?: string | null;
  supportReferencePresent?: boolean;
  performanceBudgetId?: string | null;
  providerCategory?: string | null;
  riskCategory?: string | null;
  downstreamStatus?: string | null;
  launchDecision?: string | null;
  freshStateScanResult?: string | null;
  canaryFinalState?: string | null;
  promotionDecision?: string | null;
  releaseRunId?: string | null;
}>;

export type CheckoutObservabilityTelemetry = Readonly<{
  recordCheckoutEvent: (event: CheckoutObservabilityTelemetryEvent) => void;
}>;

export type CheckoutObservabilityTelemetryInput = Omit<
  CheckoutObservabilityTelemetryEvent,
  "eventName" | "telemetryClass" | "alertClass" | "releaseHealthRequired"
> &
  Readonly<{
    state: CheckoutVisualTargetKey;
  }>;

const checkoutObservabilityProfileByState = new Map(
  checkoutObservabilityProfiles.map((profile) => [profile.state, profile]),
);

export function checkoutObservabilityTelemetryEvent(
  input: CheckoutObservabilityTelemetryInput,
): CheckoutObservabilityTelemetryEvent {
  const profile = checkoutObservabilityProfileByState.get(input.state);
  if (!profile) {
    throw new Error(`Missing checkout observability profile for state '${input.state}'.`);
  }

  const allowedScenarioStates: readonly CheckoutLaunchScenarioState[] = profile.scenarioStates;
  if (!allowedScenarioStates.includes(input.scenarioState)) {
    throw new Error(`Checkout observability profile '${input.state}' does not allow '${input.scenarioState}'.`);
  }

  return {
    eventName: profile.eventName,
    telemetryClass: profile.telemetryClass,
    alertClass: profile.alertClass,
    releaseHealthRequired: profile.releaseHealthRequired,
    entrySource: input.entrySource,
    actorMode: input.actorMode,
    scenarioState: input.scenarioState,
    visibleState: input.visibleState,
    sideEffectStatus: input.sideEffectStatus,
    readinessContract: input.readinessContract ?? null,
    readinessSnapshotState: input.readinessSnapshotState ?? null,
    sourceRevisionState: input.sourceRevisionState ?? null,
    freshWriteReceiptPresence: input.freshWriteReceiptPresence ?? null,
    supportReferencePresent: input.supportReferencePresent === true,
    performanceBudgetId: input.performanceBudgetId ?? null,
    providerCategory: input.providerCategory ?? null,
    riskCategory: input.riskCategory ?? null,
    downstreamStatus: input.downstreamStatus ?? null,
    launchDecision: input.launchDecision ?? null,
    freshStateScanResult: input.freshStateScanResult ?? null,
    canaryFinalState: input.canaryFinalState ?? null,
    promotionDecision: input.promotionDecision ?? null,
    releaseRunId: input.releaseRunId ?? null,
  };
}

export function recordCheckoutObservabilityTelemetry(
  telemetry: CheckoutObservabilityTelemetry | undefined,
  input: CheckoutObservabilityTelemetryInput,
): void {
  telemetry?.recordCheckoutEvent(checkoutObservabilityTelemetryEvent(input));
}
