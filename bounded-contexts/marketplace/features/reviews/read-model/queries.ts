import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { REVIEW_NUDGE_REMINDER_DELAY_DAYS } from "../domain/common";

export type ReviewListRow = Readonly<{
  review_id: string;
  order_id: string;
  author_account_id: string;
  author_display_name: string | null;
  subject_account_id: string;
  subject_display_name: string | null;
  author_role: string;
  // Double-blind reveal (m108): null when the row has been redacted for
  // the subject's own "received reviews" view of a not-yet-revealed review —
  // "a review is pending" without content. Never null for the author's own
  // written-review view or for a publicly listed (always-revealed) review.
  rating: number | null;
  feedback: string | null;
  status: string;
  submitted_at: string;
  updated_at: string;
  withdrawn_at: string | null;
  revealed_at: string | null;
  reveal_reason: string | null;
  held: boolean;
  // Moderation (m108). withdrawn_by_actor_type distinguishes an
  // author withdrawal from an operator one; the reason columns hold the
  // latest operator withdraw-or-redact reason for display.
  withdrawn_by_actor_type: string | null;
  moderation_operator_user_id: string | null;
  moderation_reason: string | null;
  feedback_redacted_at: string | null;
  // Subject reply: one threaded, moderatable response per review.
  reply_id: string | null;
  reply_feedback: string | null;
  reply_status: string | null;
  reply_submitted_at: string | null;
  reply_withdrawn_at: string | null;
}>;

export type ReviewDetailRow = ReviewListRow;

export type ReviewSummaryRow = Readonly<{
  account_id: string;
  account_display_name: string | null;
  average_rating_as_seller: string | null;
  review_count_as_seller: number;
  rating_1_count_as_seller: number;
  rating_2_count_as_seller: number;
  rating_3_count_as_seller: number;
  rating_4_count_as_seller: number;
  rating_5_count_as_seller: number;
  average_rating_as_buyer: string | null;
  review_count_as_buyer: number;
  rating_1_count_as_buyer: number;
  rating_2_count_as_buyer: number;
  rating_3_count_as_buyer: number;
  rating_4_count_as_buyer: number;
  rating_5_count_as_buyer: number;
  updated_at: string | null;
}>;

// The account's own role (buyer|seller) in the underlying order — the
// opposite of the stored `author_role`, since a review's author reviews the
// counterparty. `roleToAuthorRoleFilter` translates a "which of my roles"
// filter into the `author_role` value that produced it.
export type ReviewRoleFilter = "seller" | "buyer";

function roleToAuthorRoleFilter(role: ReviewRoleFilter): "buyer" | "seller" {
  return role === "seller" ? "buyer" : "seller";
}

export type ReviewEligibilityRow = Readonly<{
  order_id: string;
  author_account_id: string;
  subject_account_id: string;
  author_role: string;
  eligible_at: string;
  effective_deadline_at: string;
  submission_state: "allowed" | "held" | "expired";
}>;

export type ReviewOpportunityRow = Readonly<{
  order_id: string;
  subject_account_id: string;
  subject_display_name: string | null;
  author_role: string;
  eligible_at: string;
  active_review_id: string | null;
  // Double-blind reveal (m108): true once eligible_at + REVIEW_WINDOW_DAYS
  // has passed with no review submitted yet — the UI shows "review window
  // closed" instead of the submission callout.
  window_expired: boolean;
  window_expires_at: string;
  submission_state: "allowed" | "held" | "expired";
  hold_reason: "feedback-on-hold" | null;
}>;

// The author's own view (written reviews, public revealed-only lists): full
// content always, since either the viewer wrote it or it is already revealed.
const baseReviewSelect = `
  SELECT
    page.review_id,
    page.order_id,
    page.author_account_id,
    author.display_name AS author_display_name,
    page.subject_account_id,
    subject.display_name AS subject_display_name,
    page.author_role,
    page.rating,
    page.feedback,
    page.status,
    page.submitted_at,
    page.updated_at,
    page.withdrawn_at,
    page.revealed_at,
    page.reveal_reason,
    page.held,
    page.withdrawn_by_actor_type,
    page.moderation_operator_user_id,
    page.moderation_reason,
    page.feedback_redacted_at,
    page.reply_id,
    page.reply_feedback,
    page.reply_status,
    page.reply_submitted_at,
    page.reply_withdrawn_at
  FROM marketplace_review_pages AS page
  LEFT JOIN marketplace_review_account_sources AS author
    ON author.account_id = page.author_account_id
  LEFT JOIN marketplace_review_account_sources AS subject
    ON subject.account_id = page.subject_account_id
`;

