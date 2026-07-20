import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { recordRealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import { createPricingProductMarketStatsPatch } from "../../../support/realtime-support/patches";
import {
  MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE,
  type MarketStatHygienePolicyValue,
} from "../../market-trades/domain/stat-hygiene-policy";
import {
  acknowledgeTradeRollupRederive,
  listQueuedTradeRollupRederives,
} from "../../market-trades/read-model/rollup-rederive-queue";
import {
  loadMarketStatHygienePolicyRevision,
  resolveMarketStatHygienePolicyRevisionForPeriod,
} from "./stat-hygiene-policy-revision";
import { getProductMarketStatsSnapshot } from "./queries";

/**
 * Daily rollup maintenance: a scheduled worker job, not a checkpointed
 * event-sourced projection.
 *
 * Daily product rollups are pure, deterministic policy-shaped aggregations over the
 * already-correct, replay-backfilled Trades Tape (`pricing_market_trades`)
 * -- re-running `recomputeDailyProductRollup` for the same day always
 * produces the same row, from any worker, on any schedule, with no
 * projection checkpoint required. Each period persists the immutable policy
 * revision that shaped its median, so re-derivation never consults a newer
 * live revision. That is what makes the slice
 * "recompute-safe (replay converges)" per this slice's acceptance criteria:
 * a full tape rebuild followed by one closer pass reproduces identical
 * rollups, because the rollup IS the tape, aggregated with the same bound
 * policy revision.
 *
 * Market-state snapshots are different in kind: `pricing_market_listing_inputs`
 * / `pricing_buyer_offer_inputs` are CURRENT-state projections (latest
 * status per listing/offer, not a historical log), so "active listing count
 * as of the end of day N" can only be captured by reading that current state
 * at the moment the closer job runs on day N -- an event-sourced projection
 * reacting to the same marketplace events would not be any more accurate for
 * a day whose close it missed. This is the accepted, documented seam the
 * epic's own framing anticipates: "end-of-day ... from the existing
 * listing/offer input tables (state already projected for recommendations)".
 *
 * A single scheduled pass (`runDailyRollupCloser`) drives both: it re-derives
 * a trailing window of recently-active days (catching late refund/cancel
 * exclusions on already-closed days) and refreshes today's market-state
 * snapshot + the denormalized product aggregate for every product with
 * recent listing, offer, or trade activity. Running it every few minutes
 * (see deployables/platform-worker) gives near-real-time freshness without
 * the cross-projection-checkpoint race a second, event-reactive projection
 * subscribing to the same ordering/fulfillment/marketplace events would risk
 * (that projection's checkpoint could lag the Trades Tape's own checkpoint on
 * the identical event, reading stale tape state).
 */

export type ProductTuple = Readonly<{ catalogItemId: string; productId: string }>;
export type ProductDayTuple = ProductTuple & Readonly<{ day: string }>;

export type DailyRollupCloserParams = Readonly<{
  /** Defaults to the current time. Exposed for deterministic tests. */
  now?: string;
  /** Trailing days (inclusive of today) re-derived from the tape on every pass. */
  trailingWindowDays?: number;
  /** Bounds how many (item, product, day) / (item, product) tuples one pass recomputes. */
  limit?: number;
  /** Bounds retroactive sold-day repairs independently of the live trailing window. */
  rederiveQueueLimit?: number;
}>;

export type DailyRollupCloserResult = Readonly<{
  rollupDaysRecomputed: number;
  marketStateSnapshotsRecomputed: number;
  productAggregatesRecomputed: number;
  platformDaysRecomputed: number;
}>;

const DEFAULT_CLOSER_LIMIT = 500;
export const DEFAULT_REDERIVE_QUEUE_LIMIT = 100;

/**
 * The live stat-hygiene dials this closer pass depends on -- the trailing
 * re-derive window and 30/90-day convenience lookback/trim configuration --
 * are resolved ONCE per pass by the
 * caller (`../api/runtime.ts`) and threaded through as `policy`, rather than
 * re-resolved per (product, day) tuple: a scheduled pass over hundreds of
 * tuples should see one consistent policy snapshot, not a value that could
 * change mid-pass if a revision lands while it runs. Daily medians are the
 * exception: each UTC period loads its own persisted policy revision below.
 */
export async function runDailyRollupCloser(
  db: PgQueryable,
  params: DailyRollupCloserParams = {},
  policy: MarketStatHygienePolicyValue = MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE,
): Promise<DailyRollupCloserResult> {
  const now = params.now ? new Date(params.now) : new Date();
  const trailingWindowDays = params.trailingWindowDays ?? policy.rollupCloserTrailingWindowDays;
  const limit = params.limit ?? DEFAULT_CLOSER_LIMIT;
  const rederiveQueueLimit = params.rederiveQueueLimit ?? DEFAULT_REDERIVE_QUEUE_LIMIT;
  const windowStart = new Date(now.getTime() - trailingWindowDays * 24 * 60 * 60 * 1000).toISOString();
  const today = utcDateString(now);

  const [recentRollupTuples, queuedRollupTuples] = await Promise.all([
    listRecentTradeDayTuples(db, { since: windowStart, limit }),
    listQueuedTradeRollupRederives(db, rederiveQueueLimit),
  ]);
  const rollupTuples = dedupeProductDayTuples([...queuedRollupTuples, ...recentRollupTuples]);
  for (const tuple of rollupTuples) {
    await recomputeDailyProductRollup(db, tuple);
  }

  // Realtime scope: only products with actual trade activity in this pass's
  // trailing window (i.e. present in rollupTuples) get a realtime patch --
  // not every active-or-traded product recomputed below. `productTuples` is
  // a much wider set (every listed/offered/ever-traded product), and most of
  // those recomputes are no-op refreshes of already-current state; patching
  // all of them every closer run (every few minutes, see module header)
  // would flood the item-detail SSE topic with unchanged data. A real trade
  // is exactly what discovery's item-detail market panel cares about:
  // last-sold/chart-relevant aggregate advances.
  const advancedTuples = new Set(rollupTuples.map((tuple) => tupleKey(tuple)));

  const productTuples = dedupeProductTuples([
    ...queuedRollupTuples,
    ...(await listActiveOrTradedProductTuples(db, { limit })),
  ]);
  for (const tuple of productTuples) {
    await recomputeMarketStateSnapshot(db, { ...tuple, day: today });
    await recomputeProductMarketAggregate(db, tuple, now, policy);

    if (advancedTuples.has(tupleKey(tuple))) {
      await emitProductMarketStatsPatch(db, tuple, now);
    }
  }

  // Platform Daily Rollup: re-derives the same trailing window of
  // days as the per-product rollup above, deduped -- one row per DAY instead
  // of one row per (product, day), so a day already re-derived for several
  // products above is only recomputed once here.
  const platformDays = [...new Set(rollupTuples.map((tuple) => tuple.day))];
  for (const day of platformDays) {
    await recomputePlatformDailyRollup(db, day);
  }

  // Acknowledge only after both the product and platform daily rows have
  // recomputed successfully. Conditional deletion preserves a newer enqueue
  // of the same tuple that races this pass.
  for (const tuple of queuedRollupTuples) {
    await acknowledgeTradeRollupRederive(db, tuple);
  }

  return {
    rollupDaysRecomputed: rollupTuples.length,
    marketStateSnapshotsRecomputed: productTuples.length,
    productAggregatesRecomputed: productTuples.length,
    platformDaysRecomputed: platformDays.length,
  };
}

function tupleKey(tuple: ProductTuple): string {
  return `${tuple.catalogItemId}:${tuple.productId}`;
}

function productDayTupleKey(tuple: ProductDayTuple): string {
  return `${tupleKey(tuple)}:${tuple.day}`;
}

function dedupeProductDayTuples(tuples: readonly ProductDayTuple[]): readonly ProductDayTuple[] {
  return [...new Map(tuples.map((tuple) => [productDayTupleKey(tuple), tuple])).values()];
}

function dedupeProductTuples(tuples: readonly ProductTuple[]): readonly ProductTuple[] {
  return [...new Map(tuples.map((tuple) => [tupleKey(tuple), tuple])).values()];
}

/**
 * Records one realtime patch on Discovery's `item:{catalogItemId}` topic
 * (see ../../../support/realtime-support/topics.ts for why pricing reuses
 * that topic namespace) carrying the freshly-recomputed stats snapshot, so
 * the item-detail market panel's last-sold/chart state updates without a
 * page refresh (the m106 realtime hook pattern). `sourceGlobalPosition` is
 * synthesized from the closer pass's `now` -- this job is a scheduled
 * recompute, not an event handler, so there is no upstream event
 * globalPosition to carry; uniqueness only needs to hold per (projection,
 * position, patchKey) tuple, which a millisecond timestamp plus the
 * per-product patchKey satisfies for any realistic closer cadence.
 */
async function emitProductMarketStatsPatch(db: PgQueryable, tuple: ProductTuple, now: Date): Promise<void> {
  const stats = await getProductMarketStatsSnapshot(db, tuple);
  const patch = createPricingProductMarketStatsPatch(tuple.catalogItemId, tuple.productId, stats);

  await recordRealtimeProjectionPatch(db, {
    sourceGlobalPosition: String(now.getTime()),
    projectionName: "pricing-market-rollups-closer",
    patchKey: `market-stats:${tupleKey(tuple)}`,
    topics: patch.topics,
    recordedAt: now.toISOString(),
    patch,
  });
}

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function listRecentTradeDayTuples(
  db: PgQueryable,
  params: Readonly<{ since: string; limit: number }>,
): Promise<readonly ProductDayTuple[]> {
  const result = await db.query<{ catalog_catalog_item_id: string; product_id: string; day: string }>(
    `SELECT DISTINCT
       catalog_catalog_item_id,
       product_id,
       (sold_at AT TIME ZONE 'UTC')::date::text AS day
     FROM pricing_market_trades
     WHERE sold_at IS NOT NULL
       AND sold_at >= $1
     ORDER BY day DESC
     LIMIT $2`,
    [params.since, params.limit],
  );
  return result.rows.map((row) => ({
    catalogItemId: row.catalog_catalog_item_id,
    productId: row.product_id,
    day: row.day,
  }));
}

async function listActiveOrTradedProductTuples(
  db: PgQueryable,
  params: Readonly<{ limit: number }>,
): Promise<readonly ProductTuple[]> {
  const result = await db.query<{ catalog_catalog_item_id: string; product_id: string }>(
    `SELECT catalog_catalog_item_id, product_id
     FROM (
       SELECT catalog_catalog_item_id, product_id FROM pricing_market_listing_inputs WHERE status = 'active'
       UNION
       SELECT catalog_catalog_item_id, product_id FROM pricing_buyer_offer_inputs WHERE status = 'submitted'
       UNION
       SELECT catalog_catalog_item_id, product_id FROM pricing_market_trades
     ) AS active_or_traded_products
     LIMIT $1`,
    [params.limit],
  );
  return result.rows.map((row) => ({ catalogItemId: row.catalog_catalog_item_id, productId: row.product_id }));
}

/**
 * Recomputes one day's rollup row entirely from `pricing_market_trades` and
 * upserts it -- deterministic and idempotent: calling this twice for the
 * same day with unchanged tape data produces the same row.
 *
 * `median_price_amount` stores the policy-trimmed median UNCONDITIONALLY
 * (never minimum-sample-suppressed here); see the schema header and
 * queries.ts for where display gating is enforced. Every other column is a
 * raw included-trade fact. Existing rows load their bound revision; a row
 * created during replay resolves the revision effective at its period close.
 */
export async function recomputeDailyProductRollup(db: PgQueryable, params: ProductDayTuple): Promise<void> {
  const existingBinding = await db.query<{ stat_hygiene_policy_revision_id: string }>(
    `SELECT stat_hygiene_policy_revision_id
     FROM pricing_daily_product_rollups
     WHERE catalog_catalog_item_id = $1
       AND product_id = $2
       AND day = $3`,
    [params.catalogItemId, params.productId, params.day],
  );
  const policyRevision = existingBinding.rows[0]
    ? await loadMarketStatHygienePolicyRevision(db, existingBinding.rows[0].stat_hygiene_policy_revision_id)
    : await resolveMarketStatHygienePolicyRevisionForPeriod(db, params.day);
  const policy = policyRevision.value;

  const aggregate = await db.query<{
    first_price_amount: string | null;
    last_price_amount: string | null;
    min_price_amount: string | null;
    max_price_amount: string | null;
    median_price_amount: string | null;
    unit_volume: number;
    trade_count: number;
    verified_trade_count: number;
  }>(
    `WITH included_trades AS (
       SELECT unit_price_amount, quantity, verified, sold_at, line_id
       FROM pricing_market_trades
       WHERE catalog_catalog_item_id = $1
         AND product_id = $2
         AND sold_at >= ($3::date)::timestamp AT TIME ZONE 'UTC'
         AND sold_at < ($3::date + 1)::timestamp AT TIME ZONE 'UTC'
         AND excluded = false
     ), trim_bounds AS (
       SELECT
         CASE WHEN COUNT(*) * $4::numeric / 100 >= 1
           THEN percentile_cont($4::double precision / 100) WITHIN GROUP (ORDER BY unit_price_amount)
           ELSE NULL
         END AS lower_price_amount,
         CASE WHEN COUNT(*) * $4::numeric / 100 >= 1
           THEN percentile_cont(1 - ($4::double precision / 100)) WITHIN GROUP (ORDER BY unit_price_amount)
           ELSE NULL
         END AS upper_price_amount
       FROM included_trades
     )
     SELECT
       (array_agg(unit_price_amount ORDER BY sold_at ASC, line_id ASC))[1]
         AS first_price_amount,
       (array_agg(unit_price_amount ORDER BY sold_at DESC, line_id DESC))[1]
         AS last_price_amount,
       MIN(unit_price_amount) AS min_price_amount,
       MAX(unit_price_amount) AS max_price_amount,
       (SELECT ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY unit_price_amount))::numeric, 2)
        FROM included_trades
        WHERE (SELECT lower_price_amount FROM trim_bounds) IS NULL
           OR unit_price_amount BETWEEN (SELECT lower_price_amount FROM trim_bounds)
                                    AND (SELECT upper_price_amount FROM trim_bounds)) AS median_price_amount,
       COALESCE(SUM(quantity), 0)::integer AS unit_volume,
       COUNT(*)::integer AS trade_count,
       COUNT(*) FILTER (WHERE verified = true)::integer AS verified_trade_count
     FROM included_trades`,
    [params.catalogItemId, params.productId, params.day, policy.outlierTrimPercentile],
  );
  const row = aggregate.rows[0];
  const updatedAt = new Date().toISOString();

  await db.query(
    `INSERT INTO pricing_daily_product_rollups (
       catalog_catalog_item_id, product_id, day,
       first_price_amount, last_price_amount, min_price_amount, max_price_amount, median_price_amount,
       stat_hygiene_policy_revision_id,
       unit_volume, trade_count, verified_trade_count, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (catalog_catalog_item_id, product_id, day) DO UPDATE
     SET first_price_amount = EXCLUDED.first_price_amount,
         last_price_amount = EXCLUDED.last_price_amount,
         min_price_amount = EXCLUDED.min_price_amount,
         max_price_amount = EXCLUDED.max_price_amount,
         median_price_amount = EXCLUDED.median_price_amount,
         stat_hygiene_policy_revision_id = EXCLUDED.stat_hygiene_policy_revision_id,
         unit_volume = EXCLUDED.unit_volume,
         trade_count = EXCLUDED.trade_count,
         verified_trade_count = EXCLUDED.verified_trade_count,
         updated_at = EXCLUDED.updated_at`,
    [
      params.catalogItemId,
      params.productId,
      params.day,
      row?.first_price_amount ?? null,
      row?.last_price_amount ?? null,
      row?.min_price_amount ?? null,
      row?.max_price_amount ?? null,
      row?.median_price_amount ?? null,
      policyRevision.revisionId,
      row?.unit_volume ?? 0,
      row?.trade_count ?? 0,
      row?.verified_trade_count ?? 0,
      updatedAt,
    ],
  );
}

/**
 * Captures today's end-of-day market state (active listings + open offers)
 * from the already-projected current-state input tables. See the module
 * header for why this is a point-in-time read rather than a replay-derived
 * aggregate.
 */
export async function recomputeMarketStateSnapshot(db: PgQueryable, params: ProductDayTuple): Promise<void> {
  const aggregate = await db.query<{
    active_listing_count: number;
    min_ask_amount: string | null;
    open_offer_count: number;
    max_bid_amount: string | null;
  }>(
    `SELECT
       COALESCE(
         (SELECT COUNT(*)::integer FROM pricing_market_listing_inputs
          WHERE catalog_catalog_item_id = $1 AND product_id = $2 AND status = 'active'),
         0
       ) AS active_listing_count,
       (SELECT MIN(price_amount) FROM pricing_market_listing_inputs
        WHERE catalog_catalog_item_id = $1 AND product_id = $2 AND status = 'active') AS min_ask_amount,
       COALESCE(
         (SELECT COUNT(*)::integer FROM pricing_buyer_offer_inputs
          WHERE catalog_catalog_item_id = $1 AND product_id = $2 AND status = 'submitted'),
         0
       ) AS open_offer_count,
       (SELECT MAX(price_amount) FROM pricing_buyer_offer_inputs
        WHERE catalog_catalog_item_id = $1 AND product_id = $2 AND status = 'submitted') AS max_bid_amount`,
    [params.catalogItemId, params.productId],
  );
  const row = aggregate.rows[0]!;
  const spreadAmount =
    row.min_ask_amount !== null && row.max_bid_amount !== null
      ? (Number(row.min_ask_amount) - Number(row.max_bid_amount)).toFixed(2)
      : null;
  const updatedAt = new Date().toISOString();

  await db.query(
    `INSERT INTO pricing_market_state_snapshots (
       catalog_catalog_item_id, product_id, day,
       active_listing_count, min_ask_amount, open_offer_count, max_bid_amount, spread_amount, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (catalog_catalog_item_id, product_id, day) DO UPDATE
     SET active_listing_count = EXCLUDED.active_listing_count,
         min_ask_amount = EXCLUDED.min_ask_amount,
         open_offer_count = EXCLUDED.open_offer_count,
         max_bid_amount = EXCLUDED.max_bid_amount,
         spread_amount = EXCLUDED.spread_amount,
         updated_at = EXCLUDED.updated_at`,
    [
      params.catalogItemId,
      params.productId,
      params.day,
      row.active_listing_count,
      row.min_ask_amount,
      row.open_offer_count,
      row.max_bid_amount,
      spreadAmount,
      updatedAt,
    ],
  );
}

type TradeWindowStats = Readonly<{
  medianPriceAmount: string | null;
  unitVolume: number;
  tradeCount: number;
}>;

async function queryTradeWindowStats(
  db: PgQueryable,
  params: ProductTuple,
  since: string,
  minimumTradeSample: number,
  outlierTrimPercentile: number,
): Promise<TradeWindowStats> {
  const result = await db.query<{ median_price_amount: string | null; unit_volume: number; trade_count: number }>(
    `WITH included_trades AS (
       SELECT unit_price_amount, quantity
       FROM pricing_market_trades
       WHERE catalog_catalog_item_id = $1
         AND product_id = $2
         AND sold_at >= $3
         AND excluded = false
     ), trim_bounds AS (
       SELECT
         CASE WHEN COUNT(*) * $4::numeric / 100 >= 1
           THEN percentile_cont($4::double precision / 100) WITHIN GROUP (ORDER BY unit_price_amount)
           ELSE NULL
         END AS lower_price_amount,
         CASE WHEN COUNT(*) * $4::numeric / 100 >= 1
           THEN percentile_cont(1 - ($4::double precision / 100)) WITHIN GROUP (ORDER BY unit_price_amount)
           ELSE NULL
         END AS upper_price_amount
       FROM included_trades
     )
     SELECT
       (SELECT ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY unit_price_amount))::numeric, 2)
        FROM included_trades
        WHERE (SELECT lower_price_amount FROM trim_bounds) IS NULL
           OR unit_price_amount BETWEEN (SELECT lower_price_amount FROM trim_bounds)
                                    AND (SELECT upper_price_amount FROM trim_bounds)) AS median_price_amount,
       COALESCE(SUM(quantity), 0)::integer AS unit_volume,
       COUNT(*)::integer AS trade_count
     FROM included_trades`,
    [params.catalogItemId, params.productId, since, outlierTrimPercentile],
  );
  const row = result.rows[0]!;
  return {
    // Convenience-aggregate columns are pre-gated at write time (see schema
    // header) -- this table exists specifically for cheap reads with no
    // further query-layer logic required.
    medianPriceAmount: row.trade_count >= minimumTradeSample ? row.median_price_amount : null,
    unitVolume: row.unit_volume,
    tradeCount: row.trade_count,
  };
}

/**
 * Refreshes the denormalized, always-current per-product summary: last-sold
 * trade, 30/90-day median + volume, and Sell-Through Rate.
 */
export async function recomputeProductMarketAggregate(
  db: PgQueryable,
  params: ProductTuple,
  now: Date = new Date(),
  policy: MarketStatHygienePolicyValue = MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE,
): Promise<void> {
  const nowIso = now.toISOString();
  const since30 = new Date(now.getTime() - policy.lookbackDays.short * 24 * 60 * 60 * 1000).toISOString();
  const since90 = new Date(now.getTime() - policy.lookbackDays.long * 24 * 60 * 60 * 1000).toISOString();

  const [lastSoldResult, window30, window90, activeListingResult] = await Promise.all([
    // `sold_at` is timestamptz -- the driver returns it as a JS Date, not a
    // string (pg's default type parser; no OID override in this repo, and
    // `::text` would render Postgres's non-ISO DateStyle output instead of a
    // proper ISO string). Convert with `.toISOString()` below, matching the
    // convention other read models use for timestamptz output.
    db.query<{ last_sold_at: Date | null; last_sold_price_amount: string | null }>(
      `SELECT sold_at AS last_sold_at, unit_price_amount AS last_sold_price_amount
       FROM pricing_market_trades
       WHERE catalog_catalog_item_id = $1 AND product_id = $2 AND excluded = false AND sold_at IS NOT NULL
       ORDER BY sold_at DESC
       LIMIT 1`,
      [params.catalogItemId, params.productId],
    ),
    queryTradeWindowStats(db, params, since30, policy.minimumTradeSample, policy.outlierTrimPercentile),
    queryTradeWindowStats(db, params, since90, policy.minimumTradeSample, policy.outlierTrimPercentile),
    db.query<{ active_listing_quantity: number }>(
      `SELECT COALESCE(SUM(quantity_cap), 0)::integer AS active_listing_quantity
       FROM pricing_market_listing_inputs
       WHERE catalog_catalog_item_id = $1 AND product_id = $2 AND status = 'active'`,
      [params.catalogItemId, params.productId],
    ),
  ]);

  const last = lastSoldResult.rows[0] ?? null;
  const lastSoldAt = last?.last_sold_at ? new Date(last.last_sold_at).toISOString() : null;
  const activeListingQuantity = activeListingResult.rows[0]?.active_listing_quantity ?? 0;
  // Sell-Through Rate (GLOSSARY.md): the share of recent 30-day supply
  // (units sold plus units still actively listed) that actually sold.
  // Documented approximation of "ratio of sold quantity to available
  // quantity over a pricing window" -- available = sold + still-listed,
  // since units that already sold were also part of the available supply
  // at listing time.
  const supply30d = window30.unitVolume + activeListingQuantity;
  const sellThroughRate = supply30d > 0 ? (window30.unitVolume / supply30d).toFixed(4) : null;

  await db.query(
    `INSERT INTO pricing_product_market_aggregates (
       catalog_catalog_item_id, product_id,
       last_sold_at, last_sold_price_amount,
       median_price_30d, volume_30d, trade_count_30d,
       median_price_90d, volume_90d, trade_count_90d,
       sell_through_rate, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (catalog_catalog_item_id, product_id) DO UPDATE
     SET last_sold_at = EXCLUDED.last_sold_at,
         last_sold_price_amount = EXCLUDED.last_sold_price_amount,
         median_price_30d = EXCLUDED.median_price_30d,
         volume_30d = EXCLUDED.volume_30d,
         trade_count_30d = EXCLUDED.trade_count_30d,
         median_price_90d = EXCLUDED.median_price_90d,
         volume_90d = EXCLUDED.volume_90d,
         trade_count_90d = EXCLUDED.trade_count_90d,
         sell_through_rate = EXCLUDED.sell_through_rate,
         updated_at = EXCLUDED.updated_at`,
    [
      params.catalogItemId,
      params.productId,
      lastSoldAt,
      last?.last_sold_price_amount ?? null,
      window30.medianPriceAmount,
      window30.unitVolume,
      window30.tradeCount,
      window90.medianPriceAmount,
      window90.unitVolume,
      window90.tradeCount,
      sellThroughRate,
      nowIso,
    ],
  );
}

/**
 * Recomputes one day's Platform Daily Rollup entirely from
 * `pricing_market_trades`, summed across every product -- the platform-wide
 * counterpart to `recomputeDailyProductRollup`. Deterministic and idempotent
 * for the same reason: the row is fully re-derived from the tape, never
 * incrementally patched, so re-running it for an unchanged day reproduces
 * the same row (replay-convergent).
 */
export async function recomputePlatformDailyRollup(db: PgQueryable, day: string): Promise<void> {
  const aggregate = await db.query<{
    gmv_amount: string | null;
    trade_count: number;
    unit_volume: number;
    order_count: number;
    verified_trade_count: number;
  }>(
    `SELECT
       COALESCE(SUM(unit_price_amount * quantity) FILTER (WHERE excluded = false), 0)::numeric(14, 2)
         AS gmv_amount,
       COUNT(*) FILTER (WHERE excluded = false)::integer AS trade_count,
       COALESCE(SUM(quantity) FILTER (WHERE excluded = false), 0)::integer AS unit_volume,
       COUNT(DISTINCT order_id) FILTER (WHERE excluded = false)::integer AS order_count,
       COUNT(*) FILTER (WHERE excluded = false AND verified = true)::integer AS verified_trade_count
     FROM pricing_market_trades
     WHERE sold_at >= ($1::date)::timestamp AT TIME ZONE 'UTC'
       AND sold_at < ($1::date + 1)::timestamp AT TIME ZONE 'UTC'`,
    [day],
  );
  const row = aggregate.rows[0];
  const updatedAt = new Date().toISOString();

  await db.query(
    `INSERT INTO pricing_platform_daily_rollups (
       day, gmv_amount, trade_count, unit_volume, order_count, verified_trade_count, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (day) DO UPDATE
     SET gmv_amount = EXCLUDED.gmv_amount,
         trade_count = EXCLUDED.trade_count,
         unit_volume = EXCLUDED.unit_volume,
         order_count = EXCLUDED.order_count,
         verified_trade_count = EXCLUDED.verified_trade_count,
         updated_at = EXCLUDED.updated_at`,
    [
      day,
      row?.gmv_amount ?? "0",
      row?.trade_count ?? 0,
      row?.unit_volume ?? 0,
      row?.order_count ?? 0,
      row?.verified_trade_count ?? 0,
      updatedAt,
    ],
  );
}
