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
  type SupportOrderReturnContextLine,
  type SupportOffer,
  type SupportPriority,
  type SupportRequesterRole,
  type SupportRequestStatus,
  type SupportReturnInvestigation,
  type SupportReturnRefundGateStatus,
  type SupportResolution,
  type SupportResolutionType,
  type SupportResponse,
  type SupportResponseType,
} from "./common";
import { createChecklist, getSupportFlowDefinition, includesEvidenceType } from "./flow-catalog";
import { isHighValueReturnAmount, returnFlowPolicy } from "./return-flow-policy";

export type SupportRequestState = Readonly<{
  supportRequestId: SupportRequestId | null;
  orderId: OrderId | null;
  orderTotalAmount: string | null;
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
  sellerConditionAttestationDueAt: string | null;
  orderReturnContext: readonly SupportOrderReturnContextLine[];
  returnInvestigation: SupportReturnInvestigation | null;
  checklist: readonly SupportChecklistItem[];
  evidence: readonly SupportEvidence[];
  responses: readonly SupportResponse[];
  offers: readonly SupportOffer[];
  pendingOffer: SupportOffer | null;
  resolution: SupportResolution | null;
  closedAt: string | null;
  cancellationReason: string | null;
  escalatedAt: string | null;
  escalatedByAccountId: AccountId | null;
  escalatedByRole: SupportRequesterRole | null;
  escalationReason: string | null;
  sellerResponseReminderSentAt: string | null;
  supportReviewReminderSentAt: string | null;
  autoCloseDueAt: string | null;
  /** Set the moment a `return-for-refund` resolution fires; null for every other resolution type. */
  returnRefundGateStatus: SupportReturnRefundGateStatus | null;
  returnDeliveredAt: string | null;
  returnRefundReleaseDueAt: string | null;
  returnConditionDisputedAt: string | null;
}>;

export const initialSupportRequestState: SupportRequestState = {
  supportRequestId: null,
  orderId: null,
  orderTotalAmount: null,
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
  sellerConditionAttestationDueAt: null,
  orderReturnContext: [],
  returnInvestigation: null,
  checklist: [],
  evidence: [],
  responses: [],
  offers: [],
  pendingOffer: null,
  resolution: null,
  closedAt: null,
  cancellationReason: null,
  escalatedAt: null,
  escalatedByAccountId: null,
  escalatedByRole: null,
  escalationReason: null,
  sellerResponseReminderSentAt: null,
  supportReviewReminderSentAt: null,
  autoCloseDueAt: null,
  returnRefundGateStatus: null,
  returnDeliveredAt: null,
  returnRefundReleaseDueAt: null,
  returnConditionDisputedAt: null,
};

export type OpenSupportRequestCommand = Readonly<{
  type: "OpenSupportRequest";
  supportRequestId: SupportRequestId;
  orderId: OrderId;
  orderTotalAmount: string;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  flowType: SupportFlowType;
  openedByAccountId: AccountId;
  openedByRole: SupportRequesterRole;
  openedAt: string;
  orderReturnContext?: readonly SupportOrderReturnContextLine[] | null;
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
  offerId?: string | null;
  offerResolutionType?: SupportResolutionType | null;
  refundAmount?: string | null;
}>;

export type AcceptSupportOfferCommand = Readonly<{
  type: "AcceptSupportOffer";
  offerId: string;
  acceptedByAccountId?: AccountId | null;
  acceptedByRole: SupportRequesterRole;
  acceptedAt: string;
}>;

export type DeclineSupportOfferCommand = Readonly<{
  type: "DeclineSupportOffer";
  offerId: string;
  declinedByAccountId?: AccountId | null;
  declinedByRole: SupportRequesterRole;
  declinedAt: string;
  summary?: string | null;
}>;

export type EscalateSupportRequestCommand = Readonly<{
  type: "EscalateSupportRequest";
  escalatedAt: string;
  reason: string;
  escalatedByAccountId?: AccountId | null;
  escalatedByRole?: SupportRequesterRole | null;
}>;

