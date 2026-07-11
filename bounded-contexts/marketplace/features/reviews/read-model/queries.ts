import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type ReviewListRow = Readonly<{
  review_id: string;
  order_id: string;
  author_account_id: string;
  author_display_name: string | null;
  subject_account_id: string;
  subject_display_name: string | null;
  author_role: string;
  rating: number;
  feedback: string | null;
  status: string;
  resolution_context: string | null;
  submitted_at: string;
  updated_at: string;
  withdrawn_at: string | null;
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
  resolution_context: string | null;
  eligible_at: string;
}>;

export type ReviewOpportunityRow = Readonly<{
  order_id: string;
  subject_account_id: string;
  subject_display_name: string | null;
  author_role: string;
  eligible_at: string;
  active_review_id: string | null;
}>;

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
    page.resolution_context,
    page.submitted_at,
    page.updated_at,
    page.withdrawn_at
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
         AND status = 'active'${countRoleClause}`,
      values,
    ),
    db.query<ReviewListRow>(
      `${baseReviewSelect}
       WHERE page.subject_account_id = $1
         AND page.status = 'active'${itemsRoleClause}
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
      `${baseReviewSelect}
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

export async function getAccountReview(
  db: PgQueryable,
  reviewId: string,
  accountId: string,
): Promise<ReviewDetailRow | null> {
  const result = await db.query<ReviewDetailRow>(
    `${baseReviewSelect}
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
       resolution_context,
       eligible_at
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
       active.review_id AS active_review_id
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
