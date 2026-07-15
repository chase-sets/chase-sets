import type { DomainEvent } from "@chase-sets/event-core";
import type { FeedbackAttentionReason } from "./attention";
import type { FeedbackCasePriority, FeedbackCaseFollowUpDeliveryOutcome } from "../../cases/domain";

export type FeedbackAttentionDigestItem = Readonly<{
  attentionId: string;
  caseId: string;
  priority: FeedbackCasePriority;
  reason: FeedbackAttentionReason;
  adminHref: string;
}>;

export type FeedbackAttentionDigestRequestedEvent = DomainEvent<
  "customer-feedback.attention.digest-requested",
  Readonly<{
    eventSchemaVersion: 1;
    digestId: string;
    windowStart: string;
    windowEnd: string;
    groupKey: string;
    teamKey: string;
    recipientUserId: string | null;
    items: readonly FeedbackAttentionDigestItem[];
    capped: boolean;
    requestedAt: string;
  }>
>;

export type FeedbackAttentionDigestDeliveryOutcomeRecordedEvent = DomainEvent<
  "customer-feedback.attention.digest-delivery-outcome-recorded",
  Readonly<{
    eventSchemaVersion: 1;
    digestId: string;
    deliveryReference: string | null;
    outcome: FeedbackCaseFollowUpDeliveryOutcome;
    reportedAt: string;
  }>
>;

export type FeedbackAttentionEvent =
  | FeedbackAttentionDigestRequestedEvent
  | FeedbackAttentionDigestDeliveryOutcomeRecordedEvent;

export const feedbackAttentionEventTypes = [
  "customer-feedback.attention.digest-requested",
  "customer-feedback.attention.digest-delivery-outcome-recorded",
] as const;
