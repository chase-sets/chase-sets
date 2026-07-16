import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import {
  normalizeMarketplaceReviewScoringFact,
  normalizeMarketplaceReviewSubmittedScoring,
} from "@chase-sets/event-core/review-scoring-facts";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Recomputes the denormalized seller reputation counters (`average_rating` /
 * `review_count`) onto the `checkout_seller_accounts` join row for the given
 * account from the auxiliary `checkout_seller_account_reviews` table.
 *
 * Checkout only ever surfaces a seller's reputation to buyers (cart line,
 * savings notice), so the counters are scoped to the account's AS-SELLER
 * reviews only: a review's `author_role` records the role the AUTHOR played,
 * so a review authored by a buyer (`author_role = 'buyer'`) is about the
 * subject acting as a seller. Blending in reviews the account earned as a
 * buyer would misrepresent its seller reliability (m108).
 *
 * `average_rating = ROUND(AVG(rating), 2)` over the account's `active`,
 * as-seller reviews (NULL when there are none) and `review_count = COUNT(*)`,
 * mirroring discovery's `refreshAccountReputation`. Recomputing from the
 * auxiliary review rows (rather than applying deltas in place) keeps the
 * projection replay-safe and event-ordering independent: the counters are
 * derived state, so re-running any review event converges to the same values.
 * The reputation row is upserted onto a possibly-not-yet-projected account so
 * a review observed before the `identity.account.created` event still records
 * counters once the identity handler backfills `display_name` / `slug`.
 */
async function refreshCheckoutSellerAccountReputation(
  db: PgQueryable,
  accountId: string,
  updatedAt: string,
): Promise<void> {
  await db.query(
    `INSERT INTO checkout_seller_accounts (
       account_id,
       display_name,
       slug,
       average_rating,
       review_count,
       rating_count,
       updated_at
     )
     SELECT
       $1,
       '',
       '',
       CASE WHEN COUNT(*) FILTER (WHERE scoring_disposition = 'included') = 0
         THEN NULL ELSE ROUND(AVG(rating) FILTER (WHERE scoring_disposition = 'included')::numeric, 2) END,
       COUNT(*)::integer,
       COUNT(*) FILTER (WHERE scoring_disposition = 'included')::integer,
       $2
     FROM checkout_seller_account_reviews
     WHERE subject_account_id = $1
       AND status = 'active'
       AND author_role = 'buyer'
       AND revealed_at IS NOT NULL
       AND held = false
     ON CONFLICT (account_id) DO UPDATE SET
       average_rating = EXCLUDED.average_rating,
       review_count = EXCLUDED.review_count,
       rating_count = EXCLUDED.rating_count,
       updated_at = EXCLUDED.updated_at`,
    [accountId, updatedAt],
  );
}

/**
 * Checkout-local reputation handler set feeding the seller account projection.
 * It maintains a replay-safe auxiliary `checkout_seller_account_reviews` table
 * keyed by `review_id` and recomputes the seller's `average_rating` /
 * `review_count` onto the `checkout_seller_accounts` join row so the cart
 * seller-options read model can surface a seller rating per option.
 *
 * Each handler upserts/transitions behind a `last_stream_version` guard,
 * mirroring the inventory/identity auxiliary tables, so replaying review events
 * converges to the same row without regressing a newer review state.
 * `marketplace.review.updated` / `.withdrawn` carry only the `review_id`, so the
 * affected account is resolved back through the auxiliary review row before
 * recomputing its counters.
 */
export function buildCheckoutReputationSellerReviewsProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "marketplace.review.submitted": async (event) => {
      const data = event.data as {
        reviewId: string;
        orderId: string;
        subjectAccountId: string;
        authorRole: string;
        rating: number;
        submittedAt: string;
      };
      const scoring = normalizeMarketplaceReviewSubmittedScoring(event.data);

      await db.query(
        `INSERT INTO checkout_seller_account_reviews (
           review_id,
           order_id,
           subject_account_id,
           author_role,
           rating,
           status,
           last_stream_version,
           submitted_at,
           updated_at,
           scoring_disposition,
           scoring_reason_code,
           scoring_policy_version,
           scoring_source_fact_versions,
           scoring_operational_signal
         ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7, $8, $9, $10, $11::jsonb, $12)
         ON CONFLICT (review_id) DO UPDATE SET
           subject_account_id = EXCLUDED.subject_account_id,
           order_id = EXCLUDED.order_id,
           author_role = EXCLUDED.author_role,
           rating = EXCLUDED.rating,
           status = EXCLUDED.status,
           last_stream_version = EXCLUDED.last_stream_version,
           submitted_at = COALESCE(checkout_seller_account_reviews.submitted_at, EXCLUDED.submitted_at),
           scoring_disposition = EXCLUDED.scoring_disposition,
           scoring_reason_code = EXCLUDED.scoring_reason_code,
           scoring_policy_version = EXCLUDED.scoring_policy_version,
           scoring_source_fact_versions = EXCLUDED.scoring_source_fact_versions,
           scoring_operational_signal = EXCLUDED.scoring_operational_signal,
           updated_at = EXCLUDED.updated_at
         WHERE checkout_seller_account_reviews.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.reviewId,
          data.orderId,
          data.subjectAccountId,
          data.authorRole,
          data.rating,
          event.streamVersion,
          data.submittedAt,
          scoring.scoringDisposition,
          scoring.reasonCode,
          scoring.policyVersion,
          JSON.stringify(scoring.sourceFactVersions),
          scoring.operationalSignal,
        ],
      );

      await refreshCheckoutSellerAccountReputation(db, data.subjectAccountId, data.submittedAt);
    },
    "marketplace.review.updated": async (event) => {
      const data = event.data as {
        reviewId: string;
        rating: number;
        updatedAt: string;
      };

      const updated = await db.query<{ subject_account_id: string }>(
        `UPDATE checkout_seller_account_reviews
         SET rating = $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE review_id = $1
           AND last_stream_version < $4
         RETURNING subject_account_id`,
        [data.reviewId, data.rating, data.updatedAt, event.streamVersion],
      );

      const subjectAccountId = updated.rows[0]?.subject_account_id;
      if (subjectAccountId) {
        await refreshCheckoutSellerAccountReputation(db, subjectAccountId, data.updatedAt);
      }
    },
    "marketplace.review.withdrawn": async (event) => {
      const data = event.data as {
        reviewId: string;
        withdrawnAt: string;
      };

      const withdrawn = await db.query<{ subject_account_id: string }>(
        `UPDATE checkout_seller_account_reviews
         SET status = 'withdrawn',
             updated_at = $2,
             last_stream_version = $3
         WHERE review_id = $1
           AND last_stream_version < $3
         RETURNING subject_account_id`,
        [data.reviewId, data.withdrawnAt, event.streamVersion],
      );

      const subjectAccountId = withdrawn.rows[0]?.subject_account_id;
      if (subjectAccountId) {
        await refreshCheckoutSellerAccountReputation(db, subjectAccountId, data.withdrawnAt);
      }
    },
    "marketplace.review.revealed": async (event) => {
      const data = event.data as {
        reviewId: string;
        revealedAt: string;
      };

      const revealed = await db.query<{ subject_account_id: string }>(
        `UPDATE checkout_seller_account_reviews
         SET revealed_at = $2,
             last_stream_version = $3
         WHERE review_id = $1
           AND revealed_at IS NULL
           AND last_stream_version < $3
         RETURNING subject_account_id`,
        [data.reviewId, data.revealedAt, event.streamVersion],
      );

      const subjectAccountId = revealed.rows[0]?.subject_account_id;
      if (subjectAccountId) {
        await refreshCheckoutSellerAccountReputation(db, subjectAccountId, data.revealedAt);
      }
    },
    "marketplace.review-scoring.disposition-projected.v1": async (event) => {
      const fact = normalizeMarketplaceReviewScoringFact(event.data);
      const updated = await db.query<{ subject_account_id: string }>(
        `UPDATE checkout_seller_account_reviews
         SET scoring_disposition = CASE WHEN author_role = 'buyer' THEN $2 ELSE $4 END,
             scoring_reason_code = CASE WHEN author_role = 'buyer' THEN $3 ELSE $5 END,
             scoring_policy_version = $6,
             scoring_source_fact_versions = $7::jsonb,
             scoring_operational_signal = $8,
             last_scoring_stream_version = $9,
             updated_at = GREATEST(updated_at, $10::timestamptz)
         WHERE order_id = $1
           AND last_scoring_stream_version <= $9
         RETURNING subject_account_id`,
        [
          fact.orderId,
          fact.buyerToSeller.scoringDisposition,
          fact.buyerToSeller.reasonCode,
          fact.sellerToBuyer.scoringDisposition,
          fact.sellerToBuyer.reasonCode,
          fact.buyerToSeller.policyVersion,
          JSON.stringify(fact.buyerToSeller.sourceFactVersions),
          fact.buyerToSeller.operationalSignal ?? fact.sellerToBuyer.operationalSignal,
          event.streamVersion,
          fact.projectedAt,
        ],
      );
      for (const subjectAccountId of new Set(updated.rows.map((row) => row.subject_account_id))) {
        await refreshCheckoutSellerAccountReputation(db, subjectAccountId, fact.projectedAt);
      }
    },
    ...Object.fromEntries(
      [
        "marketplace.review-hold.placed",
        "marketplace.review-hold.extended",
        "marketplace.review-hold.reduced",
        "marketplace.review-hold.released",
        "marketplace.review-hold.terminal-recorded",
      ].map((eventType) => [
        eventType,
        async (event: Parameters<ProjectorHandlerMap[string]>[0]) => {
          const data = event.data as { orderId: string; heldDirections: readonly string[]; lifecycleAt: string };
          const updated = await db.query<{ subject_account_id: string }>(
            `UPDATE checkout_seller_account_reviews
             SET held = CASE WHEN author_role = 'buyer'
               THEN 'buyer-to-seller' = ANY($2::text[])
               ELSE 'seller-to-buyer' = ANY($2::text[])
             END,
                 updated_at = GREATEST(updated_at, $3::timestamptz)
             WHERE order_id = $1
             RETURNING subject_account_id`,
            [data.orderId, data.heldDirections, data.lifecycleAt],
          );
          for (const subjectAccountId of new Set(updated.rows.map((row) => row.subject_account_id))) {
            await refreshCheckoutSellerAccountReputation(db, subjectAccountId, data.lifecycleAt);
          }
        },
      ]),
    ),
  };
}
