import type { AccountId, OrderId, ReviewId } from "@chase-sets/primitives/typed-ids";

export type ReviewStatus = "active" | "withdrawn";
export type ReviewRole = "buyer" | "seller";

// Double-blind reveal window (m108): a submitted review stays hidden
// (excluded from public lists, summaries, and every downstream reputation
// aggregate) until EITHER the counterpart review for the same order submits
// OR this many days elapse from the review's own submission-eligibility
// deadline -- whichever comes first. The same duration gates submission
// itself: eligibility captured more than this many days ago can no longer be
// used to submit a new review ("review window closed"). A documented domain
// constant, not a platform-policy value: the acceptance criteria do not ask
// for runtime configurability, and this is already the largest domain change
// in the milestone.
export const REVIEW_WINDOW_DAYS = 60;

// Post-delivery review nudge (m108): a single reminder fires this many
// days after eligibility if the author has not submitted yet and the
// submission window (REVIEW_WINDOW_DAYS) is still open. One reminder per
// order per direction -- the sweep marks `reminder_notified_at` the moment it
// enqueues, so it never fires twice for the same eligibility grant.
export const REVIEW_NUDGE_REMINDER_DELAY_DAYS = 7;

export type ReviewRevealReason = "counterpart-submitted" | "window-expired";

export type ReviewSummary = Readonly<{
  accountId: AccountId;
  averageRating: string | null;
  reviewCount: number;
  rating1Count: number;
  rating2Count: number;
  rating3Count: number;
  rating4Count: number;
  rating5Count: number;
  updatedAt: string | null;
}>;

export type ReviewSnapshot = Readonly<{
  reviewId: ReviewId;
  orderId: OrderId;
  authorAccountId: AccountId;
  subjectAccountId: AccountId;
  authorRole: ReviewRole;
  rating: number;
  feedback: string | null;
  status: ReviewStatus;
  submittedAt: string;
  updatedAt: string;
  withdrawnAt: string | null;
}>;

export class ReputationDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReputationDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ReputationDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new ReputationDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

export function normalizeOptionalText(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function ensureIsoTimestamp(value: string, message: string): string {
  assert(!Number.isNaN(Date.parse(value)), message);
  return value;
}

export function normalizeReviewStatus(value: string): ReviewStatus {
  switch (value.trim()) {
    case "active":
      return "active";
    case "withdrawn":
      return "withdrawn";
    default:
      throw new ReputationDomainError("Review status is not supported.");
  }
}

export function normalizeReviewRole(value: string): ReviewRole {
  switch (value.trim()) {
    case "buyer":
      return "buyer";
    case "seller":
      return "seller";
    default:
      throw new ReputationDomainError("Review role is not supported.");
  }
}

export function normalizeRevealReason(value: string): ReviewRevealReason {
  switch (value.trim()) {
    case "counterpart-submitted":
      return "counterpart-submitted";
    case "window-expired":
      return "window-expired";
    default:
      throw new ReputationDomainError("Review reveal reason is not supported.");
  }
}

/** Adds `days` whole days to an ISO timestamp, returning an ISO timestamp. */
export function addReviewWindowDays(timestamp: string, days: number): string {
  const date = new Date(timestamp);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export function normalizeRating(value: number): number {
  assert(Number.isInteger(value), "Rating must be a whole number.");
  assert(value >= 1 && value <= 5, "Rating must be between 1 and 5.");
  return value;
}

export function normalizeFeedback(value?: string | null): string | null {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) {
    return null;
  }

  assert(normalized.length <= 1000, "Feedback must be 1000 characters or fewer.");

  return normalized;
}

// Moderation actions (m108) always carry a required, bounded reason so
// the event itself is the audit trail entry -- no operator action is ever
// reason-less.
export function normalizeModerationReason(value: string): string {
  const normalized = normalizeRequiredText(value, "A moderation reason is required.");
  assert(normalized.length <= 1000, "Moderation reason must be 1000 characters or fewer.");
  return normalized;
}

// A subject reply is never optional text like review feedback -- posting one
// requires content, so it is normalized as required rather than nullable.
export function normalizeReplyFeedback(value: string): string {
  const normalized = normalizeRequiredText(value, "Reply feedback is required.");
  assert(normalized.length <= 1000, "Reply feedback must be 1000 characters or fewer.");
  return normalized;
}
