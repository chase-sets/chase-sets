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
 * Trades Tape activity, a CURRENT external price signal (see
 * `loadComparableSales` for the signal-lifecycle rule) inside the
 * comparable-sale lookback window, or a currently-published estimate. That
 * last set keeps a product in the closer when an integrity reaction removes
 * its final usable input, so the below-gate path can expire the old answer.
 *
 * Full coverage, not a fixed window: candidates are deterministically
 * keyset-ordered by (catalog item, product) and each pass resumes AFTER the
 * persisted closer cursor (`pricing_market_estimate_closer_cursors`), so a
 * candidate population larger than one pass's `limit` is fully visited
 * across successive closer passes -- the tail beyond the first page is never
 * starved. When a pass drains past the end of the keyspace the cursor resets
 * and the next pass starts over from the beginning. Re-visiting a candidate
 * costs one stream read, never an event (the aggregate decider dedupes
 * unchanged same-day recomputes).
 */
export async function listMarketEstimateCandidateTuples(
  db: PgQueryable,
  params: Readonly<{ since: string; now: string; limit: number; after: MarketEstimateProductTuple | null }>,
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
         AND status = 'current' AND stale_after > $2
       UNION
       SELECT catalog_catalog_item_id, product_id
       FROM pricing_market_price_estimates
       WHERE fresh_until >= $2
     ) AS estimate_candidates
     WHERE ($3::text IS NULL OR (catalog_catalog_item_id, product_id) > ($3::text, $4::text))
     ORDER BY catalog_catalog_item_id, product_id
     LIMIT $5`,
    [params.since, params.now, params.after?.catalogItemId ?? null, params.after?.productId ?? null, params.limit],
  );
  return result.rows.map((row) => ({ catalogItemId: row.catalog_catalog_item_id, productId: row.product_id }));
}

/** Expires a published estimate when its inputs no longer clear the gate. */
export async function expireMarketPriceEstimate(
  db: PgQueryable,
  params: MarketEstimateProductTuple,
  expiredAt: string,
  readUpdatedAt: string,
): Promise<number> {
  const result = await db.query(
    `UPDATE pricing_market_price_estimates
     SET fresh_until = LEAST(fresh_until, $3::timestamptz),
         updated_at = GREATEST(updated_at, $3::timestamptz)
     WHERE catalog_catalog_item_id = $1
       AND product_id = $2
       AND fresh_until > $3
       AND updated_at = $4::timestamptz`,
    [params.catalogItemId, params.productId, expiredAt, readUpdatedAt],
  );
  return result.rowCount ?? 0;
}

/** The projection revision observed by an estimate closer before it mutates freshness. */
export async function getMarketPriceEstimateUpdatedAt(
  db: PgQueryable,
  params: MarketEstimateProductTuple,
): Promise<string | null> {
  const result = await db.query<{ updated_at: Date }>(
    `SELECT updated_at
     FROM pricing_market_price_estimates
     WHERE catalog_catalog_item_id = $1 AND product_id = $2`,
    [params.catalogItemId, params.productId],
  );
  const row = result.rows[0];
  return row ? new Date(row.updated_at).toISOString() : null;
}

const MARKET_ESTIMATE_CLOSER_NAME = "market-price-estimate-closer";

/** Where the last closer pass stopped in the candidate keyspace, or null when the next pass starts from the beginning. */
export async function getMarketEstimateCloserCursor(db: PgQueryable): Promise<MarketEstimateProductTuple | null> {
  const result = await db.query<{ after_catalog_item_id: string; after_product_id: string }>(
    `SELECT after_catalog_item_id, after_product_id
     FROM pricing_market_estimate_closer_cursors
     WHERE closer_name = $1`,
    [MARKET_ESTIMATE_CLOSER_NAME],
  );
  const row = result.rows[0];
  return row ? { catalogItemId: row.after_catalog_item_id, productId: row.after_product_id } : null;
}

/** Persists (or resets, with null) the closer cursor after a pass -- see `listMarketEstimateCandidateTuples`. */
export async function saveMarketEstimateCloserCursor(
  db: PgQueryable,
  cursor: MarketEstimateProductTuple | null,
  updatedAt: string,
): Promise<void> {
  if (cursor === null) {
    await db.query(`DELETE FROM pricing_market_estimate_closer_cursors WHERE closer_name = $1`, [
      MARKET_ESTIMATE_CLOSER_NAME,
    ]);
    return;
  }
  await db.query(
    `INSERT INTO pricing_market_estimate_closer_cursors (closer_name, after_catalog_item_id, after_product_id, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (closer_name) DO UPDATE SET
       after_catalog_item_id = EXCLUDED.after_catalog_item_id,
       after_product_id = EXCLUDED.after_product_id,
       updated_at = EXCLUDED.updated_at`,
    [MARKET_ESTIMATE_CLOSER_NAME, cursor.catalogItemId, cursor.productId, updatedAt],
  );
}

/**
 * Every Comparable Sale for one product inside the lookback window:
 *
 * - Platform trades from the Trades Tape (excluded trades never comp;
 *   the verified marker splits verified from unverified weighting).
 * - External comps from the latest price signal per provider SKU reference
 *   (one comp per external source, not one per ingestion pass --
 *   re-observing the same SKU must not multiply its weight), kept ONLY when
 *   that latest signal is current per the signal store's own lifecycle:
 *   `status = 'current'` AND `stale_after` not yet elapsed. A stale,
 *   superseded, expired, or missing-price signal counts toward NOTHING --
 *   neither the blend nor the minimum-input gate -- and the latest
 *   observation per SKU always speaks for that SKU (an older still-current
 *   signal never resurrects a reference whose newest observation went stale
 *   or lost its price). TCGplayer price signals are the only external
 *   observation store shipped today (`pricing_tcgplayer_price_signals`,
 *   keyed by the same product-key space as the tape); comp inputs are
 *   optional by design -- the blend works platform-only from day one and
 *   widens when the m112 Price Observation store lands.
 */
export async function loadComparableSales(
  db: PgQueryable,
  params: MarketEstimateProductTuple,
  window: Readonly<{ since: string; now: string }>,
): Promise<readonly ComparableSale[]> {
  const [trades, externalComps] = await Promise.all([
    db.query<{
      unit_price_amount: string;
      sold_at: Date;
      verified: boolean;
      buyer_account_id: string;
      seller_account_id: string;
    }>(
      `SELECT unit_price_amount::text AS unit_price_amount, sold_at, verified,
              buyer_account_id, seller_account_id
       FROM pricing_market_trades
       WHERE catalog_catalog_item_id = $1 AND product_id = $2
         AND excluded = false AND sold_at IS NOT NULL AND sold_at >= $3`,
      [params.catalogItemId, params.productId, window.since],
    ),
    db.query<{ market_price_amount: string; observed_at: Date }>(
      `SELECT market_price_amount::text AS market_price_amount, observed_at
       FROM (
         SELECT DISTINCT ON (external_key)
           market_price_amount, observed_at, status, stale_after
         FROM pricing_tcgplayer_price_signals
         WHERE catalog_item_id = $1 AND catalog_product_key = $2 AND observed_at >= $3
         ORDER BY external_key, observed_at DESC
       ) AS latest_signal_per_reference
       WHERE status = 'current' AND stale_after > $4 AND market_price_amount IS NOT NULL`,
      [params.catalogItemId, params.productId, window.since, window.now],
    ),
  ]);

  return [
    ...trades.rows.map(
      (row): ComparableSale => ({
        priceAmount: Number(row.unit_price_amount),
        observedAt: new Date(row.sold_at).toISOString(),
        source: row.verified ? "platform-verified-trade" : "platform-trade",
        buyerAccountId: row.buyer_account_id,
        sellerAccountId: row.seller_account_id,
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