// The subject's own "received reviews" view: a not-yet-revealed review
// redacts rating/feedback to null so the subject sees "a review is pending"
// without content while the author's side stays fully visible pre-reveal.
const subjectRedactedReviewSelect = `
  SELECT
    page.review_id,
    page.order_id,
    page.author_account_id,
    author.display_name AS author_display_name,
    page.subject_account_id,
    subject.display_name AS subject_display_name,
    page.author_role,
    CASE WHEN page.revealed_at IS NULL OR page.held THEN NULL ELSE page.rating END AS rating,
    CASE WHEN page.revealed_at IS NULL OR page.held THEN NULL ELSE page.feedback END AS feedback,
    page.status,
    page.submitted_at,
    page.updated_at,
    page.withdrawn_at,
    page.revealed_at,
    page.reveal_reason,
    page.held,
    page.withdrawn_by_actor_type,
    page.moderation_operator_user_id,
    page.moderation_reason,
    page.feedback_redacted_at,
    page.reply_id,
    page.reply_feedback,
    page.reply_status,
    page.reply_submitted_at,
    page.reply_withdrawn_at
  FROM marketplace_review_pages AS page
  LEFT JOIN marketplace_review_account_sources AS author
    ON author.account_id = page.author_account_id
  LEFT JOIN marketplace_review_account_sources AS subject
    ON subject.account_id = page.subject_account_id
`;

function normalizePageParams(params: Readonly<{ limit?: number; offset?: number }>) {
  return {
    limit: Math.max(1, Math.min(params.limit ?? 50, 250)),
    offset: Math.max(0, params.offset ?? 0),
  };
}

