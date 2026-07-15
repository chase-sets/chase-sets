import type { DomainEvent } from "@chase-sets/event-core";
import type { TypedUlid } from "@chase-sets/primitives/typed-ids";
import type { CsatSurveySubmittedEvent } from "../../csat/domain/invitation";

export type FeedbackCaseId = TypedUlid<"fbcase">;

export const feedbackCaseStatuses = ["new", "triaged", "actioned", "closed"] as const;
export type FeedbackCaseStatus = (typeof feedbackCaseStatuses)[number];

export const feedbackCasePriorities = ["low", "normal", "high", "urgent"] as const;
export type FeedbackCasePriority = (typeof feedbackCasePriorities)[number];

export const feedbackCaseDispositions = [
  "support-resolved",
  "product-change",
  "customer-education",
  "no-action",
  "duplicate",
  "spam",
  "redacted",
] as const;
export type FeedbackCaseDisposition = (typeof feedbackCaseDispositions)[number];

export const feedbackCaseOpenReasons = ["low-score", "flagged"] as const;
export type FeedbackCaseOpenReason = (typeof feedbackCaseOpenReasons)[number];

export const feedbackCaseWorkItemKinds = ["support-request", "product-work-item"] as const;
export type FeedbackCaseWorkItemKind = (typeof feedbackCaseWorkItemKinds)[number];

export type FeedbackCaseWorkItem = Readonly<{
  kind: FeedbackCaseWorkItemKind;
  reference: string;
}>;

export const feedbackCaseFollowUpStatuses = ["not-requested", "requested", "sent", "completed", "cancelled"] as const;
export type FeedbackCaseFollowUpStatus = (typeof feedbackCaseFollowUpStatuses)[number];

export const feedbackCaseFollowUpOutcomes = ["resolved", "unresolved", "no-response", "declined"] as const;
export type FeedbackCaseFollowUpOutcome = (typeof feedbackCaseFollowUpOutcomes)[number];

export const feedbackCaseFollowUpDeliveryStatuses = [
  "not-requested",
  "pending",
  "sent",
  "failed",
  "suppressed",
  "retry-exhausted",
  "no-recipient",
] as const;
export type FeedbackCaseFollowUpDeliveryStatus = (typeof feedbackCaseFollowUpDeliveryStatuses)[number];

export const feedbackCaseFollowUpChannels = ["web", "email", "sms", "rcs"] as const;
export type FeedbackCaseFollowUpChannel = (typeof feedbackCaseFollowUpChannels)[number];

export type FeedbackCaseConsent = Readonly<{
  status: "granted" | "not-granted" | "withdrawn";
  version: string;
  grantedAt: string | null;
  withdrawnAt: string | null;
}>;

export type FeedbackCaseSourceResponse = Readonly<
  Pick<
    CsatSurveySubmittedEvent["data"],
    "invitationId" | "surveyVersion" | "rating" | "submissionIdempotencyKey" | "submittedAt"
  >
> &
  Readonly<{ subjectAccountId: string }>;

export type FeedbackCase = Readonly<{
  caseId: FeedbackCaseId;
  sourceResponse: FeedbackCaseSourceResponse;
  openReason: FeedbackCaseOpenReason;
  status: FeedbackCaseStatus;
  ownerId: string | null;
  priority: FeedbackCasePriority;
  dueAt: string | null;
  disposition: FeedbackCaseDisposition | null;
  duplicateOfCaseId: FeedbackCaseId | null;
  workItems: readonly FeedbackCaseWorkItem[];
  consent: FeedbackCaseConsent;
  followUpStatus: FeedbackCaseFollowUpStatus;
  followUpDeliveryStatus: FeedbackCaseFollowUpDeliveryStatus;
  followUpDeliveryReference: string | null;
  followUpChannel: FeedbackCaseFollowUpChannel | null;
  followUpTemplateVersion: number | null;
  followUpSentAt: string | null;
  followUpOutcome: FeedbackCaseFollowUpOutcome | null;
  attentionDeliveryStatus: FeedbackCaseFollowUpDeliveryStatus;
  attentionDeliveryReference: string | null;
  openedAt: string;
  triagedAt: string | null;
  actionedAt: string | null;
  closedAt: string | null;
  reopenedAt: string | null;
}>;

