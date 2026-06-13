import {
  checkoutObservabilityProfiles,
  type CheckoutObservabilityAlertClass,
  type CheckoutObservabilityState,
  type CheckoutObservabilityTelemetryClass,
  type CheckoutScenarioState,
} from "./checkout-observability-contract";

export type CheckoutObservabilityTelemetryEvent = Readonly<{
  eventName: `checkout.${string}`;
  telemetryClass: CheckoutObservabilityTelemetryClass;
  alertClass: CheckoutObservabilityAlertClass;
  entrySource: string;
  actorMode: string;
  scenarioState: CheckoutScenarioState;
  visibleState: string;
  sideEffectStatus: string;
  operatorSignalRequired: boolean;
  readinessContract?: string | null;
  readinessSnapshotState?: string | null;
  sourceRevisionState?: string | null;
  freshWriteReceiptPresence?: string | null;
  supportReferencePresent?: boolean;
  performanceBudgetId?: string | null;
  providerCategory?: string | null;
  riskCategory?: string | null;
  downstreamStatus?: string | null;
  capabilityDecision?: string | null;
  freshStateScanResult?: string | null;
}>;

export type CheckoutObservabilityTelemetry = Readonly<{
  recordCheckoutEvent: (event: CheckoutObservabilityTelemetryEvent) => void;
}>;

export type CheckoutObservabilityTelemetryInput = Omit<
  CheckoutObservabilityTelemetryEvent,
  "eventName" | "telemetryClass" | "alertClass" | "operatorSignalRequired"
> &
  Readonly<{
    state: CheckoutObservabilityState;
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

  const allowedScenarioStates: readonly CheckoutScenarioState[] = profile.scenarioStates;
  if (!allowedScenarioStates.includes(input.scenarioState)) {
    throw new Error(`Checkout observability profile '${input.state}' does not allow '${input.scenarioState}'.`);
  }

  return {
    eventName: profile.eventName,
    telemetryClass: profile.telemetryClass,
    alertClass: profile.alertClass,
    operatorSignalRequired: profile.operatorSignalRequired,
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
    capabilityDecision: input.capabilityDecision ?? null,
    freshStateScanResult: input.freshStateScanResult ?? null,
  };
}

export function recordCheckoutObservabilityTelemetry(
  telemetry: CheckoutObservabilityTelemetry | undefined,
  input: CheckoutObservabilityTelemetryInput,
): void {
  telemetry?.recordCheckoutEvent(checkoutObservabilityTelemetryEvent(input));
}