export async function listPublicAccountReviews(
  db: PgQueryable,
  params: Readonly<{ accountId: string; role?: ReviewRoleFilter; limit?: number; offset?: number }>,
): Promise<{ items: ReviewListRow[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);
  const values: unknown[] = [params.accountId];
  let countRoleClause = "";
  let itemsRoleClause = "";
  if (params.role) {
    values.push(roleToAuthorRoleFilter(params.role));
    countRoleClause = `\n         AND author_role = $${values.length}`;
    itemsRoleClause = `\n         AND page.author_role = $${values.length}`;
  }

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_review_pages
       WHERE subject_account_id = $1
         AND status = 'active'
         AND revealed_at IS NOT NULL
         AND held = false${countRoleClause}`,
      values,
    ),
    db.query<ReviewListRow>(
      `${baseReviewSelect}
       WHERE page.subject_account_id = $1
         AND page.status = 'active'
         AND page.revealed_at IS NOT NULL
         AND page.held = false${itemsRoleClause}
       ORDER BY page.updated_at DESC, page.review_id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function listWrittenReviews(
  db: PgQueryable,
  params: Readonly<{ authorAccountId: string; role?: ReviewRoleFilter; limit?: number; offset?: number }>,
): Promise<{ items: ReviewListRow[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);
  // A written review's own `author_role` already records the account's role
  // when it wrote the review, so the filter applies directly (no inversion).
  const values: unknown[] = [params.authorAccountId];
  let roleClause = "";
  if (params.role) {
    values.push(params.role);
    roleClause = `\n         AND author_role = $${values.length}`;
  }

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_review_pages
       WHERE author_account_id = $1${roleClause}`,
      values,
    ),
    db.query<ReviewListRow>(
      `${baseReviewSelect}
       WHERE page.author_account_id = $1${roleClause.replace("author_role", "page.author_role")}
       ORDER BY page.updated_at DESC, page.review_id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function listReceivedReviews(
  db: PgQueryable,
  params: Readonly<{ subjectAccountId: string; role?: ReviewRoleFilter; limit?: number; offset?: number }>,
): Promise<{ items: ReviewListRow[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);
  const values: unknown[] = [params.subjectAccountId];
  let roleClause = "";
  if (params.role) {
    values.push(roleToAuthorRoleFilter(params.role));
    roleClause = `\n         AND author_role = $${values.length}`;
  }

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_review_pages
       WHERE subject_account_id = $1${roleClause}`,
      values,
    ),
    db.query<ReviewListRow>(
      `${subjectRedactedReviewSelect}
       WHERE page.subject_account_id = $1${roleClause.replace("author_role", "page.author_role")}
       ORDER BY page.updated_at DESC, page.review_id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

// A review's own author always sees full content, even pre-reveal (it is
// their draft). The subject sees full content only once revealed; before
// that, rating/feedback redact to null ("a review is pending" without
// content) -- the classic double-blind-reveal protection against retaliation.
const detailReviewSelect = `
  SELECT
    page.review_id,
    page.order_id,
    page.author_account_id,
    author.display_name AS author_display_name,
    page.subject_account_id,
    subject.display_name AS subject_display_name,
    page.author_role,
    CASE
      WHEN (page.revealed_at IS NULL OR page.held) AND page.subject_account_id = $2 THEN NULL
      ELSE page.rating
    END AS rating,
    CASE
      WHEN (page.revealed_at IS NULL OR page.held) AND page.subject_account_id = $2 THEN NULL
      ELSE page.feedback
    END AS feedback,
    page.status,
    page.submitted_at,
    page.updated_at,
    page.withdrawn_at,
    page.revealed_at,
    page.reveal_reason,
    page.held,
    page.withdrawn_by_actor_type,
    page.moderation_operator_user_id,
    page.moderation_reason,
    page.feedback_redacted_at,
    page.reply_id,
    page.reply_feedback,
    page.reply_status,
    page.reply_submitted_at,
    page.reply_withdrawn_at
  FROM marketplace_review_pages AS page
  LEFT JOIN marketplace_review_account_sources AS author
    ON author.account_id = page.author_account_id
  LEFT JOIN marketplace_review_account_sources AS subject
    ON subject.account_id = page.subject_account_id
`;

export async function getAccountReview(
  db: PgQueryable,
  reviewId: string,
  accountId: string,
): Promise<ReviewDetailRow | null> {
  const result = await db.query<ReviewDetailRow>(
    `${detailReviewSelect}
     WHERE page.review_id = $1
       AND (page.author_account_id = $2 OR page.subject_account_id = $2)`,
    [reviewId, accountId],
  );

  return result.rows[0] ?? null;
}

// Returns both the as-seller and as-buyer dimensions in one payload so a
// public profile (or the account's own summary page) can render "As seller" /
// "As buyer" sections from a single round trip.
export async function getPublicAccountSummary(db: PgQueryable, accountId: string): Promise<ReviewSummaryRow> {
  const result = await db.query<ReviewSummaryRow>(
    `SELECT
       summary.account_id,
       account.display_name AS account_display_name,
       summary.average_rating_as_seller::text AS average_rating_as_seller,
       summary.review_count_as_seller,
       summary.rating_1_count_as_seller,
       summary.rating_2_count_as_seller,
       summary.rating_3_count_as_seller,
       summary.rating_4_count_as_seller,
       summary.rating_5_count_as_seller,
       summary.average_rating_as_buyer::text AS average_rating_as_buyer,
       summary.review_count_as_buyer,
       summary.rating_1_count_as_buyer,
       summary.rating_2_count_as_buyer,
       summary.rating_3_count_as_buyer,
       summary.rating_4_count_as_buyer,
       summary.rating_5_count_as_buyer,
       summary.updated_at::text AS updated_at
     FROM marketplace_review_summary_pages AS summary
     LEFT JOIN marketplace_review_account_sources AS account
       ON account.account_id = summary.account_id
     WHERE summary.account_id = $1`,
    [accountId],
  );

  return (
    result.rows[0] ?? {
      account_id: accountId,
      account_display_name: null,
      average_rating_as_seller: null,
      review_count_as_seller: 0,
      rating_1_count_as_seller: 0,
      rating_2_count_as_seller: 0,
      rating_3_count_as_seller: 0,
      rating_4_count_as_seller: 0,
      rating_5_count_as_seller: 0,
      average_rating_as_buyer: null,
      review_count_as_buyer: 0,
      rating_1_count_as_buyer: 0,
      rating_2_count_as_buyer: 0,
      rating_3_count_as_buyer: 0,
      rating_4_count_as_buyer: 0,
      rating_5_count_as_buyer: 0,
      updated_at: null,
    }
  );
}

export async function getReviewEligibility(
  db: PgQueryable,
  params: Readonly<{
    orderId: string;
    authorAccountId: string;
    subjectAccountId: string;
  }>,
): Promise<ReviewEligibilityRow | null> {
  const result = await db.query<ReviewEligibilityRow>(
    `SELECT
       order_id,
       author_account_id,
       subject_account_id,
       author_role,
       eligible_at::text AS eligible_at,
       effective_deadline_at::text AS effective_deadline_at,
       submission_state
     FROM marketplace_review_eligibility_pages
     WHERE order_id = $1
       AND author_account_id = $2
       AND subject_account_id = $3`,
    [params.orderId, params.authorAccountId, params.subjectAccountId],
  );

  return result.rows[0] ?? null;
}

export async function getOrderReviewOpportunity(
  db: PgQueryable,
  params: Readonly<{
    orderId: string;
    authorAccountId: string;
  }>,
): Promise<ReviewOpportunityRow | null> {
  const result = await db.query<ReviewOpportunityRow>(
    `SELECT
       eligibility.order_id,
       eligibility.subject_account_id,
       subject.display_name AS subject_display_name,
       eligibility.author_role,
       eligibility.eligible_at,
       active.review_id AS active_review_id,
       eligibility.effective_deadline_at::text AS window_expires_at,
       eligibility.submission_state,
       CASE WHEN eligibility.submission_state = 'held' THEN 'feedback-on-hold' ELSE NULL END AS hold_reason,
       (active.review_id IS NULL AND eligibility.submission_state = 'expired') AS window_expired
     FROM marketplace_review_eligibility_pages AS eligibility
     INNER JOIN marketplace_review_order_sources AS order_source
       ON order_source.order_id = eligibility.order_id
     LEFT JOIN marketplace_review_account_sources AS subject
       ON subject.account_id = eligibility.subject_account_id
     LEFT JOIN marketplace_review_pages AS active
       ON active.order_id = eligibility.order_id
      AND active.author_account_id = eligibility.author_account_id
      AND active.subject_account_id = eligibility.subject_account_id
      AND active.status = 'active'
     WHERE eligibility.order_id = $1
       AND eligibility.author_account_id = $2
       AND (
         (
           eligibility.author_role = 'buyer'
           AND order_source.buyer_account_id = eligibility.author_account_id
           AND order_source.seller_account_id = eligibility.subject_account_id
         )
         OR (
           eligibility.author_role = 'seller'
           AND order_source.seller_account_id = eligibility.author_account_id
           AND order_source.buyer_account_id = eligibility.subject_account_id
         )
       )`,
    [params.orderId, params.authorAccountId],
  );

  return result.rows[0] ?? null;
}

/**
 * Finds an already-submitted, not-yet-revealed, non-withdrawn counterpart
 * review for the same order (the opposite author/subject direction). Used by
 * the submitted-review projection callback to decide whether both sides of a
 * pair can reveal together.
 */
export async function findPendingCounterpartReview(
  db: PgQueryable,
  params: Readonly<{
    orderId: string;
    // The counterpart's author is THIS review's subject, and vice versa.
    counterpartAuthorAccountId: string;
    counterpartSubjectAccountId: string;
  }>,
): Promise<Pick<ReviewListRow, "review_id"> | null> {
  const result = await db.query<{ review_id: string }>(
    `SELECT review_id
     FROM marketplace_review_pages
     WHERE order_id = $1
       AND author_account_id = $2
       AND subject_account_id = $3
       AND status = 'active'
       AND revealed_at IS NULL
       AND held = false
     LIMIT 1`,
    [params.orderId, params.counterpartAuthorAccountId, params.counterpartSubjectAccountId],
  );

  return result.rows[0] ?? null;
}

export type PendingCounterpartPairRow = Readonly<{
  order_id: string;
  review_id: string;
  counterpart_review_id: string;
}>;

/**
 * Self-heals a rare race the submission-time counterpart check can miss
 * (both directions submitted within the same narrow window, before either
 * side's read-model row was visible to the other's check): finds every order
 * where BOTH directions have an already-submitted, not-yet-revealed review.
 * `review_id < counterpart_review_id` dedupes the symmetric self-join to one
 * row per pair.
 */
export async function listPendingCounterpartPairs(
  db: PgQueryable,
  params: Readonly<{ limit?: number }>,
): Promise<readonly PendingCounterpartPairRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const result = await db.query<PendingCounterpartPairRow>(
    `SELECT a.order_id, a.review_id AS review_id, b.review_id AS counterpart_review_id
     FROM marketplace_review_pages AS a
     INNER JOIN marketplace_review_pages AS b
       ON a.order_id = b.order_id
      AND a.author_account_id = b.subject_account_id
      AND a.subject_account_id = b.author_account_id
     WHERE a.status = 'active'
       AND a.revealed_at IS NULL
       AND a.held = false
       AND b.status = 'active'
       AND b.revealed_at IS NULL
       AND b.held = false
       AND a.review_id < b.review_id
     LIMIT $1`,
    [limit],
  );

  return result.rows;
}

export type PendingReviewPastWindowRow = Readonly<{
  review_id: string;
  order_id: string;
  author_role: string;
}>;

/**
 * Hidden (submitted, not revealed, not withdrawn) reviews whose submission
 * window has elapsed with no counterpart -- the expiry sweep's singleton
 * reveal candidates.
 */
export async function listPendingReviewsPastWindow(
  db: PgQueryable,
  params: Readonly<{ now: string; limit?: number }>,
): Promise<readonly PendingReviewPastWindowRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const result = await db.query<PendingReviewPastWindowRow>(
    `SELECT review_id, order_id, author_role
     FROM marketplace_review_pages
     WHERE status = 'active'
       AND revealed_at IS NULL
       AND held = false
       AND review_window_expires_at IS NOT NULL
       AND review_window_expires_at <= $1::timestamptz
     ORDER BY review_window_expires_at ASC, review_id ASC
     LIMIT $2`,
    [params.now, limit],
  );

  return result.rows;
}

export type ReviewModerationTargetRow = Readonly<{
  review_id: string;
  subject_account_id: string;
  status: string;
  revealed_at: string | null;
}>;

/**
 * Minimal, unrestricted lookup for the report/moderation surfaces (m108):
 * unlike `getAccountReview`, this is not scoped to a viewing account --
 * reporting and operator moderation both need the review's subject and
 * reveal state regardless of who is asking.
 */
export async function getReviewModerationTarget(
  db: PgQueryable,
  reviewId: string,
): Promise<ReviewModerationTargetRow | null> {
  const result = await db.query<ReviewModerationTargetRow>(
    `SELECT review_id, subject_account_id, status, revealed_at::text AS revealed_at
     FROM marketplace_review_pages
     WHERE review_id = $1`,
    [reviewId],
  );

  return result.rows[0] ?? null;
}

/**
 * Resolves a public seller slug (MCP `subjectAccountSlug` input) to its
 * canonical account id via the unique `marketplace_review_account_sources`
 * slug index. Unlike a name lookup, this is never ambiguous -- the slug's
 * account-id-hash suffix guarantees at most one match -- so a miss is simply
 * "not found" rather than a disambiguation case.
 */
export async function getAccountIdBySlug(db: PgQueryable, slug: string): Promise<string | null> {
  const result = await db.query<{ account_id: string }>(
    `SELECT account_id
     FROM marketplace_review_account_sources
     WHERE slug = $1
     LIMIT 1`,
    [slug],
  );

  return result.rows[0]?.account_id ?? null;
}

/**
 * The buyer's shipping email snapshot captured at order-create time (m108)
 * -- the only email address available anywhere in the reviews source
 * tables. Used to add an email channel to buyer-directed nudge notifications;
 * seller-directed nudges stay web-only, mirroring every other seller
 * notification intent in the platform.
 */
export async function getReviewOrderBuyerEmail(db: PgQueryable, orderId: string): Promise<string | null> {
  const result = await db.query<{ buyer_email: string | null }>(
    `SELECT buyer_email
     FROM marketplace_review_order_sources
     WHERE order_id = $1`,
    [orderId],
  );

  return result.rows[0]?.buyer_email ?? null;
}

export type ReviewOpportunityReminderCandidateRow = Readonly<{
  order_id: string;
  author_account_id: string;
  subject_account_id: string;
  author_role: string;
  eligible_at: string;
}>;

/**
 * Post-delivery review nudge reminder sweep (m108): eligibility rows
 * old enough for a reminder, not yet reminded, still inside the submission
 * window, and with no active review submitted yet. Mirrors the review-window
 * expiry sweep's read-then-command pattern rather than inventing new
 * scheduling -- the caller enqueues the reminder notification and then marks
 * `reminder_notified_at`, which is what makes a re-run of this same query
 * idempotent (a crash between enqueue and mark just re-selects the same row
 * next sweep, and the notification outbox's own idempotencyKey collapses the
 * repeat enqueue into a no-op).
 */
export async function listReviewOpportunityReminderCandidates(
  db: PgQueryable,
  params: Readonly<{ now: string; limit?: number }>,
): Promise<readonly ReviewOpportunityReminderCandidateRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const result = await db.query<ReviewOpportunityReminderCandidateRow>(
    `SELECT
       eligibility.order_id,
       eligibility.author_account_id,
       eligibility.subject_account_id,
       eligibility.author_role,
       eligibility.eligible_at::text AS eligible_at
     FROM marketplace_review_eligibility_pages AS eligibility
     LEFT JOIN marketplace_review_pages AS active
       ON active.order_id = eligibility.order_id
      AND active.author_account_id = eligibility.author_account_id
      AND active.subject_account_id = eligibility.subject_account_id
      AND active.status = 'active'
     WHERE eligibility.reminder_notified_at IS NULL
       AND eligibility.submission_state = 'allowed'
       AND active.review_id IS NULL
       AND eligibility.reminder_armed_at + INTERVAL '${REVIEW_NUDGE_REMINDER_DELAY_DAYS} days' <= $1::timestamptz
       AND eligibility.effective_deadline_at > $1::timestamptz
     ORDER BY eligibility.reminder_armed_at ASC, eligibility.order_id ASC
     LIMIT $2`,
    [params.now, limit],
  );

  return result.rows;
}

