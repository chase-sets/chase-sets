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
       AND revealed_at IS NOT NULL
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
        submittedAt: string;
        reviewWindowExpiresAt?: string | null;
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
           withdrawn_at,
           revealed_at,
           review_window_expires_at,
           reveal_reason
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'active', $8, $8, NULL, NULL, $9, NULL
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
          data.reviewWindowExpiresAt ?? null,
        ],
      );

      // Hidden until reveal: the summary recompute is a harmless no-op right
      // now (the row is excluded by `revealed_at IS NOT NULL`), but keeping
      // the call means a replay that revealed this review earlier in the
      // stream still converges to the same summary.
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
        actorType?: "operator";
        operatorUserId?: string;
        reason?: string;
      };

      const subjectResult = await db.query<{ subject_account_id: string }>(
        `UPDATE marketplace_review_pages
         SET status = 'withdrawn',
             withdrawn_at = $2,
             updated_at = $2,
             withdrawn_by_actor_type = $3,
             moderation_operator_user_id = $4,
             moderation_reason = $5
         WHERE review_id = $1
         RETURNING subject_account_id`,
        [data.reviewId, data.withdrawnAt, data.actorType ?? "author", data.operatorUserId ?? null, data.reason ?? null],
      );

      const subjectAccountId = subjectResult.rows[0]?.subject_account_id;
      if (!subjectAccountId) {
        return;
      }

      await refreshReviewSummary(db, subjectAccountId, data.withdrawnAt);
    },
    "marketplace.review.feedback-redacted": async (event) => {
      const data = event.data as {
        reviewId: string;
        redactedAt: string;
        operatorUserId: string;
        reason: string;
      };

      // No summary refresh: the rating stands, and the summary aggregate
      // never stores feedback text -- only the review row's own display
      // needs updating.
      await db.query(
        `UPDATE marketplace_review_pages
         SET feedback = NULL,
             feedback_redacted_at = $2,
             moderation_operator_user_id = $3,
             moderation_reason = $4,
             updated_at = $2
         WHERE review_id = $1`,
        [data.reviewId, data.redactedAt, data.operatorUserId, data.reason],
      );
    },
    "marketplace.review.reply-submitted": async (event) => {
      const data = event.data as {
        reviewId: string;
        replyId: string;
        feedback: string;
        submittedAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_pages
         SET reply_id = $2,
             reply_feedback = $3,
             reply_status = 'active',
             reply_submitted_at = $4,
             reply_withdrawn_at = NULL,
             updated_at = $4
         WHERE review_id = $1`,
        [data.reviewId, data.replyId, data.feedback, data.submittedAt],
      );
    },
    "marketplace.review.reply-withdrawn": async (event) => {
      const data = event.data as {
        reviewId: string;
        withdrawnAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_pages
         SET reply_status = 'withdrawn',
             reply_withdrawn_at = $2,
             updated_at = $2
         WHERE review_id = $1`,
        [data.reviewId, data.withdrawnAt],
      );
    },
    "marketplace.review.revealed": async (event) => {
      const data = event.data as {
        reviewId: string;
        revealedAt: string;
        reason: string;
      };

      const subjectResult = await db.query<{ subject_account_id: string }>(
        `UPDATE marketplace_review_pages
         SET revealed_at = $2,
             reveal_reason = $3,
             updated_at = $2
         WHERE review_id = $1
           AND revealed_at IS NULL
         RETURNING subject_account_id`,
        [data.reviewId, data.revealedAt, data.reason],
      );

      const subjectAccountId = subjectResult.rows[0]?.subject_account_id;
      if (!subjectAccountId) {
        return;
      }

      await refreshReviewSummary(db, subjectAccountId, data.revealedAt);
    },
  };
}
