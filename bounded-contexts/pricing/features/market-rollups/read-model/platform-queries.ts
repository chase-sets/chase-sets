import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * The platform-wide half of the market-rollups query API: GMV,
 * liquidity, and catalog-item-breakdown reads that serve platform-operations'
 * ops dashboards. Consumed cross-context ONLY through these exported
 * functions (bound to pricing's own database pool in the platform-api /
 * platform-worker composition roots) -- platform-operations never queries
 * `pricing_market_trades` or the rollup tables directly. This keeps GMV on a
 * single computation path: whatever the ops dashboard shows is exactly what
 * this module computes, the same numbers any future public stats surface
 * would read (one-truth discipline).
 */

export type PlatformRollupGranularity = "daily" | "weekly" | "monthly";

export type PlatformGmvSeriesPoint = Readonly<{
  /** ISO calendar date (UTC). For weekly/monthly granularity, the bucket's first day. */
  day: string;
  gmvAmount: string;
  tradeCount: number;
  unitVolume: number;
  orderCount: number;
  verifiedTradeCount: number;
}>;

export type GetPlatformGmvSeriesParams = Readonly<{
  /** Inclusive, YYYY-MM-DD (UTC calendar date). */
  from: string;
  /** Inclusive, YYYY-MM-DD (UTC calendar date). */
  to: string;
  granularity?: PlatformRollupGranularity;
}>;

/**
 * GMV/volume time series for the ops dashboard's trend chart. Every field is
 * additive (a sum of daily amounts/counts), so weekly/monthly buckets are
 * produced by re-summing `pricing_platform_daily_rollups` rows -- unlike
 * distinct-account counts (see `getPlatformKpiSummary`), summing an additive
 * daily figure across a wider bucket never double-counts.
 */
export async function getPlatformGmvSeries(
  db: PgQueryable,
  params: GetPlatformGmvSeriesParams,
): Promise<readonly PlatformGmvSeriesPoint[]> {
  const granularity = params.granularity ?? "daily";
  if (granularity === "daily") {
    const result = await db.query<{
      day: string;
      gmv_amount: string;
      trade_count: number;
      unit_volume: number;
      order_count: number;
      verified_trade_count: number;
    }>(
      `SELECT day::text AS day, gmv_amount, trade_count, unit_volume, order_count, verified_trade_count
       FROM pricing_platform_daily_rollups
       WHERE day BETWEEN $1::date AND $2::date
       ORDER BY day ASC`,
      [params.from, params.to],
    );
    return result.rows.map(toPlatformGmvSeriesPoint);
  }

  const bucket = granularity === "weekly" ? "week" : "month";
  const result = await db.query<{
    day: string;
    gmv_amount: string;
    trade_count: number;
    unit_volume: number;
    order_count: number;
    verified_trade_count: number;
  }>(
    `SELECT
       date_trunc($3, day)::date::text AS day,
       SUM(gmv_amount)::numeric(14, 2) AS gmv_amount,
       SUM(trade_count)::integer AS trade_count,
       SUM(unit_volume)::integer AS unit_volume,
       SUM(order_count)::integer AS order_count,
       SUM(verified_trade_count)::integer AS verified_trade_count
     FROM pricing_platform_daily_rollups
     WHERE day BETWEEN $1::date AND $2::date
     GROUP BY date_trunc($3, day)
     ORDER BY date_trunc($3, day) ASC`,
    [params.from, params.to, bucket],
  );
  return result.rows.map(toPlatformGmvSeriesPoint);
}

function toPlatformGmvSeriesPoint(row: {
  day: string;
  gmv_amount: string;
  trade_count: number;
  unit_volume: number;
  order_count: number;
  verified_trade_count: number;
}): PlatformGmvSeriesPoint {
  return {
    day: row.day,
    gmvAmount: row.gmv_amount,
    tradeCount: row.trade_count,
    unitVolume: row.unit_volume,
    orderCount: row.order_count,
    verifiedTradeCount: row.verified_trade_count,
  };
}

