import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE } from "../../market-trades/domain/stat-hygiene-policy";

/**
 * The market-rollups query API: the serving contract for
 * discovery/public/ops surfaces built on the Daily Product Rollup, the
 * Market-State Snapshot, and the Product Market Aggregate. Minimum-sample
 * gating is enforced exactly once, here -- not per-consumer -- so every
 * caller sees identical suppression behavior.
 *
 * `minimumTradeSample` is resolved once per request by `../api/runtime.ts`
 * through pricing's mounted `PolicyRuntime` (the m110 stat-hygiene policy)
 * and passed in below -- this module stays policy-machinery-free and pure,
 * defaulting to the compiled launch value only for direct/test callers that
 * do not thread a live resolution through.
 */

export type RollupGranularity = "daily" | "weekly" | "monthly";

export type ProductRollupSeriesPoint = Readonly<{
  /** ISO calendar date (UTC). For weekly/monthly granularity, the bucket's first day. */
  day: string;
  firstPriceAmount: string | null;
  lastPriceAmount: string | null;
  minPriceAmount: string | null;
  maxPriceAmount: string | null;
  /**
   * Gated per the resolved stat-hygiene policy's minimumTradeSample. At weekly/monthly granularity
   * this is a trade-count-weighted mean of the contributing daily medians --
   * a documented approximation, not a true recomputed percentile over the
   * wider window (exact multi-day percentiles would need per-trade storage
   * at query time, defeating the "pre-aggregated series, not per-request
   * scans of the tape" point of the daily rollup table). Refine if/when an
   * exact wide-window median becomes a hard requirement.
   */
  medianPriceAmount: string | null;
  unitVolume: number;
  tradeCount: number;
  verifiedTradeCount: number;
}>;

export type GetProductRollupSeriesParams = Readonly<{
  catalogItemId: string;
  productId: string;
  /** Inclusive, YYYY-MM-DD (UTC calendar date). */
  from: string;
  /** Inclusive, YYYY-MM-DD (UTC calendar date). */
  to: string;
  granularity?: RollupGranularity;
}>;

export async function getProductRollupSeries(
  db: PgQueryable,
  params: GetProductRollupSeriesParams,
  minimumTradeSample: number = MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE.minimumTradeSample,
): Promise<readonly ProductRollupSeriesPoint[]> {
  const granularity = params.granularity ?? "daily";
  if (granularity === "daily") {
    return getDailyProductRollupSeries(db, params, minimumTradeSample);
  }
  return getBucketedProductRollupSeries(
    db,
    { ...params, bucket: granularity === "weekly" ? "week" : "month" },
    minimumTradeSample,
  );
}

async function getDailyProductRollupSeries(
  db: PgQueryable,
  params: Pick<GetProductRollupSeriesParams, "catalogItemId" | "productId" | "from" | "to">,
  minimumTradeSample: number,
): Promise<readonly ProductRollupSeriesPoint[]> {
  const result = await db.query<{
    day: string;
    first_price_amount: string | null;
    last_price_amount: string | null;
    min_price_amount: string | null;
    max_price_amount: string | null;
    median_price_amount: string | null;
    unit_volume: number;
    trade_count: number;
    verified_trade_count: number;
  }>(
    `SELECT
       day::text AS day,
       first_price_amount,
       last_price_amount,
       min_price_amount,
       max_price_amount,
       CASE WHEN trade_count >= $5 THEN median_price_amount ELSE NULL END AS median_price_amount,
       unit_volume,
       trade_count,
       verified_trade_count
     FROM pricing_daily_product_rollups
     WHERE catalog_catalog_item_id = $1
       AND product_id = $2
       AND day BETWEEN $3::date AND $4::date
     ORDER BY day ASC`,
    [params.catalogItemId, params.productId, params.from, params.to, minimumTradeSample],
  );

  return result.rows.map(toRollupSeriesPoint);
}

