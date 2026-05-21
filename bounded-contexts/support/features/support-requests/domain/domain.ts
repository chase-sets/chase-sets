import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, OrderId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  normalizeAttachments,
  normalizeEvidenceType,
  normalizeFlowType,
  normalizeIsoTimestamp,
  normalizeMoneyAmount,
  normalizeOptionalText,
  normalizePriority,
  normalizeRequesterRole,
  normalizeRequiredText,
  normalizeResolutionType,
  normalizeResponseType,
  type SupportChecklistItem,
  type SupportEvidence,
  type SupportEvidenceType,
  type SupportFlowType,
  type SupportPriority,
  type SupportRequesterRole,
  type SupportRequestStatus,
  type SupportResolution,
  type SupportResolutionType,
  type SupportResponse,
  type SupportResponseType,
} from "./common";
import { createChecklist, getSupportFlowDefinition, includesEvidenceType } from "./flow-catalog";

export type SupportRequestState = Readonly<{
  supportRequestId: SupportRequestId | null;
  orderId: OrderId | null;
  buyerAccountId: AccountId | null;
  sellerAccountId: AccountId | null;
  flowType: SupportFlowType | null;
  status: SupportRequestStatus | null;
  priority: SupportPriority | null;
  openedByAccountId: AccountId | null;
  openedByRole: SupportRequesterRole | null;
  openedAt: string | null;
  updatedAt: string | null;
  sellerResponseDueAt: string | null;
  supportReviewDueAt: string | null;
  checklist: readonly SupportChecklistItem[];
  evidence: readonly SupportEvidence[];
  responses: readonly SupportResponse[];
  resolution: SupportResolution | null;
  closedAt: string | null;
  cancellationReason: string | null;
}>;

export const initialSupportRequestState: SupportRequestState = {
  supportRequestId: null,
  orderId: null,
  buyerAccountId: null,
  sellerAccountId: null,
  flowType: null,
  status: null,
  priority: null,
  openedByAccountId: null,
  openedByRole: null,
  openedAt: null,
  updatedAt: null,
  sellerResponseDueAt: null,
  supportReviewDueAt: null,
  checklist: [],
  evidence: [],
  responses: [],
  resolution: null,
  closedAt: null,
  cancellationReason: null,
};

export type OpenSupportRequestCommand = Readonly<{
  type: "OpenSupportRequest";
  supportRequestId: SupportRequestId;
  orderId: OrderId;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  flowType: SupportFlowType;
  openedByAccountId: AccountId;
  openedByRole: SupportRequesterRole;
  openedAt: string;
}>;

export type SubmitSupportEvidenceCommand = Readonly<{
  type: "SubmitSupportEvidence";
  evidenceId: string;
  submittedByAccountId?: AccountId | null;
  submittedByRole: SupportRequesterRole;
  evidenceType: SupportEvidenceType;
  summary: string;
  occurredAt?: string | null;
  submittedAt: string;
  attachments?: readonly string[];
}>;

export type RecordSupportResponseCommand = Readonly<{
  type: "RecordSupportResponse";
  responseId: string;
  responseType: SupportResponseType;
  submittedByAccountId?: AccountId | null;
  submittedByRole: SupportRequesterRole;
  summary: string;
  submittedAt: string;
}>;

export type EscalateSupportRequestCommand = Readonly<{
  type: "EscalateSupportRequest";
  escalatedAt: string;
  reason: string;
}>;

export type ResolveSupportRequestCommand = Readonly<{
  type: "ResolveSupportRequest";
  resolutionType: SupportResolutionType;
  summary: string;
  refundAmount?: string | null;
  resolvedByAccountId?: AccountId | null;
  resolvedAt: string;
}>;

export type CloseSupportRequestCommand = Readonly<{
  type: "CloseSupportRequest";
  closedAt: string;
}>;

export type CancelSupportRequestCommand = Readonly<{
  type: "CancelSupportRequest";
  cancelledAt: string;
  reason: string;
}>;

export type SupportRequestCommand =
  | OpenSupportRequestCommand
  | SubmitSupportEvidenceCommand
  | RecordSupportResponseCommand
  | EscalateSupportRequestCommand
  | ResolveSupportRequestCommand
  | CloseSupportRequestCommand
  | CancelSupportRequestCommand;