export type FeedbackCaseActor = Readonly<{
  actorId: string;
  authority: "view-feedback-cases" | "manage-feedback-cases" | "notify-feedback-cases" | "export-feedback-cases";
}>;

export type FeedbackCaseCapability = "view" | "manage" | "notify" | "export";

export function feedbackCaseActorCan(actor: FeedbackCaseActor, capability: FeedbackCaseCapability): boolean {
  return (
    (capability === "view" &&
      ["view-feedback-cases", "manage-feedback-cases", "notify-feedback-cases", "export-feedback-cases"].includes(
        actor.authority,
      )) ||
    (capability === "manage" && actor.authority === "manage-feedback-cases") ||
    (capability === "notify" && ["notify-feedback-cases", "manage-feedback-cases"].includes(actor.authority)) ||
    (capability === "export" && ["export-feedback-cases", "manage-feedback-cases"].includes(actor.authority))
  );
}

type Attributed<T> = T & Readonly<{ eventSchemaVersion: 1; actorId: string; actedAt: string }>;

export type FeedbackCaseOpenedEvent = DomainEvent<
  "customer-feedback.case.opened",
  Attributed<{
    caseId: FeedbackCaseId;
    sourceResponse: FeedbackCaseSourceResponse;
    openReason: FeedbackCaseOpenReason;
    priority: FeedbackCasePriority;
    consent: FeedbackCaseConsent;
  }>
>;

export type FeedbackCaseTriagedEvent = DomainEvent<
  "customer-feedback.case.triaged",
  Attributed<{ caseId: FeedbackCaseId }>
>;

export type FeedbackCaseAssignedEvent = DomainEvent<
  "customer-feedback.case.assigned",
  Attributed<{ caseId: FeedbackCaseId; ownerId: string }>
>;

export type FeedbackCaseUnassignedEvent = DomainEvent<
  "customer-feedback.case.unassigned",
  Attributed<{ caseId: FeedbackCaseId; previousOwnerId: string }>
>;

export type FeedbackCasePrioritySetEvent = DomainEvent<
  "customer-feedback.case.priority-set",
  Attributed<{ caseId: FeedbackCaseId; priority: FeedbackCasePriority }>
>;

export type FeedbackCaseDueDateSetEvent = DomainEvent<
  "customer-feedback.case.due-date-set",
  Attributed<{ caseId: FeedbackCaseId; dueAt: string | null }>
>;

export type FeedbackCaseDispositionSetEvent = DomainEvent<
  "customer-feedback.case.disposition-set",
  Attributed<{
    caseId: FeedbackCaseId;
    disposition: FeedbackCaseDisposition;
    duplicateOfCaseId: FeedbackCaseId | null;
  }>
>;

export type FeedbackCaseWorkItemLinkedEvent = DomainEvent<
  "customer-feedback.case.work-item-linked",
  Attributed<{ caseId: FeedbackCaseId; workItem: FeedbackCaseWorkItem }>
>;

export type FeedbackCaseWorkItemUnlinkedEvent = DomainEvent<
  "customer-feedback.case.work-item-unlinked",
  Attributed<{ caseId: FeedbackCaseId; workItem: FeedbackCaseWorkItem }>
>;

export type FeedbackCaseFollowUpRequestedEvent = DomainEvent<
  "customer-feedback.case.follow-up-requested",
  Attributed<{
    caseId: FeedbackCaseId;
    consentVersion: string;
    recipientAccountId: string;
    channel?: FeedbackCaseFollowUpChannel;
    templateVersion?: number;
  }>
>;

export type FeedbackCaseFollowUpSentEvent = DomainEvent<
  "customer-feedback.case.follow-up-sent",
  Attributed<{
    caseId: FeedbackCaseId;
    deliveryReference: string;
    channel?: FeedbackCaseFollowUpChannel;
    templateVersion?: number;
  }>
>;

export type FeedbackCaseFollowUpDeliveryOutcome = "sent" | "failed" | "suppressed" | "retry-exhausted" | "no-recipient";

