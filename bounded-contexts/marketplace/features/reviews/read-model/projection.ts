import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

// A review's `author_role` records the role the AUTHOR played in the
// underlying order, so the SUBJECT played the opposite role: a review authored
// by a buyer (author_role = 'buyer') was written about the subject acting AS A
// SELLER, and a review authored by a seller was written about the subject
// acting AS A BUYER. Both dimensions are recomputed from the same pass over
// `marketplace_review_pages` so the summary stays replay-safe: re-running any
// review event converges to the same split counters.
async function refreshReviewSummary(db: PgQueryable, subjectAccountId: string, updatedAt: string) {
  await db.query(
    `INSERT INTO marketplace_review_summary_pages (
       account_id,
       average_rating_as_seller,
       review_count_as_seller,
       rating_1_count_as_seller,
       rating_2_count_as_seller,
       rating_3_count_as_seller,
       rating_4_count_as_seller,
       rating_5_count_as_seller,
       average_rating_as_buyer,
       review_count_as_buyer,
       rating_1_count_as_buyer,
       rating_2_count_as_buyer,
       rating_3_count_as_buyer,
       rating_4_count_as_buyer,
       rating_5_count_as_buyer,
       updated_at
     )
     SELECT
       $1,
       CASE
         WHEN COUNT(*) FILTER (WHERE author_role = 'buyer') = 0 THEN NULL
         ELSE ROUND(AVG(rating) FILTER (WHERE author_role = 'buyer')::numeric, 2)
       END,
       COUNT(*) FILTER (WHERE author_role = 'buyer')::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating = 1)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating = 2)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating = 3)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating = 4)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating = 5)::integer,
       CASE
         WHEN COUNT(*) FILTER (WHERE author_role = 'seller') = 0 THEN NULL
         ELSE ROUND(AVG(rating) FILTER (WHERE author_role = 'seller')::numeric, 2)
       END,
       COUNT(*) FILTER (WHERE author_role = 'seller')::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating = 1)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating = 2)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating = 3)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating = 4)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating = 5)::integer,
       $2
     FROM marketplace_review_pages
     WHERE subject_account_id = $1
       AND status = 'active'
     ON CONFLICT (account_id) DO UPDATE
     SET average_rating_as_seller = EXCLUDED.average_rating_as_seller,
         review_count_as_seller = EXCLUDED.review_count_as_seller,
         rating_1_count_as_seller = EXCLUDED.rating_1_count_as_seller,
         rating_2_count_as_seller = EXCLUDED.rating_2_count_as_seller,
         rating_3_count_as_seller = EXCLUDED.rating_3_count_as_seller,
         rating_4_count_as_seller = EXCLUDED.rating_4_count_as_seller,
         rating_5_count_as_seller = EXCLUDED.rating_5_count_as_seller,
         average_rating_as_buyer = EXCLUDED.average_rating_as_buyer,
         review_count_as_buyer = EXCLUDED.review_count_as_buyer,
         rating_1_count_as_buyer = EXCLUDED.rating_1_count_as_buyer,
         rating_2_count_as_buyer = EXCLUDED.rating_2_count_as_buyer,
         rating_3_count_as_buyer = EXCLUDED.rating_3_count_as_buyer,
         rating_4_count_as_buyer = EXCLUDED.rating_4_count_as_buyer,
         rating_5_count_as_buyer = EXCLUDED.rating_5_count_as_buyer,
         updated_at = EXCLUDED.updated_at`,
    [subjectAccountId, updatedAt],
  );
}

export function buildReviewProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "marketplace.review.submitted": async (event) => {
      const data = event.data as {
        reviewId: string;
        orderId: string;
        authorAccountId: string;
        subjectAccountId: string;
        authorRole: string;
        rating: number;
        feedback: string | null;
        resolutionContext?: string | null;
        submittedAt: string;
      };

      await db.query(
        `INSERT INTO marketplace_review_pages (
           review_id,
           order_id,
           author_account_id,
           subject_account_id,
           author_role,
           rating,
           feedback,
           status,
           resolution_context,
           submitted_at,
           updated_at,
           withdrawn_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $9, NULL
         )
         ON CONFLICT (review_id) DO UPDATE
         SET rating = EXCLUDED.rating,
             feedback = EXCLUDED.feedback,
             status = EXCLUDED.status,
             resolution_context = EXCLUDED.resolution_context,
             updated_at = EXCLUDED.updated_at,
             withdrawn_at = EXCLUDED.withdrawn_at`,
        [
          data.reviewId,
          data.orderId,
          data.authorAccountId,
          data.subjectAccountId,
          data.authorRole,
          data.rating,
          data.feedback,
          data.resolutionContext ?? null,
          data.submittedAt,
        ],
      );

      await refreshReviewSummary(db, data.subjectAccountId, data.submittedAt);
    },
    "marketplace.review.updated": async (event) => {
      const data = event.data as {
        reviewId: string;
        rating: number;
        feedback: string | null;
        updatedAt: string;
      };

      const subjectResult = await db.query<{ subject_account_id: string }>(
        `UPDATE marketplace_review_pages
         SET rating = $2,
             feedback = $3,
             updated_at = $4
         WHERE review_id = $1
         RETURNING subject_account_id`,
        [data.reviewId, data.rating, data.feedback, data.updatedAt],
      );

      const subjectAccountId = subjectResult.rows[0]?.subject_account_id;
      if (!subjectAccountId) {
        return;
      }

      await refreshReviewSummary(db, subjectAccountId, data.updatedAt);
    },
    "marketplace.review.withdrawn": async (event) => {
      const data = event.data as {
        reviewId: string;
        withdrawnAt: string;
      };

      const subjectResult = await db.query<{ subject_account_id: string }>(
        `UPDATE marketplace_review_pages
         SET status = 'withdrawn',
             withdrawn_at = $2,
             updated_at = $2
         WHERE review_id = $1
         RETURNING subject_account_id`,
        [data.reviewId, data.withdrawnAt],
      );

      const subjectAccountId = subjectResult.rows[0]?.subject_account_id;
      if (!subjectAccountId) {
        return;
      }

      await refreshReviewSummary(db, subjectAccountId, data.withdrawnAt);
    },
  };
}