export type SupportRequestOpenedEvent = DomainEvent<
  "support.support-request.opened",
  Readonly<{
    supportRequestId: SupportRequestId;
    orderId: OrderId;
    buyerAccountId: AccountId;
    sellerAccountId: AccountId;
    flowType: SupportFlowType;
    status: SupportRequestStatus;
    priority: SupportPriority;
    openedByAccountId: AccountId;
    openedByRole: SupportRequesterRole;
    openedAt: string;
    sellerResponseDueAt: string | null;
    supportReviewDueAt: string | null;
    checklist: readonly SupportChecklistItem[];
  }>
>;

export type SupportEvidenceSubmittedEvent = DomainEvent<
  "support.support-request.evidence-submitted",
  Readonly<{
    supportRequestId: SupportRequestId;
    evidence: SupportEvidence;
    status: SupportRequestStatus;
    updatedChecklist: readonly SupportChecklistItem[];
  }>
>;

export type SupportResponseRecordedEvent = DomainEvent<
  "support.support-request.response-recorded",
  Readonly<{
    supportRequestId: SupportRequestId;
    response: SupportResponse;
    status: SupportRequestStatus;
  }>
>;

export type SupportRequestEscalatedEvent = DomainEvent<
  "support.support-request.escalated",
  Readonly<{
    supportRequestId: SupportRequestId;
    escalatedAt: string;
    reason: string;
  }>
>;

export type SupportRequestResolvedEvent = DomainEvent<
  "support.support-request.resolved",
  Readonly<{
    supportRequestId: SupportRequestId;
    orderId: OrderId;
    buyerAccountId: AccountId;
    sellerAccountId: AccountId;
    flowType: SupportFlowType;
    resolution: SupportResolution;
  }>
>;

export type SupportRequestClosedEvent = DomainEvent<
  "support.support-request.closed",
  Readonly<{
    supportRequestId: SupportRequestId;
    orderId: OrderId;
    closedAt: string;
  }>
>;

export type SupportRequestCancelledEvent = DomainEvent<
  "support.support-request.cancelled",
  Readonly<{
    supportRequestId: SupportRequestId;
    orderId: OrderId;
    cancelledAt: string;
    reason: string;
  }>
>;

export type SupportRequestEvent =
  | SupportRequestOpenedEvent
  | SupportEvidenceSubmittedEvent
  | SupportResponseRecordedEvent
  | SupportRequestEscalatedEvent
  | SupportRequestResolvedEvent
  | SupportRequestClosedEvent
  | SupportRequestCancelledEvent;

function addHours(timestamp: string, hours: number | null) {
  if (hours === null) {
    return null;
  }

  const date = new Date(timestamp);
  date.setHours(date.getHours() + hours);
  return date.toISOString();
}

function inferStatusAfterEvidence(state: SupportRequestState, updatedChecklist: readonly SupportChecklistItem[]) {
  if (state.status === "resolved" || state.status === "closed" || state.status === "cancelled") {
    return state.status;
  }

  if (state.status === "waiting-on-buyer") {
    const buyerRequiredOpen = updatedChecklist.some(
      (item) => item.ownerRole === "buyer" && item.required && item.satisfiedAt === null,
    );
    if (!buyerRequiredOpen) {
      return state.sellerResponseDueAt ? "waiting-on-seller" : "ready-for-support";
    }
  }

  return state.status ?? "open";
}

function satisfyChecklist(
  checklist: readonly SupportChecklistItem[],
  evidenceType: SupportEvidenceType,
  submittedAt: string,
) {
  return checklist.map((item) =>
    item.satisfiedAt === null && item.evidenceTypes.includes(evidenceType)
      ? { ...item, satisfiedAt: submittedAt }
      : item,
  );
}

function normalizeEvidence(command: SubmitSupportEvidenceCommand): SupportEvidence {
  return {
    evidenceId: normalizeRequiredText(command.evidenceId, "Support evidence must include an id."),
    submittedByAccountId: command.submittedByAccountId ?? null,
    submittedByRole: normalizeRequesterRole(command.submittedByRole),
    evidenceType: normalizeEvidenceType(command.evidenceType),
    summary: normalizeRequiredText(command.summary, "Support evidence must include a summary."),
    occurredAt: command.occurredAt
      ? normalizeIsoTimestamp(command.occurredAt, "Support evidence occurrence time must be valid.")
      : null,
    submittedAt: normalizeIsoTimestamp(command.submittedAt, "Support evidence submission must record a timestamp."),
    attachments: normalizeAttachments(command.attachments),
  };
}