/** Marks the reminder as sent so the sweep never re-selects this row. */
export async function markReviewOpportunityReminderNotified(
  db: PgQueryable,
  params: Readonly<{ orderId: string; authorAccountId: string; subjectAccountId: string; notifiedAt: string }>,
): Promise<void> {
  await db.query(
    `UPDATE marketplace_review_eligibility_pages
     SET reminder_notified_at = $4
     WHERE order_id = $1
       AND author_account_id = $2
       AND subject_account_id = $3`,
    [params.orderId, params.authorAccountId, params.subjectAccountId, params.notifiedAt],
  );
}

export async function findActiveReviewForDirection(
  db: PgQueryable,
  params: Readonly<{
    orderId: string;
    authorAccountId: string;
    subjectAccountId: string;
  }>,
): Promise<Pick<ReviewListRow, "review_id"> | null> {
  const result = await db.query<{ review_id: string }>(
    `SELECT review_id
     FROM marketplace_review_pages
     WHERE order_id = $1
       AND author_account_id = $2
       AND subject_account_id = $3
       AND status = 'active'
     ORDER BY submitted_at ASC, review_id ASC
     LIMIT 1`,
    [params.orderId, params.authorAccountId, params.subjectAccountId],
  );

  return result.rows[0] ?? null;
}
