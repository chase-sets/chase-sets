import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  authenticityVerdictReasonCodes,
  authenticityVerdicts,
  normalizeLabel,
  normalizeOptionalText,
  type AuthenticityCaseId,
  type AuthenticityCaseStatus,
  type AuthenticityChecklistResult,
  type AuthenticityOrderLineNote,
  type AuthenticityOrderSnapshotRef,
  type AuthenticityPlanRef,
  type AuthenticityVerdict,
  type AuthenticityVerdictReasonCode,
} from "../../../support/runtime-support/common";

export type AuthenticityCaseState = Readonly<{
  id: AuthenticityCaseId | null;
  orderId: string | null;
  sellerAccountId: AccountId | null;
  buyerAccountId: AccountId | null;
  orderSnapshot: AuthenticityOrderSnapshotRef | null;
  authenticityPlan: AuthenticityPlanRef | null;
  status: AuthenticityCaseStatus;
  inboundTrackingIdentifier: string | null;
  verdict: AuthenticityVerdict | null;
  verdictReasonCodes: readonly AuthenticityVerdictReasonCode[];
  checklistResults: readonly AuthenticityChecklistResult[];
  evidencePhotoRefs: readonly string[];
  lineNotes: readonly AuthenticityOrderLineNote[];
  inspectorAccountId: string | null;
  outboundTrackingIdentifier: string | null;
  returnReason: string | null;
  openedAt: string | null;
  receivedAt: string | null;
  inspectionStartedAt: string | null;
  verdictRecordedAt: string | null;
  forwardedAt: string | null;
  returnedAt: string | null;
}>;

export const initialAuthenticityCaseState: AuthenticityCaseState = {
  id: null,
  orderId: null,
  sellerAccountId: null,
  buyerAccountId: null,
  orderSnapshot: null,
  authenticityPlan: null,
  status: "awaiting-inbound",
  inboundTrackingIdentifier: null,
  verdict: null,
  verdictReasonCodes: [],
  checklistResults: [],
  evidencePhotoRefs: [],
  lineNotes: [],
  inspectorAccountId: null,
  outboundTrackingIdentifier: null,
  returnReason: null,
  openedAt: null,
  receivedAt: null,
  inspectionStartedAt: null,
  verdictRecordedAt: null,
  forwardedAt: null,
  returnedAt: null,
};

export type OpenAuthenticityCaseCommand = Readonly<{
  type: "OpenAuthenticityCase";
  caseId: AuthenticityCaseId;
  orderId: string;
  sellerAccountId: AccountId;
  buyerAccountId: AccountId;
  orderSnapshot: AuthenticityOrderSnapshotRef;
  authenticityPlan: AuthenticityPlanRef;
  openedAt: string;
}>;

export type RecordAuthenticityInboundTrackingCommand = Readonly<{
  type: "RecordAuthenticityInboundTracking";
  inboundTrackingIdentifier: string;
  recordedAt: string;
}>;

export type ReceiveAuthenticityCaseCommand = Readonly<{
  type: "ReceiveAuthenticityCase";
  receivedAt: string;
}>;

export type BeginAuthenticityInspectionCommand = Readonly<{
  type: "BeginAuthenticityInspection";
  inspectorAccountId: string;
  startedAt: string;
}>;

export type RecordAuthenticityVerdictCommand = Readonly<{
  type: "RecordAuthenticityVerdict";
  verdict: AuthenticityVerdict;
  reasonCodes: readonly AuthenticityVerdictReasonCode[];
  checklistResults: readonly AuthenticityChecklistResult[];
  evidencePhotoRefs: readonly string[];
  lineNotes?: readonly AuthenticityOrderLineNote[];
  inspectorAccountId: string;
  decidedAt: string;
}>;

export type ForwardAuthenticityCaseCommand = Readonly<{
  type: "ForwardAuthenticityCase";
  forwardedAt: string;
  outboundTrackingIdentifier?: string | null;
}>;

export type ReturnAuthenticityCaseCommand = Readonly<{
  type: "ReturnAuthenticityCase";
  returnedAt: string;
  returnReason?: string | null;
}>;

export type AuthenticityCaseCommand =
  | OpenAuthenticityCaseCommand
  | RecordAuthenticityInboundTrackingCommand
  | ReceiveAuthenticityCaseCommand
  | BeginAuthenticityInspectionCommand
  | RecordAuthenticityVerdictCommand
  | ForwardAuthenticityCaseCommand
  | ReturnAuthenticityCaseCommand;

export type AuthenticityCaseOpenedEvent = DomainEvent<
  "authenticity.case.opened",
  Readonly<{
    caseId: AuthenticityCaseId;
    orderId: string;
    sellerAccountId: AccountId;
    buyerAccountId: AccountId;
    orderSnapshot: AuthenticityOrderSnapshotRef;
    authenticityPlan: AuthenticityPlanRef;
    openedAt: string;
  }>
>;

