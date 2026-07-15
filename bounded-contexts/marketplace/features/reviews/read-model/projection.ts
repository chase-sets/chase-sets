import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { normalizeMarketplaceReviewSubmittedScoring } from "@chase-sets/event-core/review-scoring-facts";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

// A review's `author_role` records the role the AUTHOR played in the
// underlying order, so the SUBJECT played the opposite role: a review authored
// by a buyer (author_role = 'buyer') was written about the subject acting AS A
// SELLER, and a review authored by a seller was written about the subject
// acting AS A BUYER. Both dimensions are recomputed from the same pass over
// `marketplace_review_pages` so the summary stays replay-safe: re-running any
// review event converges to the same split counters.
export async function refreshReviewSummary(db: PgQueryable, subjectAccountId: string, updatedAt: string) {
  await db.query(
    `INSERT INTO marketplace_review_summary_pages (
       account_id,
       average_rating_as_seller,
       review_count_as_seller,
       rating_count_as_seller,
       rating_1_count_as_seller,
       rating_2_count_as_seller,
       rating_3_count_as_seller,
       rating_4_count_as_seller,
       rating_5_count_as_seller,
       average_rating_as_buyer,
       review_count_as_buyer,
       rating_count_as_buyer,
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
         WHEN COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating_contribution_status = true) = 0 THEN NULL
         ELSE ROUND(AVG(rating) FILTER (WHERE author_role = 'buyer' AND rating_contribution_status = true)::numeric, 2)
       END,
       COUNT(*) FILTER (WHERE author_role = 'buyer')::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating_contribution_status = true)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating_contribution_status = true AND rating = 1)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating_contribution_status = true AND rating = 2)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating_contribution_status = true AND rating = 3)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating_contribution_status = true AND rating = 4)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating_contribution_status = true AND rating = 5)::integer,
       CASE
         WHEN COUNT(*) FILTER (WHERE author_role = 'seller' AND rating_contribution_status = true) = 0 THEN NULL
         ELSE ROUND(AVG(rating) FILTER (WHERE author_role = 'seller' AND rating_contribution_status = true)::numeric, 2)
       END,
       COUNT(*) FILTER (WHERE author_role = 'seller')::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating_contribution_status = true)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating_contribution_status = true AND rating = 1)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating_contribution_status = true AND rating = 2)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating_contribution_status = true AND rating = 3)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating_contribution_status = true AND rating = 4)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating_contribution_status = true AND rating = 5)::integer,
       $2
     FROM marketplace_review_pages
     WHERE subject_account_id = $1
       AND status = 'active'
       AND revealed_at IS NOT NULL
       AND held = false
     ON CONFLICT (account_id) DO UPDATE
     SET average_rating_as_seller = EXCLUDED.average_rating_as_seller,
         review_count_as_seller = EXCLUDED.review_count_as_seller,
         rating_count_as_seller = EXCLUDED.rating_count_as_seller,
         rating_1_count_as_seller = EXCLUDED.rating_1_count_as_seller,
         rating_2_count_as_seller = EXCLUDED.rating_2_count_as_seller,
         rating_3_count_as_seller = EXCLUDED.rating_3_count_as_seller,
         rating_4_count_as_seller = EXCLUDED.rating_4_count_as_seller,
         rating_5_count_as_seller = EXCLUDED.rating_5_count_as_seller,
         average_rating_as_buyer = EXCLUDED.average_rating_as_buyer,
         review_count_as_buyer = EXCLUDED.review_count_as_buyer,
         rating_count_as_buyer = EXCLUDED.rating_count_as_buyer,
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
        resolutionContext?: unknown;
        scoringDisposition?: unknown;
        scoringReasonCode?: unknown;
        scoringPolicyVersion?: unknown;
        scoringSourceFactVersions?: unknown;
        scoringOperationalSignal?: unknown;
      };
      const scoring = normalizeMarketplaceReviewSubmittedScoring(data);
      const contributionVersion = String(event.globalPosition ?? event.streamVersion ?? 0);

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
           reveal_reason,
           held,
           scoring_disposition,
           scoring_reason_code,
           scoring_policy_version,
           scoring_source_fact_versions,
           scoring_operational_signal,
           rating_contribution_status,
           rating_contribution_version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'active', $8, $8, NULL,
           CASE WHEN $9::timestamptz IS NULL THEN $8::timestamptz ELSE NULL END,
           COALESCE($9::timestamptz, $8::timestamptz),
           CASE WHEN $9::timestamptz IS NULL THEN 'window-expired' ELSE NULL END,
           EXISTS (
             SELECT 1
             FROM marketplace_review_hold_pages AS hold
             WHERE hold.order_id = $2
               AND (
                 ($5 = 'buyer' AND 'buyer-to-seller' = ANY(hold.held_directions))
                 OR ($5 = 'seller' AND 'seller-to-buyer' = ANY(hold.held_directions))
               )
           ),
           $10, $11, $12, $13::jsonb, $14,
           CASE
             WHEN $9::timestamptz IS NULL AND $10 = 'included' AND NOT EXISTS (
               SELECT 1 FROM marketplace_review_hold_pages AS hold
               WHERE hold.order_id = $2
                 AND (($5 = 'buyer' AND 'buyer-to-seller' = ANY(hold.held_directions))
                   OR ($5 = 'seller' AND 'seller-to-buyer' = ANY(hold.held_directions)))
             ) THEN true ELSE false
           END,
           $15::bigint
         )
         ON CONFLICT (review_id) DO UPDATE
         SET rating = EXCLUDED.rating,
             feedback = EXCLUDED.feedback,
             status = EXCLUDED.status,
             held = EXCLUDED.held,
             revealed_at = EXCLUDED.revealed_at,
             review_window_expires_at = EXCLUDED.review_window_expires_at,
             reveal_reason = EXCLUDED.reveal_reason,
             scoring_disposition = EXCLUDED.scoring_disposition,
             scoring_reason_code = EXCLUDED.scoring_reason_code,
             scoring_policy_version = EXCLUDED.scoring_policy_version,
             scoring_source_fact_versions = EXCLUDED.scoring_source_fact_versions,
             scoring_operational_signal = EXCLUDED.scoring_operational_signal,
             rating_contribution_status = EXCLUDED.rating_contribution_status,
             rating_contribution_version = EXCLUDED.rating_contribution_version,
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
          scoring.scoringDisposition,
          scoring.reasonCode,
          scoring.policyVersion,
          JSON.stringify(scoring.sourceFactVersions),
          scoring.operationalSignal,
          contributionVersion,
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
             updated_at = $4,
             rating_contribution_version = $5::bigint
         WHERE review_id = $1
         RETURNING subject_account_id`,
        [
          data.reviewId,
          data.rating,
          data.feedback,
          data.updatedAt,
          String(event.globalPosition ?? event.streamVersion ?? 0),
        ],
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
             moderation_reason = $5,
             rating_contribution_status = false,
             rating_contribution_version = $6::bigint
         WHERE review_id = $1
         RETURNING subject_account_id`,
        [
          data.reviewId,
          data.withdrawnAt,
          data.actorType ?? "author",
          data.operatorUserId ?? null,
          data.reason ?? null,
          String(event.globalPosition ?? event.streamVersion ?? 0),
        ],
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
             updated_at = $2,
             rating_contribution_status = scoring_disposition = 'included' AND held = false AND status = 'active',
             rating_contribution_version = $4::bigint
         WHERE review_id = $1
           AND revealed_at IS NULL
         RETURNING subject_account_id`,
        [data.reviewId, data.revealedAt, data.reason, String(event.globalPosition ?? event.streamVersion ?? 0)],
      );

      const subjectAccountId = subjectResult.rows[0]?.subject_account_id;
      if (!subjectAccountId) {
        return;
      }

      await refreshReviewSummary(db, subjectAccountId, data.revealedAt);
    },
  };
}
