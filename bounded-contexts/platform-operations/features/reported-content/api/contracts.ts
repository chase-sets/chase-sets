export type ReportedContentQueueStatus =
  | "needs-review"
  | "auto-unlisted"
  | "dismissed"
  | "seller-contact-requested"
  | "manually-unlisted"
  | "suspension-escalated"
  | "review-withdrawn"
  | "review-feedback-redacted"
  | "review-reply-withdrawn";
export type ReportedContentTargetType = "listing" | "review";
export type ReportedContentModerationAction =
  | "dismiss"
  | "contact-seller"
  | "unlist"
  | "escalate-account-suspension"
  // Review-scoped moderation (m108): the review domain commands these
  // dispatch (withdraw / redact-feedback / withdraw the subject reply) live
  // in marketplace, not platform-operations -- see the
  // `marketplace-review-moderation-reaction`.
  | "withdraw-review"
  | "redact-review-feedback"
  | "withdraw-review-reply";

// Actions valid for each target type -- rejecting a listing action against a
// review target (or vice versa) at the runtime boundary, before the event is
// ever appended.
export const REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE: Readonly<
  Record<ReportedContentTargetType, readonly ReportedContentModerationAction[]>
> = {
  listing: ["dismiss", "contact-seller", "unlist", "escalate-account-suspension"],
  review: [
    "dismiss",
    "contact-seller",
    "escalate-account-suspension",
    "withdraw-review",
    "redact-review-feedback",
    "withdraw-review-reply",
  ],
};

// Review-scoped moderation actions must always carry a reason -- the event is
// the audit trail ("every moderation action is an event with actor/reason").
export const REPORTED_CONTENT_ACTIONS_REQUIRING_NOTE: readonly ReportedContentModerationAction[] = [
  "withdraw-review",
  "redact-review-feedback",
  "withdraw-review-reply",
];

export type ReportedContentReportSummary = Readonly<{
  reportId: string;
  reporterKind: string;
  reporterKey: string;
  reporterAccountId: string | null;
  reason: string;
  details: string | null;
  submittedAt: string;
}>;

export type ReportedContentQueueItem = Readonly<{
  target_type: ReportedContentTargetType;
  target_id: string;
  target_owner_account_id: string | null;
  status: ReportedContentQueueStatus;
  report_count: number;
  reasons: readonly { reason: string; count: number }[];
  reports: readonly ReportedContentReportSummary[];
  first_reported_at: string;
  last_reported_at: string;
  auto_unlisted_at: string | null;
  auto_unlist_report_id: string | null;
  auto_unlist_threshold: number | null;
  last_action: ReportedContentModerationAction | null;
  last_action_at: string | null;
  last_action_note: string | null;
  last_action_by_user_id: string | null;
  updated_at: string;
}>;

export type ReportedContentQueueDetail = ReportedContentQueueItem;

export type ReportedContentQueueMetrics = Readonly<{
  total_count: number;
  needs_review_count: number;
  auto_unlisted_count: number;
}>;
