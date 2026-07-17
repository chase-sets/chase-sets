import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { marketPriceEstimatedEventType, type MarketPriceEstimatedEvent } from "../domain/domain";

/**
 * Projects `pricing.market-price.estimated` into the current-estimate read
 * model (`pricing_market_price_estimates`). The upsert is guarded by the
 * aggregate's monotonic `estimate_version`, so replay and out-of-order
 * redelivery converge on the latest published estimate per product.
 */
export function buildPricingMarketEstimateProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    [marketPriceEstimatedEventType]: async (event) => {
      const data = event.data as MarketPriceEstimatedEvent["data"];

      await db.query(
        `INSERT INTO pricing_market_price_estimates (
           catalog_catalog_item_id, product_id, estimate_version,
           window_started_at, window_ended_at,
           amount, currency_code, band_low_amount, band_high_amount, confidence,
           platform_verified_trade_count, platform_trade_count, external_comp_count,
           previous_amount, estimated_at, fresh_until, disclosure, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $15)
         ON CONFLICT (catalog_catalog_item_id, product_id) DO UPDATE SET
           estimate_version = EXCLUDED.estimate_version,
           window_started_at = EXCLUDED.window_started_at,
           window_ended_at = EXCLUDED.window_ended_at,
           amount = EXCLUDED.amount,
           currency_code = EXCLUDED.currency_code,
           band_low_amount = EXCLUDED.band_low_amount,
           band_high_amount = EXCLUDED.band_high_amount,
           confidence = EXCLUDED.confidence,
           platform_verified_trade_count = EXCLUDED.platform_verified_trade_count,
           platform_trade_count = EXCLUDED.platform_trade_count,
           external_comp_count = EXCLUDED.external_comp_count,
           previous_amount = EXCLUDED.previous_amount,
           estimated_at = EXCLUDED.estimated_at,
           fresh_until = EXCLUDED.fresh_until,
           disclosure = EXCLUDED.disclosure,
           updated_at = EXCLUDED.updated_at
         WHERE pricing_market_price_estimates.estimate_version < EXCLUDED.estimate_version`,
        [
          data.catalogItemId,
          data.productId,
          Number(data.estimateVersion),
          data.window.startedAt,
          data.window.endedAt,
          data.amount,
          data.currencyCode,
          data.band?.lowAmount ?? null,
          data.band?.highAmount ?? null,
          data.confidence,
          data.inputs.platformVerifiedTradeCount,
          data.inputs.platformTradeCount,
          data.inputs.externalCompCount,
          data.previousAmount,
          data.estimatedAt,
          data.freshUntil,
          data.disclosure,
        ],
      );
    },
  };
}
