import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

async function refreshReviewSummary(db: PgQueryable, subjectAccountId: string, updatedAt: string) {
  await db.query(
    `INSERT INTO marketplace_review_summary_pages (
       account_id,
       average_rating,
       review_count,
       rating_1_count,
       rating_2_count,
       rating_3_count,
       rating_4_count,
       rating_5_count,
       updated_at
     )
     SELECT
       $1,
       CASE
         WHEN COUNT(*) = 0 THEN NULL
         ELSE ROUND(AVG(rating)::numeric, 2)
       END,
       COUNT(*)::integer,
       COUNT(*) FILTER (WHERE rating = 1)::integer,
       COUNT(*) FILTER (WHERE rating = 2)::integer,
       COUNT(*) FILTER (WHERE rating = 3)::integer,
       COUNT(*) FILTER (WHERE rating = 4)::integer,
       COUNT(*) FILTER (WHERE rating = 5)::integer,
       $2
     FROM marketplace_review_pages
     WHERE subject_account_id = $1
       AND status = 'active'
     ON CONFLICT (account_id) DO UPDATE
     SET average_rating = EXCLUDED.average_rating,
         review_count = EXCLUDED.review_count,
         rating_1_count = EXCLUDED.rating_1_count,
         rating_2_count = EXCLUDED.rating_2_count,
         rating_3_count = EXCLUDED.rating_3_count,
         rating_4_count = EXCLUDED.rating_4_count,
         rating_5_count = EXCLUDED.rating_5_count,
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
           submitted_at,
           updated_at,
           withdrawn_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'active', $8, $8, NULL
         )
         ON CONFLICT (review_id) DO UPDATE
         SET rating = EXCLUDED.rating,
             feedback = EXCLUDED.feedback,
             status = EXCLUDED.status,
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