function normalizeResponse(command: RecordSupportResponseCommand): SupportResponse {
  return {
    responseId: normalizeRequiredText(command.responseId, "Support response must include an id."),
    responseType: normalizeResponseType(command.responseType),
    submittedByAccountId: command.submittedByAccountId ?? null,
    submittedByRole: normalizeRequesterRole(command.submittedByRole),
    summary: normalizeRequiredText(command.summary, "Support response must include a summary."),
    submittedAt: normalizeIsoTimestamp(command.submittedAt, "Support response must record a timestamp."),
  };
}

export const decideSupportRequest: AggregateDecider<SupportRequestState, SupportRequestCommand, SupportRequestEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "OpenSupportRequest": {
      assert(state.supportRequestId === null, "Support request is already open.");
      const flowType = normalizeFlowType(command.flowType);
      const definition = getSupportFlowDefinition(flowType);
      const openedByRole = normalizeRequesterRole(command.openedByRole);
      assert(definition.openedBy.includes(openedByRole), "This support flow cannot be opened by that role.");

      const openedAt = normalizeIsoTimestamp(command.openedAt, "Support request opening must record a timestamp.");
      const checklist = createChecklist(flowType);
      return [
        {
          type: "support.support-request.opened",
          data: {
            supportRequestId: command.supportRequestId,
            orderId: command.orderId,
            buyerAccountId: command.buyerAccountId,
            sellerAccountId: command.sellerAccountId,
            flowType,
            status: definition.initialStatus,
            priority: normalizePriority(definition.priority),
            openedByAccountId: command.openedByAccountId,
            openedByRole,
            openedAt,
            sellerResponseDueAt: addHours(openedAt, definition.sellerResponseHours),
            supportReviewDueAt: addHours(openedAt, definition.supportReviewHours),
            checklist,
          },
        },
      ];
    }
    case "SubmitSupportEvidence": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(
        state.status !== "resolved" && state.status !== "closed" && state.status !== "cancelled",
        "Closed support requests cannot accept evidence.",
      );
      assert(state.flowType !== null, "Support request flow is missing.");
      const evidence = normalizeEvidence(command);
      const definition = getSupportFlowDefinition(state.flowType);
      assert(
        includesEvidenceType(definition.allowedEvidenceTypes, evidence.evidenceType),
        "This evidence type is not accepted for the support flow.",
      );

      const updatedChecklist = satisfyChecklist(state.checklist, evidence.evidenceType, evidence.submittedAt);
      const status = inferStatusAfterEvidence(state, updatedChecklist);

      return [
        {
          type: "support.support-request.evidence-submitted",
          data: {
            supportRequestId: state.supportRequestId,
            evidence,
            status,
            updatedChecklist,
          },
        },
      ];
    }
    case "RecordSupportResponse": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(
        state.status !== "resolved" && state.status !== "closed" && state.status !== "cancelled",
        "Closed support requests cannot accept responses.",
      );
      assert(state.flowType !== null, "Support request flow is missing.");
      const response = normalizeResponse(command);
      const definition = getSupportFlowDefinition(state.flowType);
      assert(
        definition.allowedResponses.includes(response.responseType),
        "This response is not accepted for the support flow.",
      );
      assert(
        response.submittedByRole === "seller" || response.submittedByRole === "support",
        "Support responses must come from the seller or support.",
      );

      return [
        {
          type: "support.support-request.response-recorded",
          data: {
            supportRequestId: state.supportRequestId,
            response,
            status: response.responseType === "request-support-review" ? "ready-for-support" : "ready-for-support",
          },
        },
      ];
    }
    case "EscalateSupportRequest": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(
        state.status !== "resolved" && state.status !== "closed" && state.status !== "cancelled",
        "Closed support requests cannot be escalated.",
      );
      if (state.status === "ready-for-support") {
        return [];
      }

      return [
        {
          type: "support.support-request.escalated",
          data: {
            supportRequestId: state.supportRequestId,
            escalatedAt: normalizeIsoTimestamp(command.escalatedAt, "Support escalation must record a timestamp."),
            reason: normalizeRequiredText(command.reason, "Support escalation must include a reason."),
          },
        },
      ];
    }
    case "ResolveSupportRequest": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(state.status !== "closed" && state.status !== "cancelled", "Closed support requests cannot be resolved.");
      if (state.status === "resolved") {
        return [];
      }
      assert(state.flowType !== null, "Support request flow is missing.");
      const resolutionType = normalizeResolutionType(command.resolutionType);
      const definition = getSupportFlowDefinition(state.flowType);
      assert(
        definition.allowedResolutions.includes(resolutionType),
        "This resolution is not accepted for the support flow.",
      );
      const resolution: SupportResolution = {
        resolutionType,
        summary: normalizeRequiredText(command.summary, "Support resolution must include a summary."),
        refundAmount: normalizeMoneyAmount(command.refundAmount, "Refund amount"),
        resolvedByAccountId: command.resolvedByAccountId ?? null,
        resolvedAt: normalizeIsoTimestamp(command.resolvedAt, "Support resolution must record a timestamp."),
      };
      return [
        {
          type: "support.support-request.resolved",
          data: {
            supportRequestId: state.supportRequestId,
            orderId: state.orderId!,
            buyerAccountId: state.buyerAccountId!,
            sellerAccountId: state.sellerAccountId!,
            flowType: state.flowType!,
            resolution,
          },
        },
      ];
    }
    case "CloseSupportRequest": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      if (state.status === "closed") {
        return [];
      }
      assert(state.status === "resolved", "Only resolved support requests can be closed.");
      return [
        {
          type: "support.support-request.closed",
          data: {
            supportRequestId: state.supportRequestId,
            orderId: state.orderId!,
            closedAt: normalizeIsoTimestamp(command.closedAt, "Support closure must record a timestamp."),
          },
        },
      ];
    }
    case "CancelSupportRequest": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      if (state.status === "cancelled") {
        return [];
      }
      assert(
        state.status !== "resolved" && state.status !== "closed",
        "Resolved support requests cannot be cancelled.",
      );
      return [
        {
          type: "support.support-request.cancelled",
          data: {
            supportRequestId: state.supportRequestId,
            orderId: state.orderId!,
            cancelledAt: normalizeIsoTimestamp(command.cancelledAt, "Support cancellation must record a timestamp."),
            reason: normalizeRequiredText(command.reason, "Support cancellation must include a reason."),
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveSupportRequest: AggregateEvolver<SupportRequestState, SupportRequestEvent> = (state, event) => {
  switch (event.type) {
    case "support.support-request.opened":
      return {
        supportRequestId: event.data.supportRequestId,
        orderId: event.data.orderId,
        buyerAccountId: event.data.buyerAccountId,
        sellerAccountId: event.data.sellerAccountId,
        flowType: event.data.flowType,
        status: event.data.status,
        priority: event.data.priority,
        openedByAccountId: event.data.openedByAccountId,
        openedByRole: event.data.openedByRole,
        openedAt: event.data.openedAt,
        updatedAt: event.data.openedAt,
        sellerResponseDueAt: event.data.sellerResponseDueAt,
        supportReviewDueAt: event.data.supportReviewDueAt,
        checklist: event.data.checklist,
        evidence: [],
        responses: [],
        resolution: null,
        closedAt: null,
        cancellationReason: null,
      };
    case "support.support-request.evidence-submitted":
      return {
        ...state,
        status: event.data.status,
        updatedAt: event.data.evidence.submittedAt,
        checklist: event.data.updatedChecklist,
        evidence: [...state.evidence, event.data.evidence],
      };
    case "support.support-request.response-recorded":
      return {
        ...state,
        status: event.data.status,
        updatedAt: event.data.response.submittedAt,
        responses: [...state.responses, event.data.response],
      };
    case "support.support-request.escalated":
      return {
        ...state,
        status: "ready-for-support",
        updatedAt: event.data.escalatedAt,
      };
    case "support.support-request.resolved":
      return {
        ...state,
        status: "resolved",
        updatedAt: event.data.resolution.resolvedAt,
        resolution: event.data.resolution,
      };
    case "support.support-request.closed":
      return {
        ...state,
        status: "closed",
        closedAt: event.data.closedAt,
        updatedAt: event.data.closedAt,
      };
    case "support.support-request.cancelled":
      return {
        ...state,
        status: "cancelled",
        cancellationReason: event.data.reason,
        closedAt: event.data.cancelledAt,
        updatedAt: event.data.cancelledAt,
      };
    default:
      return assertNever(event);
  }
};
