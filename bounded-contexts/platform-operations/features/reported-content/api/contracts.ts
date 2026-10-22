import {
  isPlatformOperationsReportedContentActionFor,
  isPlatformOperationsReportedContentTargetType,
  platformOperationsReportedContentActionRequiresNote,
  platformOperationsReportedContentActionsByTargetType,
  type PlatformOperationsReportedContentModerationAction,
  type PlatformOperationsReportedContentModerationActionFor,
  type PlatformOperationsReportedContentTargetType,
} from "@chase-sets/event-core/public-event-payloads";
import { parseStrictTypedUlid } from "@chase-sets/primitives/typed-ids";

export type ReportedContentQueueStatus =
  | "needs-review"
  | "auto-unlisted"
  | "dismissed"
  | "seller-contact-requested"
  | "manually-unlisted"
  | "suspension-escalated"
  | "review-withdrawn"
  | "review-feedback-redacted"
  | "review-reply-withdrawn"
  | "account-contact-requested"
  | "profile-display-name-redacted";
export type ReportedContentTargetType = PlatformOperationsReportedContentTargetType;
export type ReportedContentModerationAction = PlatformOperationsReportedContentModerationAction;

// The published contract table: each target accepts exactly its actions. The runtime,
// the HTTP route, the admin route and the admin page all derive from it. Review-scoped
// domain commands live in marketplace (`marketplace-review-moderation-reaction`).
export const REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE: Readonly<{
  [TargetType in ReportedContentTargetType]: readonly PlatformOperationsReportedContentModerationActionFor<TargetType>[];
}> = platformOperationsReportedContentActionsByTargetType;

export const REPORTED_CONTENT_TARGET_TYPES = Object.keys(
  REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE,
) as readonly ReportedContentTargetType[];

export const REPORTED_CONTENT_STATUS_BY_ACTION: Readonly<
  Record<ReportedContentModerationAction, ReportedContentQueueStatus>
> = {
  dismiss: "dismissed",
  "contact-seller": "seller-contact-requested",
  unlist: "manually-unlisted",
  "escalate-account-suspension": "suspension-escalated",
  "withdraw-review": "review-withdrawn",
  "redact-review-feedback": "review-feedback-redacted",
  "withdraw-review-reply": "review-reply-withdrawn",
  "contact-account": "account-contact-requested",
  "redact-profile-display-name": "profile-display-name-redacted",
};

export function isReportedContentModerationAction(value: unknown): value is ReportedContentModerationAction {
  return typeof value === "string" && Object.hasOwn(REPORTED_CONTENT_STATUS_BY_ACTION, value);
}

/** Bounded reasons an operator action is refused before anything is appended. */
export const reportedContentActionRejectionCodes = [
  "invalid-request",
  "unknown-target-type",
  "invalid-target-id",
  "unknown-action",
  "action-not-allowed",
  "note-required",
  "target-not-queued",
  "invalid-listing-removal-directive",
] as const;

export type ReportedContentActionRejectionCode = (typeof reportedContentActionRejectionCodes)[number];

/** A refused operator action; it carries only its bounded code, never request text. */
export class ReportedContentActionRejectedError extends Error {
  constructor(readonly code: ReportedContentActionRejectionCode) {
    super(`Reported content action rejected: ${code}.`);
    this.name = "ReportedContentActionRejectedError";
  }
}

export type ReportedContentModerationCommand = {
  [TargetType in ReportedContentTargetType]: Readonly<{
    targetType: TargetType;
    targetId: string;
    action: PlatformOperationsReportedContentModerationActionFor<TargetType>;
    note: string | null;
  }>;
}[ReportedContentTargetType];

/** Validates an operator action against the contract table; rejects with a bounded code. */
export function parseReportedContentModerationCommand(
  input: Readonly<{ targetType: string; targetId: string; action: string; note: string | null }>,
): ReportedContentModerationCommand {
  const { targetType, targetId, action, note } = input;
  if (!isPlatformOperationsReportedContentTargetType(targetType)) {
    throw new ReportedContentActionRejectedError("unknown-target-type");
  }
  if (!targetId || targetId.trim() !== targetId || !isTargetIdFor(targetType, targetId)) {
    throw new ReportedContentActionRejectedError("invalid-target-id");
  }
  if (!isReportedContentModerationAction(action)) {
    throw new ReportedContentActionRejectedError("unknown-action");
  }
  if (!isPlatformOperationsReportedContentActionFor(targetType, action)) {
    throw new ReportedContentActionRejectedError("action-not-allowed");
  }
  if (platformOperationsReportedContentActionRequiresNote(action) && !note?.trim()) {
    throw new ReportedContentActionRejectedError("note-required");
  }
  return { targetType, targetId, action, note } as ReportedContentModerationCommand;
}

function isTargetIdFor(targetType: ReportedContentTargetType, targetId: string): boolean {
  if (targetType !== "account-profile") return true;
  try {
    parseStrictTypedUlid(targetId, "acc");
    return true;
  } catch {
    return false;
  }
}

/** Minimum reporter evidence an operator sees: never the reporter's account, user or key. */
export type ReportedContentReportSummary = Readonly<{
  reportId: string;
  reporterKind: "account" | "visitor";
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

export type ReportedContentQueueDetail = ReportedContentQueueItem &
  Readonly<{
    reports: readonly ReportedContentReportSummary[];
    distinct_reporter_count: number;
  }>;

export type ReportedContentQueueMetrics = Readonly<{
  total_count: number;
  needs_review_count: number;
  auto_unlisted_count: number;
}>;
