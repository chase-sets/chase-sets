import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type ReputationReviewListRow = Readonly<{
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
  submitted_at: string;
  updated_at: string;
  withdrawn_at: string | null;
}>;

export type ReputationReviewDetailRow = ReputationReviewListRow;

export type ReputationSummaryRow = Readonly<{
  account_id: string;
  account_display_name: string | null;
  average_rating: string | null;
  review_count: number;
  rating_1_count: number;
  rating_2_count: number;
  rating_3_count: number;
  rating_4_count: number;
  rating_5_count: number;
  updated_at: string | null;
}>;

export type ReviewEligibilityRow = Readonly<{
  order_id: string;
  author_account_id: string;
  subject_account_id: string;
  author_role: string;
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
    page.submitted_at,
    page.updated_at,
    page.withdrawn_at
  FROM reputation_review_pages AS page
  LEFT JOIN reputation_account_pages AS author
    ON author.account_id = page.author_account_id
  LEFT JOIN reputation_account_pages AS subject
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
  params: Readonly<{ accountId: string; limit?: number; offset?: number }>,
): Promise<{ items: ReputationReviewListRow[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM reputation_review_pages
       WHERE subject_account_id = $1
         AND status = 'active'`,
      [params.accountId],
    ),
    db.query<ReputationReviewListRow>(
      `${baseReviewSelect}
       WHERE page.subject_account_id = $1
         AND page.status = 'active'
       ORDER BY page.updated_at DESC, page.review_id DESC
       LIMIT $2 OFFSET $3`,
      [params.accountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function listWrittenReviews(
  db: PgQueryable,
  params: Readonly<{ authorAccountId: string; limit?: number; offset?: number }>,
): Promise<{ items: ReputationReviewListRow[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM reputation_review_pages
       WHERE author_account_id = $1`,
      [params.authorAccountId],
    ),
    db.query<ReputationReviewListRow>(
      `${baseReviewSelect}
       WHERE page.author_account_id = $1
       ORDER BY page.updated_at DESC, page.review_id DESC
       LIMIT $2 OFFSET $3`,
      [params.authorAccountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function listReceivedReviews(
  db: PgQueryable,
  params: Readonly<{ subjectAccountId: string; limit?: number; offset?: number }>,
): Promise<{ items: ReputationReviewListRow[]; total: number }> {
  const { limit, offset } = normalizePageParams(params);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM reputation_review_pages
       WHERE subject_account_id = $1`,
      [params.subjectAccountId],
    ),
    db.query<ReputationReviewListRow>(
      `${baseReviewSelect}
       WHERE page.subject_account_id = $1
       ORDER BY page.updated_at DESC, page.review_id DESC
       LIMIT $2 OFFSET $3`,
      [params.subjectAccountId, limit, offset],
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
): Promise<ReputationReviewDetailRow | null> {
  const result = await db.query<ReputationReviewDetailRow>(
    `${baseReviewSelect}
     WHERE page.review_id = $1
       AND (page.author_account_id = $2 OR page.subject_account_id = $2)`,
    [reviewId, accountId],
  );

  return result.rows[0] ?? null;
}

export async function getPublicAccountSummary(
  db: PgQueryable,
  accountId: string,
): Promise<ReputationSummaryRow> {
  const result = await db.query<ReputationSummaryRow>(
    `SELECT
       summary.account_id,
       account.display_name AS account_display_name,
       summary.average_rating::text AS average_rating,
       summary.review_count,
       summary.rating_1_count,
       summary.rating_2_count,
       summary.rating_3_count,
       summary.rating_4_count,
     summary.rating_5_count,
     summary.updated_at::text AS updated_at
     FROM reputation_summary_pages AS summary
     LEFT JOIN reputation_account_pages AS account
       ON account.account_id = summary.account_id
     WHERE summary.account_id = $1`,
    [accountId],
  );

  return (
    result.rows[0] ?? {
      account_id: accountId,
      account_display_name: null,
      average_rating: null,
      review_count: 0,
      rating_1_count: 0,
      rating_2_count: 0,
      rating_3_count: 0,
      rating_4_count: 0,
      rating_5_count: 0,
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
       eligible_at
     FROM reputation_review_eligibility_pages
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
     FROM reputation_review_eligibility_pages AS eligibility
     INNER JOIN reputation_order_sources AS order_source
       ON order_source.order_id = eligibility.order_id
     LEFT JOIN reputation_account_pages AS subject
       ON subject.account_id = eligibility.subject_account_id
     LEFT JOIN reputation_review_pages AS active
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
): Promise<Pick<ReputationReviewListRow, "review_id"> | null> {
  const result = await db.query<{ review_id: string }>(
    `SELECT review_id
     FROM reputation_review_pages
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