export type AuthenticityInboundTrackingRecordedEvent = DomainEvent<
  "authenticity.case.inbound-tracking-recorded",
  Readonly<{
    caseId: AuthenticityCaseId;
    inboundTrackingIdentifier: string;
    recordedAt: string;
  }>
>;

export type AuthenticityCaseReceivedEvent = DomainEvent<
  "authenticity.case.received",
  Readonly<{
    caseId: AuthenticityCaseId;
    receivedAt: string;
  }>
>;

export type AuthenticityInspectionStartedEvent = DomainEvent<
  "authenticity.case.inspection-started",
  Readonly<{
    caseId: AuthenticityCaseId;
    inspectorAccountId: string;
    startedAt: string;
  }>
>;

export type AuthenticityVerdictRecordedEvent = DomainEvent<
  "authenticity.case.verdict-recorded",
  Readonly<{
    caseId: AuthenticityCaseId;
    verdict: AuthenticityVerdict;
    reasonCodes: readonly AuthenticityVerdictReasonCode[];
    checklistResults: readonly AuthenticityChecklistResult[];
    evidencePhotoRefs: readonly string[];
    lineNotes: readonly AuthenticityOrderLineNote[];
    inspectorAccountId: string;
    decidedAt: string;
  }>
>;

export type AuthenticityCaseForwardedEvent = DomainEvent<
  "authenticity.case.forwarded",
  Readonly<{
    caseId: AuthenticityCaseId;
    forwardedAt: string;
    outboundTrackingIdentifier: string | null;
  }>
>;

export type AuthenticityCaseReturnedEvent = DomainEvent<
  "authenticity.case.returned",
  Readonly<{
    caseId: AuthenticityCaseId;
    returnedAt: string;
    returnReason: string | null;
  }>
>;

export type AuthenticityCaseEvent =
  | AuthenticityCaseOpenedEvent
  | AuthenticityInboundTrackingRecordedEvent
  | AuthenticityCaseReceivedEvent
  | AuthenticityInspectionStartedEvent
  | AuthenticityVerdictRecordedEvent
  | AuthenticityCaseForwardedEvent
  | AuthenticityCaseReturnedEvent;

export const decideAuthenticityCase: AggregateDecider<
  AuthenticityCaseState,
  AuthenticityCaseCommand,
  AuthenticityCaseEvent
