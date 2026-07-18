import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, OrderId, RemedyId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import { compareMoneyAmounts, sumMoneyAmounts } from "@chase-sets/primitives/money";
import { normalizeAffectedLineItemAmounts } from "@chase-sets/primitives/affected-line-item-amount";
import {
  assert,
  assertNever,
  normalizeAttachments,
  normalizeCurrencyCode,
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
  type SupportAffectedLineItemAmount,
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
  type SupportResponsibility,
  type SupportResponsibilityReasonCode,
  type SupportEvidenceBasis,
  type SupportResponse,
  type SupportResponseType,
} from "./common";
import { createChecklist, getSupportFlowDefinition, includesEvidenceType } from "./flow-catalog";
import {
  acceptedOfferResponsibilityFact,
  createSupportResponsibilityFact,
  normalizeSupportResolutionForReplay,
} from "./responsibility";
import { isHighValueReturnAmount, returnFlowPolicy } from "./return-flow-policy";
import {
  applyRemedyEffectFact,
  applyRemedyEffectWaiver,
  canCompleteRemedy,
  canReleaseRemedyRefund,
  createCoverageRequestedEvent,
  createRefundReleasedEvent,
  createRemedyCompletedEvent,
  createRemedyEffectWaiver,
  createRemedyExecution,
  normalizeRemedyAuthorization,
  normalizeRemedyEffectKind,
  normalizeRemedyEffectFact,
  remedyHasProcessedFact,
  type AuthorizeSupportRemedyCommand,
  type OverrideSupportRemedyEffectCommand,
  type RecordSupportRemedyEffectCommand,
  type RemedyExecution,
  type SupportRequestRemedyEffectRecordedEvent,
  type SupportRequestRemedyEvent,
} from "./remedy";
import {
  applyRemedyApproval,
  applyRemedyCorrectionRequest,
  applyRemedyReservationFact,
  applyRemedyRetryRequest,
  applyRemedyWaiverAudit,
  createRemedyApproval,
  createRemedyApprovalWorkflow,
  markRemedyWorkflowAuthorized,
  type ApproveSupportRemedyCommand,
  type ProposeSupportRemedyCommand,
  type RemedyApprovalWorkflow,
  type RequestSupportRemedyCorrectionCommand,
  type RetrySupportRemedyEffectCommand,
  type SupportRemedyApprovalEvent,
} from "./remedy-approval";
import {
  createSupportCsatOutcomeFact,
  supportCsatOutcomeFactEventType,
} from "../../../support/request-support/csat-outcome-fact";

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
  deliveredAt: string | null;
  postDeliveryOpenWindowDays: number | null;
  updatedAt: string | null;
  sellerResponseDueAt: string | null;
  supportReviewDueAt: string | null;
  sellerConditionAttestationDueAt: string | null;
  orderReturnContext: readonly SupportOrderReturnContextLine[];
  affectedLineItems: readonly SupportAffectedLineItemAmount[];
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
  /** Null for legacy cases until the explicit remedy lifecycle is authorized. */
  remedy: RemedyExecution | null;
  /** Operator proposal, reservation, approval, and recovery audit state. */
  remedyApproval: RemedyApprovalWorkflow | null;
  /** Correlated facts may arrive before authorization; replay retains them until the remedy is known. */
  deferredRemedyEffectFacts: readonly SupportRequestRemedyEffectRecordedEvent["data"][];
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
  deliveredAt: null,
  postDeliveryOpenWindowDays: null,
  updatedAt: null,
  sellerResponseDueAt: null,
  supportReviewDueAt: null,
  sellerConditionAttestationDueAt: null,
  orderReturnContext: [],
  affectedLineItems: [],
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
  remedy: null,
  remedyApproval: null,
  deferredRemedyEffectFacts: [],
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
  deliveredAt?: string | null;
  orderReturnContext?: readonly SupportOrderReturnContextLine[] | null;
  affectedLineItems?: readonly SupportAffectedLineItemAmount[] | null;
  /**
   * The support-deadline policy's resolved value for this flow at open
   * time (see `../domain/support-deadline-policy.ts`), stamped onto
   * `sellerResponseDueAt` below. Omit to fall back to the flow catalog's
   * compiled default -- used by seeds and any pre-policy call site. Must be
   * `null` when the flow has no seller-response phase at all.
   */
  sellerResponseHours?: number | null;
  /**
   * The support-deadline policy's resolved value for this flow at open
   * time, stamped onto `supportReviewDueAt` below. Omit to fall back to the
   * flow catalog's compiled default.
   */
  supportReviewHours?: number;
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
  affectedLineIds?: readonly string[] | null;
  refundCurrencyCode?: string | null;
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
  affectedLineIds?: readonly string[] | null;
  refundCurrencyCode?: string | null;
  responsibility: SupportResponsibility | string;
  evidenceBasis: Readonly<{ type: SupportEvidenceBasis["type"] | string; reference: string }>;
  responsibilityReasonCode: SupportResponsibilityReasonCode | string;
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
  | ReleaseReturnRefundCommand
  | ProposeSupportRemedyCommand
  | ApproveSupportRemedyCommand
  | RetrySupportRemedyEffectCommand
  | RequestSupportRemedyCorrectionCommand
  | AuthorizeSupportRemedyCommand
  | RecordSupportRemedyEffectCommand
  | OverrideSupportRemedyEffectCommand;

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
    deliveredAt: string | null;
    postDeliveryOpenWindowDays: number | null;
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