/** SUM of the Platform Daily Rollup's GMV for a whole calendar month -- the tape side of the tape-vs-ledger reconciliation check. */
export async function getPlatformGmvForMonth(
  db: PgQueryable,
  params: Readonly<{ /** YYYY-MM */ yearMonth: string }>,
): Promise<string> {
  const result = await db.query<{ gmv_amount: string | null }>(
    `SELECT COALESCE(SUM(gmv_amount), 0)::numeric(14, 2) AS gmv_amount
     FROM pricing_platform_daily_rollups
     WHERE date_trunc('month', day) = to_date($1, 'YYYY-MM')`,
    [params.yearMonth],
  );
  return result.rows[0]?.gmv_amount ?? "0.00";
}

export type PlatformKpiSummary = Readonly<{
  gmvAmount: string;
  tradeCount: number;
  orderCount: number;
  unitVolume: number;
  verifiedTradeCount: number;
  activeBuyerCount: number;
  activeSellerCount: number;
}>;

/**
 * Range-scoped platform KPI summary: the ops dashboard's headline stat tiles.
 * Computed directly off the Trades Tape (not the daily rollup table) because
 * `activeBuyerCount`/`activeSellerCount` are DISTINCT-account counts over the
 * whole requested range -- summing per-day distinct counts from a rollup
 * table would double-count a buyer or seller active on more than one day.
 * One raw aggregate query per request is cheap at this context's scale and
 * keeps the distinct-count arithmetic correct by construction; revisit with a
 * dedicated approximate-distinct rollup (e.g. HyperLogLog) if range-scoped
 * summary requests ever need to scan a materially larger tape.
 */
export async function getPlatformKpiSummary(
  db: PgQueryable,
  params: Readonly<{ from: string; to: string }>,
): Promise<PlatformKpiSummary> {
  const result = await db.query<{
    gmv_amount: string | null;
    trade_count: number;
    order_count: number;
    unit_volume: number;
    verified_trade_count: number;
    active_buyer_count: number;
    active_seller_count: number;
  }>(
    `SELECT
       COALESCE(SUM(unit_price_amount * quantity), 0)::numeric(14, 2) AS gmv_amount,
       COUNT(*)::integer AS trade_count,
       COUNT(DISTINCT order_id)::integer AS order_count,
       COALESCE(SUM(quantity), 0)::integer AS unit_volume,
       COUNT(*) FILTER (WHERE verified = true)::integer AS verified_trade_count,
       COUNT(DISTINCT buyer_account_id)::integer AS active_buyer_count,
       COUNT(DISTINCT seller_account_id)::integer AS active_seller_count
     FROM pricing_market_trades
     WHERE excluded = false
       AND sold_at >= ($1::date)::timestamp AT TIME ZONE 'UTC'
       AND sold_at < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'`,
    [params.from, params.to],
  );
  const row = result.rows[0];

  return {
    gmvAmount: row?.gmv_amount ?? "0.00",
    tradeCount: row?.trade_count ?? 0,
    orderCount: row?.order_count ?? 0,
    unitVolume: row?.unit_volume ?? 0,
    verifiedTradeCount: row?.verified_trade_count ?? 0,
    activeBuyerCount: row?.active_buyer_count ?? 0,
    activeSellerCount: row?.active_seller_count ?? 0,
  };
}

export type PlatformLiquiditySummary = Readonly<{
  asOfDay: string;
  /**
   * Platform-wide Sell-Through Rate: `volume sold in the last 30 days /
   * (volume sold + units still actively listed)`, aggregated the same way
   * the per-product convenience aggregate defines it (see
   * `pricing_product_market_aggregates` / GLOSSARY.md "Sell-Through Rate"),
   * just summed across every product instead of computed per product. Null
   * when there is no recent supply at all (nothing sold, nothing listed).
   */
  sellThroughRate: string | null;
  /** Median of that day's per-product ask/bid spread, across products with both an active listing and an open offer. Null when no product has both. */
  medianSpreadAmount: string | null;
  /** How many products contributed a spread sample to the median above -- shown alongside the median so a thin sample is visibly thin, not silently authoritative. */
  spreadSampleCount: number;
  /**
   * Median time-to-sale is NOT included: `pricing_market_listing_inputs`
   * only carries `updated_at` (last status transition), not a listing
   * CREATION timestamp, so "time from listed to sold" cannot be computed
   * without a new field on that projection. A documented, deliberate gap
   * rather than a value derived from the wrong timestamp.
   */
}>;

