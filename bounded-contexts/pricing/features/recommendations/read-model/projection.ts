import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildPricingRecommendationProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "pricing.market-price-snapshot.recorded": async (event) => {
      const data = event.data as {
        recommendationId: string;
        catalogItemId: string;
        sellerAccountId: string;
        marketPriceAmount: number;
        marketCurrency: string;
        observedAt: string;
      };

      await db.query(
        `INSERT INTO pricing_recommendation_pages (
           recommendation_id,
           catalog_catalog_item_id,
           seller_account_id,
           market_price_amount,
           market_currency,
           market_observed_at,
           recommended_list_amount,
           recommendation_reason,
           recommendation_published_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, $6)
         ON CONFLICT (recommendation_id)
         DO UPDATE SET
           catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
           seller_account_id = EXCLUDED.seller_account_id,
           market_price_amount = EXCLUDED.market_price_amount,
           market_currency = EXCLUDED.market_currency,
           market_observed_at = EXCLUDED.market_observed_at,
           updated_at = EXCLUDED.updated_at`,
        [
          data.recommendationId,
          data.catalogItemId,
          data.sellerAccountId,
          data.marketPriceAmount,
          data.marketCurrency,
          data.observedAt,
        ],
      );
    },
    "pricing.recommendation.published": async (event) => {
      const data = event.data as {
        recommendationId: string;
        recommendedListAmount: number;
        reason: string;
        publishedAt: string;
      };

      await db.query(
        `UPDATE pricing_recommendation_pages
         SET recommended_list_amount = $2,
             recommendation_reason = $3,
             recommendation_published_at = $4,
             updated_at = $4
         WHERE recommendation_id = $1`,
        [
          data.recommendationId,
          data.recommendedListAmount,
          data.reason,
          data.publishedAt,
        ],
      );
    },
  };
}
