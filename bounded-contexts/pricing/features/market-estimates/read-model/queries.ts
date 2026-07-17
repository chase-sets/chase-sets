import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ComparableSale, MarketEstimateInputCounts } from "../domain/blended-estimate";

export type MarketEstimateProductTuple = Readonly<{ catalogItemId: string; productId: string }>;

export type MarketPriceEstimateRecord = Readonly<{
  catalogItemId: string;
  productId: string;
  estimateVersion: string;
  windowStartedAt: string;
  windowEndedAt: string;
  amount: string;
  currencyCode: string;
  band: Readonly<{ lowAmount: string; highAmount: string }> | null;
  confidence: "low" | "medium" | "high";
  inputCounts: MarketEstimateInputCounts;
  previousAmount: string | null;
  estimatedAt: string;
  freshUntil: string;
  disclosure: "internal" | "account" | "public";
}>;

/** The current published Market Price for one resolved Product, or null when none has cleared the gate yet. */
export async function getMarketPriceEstimate(
  db: PgQueryable,
  params: MarketEstimateProductTuple,
): Promise<MarketPriceEstimateRecord | null> {
  const result = await db.query<{
    estimate_version: string;
    window_started_at: Date;
    window_ended_at: Date;
    amount: string;
    currency_code: string;
    band_low_amount: string | null;
    band_high_amount: string | null;
    confidence: "low" | "medium" | "high";
    platform_verified_trade_count: number;
    platform_trade_count: number;
    external_comp_count: number;
    previous_amount: string | null;
    estimated_at: Date;
    fresh_until: Date;
    disclosure: "internal" | "account" | "public";
  }>(
    `SELECT estimate_version, window_started_at, window_ended_at,
            amount::text AS amount, currency_code,
            band_low_amount::text AS band_low_amount, band_high_amount::text AS band_high_amount,
            confidence, platform_verified_trade_count, platform_trade_count, external_comp_count,
            previous_amount::text AS previous_amount, estimated_at, fresh_until, disclosure
     FROM pricing_market_price_estimates
     WHERE catalog_catalog_item_id = $1 AND product_id = $2`,
    [params.catalogItemId, params.productId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    catalogItemId: params.catalogItemId,
    productId: params.productId,
    estimateVersion: row.estimate_version,
    windowStartedAt: new Date(row.window_started_at).toISOString(),
    windowEndedAt: new Date(row.window_ended_at).toISOString(),
    amount: row.amount,
    currencyCode: row.currency_code,
    band:
      row.band_low_amount !== null && row.band_high_amount !== null
        ? { lowAmount: row.band_low_amount, highAmount: row.band_high_amount }
        : null,
    confidence: row.confidence,
    inputCounts: {
      platformVerifiedTradeCount: row.platform_verified_trade_count,
      platformTradeCount: row.platform_trade_count,
      externalCompCount: row.external_comp_count,
    },
    previousAmount: row.previous_amount,
    estimatedAt: new Date(row.estimated_at).toISOString(),
    freshUntil: new Date(row.fresh_until).toISOString(),
    disclosure: row.disclosure,
  };
}

/**
 * Products the estimate closer pass considers: anything with non-excluded
 * Trades Tape activity or an external comp observation inside the
 * comparable-sale lookback window. Deterministically ordered so a bounded
 * pass recomputes a stable candidate set; the aggregate decider dedupes
 * unchanged same-day recomputes, so re-visiting a candidate every pass costs
 * one stream read, never an event.
 */
export async function listMarketEstimateCandidateTuples(
  db: PgQueryable,
  params: Readonly<{ since: string; limit: number }>,
): Promise<readonly MarketEstimateProductTuple[]> {
  const result = await db.query<{ catalog_catalog_item_id: string; product_id: string }>(
    `SELECT catalog_catalog_item_id, product_id
     FROM (
       SELECT catalog_catalog_item_id, product_id
       FROM pricing_market_trades
       WHERE excluded = false AND sold_at IS NOT NULL AND sold_at >= $1
       UNION
       SELECT catalog_item_id AS catalog_catalog_item_id, catalog_product_key AS product_id
       FROM pricing_tcgplayer_price_signals
       WHERE market_price_amount IS NOT NULL AND observed_at >= $1
     ) AS estimate_candidates
     ORDER BY catalog_catalog_item_id, product_id
     LIMIT $2`,
    [params.since, params.limit],
  );
  return result.rows.map((row) => ({ catalogItemId: row.catalog_catalog_item_id, productId: row.product_id }));
}

/**
 * Every Comparable Sale for one product inside the lookback window:
 *
 * - Platform trades from the Trades Tape (excluded trades never comp;
 *   the verified marker splits verified from unverified weighting).
 * - External comps from the latest current price signal per provider SKU
 *   reference (one comp per external source, not one per ingestion pass --
 *   re-observing the same SKU must not multiply its weight). TCGplayer price
 *   signals are the only external observation store shipped today
 *   (`pricing_tcgplayer_price_signals`, keyed by the same product-key space
 *   as the tape); comp inputs are optional by design -- the blend works
 *   platform-only from day one and widens when the m112 Price Observation
 *   store lands.
 */
export async function loadComparableSales(
  db: PgQueryable,
  params: MarketEstimateProductTuple,
  since: string,
): Promise<readonly ComparableSale[]> {
  const [trades, externalComps] = await Promise.all([
    db.query<{ unit_price_amount: string; sold_at: Date; verified: boolean }>(
      `SELECT unit_price_amount::text AS unit_price_amount, sold_at, verified
       FROM pricing_market_trades
       WHERE catalog_catalog_item_id = $1 AND product_id = $2
         AND excluded = false AND sold_at IS NOT NULL AND sold_at >= $3`,
      [params.catalogItemId, params.productId, since],
    ),
    db.query<{ market_price_amount: string; observed_at: Date }>(
      `SELECT DISTINCT ON (external_key)
         market_price_amount::text AS market_price_amount, observed_at
       FROM pricing_tcgplayer_price_signals
       WHERE catalog_item_id = $1 AND catalog_product_key = $2
         AND market_price_amount IS NOT NULL AND observed_at >= $3
       ORDER BY external_key, observed_at DESC`,
      [params.catalogItemId, params.productId, since],
    ),
  ]);

  return [
    ...trades.rows.map(
      (row): ComparableSale => ({
        priceAmount: Number(row.unit_price_amount),
        observedAt: new Date(row.sold_at).toISOString(),
        source: row.verified ? "platform-verified-trade" : "platform-trade",
      }),
    ),
    ...externalComps.rows.map(
      (row): ComparableSale => ({
        priceAmount: Number(row.market_price_amount),
        observedAt: new Date(row.observed_at).toISOString(),
        source: "external-comp",
      }),
    ),
  ];
}