export async function getPlatformLiquiditySummary(
  db: PgQueryable,
  params: Readonly<{ asOfDay: string }>,
): Promise<PlatformLiquiditySummary> {
  const [supplyResult, spreadResult] = await Promise.all([
    db.query<{ volume_30d: string | null; active_listing_quantity: string | null }>(
      `SELECT
         (SELECT COALESCE(SUM(volume_30d), 0) FROM pricing_product_market_aggregates) AS volume_30d,
         (SELECT COALESCE(SUM(quantity_cap), 0) FROM pricing_market_listing_inputs WHERE status = 'active')
           AS active_listing_quantity`,
    ),
    db.query<{ median_spread_amount: string | null; spread_sample_count: number }>(
      `SELECT
         ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY spread_amount))::numeric, 2) AS median_spread_amount,
         COUNT(*)::integer AS spread_sample_count
       FROM pricing_market_state_snapshots
       WHERE day = $1::date AND spread_amount IS NOT NULL`,
      [params.asOfDay],
    ),
  ]);

  const volume30d = Number(supplyResult.rows[0]?.volume_30d ?? "0");
  const activeListingQuantity = Number(supplyResult.rows[0]?.active_listing_quantity ?? "0");
  const supply30d = volume30d + activeListingQuantity;
  const sellThroughRate = supply30d > 0 ? (volume30d / supply30d).toFixed(4) : null;

  return {
    asOfDay: params.asOfDay,
    sellThroughRate,
    medianSpreadAmount: spreadResult.rows[0]?.median_spread_amount ?? null,
    spreadSampleCount: spreadResult.rows[0]?.spread_sample_count ?? 0,
  };
}

export type SellerCohortGmvSummary = Readonly<{
  gmvAmount: string;
  tradeCount: number;
  unitVolume: number;
}>;

/**
 * GMV/volume attributable to a specific set of seller accounts over a range
 * -- the offer-economics monitor's cohort-scoped counterpart to
 * `getPlatformKpiSummary`. Computed directly off the Trades Tape,
 * the same one-truth source `getPlatformKpiSummary` reads, so "locked
 * cohort GMV" and "platform GMV" are always comparable numbers from the
 * same table with the same exclusion rules. Returns zeros without querying
 * when the cohort is empty (there is nothing to sum).
 */
export async function getSellerCohortGmvSummary(
  db: PgQueryable,
  params: Readonly<{ sellerAccountIds: readonly string[]; from: string; to: string }>,
): Promise<SellerCohortGmvSummary> {
  if (params.sellerAccountIds.length === 0) {
    return { gmvAmount: "0.00", tradeCount: 0, unitVolume: 0 };
  }

  const result = await db.query<{ gmv_amount: string | null; trade_count: number; unit_volume: number }>(
    `SELECT
       COALESCE(SUM(unit_price_amount * quantity), 0)::numeric(14, 2) AS gmv_amount,
       COUNT(*)::integer AS trade_count,
       COALESCE(SUM(quantity), 0)::integer AS unit_volume
     FROM pricing_market_trades
     WHERE excluded = false
       AND seller_account_id = ANY($1::text[])
       AND sold_at >= ($2::date)::timestamp AT TIME ZONE 'UTC'
       AND sold_at < ($3::date + 1)::timestamp AT TIME ZONE 'UTC'`,
    [params.sellerAccountIds, params.from, params.to],
  );
  const row = result.rows[0];

  return {
    gmvAmount: row?.gmv_amount ?? "0.00",
    tradeCount: row?.trade_count ?? 0,
    unitVolume: row?.unit_volume ?? 0,
  };
}