export type SupportAffectedLineItemsRecordedEvent = DomainEvent<
  "support.support-request.affected-line-items-recorded",
  Readonly<{
    supportRequestId: SupportRequestId;
    affectedLineItems: readonly SupportAffectedLineItemAmount[];
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

export type SupportCsatOutcomeFactPublishedEvent = DomainEvent<
  typeof supportCsatOutcomeFactEventType,
  ReturnType<typeof createSupportCsatOutcomeFact>
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
    deadlineOutcome:
      | Readonly<{ type: "automatic-resolution"; resolutionType: SupportResolutionType }>
      | Readonly<{ type: "support-review" }>;
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
  | SupportAffectedLineItemsRecordedEvent
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
  | SupportRequestReturnRefundReleasedEvent
  | SupportRemedyApprovalEvent
  | SupportRequestRemedyEvent
  | SupportCsatOutcomeFactPublishedEvent;

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

function appendAutomaticRemedyEvents(
  remedy: RemedyExecution,
  occurredAt: string,
  causationId: string,
): readonly SupportRequestRemedyEvent[] {
  const events: SupportRequestRemedyEvent[] = [];
  let next = remedy;
  if (canReleaseRemedyRefund(next)) {
    const released = createRefundReleasedEvent(next, occurredAt, causationId);
    events.push(released);
    next = { ...next, refundReleasedAt: released.data.occurredAt };
  }
  if (canCompleteRemedy(next)) {
    events.push(createRemedyCompletedEvent(next, occurredAt, causationId));
  }
  return events;
}

function assertRemedyEffectCompatibility(remedy: RemedyExecution, fact: ReturnType<typeof normalizeRemedyEffectFact>) {
  if (fact.effect === "coverage-reservation" && fact.outcome === "satisfied") {
    assert(fact.amount !== null, "Coverage reservation fact must include the reserved amount.");
    assert(
      fact.currencyCode === remedy.allocation.currencyCode,
      "Coverage reservation currency must match the remedy.",
    );
    assert(
      compareMoneyAmounts(fact.amount, remedy.allocation.platformFundedAmount) === 0,
      "Coverage reservation amount must match the platform-funded allocation.",
    );
  }
  if (fact.effect === "refund-completion" && fact.outcome === "satisfied") {
    assert(fact.refundId !== null, "Refund completion fact must include the refund id.");
    assert(fact.amount !== null, "Refund completion fact must include the refunded amount.");
    assert(fact.currencyCode === remedy.remedy.currencyCode, "Refund completion currency must match the remedy.");
    assert(
      compareMoneyAmounts(fact.amount, remedy.remedy.amount) === 0,
      "Refund completion amount must match the authorized remedy.",
    );
  }
  if (fact.effect === "settlement-reconciliation" && fact.outcome === "satisfied") {
    assert(fact.refundId !== null, "Settlement reconciliation fact must include the refund id.");
    assert(fact.allocation !== null, "Settlement reconciliation fact must include the reserved allocation.");
    assert(
      fact.allocation.sellerFundedAmount === remedy.allocation.sellerFundedAmount &&
        fact.allocation.platformFundedAmount === remedy.allocation.platformFundedAmount &&
        fact.allocation.currencyCode === remedy.allocation.currencyCode &&
        fact.allocation.fundingKind === remedy.allocation.fundingKind,
      "Settlement reconciliation allocation must match the authorized remedy.",
    );
  }
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

function normalizeAffectedLineItems(
  value: readonly SupportAffectedLineItemAmount[] | null | undefined,
): readonly SupportAffectedLineItemAmount[] {
  try {
    return normalizeAffectedLineItemAmounts(value ?? []).map((line) => ({
      lineId: line.lineId,
      amount: line.amount,
      currencyCode: line.currencyCode,
    }));
  } catch (error) {
    assert(false, error instanceof Error ? error.message : "Affected line-item amounts are invalid.");
  }
}

function selectAffectedLineItems(
  state: SupportRequestState,
  requestedLineIds: readonly string[] | null | undefined,
  requestedCurrencyCode: string | null | undefined,
) {
  if (state.affectedLineItems.length === 0) {
    assert(
      requestedLineIds === null || requestedLineIds === undefined,
      "Affected line-item facts are not available for this support request.",
    );
    return {
      lineItems: [],
      capAmount: state.orderTotalAmount,
      currencyCode: requestedCurrencyCode ? normalizeCurrencyCode(requestedCurrencyCode) : null,
    };
  }

  const lineIds = requestedLineIds ?? state.affectedLineItems.map((line) => line.lineId);
  assert(lineIds.length > 0, "At least one affected line item is required.");
  assert(new Set(lineIds).size === lineIds.length, "Affected line items cannot be duplicated.");
  const lineItems = lineIds.map((lineId) => {
    const lineItem = state.affectedLineItems.find((candidate) => candidate.lineId === lineId);
    assert(lineItem !== undefined, "Offer references a line item outside the support request.");
    return lineItem;
  });
  const currencyCodes = new Set(lineItems.map((line) => normalizeCurrencyCode(line.currencyCode)));
  assert(currencyCodes.size === 1, "Affected line items must use one currency.");
  const currencyCode = [...currencyCodes][0]!;
  if (requestedCurrencyCode !== null && requestedCurrencyCode !== undefined) {
    assert(normalizeCurrencyCode(requestedCurrencyCode) === currencyCode, "Offer currency must match affected lines.");
  }

  return {
    lineItems,
    capAmount: sumMoneyAmounts(lineItems.map((line) => line.amount)),
    currencyCode,
  };
}

function assertRefundAmountWithinAffectedLines(
  state: SupportRequestState,
  refundAmount: string | null | undefined,
  lineIds: readonly string[] | null | undefined,
  currencyCode: string | null | undefined,
  requirePositive = false,
) {
  const selected = selectAffectedLineItems(state, lineIds, currencyCode);
  const amount = normalizeMoneyAmount(refundAmount, "Refund amount");
  if (amount === null) {
    assert(!requirePositive, "Refund amount must be greater than zero.");
    return { ...selected, amount: null };
  }
  assert(compareMoneyAmounts(amount, "0.00") > 0, "Refund amount must be greater than zero.");
  assert(selected.capAmount !== null, "Support request order total is required for refund validation.");
  assert(
    compareMoneyAmounts(amount, selected.capAmount) <= 0,
    state.affectedLineItems.length > 0
      ? "Refund amount cannot exceed affected line totals."
      : "Offer refund amount cannot exceed the order total.",
  );
  return { ...selected, amount };
}

function refundAmountForResolution(
  resolutionType: SupportResolutionType,
  selected: ReturnType<typeof assertRefundAmountWithinAffectedLines>,
) {
  if (!isRefundReleaseResolution(resolutionType)) {
    return selected.amount;
  }

  return selected.amount ?? selected.capAmount;
}

function createSupportResolutionOutcomeFact(
  input: Readonly<{
    supportRequestId: SupportRequestId;
    buyerAccountId: AccountId;
    flowType: SupportFlowType;
    resolution: SupportResolution;
  }>,
) {
  return createSupportCsatOutcomeFact({
    outcomeCode: input.flowType === "return-request" ? "return.resolved" : "support.request-resolved",
    subjectAccountId: input.buyerAccountId,
    subjectKind: "buyer",
    subjectEntityType: input.flowType === "return-request" ? "return" : "support-request",
    subjectEntityId: input.supportRequestId,
    outcomeOccurredAt: input.resolution.resolvedAt,
    idempotencyKey: `support-request:${input.supportRequestId}:resolved`,
  });
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
  const selected = assertRefundAmountWithinAffectedLines(
    state,
    resolutionType === "partial-refund" ? command.refundAmount : null,
    command.affectedLineIds,
    command.refundCurrencyCode,
    resolutionType === "partial-refund",
  );
  const refundAmount = refundAmountForResolution(resolutionType, selected);
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

function resolveFromOffer(
  flowType: SupportFlowType,
  offer: SupportOffer,
  acceptedByAccountId: AccountId | null,
): SupportResolution {
  return {
    resolutionType: offer.resolutionType,
    summary: `Party agreement accepted offer ${offer.offerId}: ${offer.summary}`,
    refundAmount: offer.refundAmount,
    resolvedByAccountId: acceptedByAccountId,
    resolvedByRole: offer.decidedByRole,
    resolvedAt: offer.decidedAt!,
    ...acceptedOfferResponsibilityFact(flowType, offer.offerId),
  };
}

function resolutionsMatch(left: SupportResolution | null, right: SupportResolution): boolean {
  return (
    left !== null &&
    left.resolutionType === right.resolutionType &&
    left.summary === right.summary &&
    left.refundAmount === right.refundAmount &&
    left.resolvedByAccountId === right.resolvedByAccountId &&
    left.resolvedByRole === right.resolvedByRole &&
    left.resolvedAt === right.resolvedAt &&
    left.responsibility === right.responsibility &&
    left.evidenceBasis.type === right.evidenceBasis.type &&
    left.evidenceBasis.reference === right.evidenceBasis.reference &&
    left.responsibilityReasonCode === right.responsibilityReasonCode
  );
}

export const decideSupportRequest: AggregateDecider<SupportRequestState, SupportRequestCommand, SupportRequestEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "OpenSupportRequest": {
      const flowType = normalizeFlowType(command.flowType);
      if (state.supportRequestId !== null) {
        assert(
          state.supportRequestId === command.supportRequestId &&
            state.orderId === command.orderId &&
            state.buyerAccountId === command.buyerAccountId &&
            state.sellerAccountId === command.sellerAccountId &&
            state.flowType === flowType &&
            state.openedByAccountId === command.openedByAccountId &&
            state.openedByRole === command.openedByRole &&
            state.openedAt === command.openedAt,
          "Support request is already open with different evidence.",
        );
        return [];
      }
      const definition = getSupportFlowDefinition(flowType);
      const openedByRole = normalizeRequesterRole(command.openedByRole);
      assert(definition.openedBy.includes(openedByRole), "This support flow cannot be opened by that role.");

      const openedAt = normalizeIsoTimestamp(command.openedAt, "Support request opening must record a timestamp.");
      const deliveredAt = command.deliveredAt
        ? normalizeIsoTimestamp(command.deliveredAt, "Order delivery must record a timestamp.")
        : null;
      if (definition.postDeliveryOpenWindowDays !== null && deliveredAt !== null) {
        const openWindowEndsAt = Date.parse(deliveredAt) + definition.postDeliveryOpenWindowDays * 24 * 60 * 60 * 1000;
        assert(
          Date.parse(openedAt) <= openWindowEndsAt,
          `Order problems must be reported within ${definition.postDeliveryOpenWindowDays} days of delivery. Authenticity concerns can still be reported at any time.`,
        );
      }
      const orderTotalAmount = normalizeMoneyAmount(command.orderTotalAmount, "Order total");
      assert(orderTotalAmount !== null, "Support request must include the order total.");
      const checklist = createChecklist(flowType);
      const status = statusForOpenedRequest(flowType, orderTotalAmount, definition.initialStatus);
      // The support-deadline policy is resolved once, by the caller, before
      // this decider runs (see `../api/runtime.ts`'s `openSupportRequest`)
      // and arrives here already stamped onto the command -- the fairness
      // invariant (a policy revision affects only newly opened requests) and
      // the m114 LAW (deciders consume stamped values, never re-read policy
      // live) both fall out of that: this function never calls the policy
      // resolver itself. Omitted fields fall back to the flow catalog's
      // compiled default, so seeds and any pre-policy call site are unaffected.
      const sellerResponseHours =
        command.sellerResponseHours === undefined ? definition.sellerResponseHours : command.sellerResponseHours;
      assert(
        definition.sellerResponseHours !== null || sellerResponseHours === null,
        "This support flow has no seller-response phase; seller response hours must stay null.",
      );
      const supportReviewHours = command.supportReviewHours ?? definition.supportReviewHours;
      const events: SupportRequestEvent[] = [
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
            deliveredAt,
            postDeliveryOpenWindowDays: definition.postDeliveryOpenWindowDays,
            sellerResponseDueAt: addHours(openedAt, sellerResponseHours),
            supportReviewDueAt: addHours(openedAt, supportReviewHours),
            sellerConditionAttestationDueAt: null,
            orderReturnContext: normalizeOrderReturnContext(command.orderReturnContext),
            returnInvestigation: null,
            checklist,
          },
        },
      ];
      const affectedLineItems = normalizeAffectedLineItems(command.affectedLineItems);
      if (affectedLineItems.length > 0) {
        events.push({
          type: "support.support-request.affected-line-items-recorded",
          data: {
            supportRequestId: command.supportRequestId,
            affectedLineItems,
          },
        });
      }
      return events;
    }
    case "SubmitSupportEvidence": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      const evidence = normalizeEvidence(command);
      const existingEvidence = state.evidence.find((candidate) => candidate.evidenceId === evidence.evidenceId);
      if (existingEvidence) {
        assert(
          JSON.stringify(existingEvidence) === JSON.stringify(evidence),
          "Support evidence id is already used for different evidence.",
        );
        return [];
      }
      assert(
        state.status !== "resolved" && state.status !== "closed" && state.status !== "cancelled",
        "Closed support requests cannot accept evidence.",
      );
      assert(state.flowType !== null, "Support request flow is missing.");
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
        assert(
          definition.confirmedResponseResponsibility !== undefined,
          "Confirmed cancellation responsibility must be defined by the support flow.",
        );
        const resolution: SupportResolution = {
          resolutionType: "cancel-order",
          summary: "Seller confirmed the buyer cancellation request.",
          refundAmount: null,
          resolvedByAccountId: response.submittedByAccountId,
          resolvedByRole: response.submittedByRole,
          resolvedAt: response.submittedAt,
          ...createSupportResponsibilityFact({
            flowType: state.flowType,
            ...definition.confirmedResponseResponsibility,
          }),
        };
        const resolvedEvent: SupportRequestResolvedEvent = {
          type: "support.support-request.resolved",
          data: {
            supportRequestId: state.supportRequestId,
            orderId: state.orderId!,
            buyerAccountId: state.buyerAccountId!,
            sellerAccountId: state.sellerAccountId!,
            flowType: state.flowType,
            resolution,
            autoCloseDueAt: autoCloseDueAtFor(response.submittedAt),
          },
        };
        return [
          responseRecorded,
          resolvedEvent,
          {
            type: supportCsatOutcomeFactEventType,
            data: createSupportResolutionOutcomeFact({
              supportRequestId: state.supportRequestId,
              buyerAccountId: state.buyerAccountId!,
              flowType: state.flowType,
              resolution,
            }),
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
      const resolution = resolveFromOffer(state.flowType!, acceptedOffer, command.acceptedByAccountId ?? null);
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
        {
          type: supportCsatOutcomeFactEventType,
          data: createSupportResolutionOutcomeFact({
            supportRequestId: state.supportRequestId,
            buyerAccountId: state.buyerAccountId!,
            flowType: state.flowType!,
            resolution,
          }),
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
      const selected = assertRefundAmountWithinAffectedLines(
        state,
        isRefundReleaseResolution(resolutionType) ? command.refundAmount : null,
        command.affectedLineIds,
        command.refundCurrencyCode,
        resolutionType === "partial-refund",
      );
      const responsibilityFact = createSupportResponsibilityFact({
        flowType: state.flowType,
        responsibility: command.responsibility,
        evidenceBasis: command.evidenceBasis,
        responsibilityReasonCode: command.responsibilityReasonCode,
      });
      if (resolvedByRole === null) {
        assert(
          responsibilityFact.evidenceBasis.type === "deterministic-policy",
          "System resolutions require a deterministic policy evidence basis.",
        );
      } else {
        assert(resolvedByRole === "support", "Only support can adjudicate a support request directly.");
        assert(
          responsibilityFact.evidenceBasis.type === "operator-finding" ||
            responsibilityFact.evidenceBasis.type === "insufficient-evidence",
          "Support adjudication requires an operator finding or insufficient evidence basis.",
        );
      }
      const resolution: SupportResolution = {
        resolutionType,
        summary: normalizeRequiredText(command.summary, "Support resolution must include a summary."),
        refundAmount: refundAmountForResolution(resolutionType, selected),
        resolvedByAccountId: command.resolvedByAccountId ?? null,
        resolvedByRole,
        resolvedAt: normalizeIsoTimestamp(command.resolvedAt, "Support resolution must record a timestamp."),
        ...responsibilityFact,
      };
      if (state.status === "resolved") {
        assert(resolutionsMatch(state.resolution, resolution), "Support request already has a different resolution.");
        return [];
      }
      const resolvedEvent: SupportRequestResolvedEvent = {
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
      };
      return [
        resolvedEvent,
        {
          type: supportCsatOutcomeFactEventType,
          data: createSupportResolutionOutcomeFact({
            supportRequestId: state.supportRequestId,
            buyerAccountId: state.buyerAccountId!,
            flowType: state.flowType,
            resolution,
          }),
        },
      ];
    }
    case "ProposeSupportRemedy": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(state.status === "resolved", "A remedy can only be proposed after the support decision is made.");
      assert(state.resolution?.refundAmount, "Only a monetary support decision can propose this remedy.");
      assert(state.remedy === null, "This support request already has an authorized remedy.");
      assert(command.terms.supportRequestId === state.supportRequestId, "Remedy proposal belongs to another case.");
      assert(
        compareMoneyAmounts(command.terms.remedy.amount, state.resolution.refundAmount) === 0,
        "Proposed remedy amount must match the decided refund amount.",
      );
      if (state.remedyApproval) {
        assert(
          state.remedyApproval.terms.idempotencyKey === command.terms.idempotencyKey,
          "This support request already has a different remedy proposal.",
        );
        return [];
      }
      let workflow = createRemedyApprovalWorkflow(command);
      for (const entry of state.deferredRemedyEffectFacts) {
        if (entry.remedyId === command.terms.remedyId && entry.coverageId === command.terms.coverageId) {
          workflow = applyRemedyReservationFact(workflow, entry.fact);
        }
      }
      const events: SupportRequestEvent[] = [
        {
          type: "support.support-request.remedy-proposed",
          data: { supportRequestId: state.supportRequestId, workflow },
        },
      ];
      const coverageRequested = createCoverageRequestedEvent(command.terms);
      if (coverageRequested) events.push(coverageRequested);
      return events;
    }
    case "ApproveSupportRemedy": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(state.remedyApproval !== null, "A remedy must be proposed before approval.");
      if (state.remedyApproval.approvals.some((approval) => approval.idempotencyKey === command.idempotencyKey)) {
        return [];
      }
      const approval = createRemedyApproval(state.remedyApproval, command);
      const approvedWorkflow = applyRemedyApproval(state.remedyApproval, approval);
      const events: SupportRequestEvent[] = [
        {
          type: "support.support-request.remedy-approved",
          data: {
            supportRequestId: state.supportRequestId,
            remedyId: state.remedyApproval.terms.remedyId as RemedyId,
            approval,
          },
        },
      ];
      if (approvedWorkflow.status !== "approved") return events;
      assert(state.remedy === null, "This support request already has an authorized remedy.");
      const authorization = { ...approvedWorkflow.terms, occurredAt: command.approvedAt };
      const deferredEntries = state.deferredRemedyEffectFacts.filter(
        (entry) =>
          entry.remedyId === authorization.remedyId &&
          (entry.coverageId == null || entry.coverageId === authorization.coverageId),
      );
      const remedy = createRemedyExecution(
        authorization,
        deferredEntries.map((entry) => entry.fact),
      );
      events.push({ type: "support.support-request.remedy-authorized.v1", data: authorization });
      events.push(...appendAutomaticRemedyEvents(remedy, command.approvedAt, command.idempotencyKey));
      return events;
    }
    case "RetrySupportRemedyEffect": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(state.remedy !== null, "A remedy must be authorized before an effect can be retried.");
      assert(state.remedyApproval !== null, "Remedy approval audit state is required for a retry.");
      assert(state.remedy.remedyId === command.remedyId, "Retry belongs to a different remedy.");
      if (state.remedyApproval.auditTrail.some((entry) => entry.correlationId === command.idempotencyKey)) return [];
      const effect = normalizeRemedyEffectKind(String(command.effect));
      const current = state.remedy.effects.find((candidate) => candidate.effect === effect);
      assert(current?.status === "failed-retryable", "Only a retryable failed effect can be retried.");
      return [
        {
          type: "support.support-request.remedy-effect-retry-requested",
          data: {
            supportRequestId: state.supportRequestId,
            remedyId: command.remedyId,
            effect,
            requestedByAccountId: command.requestedByAccountId,
            permissionUsed: command.permissionUsed,
            reasonCode: normalizeRequiredText(command.reasonCode, "Retry requires a structured reason."),
            rationale: normalizeRequiredText(command.rationale, "Retry requires a rationale."),
            idempotencyKey: normalizeRequiredText(command.idempotencyKey, "Retry idempotency key is required."),
            requestedAt: normalizeIsoTimestamp(command.requestedAt, "Retry must record a timestamp."),
          },
        },
      ];
    }
    case "RequestSupportRemedyCorrection": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(state.remedyApproval !== null, "A remedy must be proposed before requesting a correction.");
      if (state.remedyApproval.auditTrail.some((entry) => entry.correlationId === command.idempotencyKey)) return [];
      const evidenceReferences = command.evidenceReferences.map((reference) => reference.trim()).filter(Boolean);
      assert(evidenceReferences.length > 0, "Correction request requires evidence references.");
      return [
        {
          type: "support.support-request.remedy-correction-requested",
          data: {
            supportRequestId: state.supportRequestId,
            remedyId: state.remedyApproval.terms.remedyId as RemedyId,
            requestedByAccountId: command.requestedByAccountId,
            permissionUsed: command.permissionUsed,
            reasonCode: normalizeRequiredText(command.reasonCode, "Correction requires a structured reason."),
            rationale: normalizeRequiredText(command.rationale, "Correction requires a rationale."),
            evidenceReferences,
            idempotencyKey: normalizeRequiredText(
              command.idempotencyKey,
              "Correction request idempotency key is required.",
            ),
            requestedAt: normalizeIsoTimestamp(command.requestedAt, "Correction request must record a timestamp."),
          },
        },
      ];
    }
    case "AuthorizeSupportRemedy": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(state.status === "resolved", "A remedy can only be authorized after the support decision is made.");
      assert(state.resolution?.refundAmount, "Only a monetary support decision can authorize this remedy.");
      assert(
        state.remedyApproval?.status === "approved",
        "A remedy must satisfy reservation and approval policy first.",
      );
      const authorization = normalizeRemedyAuthorization(state.supportRequestId, command);
      assert(
        state.remedyApproval.terms.idempotencyKey === authorization.idempotencyKey,
        "Authorization must use the approved proposal terms.",
      );
      assert(
        compareMoneyAmounts(authorization.remedy.amount, state.resolution.refundAmount) === 0,
        "Authorized remedy amount must match the decided refund amount.",
      );
      if (state.remedy) {
        assert(
          state.remedy.authorizationIdempotencyKey === authorization.idempotencyKey,
          "This support request already has a different authorized remedy.",
        );
        return [];
      }

      const deferredEntries = state.deferredRemedyEffectFacts.filter(
        (entry) =>
          entry.remedyId === authorization.remedyId &&
          (entry.coverageId == null || entry.coverageId === authorization.coverageId),
      );
      for (const entry of deferredEntries) {
        if (
          authorization.coverageId !== null &&
          (entry.fact.effect === "coverage-reservation" || entry.fact.effect === "settlement-reconciliation")
        ) {
          assert(
            entry.coverageId === authorization.coverageId,
            "Financial remedy fact requires the matching coverage id.",
          );
        }
      }
      const deferredFacts = deferredEntries.map((entry) => entry.fact);
      const remedy = createRemedyExecution(authorization, deferredFacts);
      for (const fact of deferredFacts) {
        assertRemedyEffectCompatibility(remedy, fact);
      }
      const events: SupportRequestRemedyEvent[] = [
        { type: "support.support-request.remedy-authorized.v1", data: authorization },
      ];
      events.push(...appendAutomaticRemedyEvents(remedy, authorization.occurredAt, authorization.idempotencyKey));
      return events;
    }
    case "RecordSupportRemedyEffect": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      const fact = normalizeRemedyEffectFact(command);
      const coverageId = command.coverageId ?? null;
      if (
        remedyHasProcessedFact(state.remedy, fact.idempotencyKey) ||
        state.deferredRemedyEffectFacts.some((entry) => entry.fact.idempotencyKey === fact.idempotencyKey)
      ) {
        return [];
      }
      if (state.remedy) {
        assert(state.remedy.remedyId === command.remedyId, "Remedy effect belongs to a different remedy.");
        assert(
          coverageId == null || state.remedy.coverageId === coverageId,
          "Remedy effect coverage id does not match the authorized remedy.",
        );
        if (
          state.remedy.coverageId !== null &&
          (fact.effect === "coverage-reservation" || fact.effect === "settlement-reconciliation")
        ) {
          assert(coverageId === state.remedy.coverageId, "Financial remedy fact requires the matching coverage id.");
        }
        assert(
          state.remedy.effects.some((effect) => effect.effect === fact.effect),
          "Remedy effect is not required by the authorized policy.",
        );
        assert(
          fact.refundId == null || state.remedy.refundId == null || fact.refundId === state.remedy.refundId,
          "Remedy effects must reconcile to the same refund id.",
        );
        assertRemedyEffectCompatibility(state.remedy, fact);
      }
      const recorded: SupportRequestRemedyEffectRecordedEvent = {
        type: "support.support-request.remedy-effect-recorded",
        data: {
          supportRequestId: state.supportRequestId,
          remedyId: command.remedyId,
          coverageId,
          fact,
        },
      };
      if (!state.remedy) {
        return [recorded];
      }
      const remedy = applyRemedyEffectFact(state.remedy, fact);
      return [recorded, ...appendAutomaticRemedyEvents(remedy, fact.occurredAt, fact.sourceFactId)];
    }
    case "OverrideSupportRemedyEffect": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      assert(state.remedy !== null, "A remedy must be authorized before an effect can be overridden.");
      assert(state.remedy.remedyId === command.remedyId, "Remedy override belongs to a different remedy.");
      const { effect, waiver } = createRemedyEffectWaiver(command);
      const current = state.remedy.effects.find((candidate) => candidate.effect === effect);
      assert(current, "Remedy effect is not required by the authorized policy.");
      if (current.waiver?.idempotencyKey === waiver.idempotencyKey) {
        return [];
      }
      const waivedEvent: SupportRequestRemedyEvent = {
        type: "support.support-request.remedy-effect-waived",
        data: {
          supportRequestId: state.supportRequestId,
          remedyId: command.remedyId,
          effect,
          waiver,
        },
      };
      const remedy = applyRemedyEffectWaiver(state.remedy, effect, waiver);
      return [waivedEvent, ...appendAutomaticRemedyEvents(remedy, waiver.waivedAt, waiver.idempotencyKey)];
    }
    case "CloseSupportRequest": {
      assert(state.supportRequestId !== null, "Support request must be opened first.");
      if (state.status === "closed") {
        return [];
      }
      assert(state.status === "resolved", "Only resolved support requests can be closed.");
      assert(
        state.remedy === null || state.remedy.status === "completed",
        "A support request cannot close until every required remedy effect is complete.",
      );
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
      assert(state.flowType !== null, "Support response reminder requires a support flow.");
      assert(
        state.status === "waiting-on-seller",
        "Support response reminders only apply while waiting on the seller.",
      );
      assert(state.sellerResponseDueAt !== null, "Support response reminder requires a response deadline.");
      assert(state.sellerResponseReminderSentAt === null, "Support response reminder has already been emitted.");
      const definition = getSupportFlowDefinition(state.flowType);
      return [
        {
          type: "support.support-request.response-reminder-emitted",
          data: {
            supportRequestId: state.supportRequestId,
            remindedAt: normalizeIsoTimestamp(command.remindedAt, "Support response reminder must record a timestamp."),
            actingRole: "seller",
            dueAt: state.sellerResponseDueAt,
            deadlineOutcome: definition.autoResolvesOnSellerSilence
              ? { type: "automatic-resolution", resolutionType: definition.defaultResolution }
              : { type: "support-review" },
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
        deliveredAt: event.data.deliveredAt ?? null,
        postDeliveryOpenWindowDays: event.data.postDeliveryOpenWindowDays ?? null,
        updatedAt: event.data.openedAt,
        sellerResponseDueAt: event.data.sellerResponseDueAt,
        supportReviewDueAt: event.data.supportReviewDueAt,
        sellerConditionAttestationDueAt: event.data.sellerConditionAttestationDueAt,
        orderReturnContext: event.data.orderReturnContext,
        affectedLineItems: [],
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
        remedy: null,
        remedyApproval: null,
        deferredRemedyEffectFacts: [],
      };
    case "support.support-request.affected-line-items-recorded":
      return {
        ...state,
        affectedLineItems: event.data.affectedLineItems,
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
    case "support.support-request.resolved": {
      const resolution = normalizeSupportResolutionForReplay(event.data.resolution, event.data.flowType);
      return {
        ...state,
        status: "resolved",
        updatedAt: resolution.resolvedAt,
        resolution,
        autoCloseDueAt: event.data.autoCloseDueAt,
        returnRefundGateStatus: resolution.resolutionType === "return-for-refund" ? "awaiting-return-delivery" : null,
      };
    }
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
    case "support.support-request.remedy-proposed":
      return { ...state, remedyApproval: event.data.workflow, autoCloseDueAt: null };
    case "support.support-request.remedy-approved":
      return state.remedyApproval?.terms.remedyId === event.data.remedyId
        ? { ...state, remedyApproval: applyRemedyApproval(state.remedyApproval, event.data.approval) }
        : state;
    case "support.support-request.remedy-effect-retry-requested":
      return state.remedyApproval?.terms.remedyId === event.data.remedyId
        ? { ...state, remedyApproval: applyRemedyRetryRequest(state.remedyApproval, event) }
        : state;
    case "support.support-request.remedy-correction-requested":
      return state.remedyApproval?.terms.remedyId === event.data.remedyId
        ? { ...state, remedyApproval: applyRemedyCorrectionRequest(state.remedyApproval, event) }
        : state;
    case "support.support-request.remedy-authorized.v1": {
      const deferred = state.deferredRemedyEffectFacts
        .filter(
          (entry) =>
            entry.remedyId === event.data.remedyId &&
            (entry.coverageId == null || entry.coverageId === event.data.coverageId),
        )
        .map((entry) => entry.fact);
      return {
        ...state,
        remedy: createRemedyExecution(event.data, deferred),
        remedyApproval: state.remedyApproval
          ? markRemedyWorkflowAuthorized(state.remedyApproval, event.data.occurredAt)
          : state.remedyApproval,
        autoCloseDueAt: null,
      };
    }
    case "support.support-request.platform-coverage-requested.v1":
      return state;
    case "support.support-request.remedy-effect-recorded":
      if (state.remedy?.remedyId === event.data.remedyId) {
        return {
          ...state,
          remedy: applyRemedyEffectFact(state.remedy, event.data.fact),
          remedyApproval:
            state.remedyApproval?.terms.remedyId === event.data.remedyId
              ? applyRemedyReservationFact(state.remedyApproval, event.data.fact)
              : state.remedyApproval,
        };
      }
      if (
        state.deferredRemedyEffectFacts.some((entry) => entry.fact.idempotencyKey === event.data.fact.idempotencyKey)
      ) {
        return state;
      }
      return {
        ...state,
        deferredRemedyEffectFacts: [...state.deferredRemedyEffectFacts, event.data],
        remedyApproval:
          state.remedyApproval?.terms.remedyId === event.data.remedyId
            ? applyRemedyReservationFact(state.remedyApproval, event.data.fact)
            : state.remedyApproval,
      };
    case "support.support-request.remedy-effect-waived":
      return state.remedy?.remedyId === event.data.remedyId
        ? {
            ...state,
            remedy: applyRemedyEffectWaiver(state.remedy, event.data.effect, event.data.waiver),
            remedyApproval:
              state.remedyApproval?.terms.remedyId === event.data.remedyId
                ? applyRemedyWaiverAudit(state.remedyApproval, event.data.effect, event.data.waiver)
                : state.remedyApproval,
          }
        : state;
    case "support.support-request.refund-released.v1":
      return state.remedy?.remedyId === event.data.remedyId
        ? { ...state, remedy: { ...state.remedy, refundReleasedAt: event.data.occurredAt } }
        : state;
    case "support.support-request.remedy-completed.v1":
      return state.remedy?.remedyId === event.data.remedyId
        ? {
            ...state,
            remedy: {
              ...state.remedy,
              status: "completed",
              completedAt: event.data.completedAt,
              refundId: event.data.refundId,
            },
            autoCloseDueAt: autoCloseDueAtFor(event.data.completedAt),
          }
        : state;
    case supportCsatOutcomeFactEventType:
      return state;
    default:
      return assertNever(event);
  }
};