export type FeedbackCaseFollowUpDeliveryOutcomeRecordedEvent = DomainEvent<
  "customer-feedback.case.follow-up-delivery-outcome-recorded",
  Attributed<{
    caseId: FeedbackCaseId;
    deliveryReference: string | null;
    outcome: FeedbackCaseFollowUpDeliveryOutcome;
    channel?: FeedbackCaseFollowUpChannel | null;
    templateVersion?: number | null;
  }>
>;

export type FeedbackCaseAttentionRequestedEvent = DomainEvent<
  "customer-feedback.case.attention-requested",
  Attributed<{
    caseId: FeedbackCaseId;
    attentionId: string;
    reason: "low-score" | "reopened";
    ruleVersion: string;
    rating: number;
    priority: FeedbackCasePriority;
    ownerId: string | null;
    dueAt: string | null;
    adminHref: string;
  }>
>;

export type FeedbackCaseAttentionDeliveryOutcomeRecordedEvent = DomainEvent<
  "customer-feedback.case.attention-delivery-outcome-recorded",
  Attributed<{
    caseId: FeedbackCaseId;
    attentionId: string;
    deliveryReference: string | null;
    outcome: FeedbackCaseFollowUpDeliveryOutcome;
  }>
>;

export type FeedbackCaseFollowUpOutcomeRecordedEvent = DomainEvent<
  "customer-feedback.case.follow-up-outcome-recorded",
  Attributed<{ caseId: FeedbackCaseId; outcome: FeedbackCaseFollowUpOutcome }>
>;

export type FeedbackCaseFollowUpConsentWithdrawnEvent = DomainEvent<
  "customer-feedback.case.follow-up-consent-withdrawn",
  Attributed<{ caseId: FeedbackCaseId; consentVersion: string }>
>;

export type FeedbackCaseClosedEvent = DomainEvent<
  "customer-feedback.case.closed",
  Attributed<{ caseId: FeedbackCaseId }>
>;

export type FeedbackCaseReopenedEvent = DomainEvent<
  "customer-feedback.case.reopened",
  Attributed<{ caseId: FeedbackCaseId }>
>;

export type FeedbackCaseEvent =
  | FeedbackCaseOpenedEvent
  | FeedbackCaseTriagedEvent
  | FeedbackCaseAssignedEvent
  | FeedbackCaseUnassignedEvent
  | FeedbackCasePrioritySetEvent
  | FeedbackCaseDueDateSetEvent
  | FeedbackCaseDispositionSetEvent
  | FeedbackCaseWorkItemLinkedEvent
  | FeedbackCaseWorkItemUnlinkedEvent
  | FeedbackCaseFollowUpRequestedEvent
  | FeedbackCaseFollowUpSentEvent
  | FeedbackCaseFollowUpDeliveryOutcomeRecordedEvent
  | FeedbackCaseFollowUpOutcomeRecordedEvent
  | FeedbackCaseFollowUpConsentWithdrawnEvent
  | FeedbackCaseClosedEvent
  | FeedbackCaseReopenedEvent
  | FeedbackCaseAttentionRequestedEvent
  | FeedbackCaseAttentionDeliveryOutcomeRecordedEvent;

export const feedbackCaseEventTypes = [
  "customer-feedback.case.opened",
  "customer-feedback.case.triaged",
  "customer-feedback.case.assigned",
  "customer-feedback.case.unassigned",
  "customer-feedback.case.priority-set",
  "customer-feedback.case.due-date-set",
  "customer-feedback.case.disposition-set",
  "customer-feedback.case.work-item-linked",
  "customer-feedback.case.work-item-unlinked",
  "customer-feedback.case.follow-up-requested",
  "customer-feedback.case.follow-up-sent",
  "customer-feedback.case.follow-up-delivery-outcome-recorded",
  "customer-feedback.case.follow-up-outcome-recorded",
  "customer-feedback.case.follow-up-consent-withdrawn",
  "customer-feedback.case.closed",
  "customer-feedback.case.reopened",
  "customer-feedback.case.attention-requested",
  "customer-feedback.case.attention-delivery-outcome-recorded",
] as const;