async function getBucketedProductRollupSeries(
  db: PgQueryable,
  params: Pick<GetProductRollupSeriesParams, "catalogItemId" | "productId" | "from" | "to"> &
    Readonly<{ bucket: "week" | "month" }>,
  minimumTradeSample: number,
): Promise<readonly ProductRollupSeriesPoint[]> {
  const result = await db.query<{
    day: string;
    first_price_amount: string | null;
    last_price_amount: string | null;
    min_price_amount: string | null;
    max_price_amount: string | null;
    median_price_amount: string | null;
    unit_volume: number;
    trade_count: number;
    verified_trade_count: number;
  }>(
    `SELECT
       date_trunc($5, day)::date::text AS day,
       (array_agg(first_price_amount ORDER BY day ASC) FILTER (WHERE first_price_amount IS NOT NULL))[1]
         AS first_price_amount,
       (array_agg(last_price_amount ORDER BY day DESC) FILTER (WHERE last_price_amount IS NOT NULL))[1]
         AS last_price_amount,
       MIN(min_price_amount) AS min_price_amount,
       MAX(max_price_amount) AS max_price_amount,
       CASE WHEN SUM(trade_count) >= $6 AND SUM(trade_count) FILTER (WHERE median_price_amount IS NOT NULL) > 0
         THEN ROUND(
           SUM(median_price_amount * trade_count) FILTER (WHERE median_price_amount IS NOT NULL)
             / NULLIF(SUM(trade_count) FILTER (WHERE median_price_amount IS NOT NULL), 0),
           2
         )
         ELSE NULL
       END AS median_price_amount,
       SUM(unit_volume)::integer AS unit_volume,
       SUM(trade_count)::integer AS trade_count,
       SUM(verified_trade_count)::integer AS verified_trade_count
     FROM pricing_daily_product_rollups
     WHERE catalog_catalog_item_id = $1
       AND product_id = $2
       AND day BETWEEN $3::date AND $4::date
     GROUP BY date_trunc($5, day)
     ORDER BY date_trunc($5, day) ASC`,
    [params.catalogItemId, params.productId, params.from, params.to, params.bucket, minimumTradeSample],
  );

  return result.rows.map(toRollupSeriesPoint);
}

function toRollupSeriesPoint(row: {
  day: string;
  first_price_amount: string | null;
  last_price_amount: string | null;
  min_price_amount: string | null;
  max_price_amount: string | null;
  median_price_amount: string | null;
  unit_volume: number;
  trade_count: number;
  verified_trade_count: number;
}): ProductRollupSeriesPoint {
  return {
    day: row.day,
    firstPriceAmount: row.first_price_amount,
    lastPriceAmount: row.last_price_amount,
    minPriceAmount: row.min_price_amount,
    maxPriceAmount: row.max_price_amount,
    medianPriceAmount: row.median_price_amount,
    unitVolume: row.unit_volume,
    tradeCount: row.trade_count,
    verifiedTradeCount: row.verified_trade_count,
  };
}

export type MarketStateSnapshotPoint = Readonly<{
  day: string;
  activeListingCount: number;
  minAskAmount: string | null;
  openOfferCount: number;
  maxBidAmount: string | null;
  spreadAmount: string | null;
}>;

export type GetMarketStateSnapshotSeriesParams = Readonly<{
  catalogItemId: string;
  productId: string;
  from: string;
  to: string;
}>;

export async function getMarketStateSnapshotSeries(
  db: PgQueryable,
  params: GetMarketStateSnapshotSeriesParams,
): Promise<readonly MarketStateSnapshotPoint[]> {
  const result = await db.query<{
    day: string;
    active_listing_count: number;
    min_ask_amount: string | null;
    open_offer_count: number;
    max_bid_amount: string | null;
    spread_amount: string | null;
  }>(
    `SELECT day::text AS day, active_listing_count, min_ask_amount, open_offer_count, max_bid_amount, spread_amount
     FROM pricing_market_state_snapshots
     WHERE catalog_catalog_item_id = $1
       AND product_id = $2
       AND day BETWEEN $3::date AND $4::date
     ORDER BY day ASC`,
    [params.catalogItemId, params.productId, params.from, params.to],
  );

  return result.rows.map(toMarketStateSnapshotPoint);
}

