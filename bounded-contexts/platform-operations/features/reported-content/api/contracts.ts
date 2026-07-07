export type ReportedContentQueueStatus =
  | "needs-review"
  | "auto-unlisted"
  | "dismissed"
  | "seller-contact-requested"
  | "manually-unlisted"
  | "suspension-escalated";
export type ReportedContentTargetType = "listing" | "review";
export type ReportedContentModerationAction = "dismiss" | "contact-seller" | "unlist" | "escalate-account-suspension";

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