export type ResolveSupportRequestCommand = Readonly<{
  type: "ResolveSupportRequest";
  resolutionType: SupportResolutionType;
  summary: string;
  refundAmount?: string | null;
  resolvedByAccountId?: AccountId | null;
  resolvedByRole?: SupportRequesterRole | null;
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

/**
 * Emitted by the deadline sweep once the acting party's response window is
 * half elapsed. Idempotent: the decider rejects a second reminder for the
 * same waiting period (see `sellerResponseReminderSentAt`).
 */
export type EmitSupportResponseReminderCommand = Readonly<{
  type: "EmitSupportResponseReminder";
  remindedAt: string;
}>;

/**
 * Emitted by the deadline sweep once a `ready-for-support` case is
 * approaching its support-review deadline. Idempotent per case (see
 * `supportReviewReminderSentAt`).
 */
export type EmitSupportReviewReminderCommand = Readonly<{
  type: "EmitSupportReviewReminder";
  remindedAt: string;
}>;

/**
 * Records the fact that a `return-for-refund` case's returned item arrived
 * back. Only valid while the gate is `awaiting-return-delivery`. Starts the
 * inspection window the seller has to dispute the item's condition before
 * the refund auto-releases.
 */
export type RecordReturnDeliveryCommand = Readonly<{
  type: "RecordReturnDelivery";
  deliveredAt: string;
  recordedByAccountId?: AccountId | null;
  recordedByRole: SupportRequesterRole;
}>;

/**
 * The seller's structured objection to the returned item's condition,
 * recorded within the inspection window. Blocks the auto-release sweep;
 * only a support-scoped `ReleaseReturnRefund` can move the gate forward
 * from here.
 */
export type DisputeReturnConditionCommand = Readonly<{
  type: "DisputeReturnCondition";
  disputedAt: string;
  reason: string;
  disputedByAccountId?: AccountId | null;
}>;

/**
 * Opens the money gate: releasing this lets the payments refund-effect
 * projection actually call `issueRefund`. `releasedByRole: null` is the
 * automated sweep path (only allowed once the inspection window has
 * elapsed with no dispute); `releasedByRole: "support"` is a manual
 * operator override, allowed from either `awaiting-return-inspection` or
 * `return-condition-disputed`, with no deadline requirement.
 */
export type ReleaseReturnRefundCommand = Readonly<{
  type: "ReleaseReturnRefund";
  releasedAt: string;
  releasedByAccountId?: AccountId | null;
  releasedByRole: "support" | null;
}>;

export type SupportRequestCommand =
  | OpenSupportRequestCommand
  | SubmitSupportEvidenceCommand
  | RecordSupportResponseCommand
  | AcceptSupportOfferCommand
  | DeclineSupportOfferCommand
  | EscalateSupportRequestCommand
  | ResolveSupportRequestCommand
  | CloseSupportRequestCommand
  | CancelSupportRequestCommand
  | EmitSupportResponseReminderCommand
  | EmitSupportReviewReminderCommand
  | RecordReturnDeliveryCommand
  | DisputeReturnConditionCommand
  | ReleaseReturnRefundCommand;

export type SupportRequestOpenedEvent = DomainEvent<
  "support.support-request.opened",
  Readonly<{
    supportRequestId: SupportRequestId;
    orderId: OrderId;
    orderTotalAmount: string;
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
    sellerConditionAttestationDueAt: string | null;
    orderReturnContext: readonly SupportOrderReturnContextLine[];
    returnInvestigation: SupportReturnInvestigation | null;
    checklist: readonly SupportChecklistItem[];
  }>
>;

export type SupportEvidenceSubmittedEvent = DomainEvent<
  "support.support-request.evidence-submitted",
  Readonly<{
    supportRequestId: SupportRequestId;
    evidence: SupportEvidence;
    status: SupportRequestStatus;
    priority: SupportPriority;
    sellerConditionAttestationDueAt: string | null;
    returnInvestigation: SupportReturnInvestigation | null;
    updatedChecklist: readonly SupportChecklistItem[];
  }>
>;

export type SupportResponseRecordedEvent = DomainEvent<
  "support.support-request.response-recorded",
  Readonly<{
    supportRequestId: SupportRequestId;
    response: SupportResponse;
    offer: SupportOffer | null;
    status: SupportRequestStatus;
  }>
>;

export type SupportOfferAcceptedEvent = DomainEvent<
  "support.support-request.offer-accepted",
  Readonly<{
    supportRequestId: SupportRequestId;
    offer: SupportOffer;
    status?: SupportRequestStatus;
  }>
>;

export type SupportOfferDeclinedEvent = DomainEvent<
  "support.support-request.offer-declined",
  Readonly<{
    supportRequestId: SupportRequestId;
    offer: SupportOffer;
    status: SupportRequestStatus;
  }>
>;

export type SupportRequestEscalatedEvent = DomainEvent<
  "support.support-request.escalated",
  Readonly<{
    supportRequestId: SupportRequestId;
    escalatedAt: string;
    reason: string;
    escalatedByAccountId: AccountId | null;
    escalatedByRole: SupportRequesterRole | null;
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
    /** Starts the auto-close clock: `resolved` cases close automatically once this passes. */
    autoCloseDueAt: string;
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

export type SupportResponseReminderEmittedEvent = DomainEvent<
  "support.support-request.response-reminder-emitted",
  Readonly<{
    supportRequestId: SupportRequestId;
    remindedAt: string;
    actingRole: SupportRequesterRole;
    dueAt: string;
  }>
>;

export type SupportReviewReminderEmittedEvent = DomainEvent<
  "support.support-request.review-reminder-emitted",
  Readonly<{
    supportRequestId: SupportRequestId;
    remindedAt: string;
    dueAt: string;
  }>
>;

export type SupportRequestReturnDeliveredEvent = DomainEvent<
  "support.support-request.return-delivered",
  Readonly<{
    supportRequestId: SupportRequestId;
    orderId: OrderId;
    deliveredAt: string;
    /** Inspection window end: the auto-release sweep candidate deadline. */
    returnRefundReleaseDueAt: string;
    recordedByAccountId: AccountId | null;
    recordedByRole: SupportRequesterRole;
  }>
>;

export type SupportRequestReturnConditionDisputedEvent = DomainEvent<
  "support.support-request.return-condition-disputed",
  Readonly<{
    supportRequestId: SupportRequestId;
    orderId: OrderId;
    disputedAt: string;
    reason: string;
    disputedByAccountId: AccountId | null;
  }>
>;

export type SupportRequestReturnRefundReleasedEvent = DomainEvent<
  "support.support-request.return-refund-released",
  Readonly<{
    supportRequestId: SupportRequestId;
    orderId: OrderId;
    releasedAt: string;
    releasedByAccountId: AccountId | null;
    releasedByRole: "support" | null;
  }>
>;

export type SupportRequestEvent =
  | SupportRequestOpenedEvent
  | SupportEvidenceSubmittedEvent
  | SupportResponseRecordedEvent
  | SupportOfferAcceptedEvent
  | SupportOfferDeclinedEvent
  | SupportRequestEscalatedEvent
  | SupportRequestResolvedEvent
  | SupportRequestClosedEvent
  | SupportRequestCancelledEvent
  | SupportResponseReminderEmittedEvent
  | SupportReviewReminderEmittedEvent
  | SupportRequestReturnDeliveredEvent
  | SupportRequestReturnConditionDisputedEvent
  | SupportRequestReturnRefundReleasedEvent;

function addHours(timestamp: string, hours: number | null) {
  if (hours === null) {
    return null;
  }

  const date = new Date(timestamp);
  date.setHours(date.getHours() + hours);
  return date.toISOString();
}

/** Resolved cases auto-close this many days after resolution, releasing settlement holds and keeping the queue clean. */
const AUTO_CLOSE_DAYS_AFTER_RESOLUTION = 7;

function autoCloseDueAtFor(resolvedAt: string): string {
  const date = new Date(resolvedAt);
  date.setDate(date.getDate() + AUTO_CLOSE_DAYS_AFTER_RESOLUTION);
  return date.toISOString();
}

function statusForOpenedRequest(
  flowType: SupportFlowType,
  orderTotalAmount: string,
  defaultStatus: SupportRequestStatus,
) {
  if (flowType === "return-request" && isHighValueReturnAmount(orderTotalAmount)) {
    return "ready-for-support";
  }

  return defaultStatus;
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

function addSellerConditionAttestationChecklist(
  checklist: readonly SupportChecklistItem[],
): readonly SupportChecklistItem[] {
  if (checklist.some((item) => item.key === "seller-return-condition-attestation")) {
    return checklist;
  }

  return [
    ...checklist,
    {
      key: "seller-return-condition-attestation",
      label: "Seller confirms the returned item condition after receipt.",
      ownerRole: "seller",
      evidenceTypes: ["seller-condition-attestation"],
      required: true,
      satisfiedAt: null,
    },
  ];
}

function requiredChecklistSatisfied(state: SupportRequestState) {
  return state.checklist.every((item) => !item.required || item.satisfiedAt !== null);
}

function isRefundReleaseResolution(resolutionType: SupportResolutionType) {
  return ["full-refund", "partial-refund", "return-for-refund"].includes(resolutionType);
}

function assertReturnRefundReleaseAllowed(
  state: SupportRequestState,
  resolutionType: SupportResolutionType,
  resolvedByRole: SupportRequesterRole | null,
) {
  if (state.flowType !== "return-request" || !isRefundReleaseResolution(resolutionType)) {
    return;
  }

  assert(requiredChecklistSatisfied(state), "Return refund resolution requires completed return evidence.");

  if (isHighValueReturnAmount(state.orderTotalAmount)) {
    assert(resolvedByRole === "support", "High-value return refunds require support review.");
  }
}

function normalizeOrderReturnContext(
  value: readonly SupportOrderReturnContextLine[] | null | undefined,
): readonly SupportOrderReturnContextLine[] {
  return (value ?? []).map((line) => ({
    lineId: normalizeRequiredText(line.lineId, "Return context line id is required."),
    listingId: normalizeRequiredText(line.listingId, "Return context listing id is required."),
    itemTitle: normalizeRequiredText(line.itemTitle, "Return context item title is required."),
    productSummary: normalizeOptionalText(line.productSummary),
    quantity: Math.max(1, Math.trunc(Number(line.quantity))),
    gradedCard: line.gradedCard
      ? {
          gradingCompany: normalizeRequiredText(
            line.gradedCard.gradingCompany,
            "Return context graded card company is required.",
          ),
          grade: normalizeRequiredText(line.gradedCard.grade, "Return context graded card grade is required."),
          certificationNumber: normalizeOptionalText(line.gradedCard.certificationNumber),
        }
      : null,
  }));
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
    offerId: command.offerId ? normalizeRequiredText(command.offerId, "Support offer must include an id.") : null,
  };
}

function isOfferResponseType(responseType: SupportResponseType) {
  return (
    responseType === "accept-return" || responseType === "offer-partial-refund" || responseType === "offer-replacement"
  );
}

function expectedOfferResolution(responseType: SupportResponseType): SupportResolutionType | null {
  switch (responseType) {
    case "accept-return":
      return "return-for-refund";
    case "offer-partial-refund":
      return "partial-refund";
    case "offer-replacement":
      return "replacement";
    default:
      return null;
  }
}

function counterpartyFor(role: SupportRequesterRole): SupportRequesterRole {
  if (role === "buyer") {
    return "seller";
  }
  if (role === "seller") {
    return "buyer";
  }
  return "buyer";
}

function statusForPendingOffer(offer: SupportOffer): SupportRequestStatus {
  if (offer.pendingWithRole === "buyer") {
    return "waiting-on-buyer";
  }
  if (offer.pendingWithRole === "seller") {
    return "waiting-on-seller";
  }
  return "ready-for-support";
}

function normalizePositiveRefundAmount(value: string | null | undefined, orderTotalAmount: string | null) {
  const amount = normalizeMoneyAmount(value, "Offer refund amount");
  assert(amount !== null && Number(amount) > 0, "Offer refund amount must be greater than zero.");
  assert(orderTotalAmount !== null, "Support request order total is required for refund offer validation.");
  assert(Number(amount) <= Number(orderTotalAmount), "Offer refund amount cannot exceed the order total.");
  return amount;
}

function buildOffer(
  state: SupportRequestState,
  command: RecordSupportResponseCommand,
  response: SupportResponse,
): SupportOffer | null {
  if (!isOfferResponseType(response.responseType)) {
    assert(command.offerId === null || command.offerId === undefined, "Only offer responses can include an offer id.");
    assert(
      command.offerResolutionType === null || command.offerResolutionType === undefined,
      "Only offer responses can include an offer resolution.",
    );
    assert(
      command.refundAmount === null || command.refundAmount === undefined,
      "Only offer responses can include a refund amount.",
    );
    return null;
  }

  assert(response.offerId !== null, "Offer responses must include an offer id.");
  const resolutionType = normalizeResolutionType(command.offerResolutionType ?? "");
  const expectedResolution = expectedOfferResolution(response.responseType);
  assert(expectedResolution === resolutionType, "Offer resolution does not match the response type.");
  assert(state.flowType !== null, "Support request flow is missing.");
  const definition = getSupportFlowDefinition(state.flowType);
  assert(
    definition.allowedResolutions.includes(resolutionType),
    "This offer resolution is not accepted for the support flow.",
  );
  const refundAmount =
    resolutionType === "partial-refund"
      ? normalizePositiveRefundAmount(command.refundAmount, state.orderTotalAmount)
      : null;
  assert(
    resolutionType === "partial-refund" || command.refundAmount === null || command.refundAmount === undefined,
    "Only partial refund offers can include a refund amount.",
  );

  return {
    offerId: response.offerId,
    responseId: response.responseId,
    offeredByAccountId: response.submittedByAccountId,
    offeredByRole: response.submittedByRole,
    pendingWithRole: counterpartyFor(response.submittedByRole),
    responseType: response.responseType,
    resolutionType,
    refundAmount,
    summary: response.summary,
    offeredAt: response.submittedAt,
    status: "pending",
    decidedByAccountId: null,
    decidedByRole: null,
    decidedAt: null,
    decisionSummary: null,
  };
}

function resolveFromOffer(offer: SupportOffer, acceptedByAccountId: AccountId | null): SupportResolution {
  return {
    resolutionType: offer.resolutionType,
    summary: `Party agreement accepted offer ${offer.offerId}: ${offer.summary}`,
    refundAmount: offer.refundAmount,
    resolvedByAccountId: acceptedByAccountId,
    resolvedByRole: offer.decidedByRole,
    resolvedAt: offer.decidedAt!,
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
      const orderTotalAmount = normalizeMoneyAmount(command.orderTotalAmount, "Order total");
      assert(orderTotalAmount !== null, "Support request must include the order total.");
      const checklist = createChecklist(flowType);
      const status = statusForOpenedRequest(flowType, orderTotalAmount, definition.initialStatus);
      return [
        {
          type: "support.support-request.opened",
          data: {
            supportRequestId: command.supportRequestId,
            orderId: command.orderId,
            orderTotalAmount,
            buyerAccountId: command.buyerAccountId,
            sellerAccountId: command.sellerAccountId,
            flowType,
            status,
            priority: normalizePriority(definition.priority),
            openedByAccountId: command.openedByAccountId,
            openedByRole,
            openedAt,
            sellerResponseDueAt: addHours(openedAt, definition.sellerResponseHours),
            supportReviewDueAt: addHours(openedAt, definition.supportReviewHours),
            sellerConditionAttestationDueAt: null,
            orderReturnContext: normalizeOrderReturnContext(command.orderReturnContext),
            returnInvestigation: null,
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
      if (state.flowType === "return-request" && evidence.evidenceType === "photo") {
        assert(evidence.attachments.length > 0, "Return photo evidence requires at least one attachment.");
      }
      if (state.flowType === "return-request" && evidence.evidenceType === "return-discrepancy-photo") {
        assert(evidence.attachments.length > 0, "Return discrepancy evidence requires at least one photo attachment.");
      }

      const checklistWithReceipt =
        state.flowType === "return-request" && evidence.evidenceType === "return-delivery-confirmation"
          ? addSellerConditionAttestationChecklist(state.checklist)
          : state.checklist;
      const updatedChecklist = satisfyChecklist(checklistWithReceipt, evidence.evidenceType, evidence.submittedAt);
      const returnInvestigation =
        state.flowType === "return-request" && evidence.evidenceType === "return-discrepancy-photo"
          ? {
              reason: "seller-condition-discrepancy" as const,
              convertedAt: evidence.submittedAt,
            }
          : state.returnInvestigation;
      const sellerConditionAttestationDueAt =
        state.flowType === "return-request" && evidence.evidenceType === "return-delivery-confirmation"
          ? addHours(evidence.submittedAt, returnFlowPolicy.sellerConditionAttestationHours)
          : state.sellerConditionAttestationDueAt;
      const status =
        state.flowType === "return-request" && evidence.evidenceType === "return-discrepancy-photo"
          ? "ready-for-support"
          : inferStatusAfterEvidence(state, updatedChecklist);

      return [
        {
          type: "support.support-request.evidence-submitted",
          data: {
            supportRequestId: state.supportRequestId,
            evidence,
            status,
            priority:
              state.flowType === "return-request" && evidence.evidenceType === "return-discrepancy-photo"
                ? "urgent"
                : (state.priority ?? "normal"),
            sellerConditionAttestationDueAt,
            returnInvestigation,
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
      assert(
        state.escalatedAt === null || response.submittedByRole !== "seller",
        "This support request has been escalated; only support can act on it now.",
      );
      assert(
        state.pendingOffer === null,
        "Pending support offers must be accepted or declined before another response.",
      );
      if (response.responseType === "challenge-with-evidence") {
        assert(
          !state.responses.some((existing) => existing.responseType === "challenge-with-evidence"),
          "This support request already has a seller challenge; further disagreement must be escalated.",
        );
      }
      const offer = buildOffer(state, command, response);
      const status = offer
        ? statusForPendingOffer(offer)
        : response.responseType === "challenge-with-evidence"
          ? "waiting-on-buyer"
          : "ready-for-support";
      const responseRecorded: SupportResponseRecordedEvent = {
        type: "support.support-request.response-recorded",
        data: {
          supportRequestId: state.supportRequestId,
          response,
          offer,
          status,
        },
      };

      if (state.flowType === "buyer-cancel-request" && response.responseType === "confirm-cancellation") {
        assert(
          definition.allowedResolutions.includes("cancel-order"),
          "This resolution is not accepted for the support flow.",
        );
        return [
          responseRecorded,
          {
            type: "support.support-request.resolved",
            data: {
              supportRequestId: state.supportRequestId,
              orderId: state.orderId!,
              buyerAccountId: state.buyerAccountId!,
              sellerAccountId: state.sellerAccountId!,
              flowType: state.flowType,
              resolution: {
                resolutionType: "cancel-order",
                summary: "Seller confirmed the buyer cancellation request.",
                refundAmount: null,
                resolvedByAccountId: response.submittedByAccountId,
                resolvedByRole: response.submittedByRole,
                resolvedAt: response.submittedAt,
              },
              autoCloseDueAt: autoCloseDueAtFor(response.submittedAt),
            },
          },
        ];
      }

      return [responseRecorded];
    }
    case "AcceptSupportOffer": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(
        state.status !== "resolved" && state.status !== "closed" && state.status !== "cancelled",
        "Closed support requests cannot accept offers.",
      );
      const acceptedByRole = normalizeRequesterRole(command.acceptedByRole);
      const acceptedAt = normalizeIsoTimestamp(command.acceptedAt, "Support offer acceptance must record a timestamp.");
      const offerId = normalizeRequiredText(command.offerId, "Support offer id is required.");
      const offer = state.pendingOffer;
      assert(
        offer !== null && offer.offerId === offerId && offer.status === "pending",
        "No pending support offer is available.",
      );
      assert(offer.pendingWithRole === acceptedByRole, "This support offer is waiting on the other party.");
      const acceptedOffer: SupportOffer = {
        ...offer,
        status: "accepted",
        decidedByAccountId: command.acceptedByAccountId ?? null,
        decidedByRole: acceptedByRole,
        decidedAt: acceptedAt,
        decisionSummary: "Offer accepted by the counterparty.",
      };
      const resolution = resolveFromOffer(acceptedOffer, command.acceptedByAccountId ?? null);
      assertReturnRefundReleaseAllowed(state, resolution.resolutionType, acceptedByRole);

      return [
        {
          type: "support.support-request.offer-accepted",
          data: {
            supportRequestId: state.supportRequestId,
            offer: acceptedOffer,
            status: state.status ?? "open",
          },
        },
        {
          type: "support.support-request.resolved",
          data: {
            supportRequestId: state.supportRequestId,
            orderId: state.orderId!,
            buyerAccountId: state.buyerAccountId!,
            sellerAccountId: state.sellerAccountId!,
            flowType: state.flowType!,
            resolution,
            autoCloseDueAt: autoCloseDueAtFor(resolution.resolvedAt),
          },
        },
      ];
    }
    case "DeclineSupportOffer": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(
        state.status !== "resolved" && state.status !== "closed" && state.status !== "cancelled",
        "Closed support requests cannot decline offers.",
      );
      const declinedByRole = normalizeRequesterRole(command.declinedByRole);
      const declinedAt = normalizeIsoTimestamp(command.declinedAt, "Support offer decline must record a timestamp.");
      const offerId = normalizeRequiredText(command.offerId, "Support offer id is required.");
      const offer = state.pendingOffer;
      assert(
        offer !== null && offer.offerId === offerId && offer.status === "pending",
        "No pending support offer is available.",
      );
      assert(offer.pendingWithRole === declinedByRole, "This support offer is waiting on the other party.");
      return [
        {
          type: "support.support-request.offer-declined",
          data: {
            supportRequestId: state.supportRequestId,
            offer: {
              ...offer,
              status: "declined",
              decidedByAccountId: command.declinedByAccountId ?? null,
              decidedByRole: declinedByRole,
              decidedAt: declinedAt,
              decisionSummary: normalizeOptionalText(command.summary) ?? "Offer declined by the counterparty.",
            },
            status: "ready-for-support",
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
            escalatedByAccountId: command.escalatedByAccountId ?? null,
            escalatedByRole:
              command.escalatedByRole === null || command.escalatedByRole === undefined
                ? null
                : normalizeRequesterRole(command.escalatedByRole),
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
      const resolvedByRole =
        command.resolvedByRole === null || command.resolvedByRole === undefined
          ? null
          : normalizeRequesterRole(command.resolvedByRole);
      assert(
        state.escalatedAt === null || resolvedByRole === "support",
        "Escalated support requests can only be resolved by support.",
      );
      assertReturnRefundReleaseAllowed(state, resolutionType, resolvedByRole);
      const resolution: SupportResolution = {
        resolutionType,
        summary: normalizeRequiredText(command.summary, "Support resolution must include a summary."),
        refundAmount: normalizeMoneyAmount(command.refundAmount, "Refund amount"),
        resolvedByAccountId: command.resolvedByAccountId ?? null,
        resolvedByRole,
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
            autoCloseDueAt: autoCloseDueAtFor(resolution.resolvedAt),
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
    case "EmitSupportResponseReminder": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(
        state.status === "waiting-on-seller",
        "Support response reminders only apply while waiting on the seller.",
      );
      assert(state.sellerResponseDueAt !== null, "Support response reminder requires a response deadline.");
      assert(state.sellerResponseReminderSentAt === null, "Support response reminder has already been emitted.");
      return [
        {
          type: "support.support-request.response-reminder-emitted",
          data: {
            supportRequestId: state.supportRequestId,
            remindedAt: normalizeIsoTimestamp(command.remindedAt, "Support response reminder must record a timestamp."),
            actingRole: "seller",
            dueAt: state.sellerResponseDueAt,
          },
        },
      ];
    }
    case "EmitSupportReviewReminder": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(
        state.status === "ready-for-support",
        "Support review reminders only apply while a case is ready for support review.",
      );
      assert(state.supportReviewDueAt !== null, "Support review reminder requires a review deadline.");
      assert(state.supportReviewReminderSentAt === null, "Support review reminder has already been emitted.");
      return [
        {
          type: "support.support-request.review-reminder-emitted",
          data: {
            supportRequestId: state.supportRequestId,
            remindedAt: normalizeIsoTimestamp(command.remindedAt, "Support review reminder must record a timestamp."),
            dueAt: state.supportReviewDueAt,
          },
        },
      ];
    }
    case "RecordReturnDelivery": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(
        state.returnRefundGateStatus === "awaiting-return-delivery",
        "This case has no return-for-refund refund awaiting return delivery.",
      );
      const deliveredAt = normalizeIsoTimestamp(command.deliveredAt, "Return delivery must record a timestamp.");
      return [
        {
          type: "support.support-request.return-delivered",
          data: {
            supportRequestId: state.supportRequestId,
            orderId: state.orderId!,
            deliveredAt,
            returnRefundReleaseDueAt: addHours(deliveredAt, returnFlowPolicy.returnRefundInspectionWindowHours)!,
            recordedByAccountId: command.recordedByAccountId ?? null,
            recordedByRole: normalizeRequesterRole(command.recordedByRole),
          },
        },
      ];
    }
    case "DisputeReturnCondition": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(
        state.returnRefundGateStatus === "awaiting-return-inspection",
        "This case has no return awaiting inspection to dispute.",
      );
      return [
        {
          type: "support.support-request.return-condition-disputed",
          data: {
            supportRequestId: state.supportRequestId,
            orderId: state.orderId!,
            disputedAt: normalizeIsoTimestamp(command.disputedAt, "Return condition dispute must record a timestamp."),
            reason: normalizeRequiredText(command.reason, "Return condition dispute must include a reason."),
            disputedByAccountId: command.disputedByAccountId ?? null,
          },
        },
      ];
    }
    case "ReleaseReturnRefund": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      const releasedAt = normalizeIsoTimestamp(command.releasedAt, "Return refund release must record a timestamp.");
      if (command.releasedByRole === "support") {
        assert(
          state.returnRefundGateStatus === "awaiting-return-inspection" ||
            state.returnRefundGateStatus === "return-condition-disputed",
          "This case has no pending return refund for support to release.",
        );
      } else {
        assert(
          state.returnRefundGateStatus === "awaiting-return-inspection",
          "This case has no return refund awaiting automatic release.",
        );
        assert(
          state.returnRefundReleaseDueAt !== null && releasedAt >= state.returnRefundReleaseDueAt,
          "The return refund inspection window has not elapsed yet.",
        );
      }
      return [
        {
          type: "support.support-request.return-refund-released",
          data: {
            supportRequestId: state.supportRequestId,
            orderId: state.orderId!,
            releasedAt,
            releasedByAccountId: command.releasedByAccountId ?? null,
            releasedByRole: command.releasedByRole,
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
        orderTotalAmount: event.data.orderTotalAmount,
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
        sellerConditionAttestationDueAt: event.data.sellerConditionAttestationDueAt,
        orderReturnContext: event.data.orderReturnContext,
        returnInvestigation: event.data.returnInvestigation,
        checklist: event.data.checklist,
        evidence: [],
        responses: [],
        offers: [],
        pendingOffer: null,
        resolution: null,
        closedAt: null,
        cancellationReason: null,
        escalatedAt: null,
        escalatedByAccountId: null,
        escalatedByRole: null,
        escalationReason: null,
        sellerResponseReminderSentAt: null,
        supportReviewReminderSentAt: null,
        autoCloseDueAt: null,
        returnRefundGateStatus: null,
        returnDeliveredAt: null,
        returnRefundReleaseDueAt: null,
        returnConditionDisputedAt: null,
      };
    case "support.support-request.evidence-submitted":
      return {
        ...state,
        status: event.data.status,
        priority: event.data.priority,
        updatedAt: event.data.evidence.submittedAt,
        sellerConditionAttestationDueAt: event.data.sellerConditionAttestationDueAt,
        returnInvestigation: event.data.returnInvestigation,
        checklist: event.data.updatedChecklist,
        evidence: [...state.evidence, event.data.evidence],
      };
    case "support.support-request.response-recorded":
      return {
        ...state,
        status: event.data.status,
        updatedAt: event.data.response.submittedAt,
        responses: [...state.responses, event.data.response],
        offers: event.data.offer ? [...state.offers, event.data.offer] : state.offers,
        pendingOffer: event.data.offer ?? state.pendingOffer,
      };
    case "support.support-request.offer-accepted":
      return {
        ...state,
        status: event.data.status ?? state.status,
        updatedAt: event.data.offer.decidedAt,
        offers: state.offers.map((offer) => (offer.offerId === event.data.offer.offerId ? event.data.offer : offer)),
        pendingOffer: null,
      };
    case "support.support-request.offer-declined":
      return {
        ...state,
        status: event.data.status,
        updatedAt: event.data.offer.decidedAt,
        offers: state.offers.map((offer) => (offer.offerId === event.data.offer.offerId ? event.data.offer : offer)),
        pendingOffer: null,
      };
    case "support.support-request.escalated":
      return {
        ...state,
        status: "ready-for-support",
        updatedAt: event.data.escalatedAt,
        escalatedAt: event.data.escalatedAt,
        escalatedByAccountId: event.data.escalatedByAccountId,
        escalatedByRole: event.data.escalatedByRole,
        escalationReason: event.data.reason,
      };
    case "support.support-request.resolved":
      return {
        ...state,
        status: "resolved",
        updatedAt: event.data.resolution.resolvedAt,
        resolution: event.data.resolution,
        autoCloseDueAt: event.data.autoCloseDueAt,
        returnRefundGateStatus:
          event.data.resolution.resolutionType === "return-for-refund" ? "awaiting-return-delivery" : null,
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
    case "support.support-request.response-reminder-emitted":
      return {
        ...state,
        sellerResponseReminderSentAt: event.data.remindedAt,
      };
    case "support.support-request.review-reminder-emitted":
      return {
        ...state,
        supportReviewReminderSentAt: event.data.remindedAt,
      };
    case "support.support-request.return-delivered":
      return {
        ...state,
        returnRefundGateStatus: "awaiting-return-inspection",
        returnDeliveredAt: event.data.deliveredAt,
        returnRefundReleaseDueAt: event.data.returnRefundReleaseDueAt,
      };
    case "support.support-request.return-condition-disputed":
      return {
        ...state,
        returnRefundGateStatus: "return-condition-disputed",
        returnConditionDisputedAt: event.data.disputedAt,
      };
    case "support.support-request.return-refund-released":
      return {
        ...state,
        returnRefundGateStatus: "return-refund-released",
      };
    default:
      return assertNever(event);
  }
};