export async function getLatestMarketStateSnapshot(
  db: PgQueryable,
  params: Readonly<{ catalogItemId: string; productId: string }>,
): Promise<MarketStateSnapshotPoint | null> {
  const result = await db.query<{
    day: string;
    active_listing_count: number;
    min_ask_amount: string | null;
    open_offer_count: number;
    max_bid_amount: string | null;
    spread_amount: string | null;
  }>(
    `SELECT day::text AS day, active_listing_count, min_ask_amount, open_offer_count, max_bid_amount, spread_amount
     FROM pricing_market_state_snapshots
     WHERE catalog_catalog_item_id = $1 AND product_id = $2
     ORDER BY day DESC
     LIMIT 1`,
    [params.catalogItemId, params.productId],
  );

  const row = result.rows[0];
  return row ? toMarketStateSnapshotPoint(row) : null;
}

function toMarketStateSnapshotPoint(row: {
  day: string;
  active_listing_count: number;
  min_ask_amount: string | null;
  open_offer_count: number;
  max_bid_amount: string | null;
  spread_amount: string | null;
}): MarketStateSnapshotPoint {
  return {
    day: row.day,
    activeListingCount: row.active_listing_count,
    minAskAmount: row.min_ask_amount,
    openOfferCount: row.open_offer_count,
    maxBidAmount: row.max_bid_amount,
    spreadAmount: row.spread_amount,
  };
}

export type ProductMarketAggregate = Readonly<{
  lastSoldAt: string | null;
  lastSoldPriceAmount: string | null;
  medianPrice30d: string | null;
  volume30d: number;
  tradeCount30d: number;
  medianPrice90d: string | null;
  volume90d: number;
  tradeCount90d: number;
  sellThroughRate: string | null;
}>;

export async function getProductMarketAggregate(
  db: PgQueryable,
  params: Readonly<{ catalogItemId: string; productId: string }>,
): Promise<ProductMarketAggregate | null> {
  // `last_sold_at` is timestamptz -- the driver returns it as a JS Date, not
  // a string (pg's default type parser; no OID override in this repo).
  // Converted to an ISO string below, matching this codebase's timestamptz
  // read-model convention.
  const result = await db.query<{
    last_sold_at: Date | null;
    last_sold_price_amount: string | null;
    median_price_30d: string | null;
    volume_30d: number;
    trade_count_30d: number;
    median_price_90d: string | null;
    volume_90d: number;
    trade_count_90d: number;
    sell_through_rate: string | null;
  }>(
    `SELECT
       last_sold_at, last_sold_price_amount,
       median_price_30d, volume_30d, trade_count_30d,
       median_price_90d, volume_90d, trade_count_90d,
       sell_through_rate
     FROM pricing_product_market_aggregates
     WHERE catalog_catalog_item_id = $1 AND product_id = $2`,
    [params.catalogItemId, params.productId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    lastSoldAt: row.last_sold_at ? new Date(row.last_sold_at).toISOString() : null,
    lastSoldPriceAmount: row.last_sold_price_amount,
    medianPrice30d: row.median_price_30d,
    volume30d: row.volume_30d,
    tradeCount30d: row.trade_count_30d,
    medianPrice90d: row.median_price_90d,
    volume90d: row.volume_90d,
    tradeCount90d: row.trade_count_90d,
    sellThroughRate: row.sell_through_rate,
  };
}

export type ProductMarketStatsSnapshot = Readonly<{
  aggregate: ProductMarketAggregate | null;
  marketState: MarketStateSnapshotPoint | null;
}>;

/**
 * The "stats snapshot fetch" half of the market-rollups query API: one call
 * for the current-state summary a stats panel needs (last sale, 30/90-day
 * medians, sell-through, and today's listing/offer state + spread).
 */
export async function getProductMarketStatsSnapshot(
  db: PgQueryable,
  params: Readonly<{ catalogItemId: string; productId: string }>,
): Promise<ProductMarketStatsSnapshot> {
  const [aggregate, marketState] = await Promise.all([
    getProductMarketAggregate(db, params),
    getLatestMarketStateSnapshot(db, params),
  ]);

  return { aggregate, marketState };
}
