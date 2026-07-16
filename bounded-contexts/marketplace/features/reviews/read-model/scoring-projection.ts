import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { normalizeMarketplaceReviewScoringFact } from "@chase-sets/event-core/review-scoring-facts";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { refreshReviewSummary } from "./projection";

export function buildReviewScoringProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "marketplace.review-scoring.disposition-projected.v1": async (event) => {
      const fact = normalizeMarketplaceReviewScoringFact(event.data);
      const sourceFactVersions = fact.buyerToSeller.sourceFactVersions;
      const signal = fact.buyerToSeller.operationalSignal ?? fact.sellerToBuyer.operationalSignal;
      const stored = await db.query<{ order_id: string }>(
        `INSERT INTO marketplace_review_scoring_pages (
           order_id,
           buyer_to_seller_disposition,
           buyer_to_seller_reason_code,
           seller_to_buyer_disposition,
           seller_to_buyer_reason_code,
           policy_version,
           source_fact_versions,
           operational_signal,
           last_stream_version,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
         ON CONFLICT (order_id) DO UPDATE SET
           buyer_to_seller_disposition = EXCLUDED.buyer_to_seller_disposition,
           buyer_to_seller_reason_code = EXCLUDED.buyer_to_seller_reason_code,
           seller_to_buyer_disposition = EXCLUDED.seller_to_buyer_disposition,
           seller_to_buyer_reason_code = EXCLUDED.seller_to_buyer_reason_code,
           policy_version = EXCLUDED.policy_version,
           source_fact_versions = EXCLUDED.source_fact_versions,
           operational_signal = EXCLUDED.operational_signal,
           last_stream_version = EXCLUDED.last_stream_version,
           updated_at = EXCLUDED.updated_at
         WHERE marketplace_review_scoring_pages.last_stream_version <= EXCLUDED.last_stream_version
         RETURNING order_id`,
        [
          fact.orderId,
          fact.buyerToSeller.scoringDisposition,
          fact.buyerToSeller.reasonCode,
          fact.sellerToBuyer.scoringDisposition,
          fact.sellerToBuyer.reasonCode,
          fact.buyerToSeller.policyVersion,
          JSON.stringify(sourceFactVersions),
          signal,
          event.streamVersion,
          fact.projectedAt,
        ],
      );
      if (!stored.rows[0]) return;

      const affected = await db.query<{ subject_account_id: string }>(
        `UPDATE marketplace_review_pages
         SET scoring_disposition = CASE WHEN author_role = 'buyer' THEN $2 ELSE $4 END,
             scoring_reason_code = CASE WHEN author_role = 'buyer' THEN $3 ELSE $5 END,
             scoring_policy_version = $6,
             scoring_source_fact_versions = $7::jsonb,
             scoring_operational_signal = $8,
             rating_contribution_status =
               status = 'active' AND revealed_at IS NOT NULL AND held = false AND
               CASE WHEN author_role = 'buyer' THEN $2 = 'included' ELSE $4 = 'included' END,
             rating_contribution_version = GREATEST(rating_contribution_version, $9::bigint),
             updated_at = GREATEST(updated_at, $10::timestamptz)
         WHERE order_id = $1
         RETURNING subject_account_id`,
        [
          fact.orderId,
          fact.buyerToSeller.scoringDisposition,
          fact.buyerToSeller.reasonCode,
          fact.sellerToBuyer.scoringDisposition,
          fact.sellerToBuyer.reasonCode,
          fact.buyerToSeller.policyVersion,
          JSON.stringify(sourceFactVersions),
          signal,
          String(event.globalPosition ?? event.streamVersion ?? 0),
          fact.projectedAt,
        ],
      );

      for (const subjectAccountId of new Set(affected.rows.map((row) => row.subject_account_id))) {
        await refreshReviewSummary(db, subjectAccountId, fact.projectedAt);
      }
    },
  };
}