> = (state, command) => {
  switch (command.type) {
    case "OpenAuthenticityCase":
      assert(state.id === null, "Authenticity case has already been opened.");
      assert(normalizeLabel(command.orderId).length > 0, "Authenticity cases require an order id.");
      return [
        {
          type: "authenticity.case.opened",
          data: {
            caseId: command.caseId,
            orderId: normalizeLabel(command.orderId),
            sellerAccountId: command.sellerAccountId,
            buyerAccountId: command.buyerAccountId,
            orderSnapshot: command.orderSnapshot,
            authenticityPlan: command.authenticityPlan,
            openedAt: command.openedAt,
          },
        },
      ];
    case "RecordAuthenticityInboundTracking":
      requireOpenedCase(state);
      assert(
        state.status === "awaiting-inbound",
        "Inbound tracking can only be recorded before the case is received at the facility.",
      );
      assert(
        normalizeLabel(command.inboundTrackingIdentifier).length > 0,
        "Inbound tracking identifier must not be blank.",
      );
      return [
        {
          type: "authenticity.case.inbound-tracking-recorded",
          data: {
            caseId: state.id!,
            inboundTrackingIdentifier: normalizeLabel(command.inboundTrackingIdentifier),
            recordedAt: command.recordedAt,
          },
        },
      ];
    case "ReceiveAuthenticityCase":
      requireOpenedCase(state);
      assert(state.status === "awaiting-inbound", "Only a case awaiting inbound delivery can be received.");
      return [
        {
          type: "authenticity.case.received",
          data: {
            caseId: state.id!,
            receivedAt: command.receivedAt,
          },
        },
      ];
    case "BeginAuthenticityInspection":
      requireOpenedCase(state);
      assert(state.status === "received", "Inspection can only begin once the case has been received.");
      assert(
        normalizeLabel(command.inspectorAccountId).length > 0,
        "Beginning an inspection requires an inspector actor.",
      );
      return [
        {
          type: "authenticity.case.inspection-started",
          data: {
            caseId: state.id!,
            inspectorAccountId: normalizeLabel(command.inspectorAccountId),
            startedAt: command.startedAt,
          },
        },
      ];
    case "RecordAuthenticityVerdict":
      requireOpenedCase(state);
      assert(state.status === "inspecting", "A verdict can only be recorded while the case is being inspected.");
      validateVerdict(command.verdict);
      validateReasonCodes(command.verdict, command.reasonCodes);
      validateEvidencePhotoRefs(command.evidencePhotoRefs);
      assert(normalizeLabel(command.inspectorAccountId).length > 0, "Recording a verdict requires an inspector actor.");
      return [
        {
          type: "authenticity.case.verdict-recorded",
          data: {
            caseId: state.id!,
            verdict: command.verdict,
            reasonCodes: command.reasonCodes,
            checklistResults: command.checklistResults,
            evidencePhotoRefs: command.evidencePhotoRefs,
            lineNotes: command.lineNotes ?? [],
            inspectorAccountId: normalizeLabel(command.inspectorAccountId),
            decidedAt: command.decidedAt,
          },
        },
      ];
    case "ForwardAuthenticityCase":
      requireOpenedCase(state);
      assert(state.status === "passed", "Only a case with a passed verdict can be forwarded to the buyer.");
      return [
        {
          type: "authenticity.case.forwarded",
          data: {
            caseId: state.id!,
            forwardedAt: command.forwardedAt,
            outboundTrackingIdentifier: normalizeOptionalText(command.outboundTrackingIdentifier),
          },
        },
      ];
    case "ReturnAuthenticityCase":
      requireOpenedCase(state);
      assert(
        state.status === "failed" || state.status === "inconclusive",
        "Only a failed or inconclusive case can be returned to the seller.",
      );
      return [
        {
          type: "authenticity.case.returned",
          data: {
            caseId: state.id!,
            returnedAt: command.returnedAt,
            returnReason: normalizeOptionalText(command.returnReason) ?? defaultReturnReason(state),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveAuthenticityCase: AggregateEvolver<AuthenticityCaseState, AuthenticityCaseEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "authenticity.case.opened":
      return {
        ...state,
        id: event.data.caseId,
        orderId: event.data.orderId,
        sellerAccountId: event.data.sellerAccountId,
        buyerAccountId: event.data.buyerAccountId,
        orderSnapshot: event.data.orderSnapshot,
        authenticityPlan: event.data.authenticityPlan,
        status: "awaiting-inbound",
        openedAt: event.data.openedAt,
      };
    case "authenticity.case.inbound-tracking-recorded":
      return {
        ...state,
        inboundTrackingIdentifier: event.data.inboundTrackingIdentifier,
      };
    case "authenticity.case.received":
      return {
        ...state,
        status: "received",
        receivedAt: event.data.receivedAt,
      };
    case "authenticity.case.inspection-started":
      return {
        ...state,
        status: "inspecting",
        inspectorAccountId: event.data.inspectorAccountId,
        inspectionStartedAt: event.data.startedAt,
      };
    case "authenticity.case.verdict-recorded":
      return {
        ...state,
        status: event.data.verdict,
        verdict: event.data.verdict,
        verdictReasonCodes: event.data.reasonCodes,
        checklistResults: event.data.checklistResults,
        evidencePhotoRefs: event.data.evidencePhotoRefs,
        lineNotes: event.data.lineNotes,
        inspectorAccountId: event.data.inspectorAccountId,
        verdictRecordedAt: event.data.decidedAt,
      };
    case "authenticity.case.forwarded":
      return {
        ...state,
        status: "forwarded",
        forwardedAt: event.data.forwardedAt,
        outboundTrackingIdentifier: event.data.outboundTrackingIdentifier,
      };
    case "authenticity.case.returned":
      return {
        ...state,
        status: "returned",
        returnedAt: event.data.returnedAt,
        returnReason: event.data.returnReason,
      };
    default:
      return assertNever(event);
  }
};

function requireOpenedCase(state: AuthenticityCaseState) {
  assert(state.id !== null, "Authenticity case must be opened first.");
}

function validateVerdict(verdict: AuthenticityVerdict) {
  assert(
    (authenticityVerdicts as readonly string[]).includes(verdict),
    `Unsupported authenticity verdict: ${String(verdict)}.`,
  );
}

function validateReasonCodes(verdict: AuthenticityVerdict, reasonCodes: readonly AuthenticityVerdictReasonCode[]) {
  for (const reasonCode of reasonCodes) {
    assert(
      (authenticityVerdictReasonCodes as readonly string[]).includes(reasonCode),
      `Unsupported authenticity verdict reason code: ${String(reasonCode)}.`,
    );
  }

  if (verdict === "passed") {
    assert(reasonCodes.length === 0, "A passed verdict must not carry reason codes.");
    return;
  }

  assert(reasonCodes.length > 0, "A failed or inconclusive verdict requires at least one reason code.");
}

function validateEvidencePhotoRefs(evidencePhotoRefs: readonly string[]) {
  assert(evidencePhotoRefs.length > 0, "A verdict requires at least one evidence photo reference.");
  for (const ref of evidencePhotoRefs) {
    assert(normalizeLabel(ref).length > 0, "Evidence photo references must not be blank.");
  }
}

function defaultReturnReason(state: AuthenticityCaseState): string | null {
  if (state.verdict === "failed") {
    return "authenticity-check-failed";
  }
  if (state.verdict === "inconclusive") {
    return "authenticity-check-inconclusive";
  }
  return null;
}
