import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildPricingRecommendationProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
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
        [data.recommendationId, data.recommendedListAmount, data.reason, data.publishedAt],
      );
    },
    "pricing.recommendation.proposed": async (event) => {
      const data = event.data as {
        recommendationId: string;
        catalogItemId: string;
        sellerAccountId: string;
        actionType: string;
        listingId: string | null;
        inventoryItemId: string | null;
        marketPriceAmount: number;
        marketCurrency: string;
        marketSignalType: string;
        currentPriceAmount: number | null;
        recommendedListAmount: number;
        reason: string;
        quantityCap: number | null;
        observedAt: string;
      };

      await db.query(
        `INSERT INTO pricing_recommendation_pages (
           recommendation_id,
           catalog_catalog_item_id,
           seller_account_id,
           action_type,
           status,
           listing_id,
           inventory_item_id,
           market_price_amount,
           market_currency,
           market_signal_type,
           market_observed_at,
           current_price_amount,
           recommended_list_amount,
           recommendation_reason,
           quantity_cap,
           applied_listing_id,
           last_error,
           recommendation_published_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, 'proposed', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL, NULL, $10, $10)
         ON CONFLICT (recommendation_id)
         DO UPDATE SET
           catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
           seller_account_id = EXCLUDED.seller_account_id,
           action_type = EXCLUDED.action_type,
           status = EXCLUDED.status,
           listing_id = EXCLUDED.listing_id,
           inventory_item_id = EXCLUDED.inventory_item_id,
           market_price_amount = EXCLUDED.market_price_amount,
           market_currency = EXCLUDED.market_currency,
           market_signal_type = EXCLUDED.market_signal_type,
           market_observed_at = EXCLUDED.market_observed_at,
           current_price_amount = EXCLUDED.current_price_amount,
           recommended_list_amount = EXCLUDED.recommended_list_amount,
           recommendation_reason = EXCLUDED.recommendation_reason,
           quantity_cap = EXCLUDED.quantity_cap,
           applied_listing_id = NULL,
           last_error = NULL,
           recommendation_published_at = EXCLUDED.recommendation_published_at,
           updated_at = EXCLUDED.updated_at`,
        [
          data.recommendationId,
          data.catalogItemId,
          data.sellerAccountId,
          data.actionType,
          data.listingId,
          data.inventoryItemId,
          data.marketPriceAmount,
          data.marketCurrency,
          data.marketSignalType,
          data.observedAt,
          data.currentPriceAmount,
          data.recommendedListAmount,
          data.reason,
          data.quantityCap,
        ],
      );
    },
    "pricing.recommendation.applied": async (event) => {
      const data = event.data as {
        recommendationId: string;
        appliedListingId: string;
        appliedAt: string;
      };

      await db.query(
        `UPDATE pricing_recommendation_pages
         SET status = 'applied',
             applied_listing_id = $2,
             last_error = NULL,
             recommendation_published_at = $3,
             updated_at = $3
         WHERE recommendation_id = $1`,
        [data.recommendationId, data.appliedListingId, data.appliedAt],
      );
    },
    "pricing.recommendation.failed": async (event) => {
      const data = event.data as {
        recommendationId: string;
        errorMessage: string;
        failedAt: string;
      };

      await db.query(
        `UPDATE pricing_recommendation_pages
         SET status = 'failed',
             last_error = $2,
             recommendation_published_at = $3,
             updated_at = $3
         WHERE recommendation_id = $1`,
        [data.recommendationId, data.errorMessage, data.failedAt],
      );
    },
    "pricing.recommendation.dismissed": async (event) => {
      const data = event.data as {
        recommendationId: string;
        dismissedAt: string;
      };

      await db.query(
        `UPDATE pricing_recommendation_pages
         SET status = 'dismissed',
             recommendation_published_at = $2,
             updated_at = $2
         WHERE recommendation_id = $1`,
        [data.recommendationId, data.dismissedAt],
      );
    },
  };
}