export type SellerCohortWeeklyGmvPoint = Readonly<{
  weekStart: string;
  gmvAmount: string;
  tradeCount: number;
}>;

/**
 * Week-bucketed trade counts/GMV for a seller cohort -- paired with
 * Marketplace's `getLockedFeeListingCohortSummary` weekly listings-created
 * series to compute a real sell-through trend (cumulative trades /
 * cumulative listings created, per week) rather than a single blended
 * ratio, so the monitor can show whether sell-through is decaying as the
 * cohort matures.
 */
export async function getSellerCohortWeeklyGmv(
  db: PgQueryable,
  params: Readonly<{ sellerAccountIds: readonly string[]; from: string; to: string }>,
): Promise<readonly SellerCohortWeeklyGmvPoint[]> {
  if (params.sellerAccountIds.length === 0) {
    return [];
  }

  const result = await db.query<{ week_start: string; gmv_amount: string; trade_count: number }>(
    `SELECT
       date_trunc('week', sold_at)::date::text AS week_start,
       SUM(unit_price_amount * quantity)::numeric(14, 2) AS gmv_amount,
       COUNT(*)::integer AS trade_count
     FROM pricing_market_trades
     WHERE excluded = false
       AND seller_account_id = ANY($1::text[])
       AND sold_at >= ($2::date)::timestamp AT TIME ZONE 'UTC'
       AND sold_at < ($3::date + 1)::timestamp AT TIME ZONE 'UTC'
     GROUP BY date_trunc('week', sold_at)
     ORDER BY date_trunc('week', sold_at) ASC`,
    [params.sellerAccountIds, params.from, params.to],
  );

  return result.rows.map((row) => ({
    weekStart: row.week_start,
    gmvAmount: row.gmv_amount,
    tradeCount: row.trade_count,
  }));
}

export type TopCatalogItemGmv = Readonly<{
  catalogItemId: string;
  title: string | null;
  gmvAmount: string;
  tradeCount: number;
  unitVolume: number;
}>;

/**
 * Top catalog items by GMV for the requested range -- the ops dashboard's
 * "breakdown" surface. This is a per-item breakdown, not a
 * game/category-level rollup: catalog has no queryable "game" or "category"
 * dimension today (only a many-to-many leaf `category_ids` array requiring a
 * cross-context root-category-tree resolution -- see the PR description for
 * the full reasoning). Shipping a real, honest per-item breakdown now rather
 * than blocking on that separately-scoped taxonomy work.
 */
export async function getTopCatalogItemsByGmv(
  db: PgQueryable,
  params: Readonly<{ from: string; to: string; limit?: number }>,
): Promise<readonly TopCatalogItemGmv[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 10, 100));
  const result = await db.query<{
    catalog_catalog_item_id: string;
    title: string | null;
    gmv_amount: string;
    trade_count: number;
    unit_volume: number;
  }>(
    `SELECT
       trades.catalog_catalog_item_id,
       item.title,
       SUM(trades.unit_price_amount * trades.quantity)::numeric(14, 2) AS gmv_amount,
       COUNT(*)::integer AS trade_count,
       COALESCE(SUM(trades.quantity), 0)::integer AS unit_volume
     FROM pricing_market_trades trades
     LEFT JOIN pricing_catalog_item_inputs item ON item.catalog_item_id = trades.catalog_catalog_item_id
     WHERE trades.excluded = false
       AND trades.sold_at >= ($1::date)::timestamp AT TIME ZONE 'UTC'
       AND trades.sold_at < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'
     GROUP BY trades.catalog_catalog_item_id, item.title
     ORDER BY gmv_amount DESC
     LIMIT $3`,
    [params.from, params.to, limit],
  );

  return result.rows.map((row) => ({
    catalogItemId: row.catalog_catalog_item_id,
    title: row.title,
    gmvAmount: row.gmv_amount,
    tradeCount: row.trade_count,
    unitVolume: row.unit_volume,
  }));
}
