import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { buildPricingMarketTradesProjectionHandlers } from "../../market-trades/integrations/source/source-projection";
import { buildPricingMarketplaceInputProjectionHandlers } from "../../recommendations/integrations/source/source-projection";
import { MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE } from "../../market-trades/domain/stat-hygiene-policy";
import { createMarketRollupsRuntime } from "../api/runtime";
import {
  recomputeDailyProductRollup,
  recomputeMarketStateSnapshot,
  recomputeProductMarketAggregate,
  runDailyRollupCloser,
} from "../read-model/rollup-maintenance";
import { getProductMarketStatsSnapshot, getProductRollupSeries } from "../read-model/queries";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["pricing"] as const;

// Monotonic version stamped in delivery order so the projection's stream-version
// guards advance across an entity's lifecycle events even when these seed events
// are not all keyed by the same streamId (mirrors real ordered delivery).
let nextEventStreamVersion = 0;
function event(type: string, data: Record<string, unknown>, recordedAt: string, streamId?: string) {
  nextEventStreamVersion += 1;
  return {
    type,
    streamId: streamId ?? `stream_${type}`,
    streamVersion: nextEventStreamVersion,
    data,
    timing: { recordedAt },
  } as never;
}

describeDb("pricing market-rollups SQL persistence boundary (#4305)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "pricing_market_rollups");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  function tradeHandlers(pool: PgTransactionalPool) {
    return buildPricingMarketTradesProjectionHandlers(pool);
  }

  function marketInputHandlers(pool: PgTransactionalPool) {
    return buildPricingMarketplaceInputProjectionHandlers(pool);
  }

  /** Applies three included trades + one cancelled (excluded) trade on 2026-07-01 for cat_1/prod_1. */
  async function seedJuly1Trades(pool: PgTransactionalPool) {
    const handlers = tradeHandlers(pool);

    await handlers["ordering.order.created"]!(
      event(
        "ordering.order.created",
        {
          orderId: "ord_1",
          sourceType: "cart-checkout",
          buyerAccountId: "buyer_1",
          sellerAccountId: "seller_1",
          lines: [
            { lineId: "line_1", catalogItemId: "cat_1", productId: "prod_1", unitPriceAmount: "10.00", quantity: 1 },
          ],
        },
        "2026-07-01T09:00:00.000Z",
      ),
    );
    await handlers["ordering.order.ready-for-fulfillment-recorded"]!(
      event(
        "ordering.order.ready-for-fulfillment-recorded",
        { orderId: "ord_1", readyForFulfillmentAt: "2026-07-01T10:00:00.000Z" },
        "2026-07-01T10:00:00.000Z",
      ),
    );

    await handlers["ordering.order.created"]!(
      event(
        "ordering.order.created",
        {
          orderId: "ord_2",
          sourceType: "buy-now",
          buyerAccountId: "buyer_2",
          sellerAccountId: "seller_1",
          lines: [
            { lineId: "line_1", catalogItemId: "cat_1", productId: "prod_1", unitPriceAmount: "20.00", quantity: 2 },
          ],
        },
        "2026-07-01T13:00:00.000Z",
      ),
    );
    await handlers["ordering.order.ready-for-fulfillment-recorded"]!(
      event(
        "ordering.order.ready-for-fulfillment-recorded",
        { orderId: "ord_2", readyForFulfillmentAt: "2026-07-01T14:00:00.000Z" },
        "2026-07-01T14:00:00.000Z",
      ),
    );

    await handlers["ordering.order.created"]!(
      event(
        "ordering.order.created",
        {
          orderId: "ord_3",
          sourceType: "offer-acceptance",
          buyerAccountId: "buyer_3",
          sellerAccountId: "seller_1",
          lines: [
            { lineId: "line_1", catalogItemId: "cat_1", productId: "prod_1", unitPriceAmount: "30.00", quantity: 1 },
          ],
        },
        "2026-07-01T17:00:00.000Z",
      ),
    );
    await handlers["ordering.order.ready-for-fulfillment-recorded"]!(
      event(
        "ordering.order.ready-for-fulfillment-recorded",
        { orderId: "ord_3", readyForFulfillmentAt: "2026-07-01T18:00:00.000Z" },
        "2026-07-01T18:00:00.000Z",
      ),
    );

    // A fourth trade that reaches sold_at within the same day and is THEN
    // cancelled (excluded) -- proves the day-range aggregate's `excluded =
    // false` filter is doing real work, not just that a never-sold order is
    // naturally absent from the date range.
    await handlers["ordering.order.created"]!(
      event(
        "ordering.order.created",
        {
          orderId: "ord_4",
          sourceType: "cart-checkout",
          buyerAccountId: "buyer_4",
          sellerAccountId: "seller_1",
          lines: [
            { lineId: "line_1", catalogItemId: "cat_1", productId: "prod_1", unitPriceAmount: "999.00", quantity: 5 },
          ],
        },
        "2026-07-01T19:00:00.000Z",
      ),
    );
    await handlers["ordering.order.ready-for-fulfillment-recorded"]!(
      event(
        "ordering.order.ready-for-fulfillment-recorded",
        { orderId: "ord_4", readyForFulfillmentAt: "2026-07-01T19:15:00.000Z" },
        "2026-07-01T19:15:00.000Z",
      ),
    );
    await handlers["ordering.order.cancelled"]!(
      event(
        "ordering.order.cancelled",
        { orderId: "ord_4", cancelledAt: "2026-07-01T19:30:00.000Z" },
        "2026-07-01T19:30:00.000Z",
      ),
    );
  }

  async function seedIncludedTrades(
    pool: PgTransactionalPool,
    params: Readonly<{
      catalogItemId: string;
      productId: string;
      day: string;
      prices: readonly string[];
      idPrefix: string;
    }>,
  ) {
    const handlers = tradeHandlers(pool);
    const dayStart = new Date(`${params.day}T00:00:00.000Z`).getTime();

    for (const [index, unitPriceAmount] of params.prices.entries()) {
      const orderId = `${params.idPrefix}_${index}`;
      const createdAt = new Date(dayStart + index * 5 * 60 * 1000).toISOString();
      const soldAt = new Date(dayStart + (index * 5 + 1) * 60 * 1000).toISOString();
      await handlers["ordering.order.created"]!(
        event(
          "ordering.order.created",
          {
            orderId,
            sourceType: "buy-now",
            buyerAccountId: `buyer_${orderId}`,
            sellerAccountId: "seller_trim_fixture",
            lines: [
              {
                lineId: "line_1",
                catalogItemId: params.catalogItemId,
                productId: params.productId,
                unitPriceAmount,
                quantity: 1,
              },
            ],
          },
          createdAt,
        ),
      );
      await handlers["ordering.order.ready-for-fulfillment-recorded"]!(
        event("ordering.order.ready-for-fulfillment-recorded", { orderId, readyForFulfillmentAt: soldAt }, soldAt),
      );
    }
  }

  async function activateStatHygienePolicyRevision(
    pool: PgTransactionalPool,
    params: Readonly<{
      documentId: string;
      revisionEventId: string;
      value: typeof MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE;
      effectiveFrom: string;
      effectiveUntil?: string | null;
      recordedAt: string;
    }>,
  ) {
    await pool.query(
      `INSERT INTO platform_policy_documents (
         document_id, policy_key, context_name, schema_summary, status, value,
         effective_from, effective_until, created_at, updated_at
       ) VALUES (
         $1, 'pricing.market-stat-hygiene', 'pricing', 'test fixture', 'active', $2::jsonb,
         $3, $4, $5, $5
       )
       ON CONFLICT (document_id) DO UPDATE
       SET status = EXCLUDED.status,
           value = EXCLUDED.value,
           effective_from = EXCLUDED.effective_from,
           effective_until = EXCLUDED.effective_until,
           updated_at = EXCLUDED.updated_at`,
      [
        params.documentId,
        JSON.stringify(params.value),
        params.effectiveFrom,
        params.effectiveUntil ?? null,
        params.recordedAt,
      ],
    );
    await pool.query(
      `INSERT INTO platform_policy_document_history (
         event_id, document_id, policy_key, event_type, actor_user_id, status, value,
         effective_from, effective_until, recorded_at
       ) VALUES (
         $1, $2, 'pricing.market-stat-hygiene', 'revised', 'user_test', 'active', $3::jsonb,
         $4, $5, $6
       )`,
      [
        params.revisionEventId,
        params.documentId,
        JSON.stringify(params.value),
        params.effectiveFrom,
        params.effectiveUntil ?? null,
        params.recordedAt,
      ],
    );
  }

  it("computes the daily rollup from included trades only: min/max/median/first/last/volume/count", async () => {
    const pool = pools.pricing;
    await seedJuly1Trades(pool);

    await recomputeDailyProductRollup(pool, { catalogItemId: "cat_1", productId: "prod_1", day: "2026-07-01" });

    const row = await pool.query<{
      first_price_amount: string;
      last_price_amount: string;
      min_price_amount: string;
      max_price_amount: string;
      median_price_amount: string;
      unit_volume: number;
      trade_count: number;
      verified_trade_count: number;
    }>(
      `SELECT first_price_amount, last_price_amount, min_price_amount, max_price_amount, median_price_amount,
              unit_volume, trade_count, verified_trade_count
       FROM pricing_daily_product_rollups
       WHERE catalog_catalog_item_id = 'cat_1' AND product_id = 'prod_1' AND day = '2026-07-01'`,
    );

    expect(row.rows[0]).toEqual({
      first_price_amount: "10.00",
      last_price_amount: "30.00",
      min_price_amount: "10.00",
      max_price_amount: "30.00",
      median_price_amount: "20.00",
      unit_volume: 4, // 1 + 2 + 1, excluding the cancelled trade's quantity of 5
      trade_count: 3,
      verified_trade_count: 0,
    });
  });

  it("trims only daily and 30/90-day median inputs while raw facts, counts, and visibility stay unchanged", async () => {
    const pool = pools.pricing;
    const prices = ["0.00", "0.00", ...Array.from({ length: 17 }, (_, index) => `${index + 1}.00`), "100.00"];
    await seedIncludedTrades(pool, {
      catalogItemId: "cat_trim",
      productId: "prod_trim",
      day: "2026-07-01",
      prices,
      idPrefix: "ord_trim",
    });

    await recomputeDailyProductRollup(pool, {
      catalogItemId: "cat_trim",
      productId: "prod_trim",
      day: "2026-07-01",
    });
    await recomputeProductMarketAggregate(
      pool,
      { catalogItemId: "cat_trim", productId: "prod_trim" },
      new Date("2026-07-02T00:00:00.000Z"),
    );

    const daily = await pool.query(
      `SELECT first_price_amount, last_price_amount, min_price_amount, max_price_amount, median_price_amount,
              unit_volume, trade_count
       FROM pricing_daily_product_rollups
       WHERE catalog_catalog_item_id = 'cat_trim' AND product_id = 'prod_trim' AND day = '2026-07-01'`,
    );
    expect(daily.rows[0]).toEqual({
      first_price_amount: "0.00",
      last_price_amount: "100.00",
      min_price_amount: "0.00",
      max_price_amount: "100.00",
      median_price_amount: "8.00",
      unit_volume: 20,
      trade_count: 20,
    });

    const aggregate = await getProductMarketStatsSnapshot(pool, {
      catalogItemId: "cat_trim",
      productId: "prod_trim",
    });
    expect(aggregate.aggregate).toMatchObject({
      lastSoldPriceAmount: "100.00",
      medianPrice30d: "8.00",
      volume30d: 20,
      tradeCount30d: 20,
      medianPrice90d: "8.00",
      volume90d: 20,
      tradeCount90d: 20,
    });
  });

  it("honors the trim floor for a thin daily window", async () => {
    const pool = pools.pricing;
    await activateStatHygienePolicyRevision(pool, {
      documentId: "pol_trim_floor",
      revisionEventId: "evt_trim_floor",
      value: { ...MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE, outlierTrimPercentile: 25 },
      effectiveFrom: "2026-07-03T00:00:00.000Z",
      recordedAt: "2026-07-03T00:00:00.000Z",
    });
    await seedIncludedTrades(pool, {
      catalogItemId: "cat_trim_floor",
      productId: "prod_trim_floor",
      day: "2026-07-03",
      prices: ["0.00", "100.00"],
      idPrefix: "ord_trim_floor",
    });

    await recomputeDailyProductRollup(pool, {
      catalogItemId: "cat_trim_floor",
      productId: "prod_trim_floor",
      day: "2026-07-03",
    });

    const row = await pool.query<{ median_price_amount: string; trade_count: number }>(
      `SELECT median_price_amount, trade_count
       FROM pricing_daily_product_rollups
       WHERE catalog_catalog_item_id = 'cat_trim_floor'
         AND product_id = 'prod_trim_floor'
         AND day = '2026-07-03'`,
    );
    expect(row.rows[0]).toEqual({ median_price_amount: "50.00", trade_count: 2 });
  });

  it("carries the trade count on a below-threshold day but suppresses the median only in the query layer", async () => {
    const pool = pools.pricing;
    const handlers = tradeHandlers(pool);

    // Only 2 trades this day -- below the stat-hygiene policy's minimumTradeSample compiled default (3).
    for (const [orderId, price, hour] of [
      ["ord_a", "10.00", "09"],
      ["ord_b", "12.00", "13"],
    ] as const) {
      await handlers["ordering.order.created"]!(
        event(
          "ordering.order.created",
          {
            orderId,
            sourceType: "cart-checkout",
            buyerAccountId: "buyer_1",
            sellerAccountId: "seller_1",
            lines: [
              { lineId: "line_1", catalogItemId: "cat_2", productId: "prod_2", unitPriceAmount: price, quantity: 1 },
            ],
          },
          `2026-07-02T${hour}:00:00.000Z`,
        ),
      );
      await handlers["ordering.order.ready-for-fulfillment-recorded"]!(
        event(
          "ordering.order.ready-for-fulfillment-recorded",
          { orderId, readyForFulfillmentAt: `2026-07-02T${hour}:30:00.000Z` },
          `2026-07-02T${hour}:30:00.000Z`,
        ),
      );
    }

    await recomputeDailyProductRollup(pool, { catalogItemId: "cat_2", productId: "prod_2", day: "2026-07-02" });

    // The raw table carries the (unsuppressed) median and the true count.
    const raw = await pool.query<{ median_price_amount: string; trade_count: number }>(
      `SELECT median_price_amount, trade_count FROM pricing_daily_product_rollups
       WHERE catalog_catalog_item_id = 'cat_2' AND product_id = 'prod_2' AND day = '2026-07-02'`,
    );
    expect(raw.rows[0]).toEqual({ median_price_amount: "11.00", trade_count: 2 });

    // The query layer gates it: median is suppressed, but volume/count still surface.
    const series = await getProductRollupSeries(pool, {
      catalogItemId: "cat_2",
      productId: "prod_2",
      from: "2026-07-02",
      to: "2026-07-02",
    });
    expect(series).toEqual([expect.objectContaining({ day: "2026-07-02", tradeCount: 2, medianPriceAmount: null })]);
  });

  it("reconciles exactly after a full tape rebuild (replay convergence)", async () => {
    const pool = pools.pricing;
    await seedJuly1Trades(pool);
    await seedIncludedTrades(pool, {
      catalogItemId: "cat_trim_replay",
      productId: "prod_trim_replay",
      day: "2026-07-01",
      prices: ["0.00", "0.00", ...Array.from({ length: 17 }, (_, index) => `${index + 1}.00`), "100.00"],
      idPrefix: "ord_trim_replay",
    });
    await recomputeDailyProductRollup(pool, { catalogItemId: "cat_1", productId: "prod_1", day: "2026-07-01" });
    await recomputeDailyProductRollup(pool, {
      catalogItemId: "cat_trim_replay",
      productId: "prod_trim_replay",
      day: "2026-07-01",
    });

    const before = await pool.query(
      `SELECT first_price_amount, last_price_amount, min_price_amount, max_price_amount, median_price_amount,
              unit_volume, trade_count, verified_trade_count
       FROM pricing_daily_product_rollups
       WHERE day = '2026-07-01'
       ORDER BY catalog_catalog_item_id, product_id`,
    );
    expect(before.rowCount).toBe(2);

    // Wipe the tape and the rollup, then replay the identical event sequence
    // from scratch through fresh projection handlers.
    await pool.query(`DELETE FROM pricing_market_trades`);
    await pool.query(`DELETE FROM pricing_daily_product_rollups`);
    await seedJuly1Trades(pool);
    await seedIncludedTrades(pool, {
      catalogItemId: "cat_trim_replay",
      productId: "prod_trim_replay",
      day: "2026-07-01",
      prices: ["0.00", "0.00", ...Array.from({ length: 17 }, (_, index) => `${index + 1}.00`), "100.00"],
      idPrefix: "ord_trim_replay",
    });
    await recomputeDailyProductRollup(pool, { catalogItemId: "cat_1", productId: "prod_1", day: "2026-07-01" });
    await recomputeDailyProductRollup(pool, {
      catalogItemId: "cat_trim_replay",
      productId: "prod_trim_replay",
      day: "2026-07-01",
    });

    const after = await pool.query(
      `SELECT first_price_amount, last_price_amount, min_price_amount, max_price_amount, median_price_amount,
              unit_volume, trade_count, verified_trade_count
       FROM pricing_daily_product_rollups
       WHERE day = '2026-07-01'
       ORDER BY catalog_catalog_item_id, product_id`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("re-derives a bucketed weekly series with SUM-combined volume/count and a gated weighted median", async () => {
    const pool = pools.pricing;
    await seedJuly1Trades(pool); // 3 included trades on 2026-07-01, median 20.00

    const handlers = tradeHandlers(pool);
    // A second day in the same UTC week (2026-07-02) with 3 more included trades, median 40.00.
    for (const [orderId, price, hour] of [
      ["ord_5", "30.00", "09"],
      ["ord_6", "40.00", "13"],
      ["ord_7", "50.00", "17"],
    ] as const) {
      await handlers["ordering.order.created"]!(
        event(
          "ordering.order.created",
          {
            orderId,
            sourceType: "cart-checkout",
            buyerAccountId: "buyer_1",
            sellerAccountId: "seller_1",
            lines: [
              { lineId: "line_1", catalogItemId: "cat_1", productId: "prod_1", unitPriceAmount: price, quantity: 1 },
            ],
          },
          `2026-07-02T${hour}:00:00.000Z`,
        ),
      );
      await handlers["ordering.order.ready-for-fulfillment-recorded"]!(
        event(
          "ordering.order.ready-for-fulfillment-recorded",
          { orderId, readyForFulfillmentAt: `2026-07-02T${hour}:30:00.000Z` },
          `2026-07-02T${hour}:30:00.000Z`,
        ),
      );
    }

    await recomputeDailyProductRollup(pool, { catalogItemId: "cat_1", productId: "prod_1", day: "2026-07-01" });
    await recomputeDailyProductRollup(pool, { catalogItemId: "cat_1", productId: "prod_1", day: "2026-07-02" });

    const weekly = await getProductRollupSeries(pool, {
      catalogItemId: "cat_1",
      productId: "prod_1",
      from: "2026-06-29",
      to: "2026-07-05",
      granularity: "weekly",
    });

    expect(weekly).toHaveLength(1);
    expect(weekly[0]).toMatchObject({
      unitVolume: 4 + 3,
      tradeCount: 6,
      minPriceAmount: "10.00",
      maxPriceAmount: "50.00",
      // Trade-count-weighted mean of the two equally-sized (3-trade) daily
      // medians: (20.00*3 + 40.00*3) / 6 = 30.00.
      medianPriceAmount: "30.00",
    });
  });

  it("captures end-of-day active listings and open offers as the market-state snapshot, with spread", async () => {
    const pool = pools.pricing;
    const handlers = marketInputHandlers(pool);

    await handlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "lst_1",
          accountId: "seller_1",
          catalogItemId: "cat_3",
          productId: "prod_3",
          priceAmount: "25.00",
          quantityCap: 2,
        },
        "2026-07-05T08:00:00.000Z",
        "marketplace.listing-lst_1",
      ),
    );
    await handlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "2026-07-05T08:01:00.000Z", "marketplace.listing-lst_1"),
    );

    await handlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "lst_2",
          accountId: "seller_2",
          catalogItemId: "cat_3",
          productId: "prod_3",
          priceAmount: "22.00",
          quantityCap: 1,
        },
        "2026-07-05T08:02:00.000Z",
        "marketplace.listing-lst_2",
      ),
    );
    await handlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "2026-07-05T08:03:00.000Z", "marketplace.listing-lst_2"),
    );

    // A paused listing must not count as active.
    await handlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "lst_3",
          accountId: "seller_3",
          catalogItemId: "cat_3",
          productId: "prod_3",
          priceAmount: "5.00",
          quantityCap: 1,
        },
        "2026-07-05T08:04:00.000Z",
        "marketplace.listing-lst_3",
      ),
    );
    await handlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "2026-07-05T08:05:00.000Z", "marketplace.listing-lst_3"),
    );
    await handlers["marketplace.listing.paused"]!(
      event("marketplace.listing.paused", {}, "2026-07-05T08:06:00.000Z", "marketplace.listing-lst_3"),
    );

    await handlers["marketplace.offer.submitted"]!(
      event(
        "marketplace.offer.submitted",
        {
          offerId: "off_1",
          buyerAccountId: "buyer_1",
          catalogItemId: "cat_3",
          productId: "prod_3",
          priceAmount: "15.00",
          quantityRequested: 1,
        },
        "2026-07-05T09:00:00.000Z",
      ),
    );
    await handlers["marketplace.offer.submitted"]!(
      event(
        "marketplace.offer.submitted",
        {
          offerId: "off_2",
          buyerAccountId: "buyer_2",
          catalogItemId: "cat_3",
          productId: "prod_3",
          priceAmount: "18.00",
          quantityRequested: 1,
        },
        "2026-07-05T09:05:00.000Z",
      ),
    );

    await recomputeMarketStateSnapshot(pool, { catalogItemId: "cat_3", productId: "prod_3", day: "2026-07-05" });

    const snapshot = await pool.query<{
      active_listing_count: number;
      min_ask_amount: string;
      open_offer_count: number;
      max_bid_amount: string;
      spread_amount: string;
    }>(
      `SELECT active_listing_count, min_ask_amount, open_offer_count, max_bid_amount, spread_amount
       FROM pricing_market_state_snapshots
       WHERE catalog_catalog_item_id = 'cat_3' AND product_id = 'prod_3' AND day = '2026-07-05'`,
    );

    expect(snapshot.rows[0]).toEqual({
      active_listing_count: 2,
      min_ask_amount: "22.00",
      open_offer_count: 2,
      max_bid_amount: "18.00",
      spread_amount: "4.00",
    });
  });

  it("refreshes the denormalized product market aggregate (last sale, 30/90d windows, sell-through rate)", async () => {
    const pool = pools.pricing;
    await seedJuly1Trades(pool);

    // One active listing (quantity_cap 6) still on the shelf for the sell-through denominator.
    const marketHandlers = marketInputHandlers(pool);
    await marketHandlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "lst_agg",
          accountId: "seller_1",
          catalogItemId: "cat_1",
          productId: "prod_1",
          priceAmount: "25.00",
          quantityCap: 6,
        },
        "2026-07-01T08:00:00.000Z",
        "marketplace.listing-lst_agg",
      ),
    );
    await marketHandlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "2026-07-01T08:01:00.000Z", "marketplace.listing-lst_agg"),
    );

    const now = new Date("2026-07-10T00:00:00.000Z");
    await recomputeProductMarketAggregate(pool, { catalogItemId: "cat_1", productId: "prod_1" }, now);

    const aggregate = await getProductMarketAggregateOrThrow(pool);
    expect(aggregate).toMatchObject({
      lastSoldAt: "2026-07-01T18:00:00.000Z",
      lastSoldPriceAmount: "30.00",
      medianPrice30d: "20.00",
      volume30d: 4,
      tradeCount30d: 3,
      medianPrice90d: "20.00",
      volume90d: 4,
      tradeCount90d: 3,
      // sold (4) / (sold (4) + still-listed (6)) = 0.4
      sellThroughRate: "0.4000",
    });

    async function getProductMarketAggregateOrThrow(dbPool: PgTransactionalPool) {
      const snapshot = await getProductMarketStatsSnapshot(dbPool, { catalogItemId: "cat_1", productId: "prod_1" });
      if (!snapshot.aggregate) {
        throw new Error("Expected a product market aggregate row.");
      }
      return snapshot.aggregate;
    }
  });

  it("runs the daily closer idempotently: a second consecutive pass reproduces identical rollups and snapshots", async () => {
    const pool = pools.pricing;
    await seedJuly1Trades(pool);

    const now = "2026-07-01T20:00:00.000Z";
    const first = await runDailyRollupCloser(pool, { now, trailingWindowDays: 7, limit: 500 });
    expect(first.rollupDaysRecomputed).toBeGreaterThan(0);

    const rollupsAfterFirst = await pool.query(
      `SELECT catalog_catalog_item_id, product_id, day, first_price_amount, last_price_amount, min_price_amount,
              max_price_amount, median_price_amount, unit_volume, trade_count, verified_trade_count
       FROM pricing_daily_product_rollups ORDER BY catalog_catalog_item_id, product_id, day`,
    );

    const second = await runDailyRollupCloser(pool, { now, trailingWindowDays: 7, limit: 500 });
    expect(second.rollupDaysRecomputed).toBe(first.rollupDaysRecomputed);

    const rollupsAfterSecond = await pool.query(
      `SELECT catalog_catalog_item_id, product_id, day, first_price_amount, last_price_amount, min_price_amount,
              max_price_amount, median_price_amount, unit_volume, trade_count, verified_trade_count
       FROM pricing_daily_product_rollups ORDER BY catalog_catalog_item_id, product_id, day`,
    );

    expect(rollupsAfterSecond.rows).toEqual(rollupsAfterFirst.rows);
  });

  it("binds daily medians to period policy revisions and replays deterministically across the revision boundary", async () => {
    const pool = pools.pricing;
    const oldPolicy = { ...MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE, outlierTrimPercentile: 5 };
    const newPolicy = { ...MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE, outlierTrimPercentile: 25 };
    const prices = ["0.00", "0.00", "0.00", "10.00", "20.00", "20.00", "20.00", "100.00"];

    await activateStatHygienePolicyRevision(pool, {
      documentId: "pol_runtime_trim",
      revisionEventId: "evt_runtime_trim_v1",
      value: oldPolicy,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    await seedIncludedTrades(pool, {
      catalogItemId: "cat_runtime_trim",
      productId: "prod_runtime_trim",
      day: "2026-07-01",
      prices,
      idPrefix: "ord_runtime_trim_old",
    });
    await seedIncludedTrades(pool, {
      catalogItemId: "cat_runtime_trim",
      productId: "prod_runtime_trim",
      day: "2026-07-10",
      prices,
      idPrefix: "ord_runtime_trim_in_window",
    });

    // The old period closes under v1 and records that exact immutable event id.
    await recomputeDailyProductRollup(pool, {
      catalogItemId: "cat_runtime_trim",
      productId: "prod_runtime_trim",
      day: "2026-07-01",
    });

    await activateStatHygienePolicyRevision(pool, {
      documentId: "pol_runtime_trim",
      revisionEventId: "evt_runtime_trim_v2",
      value: newPolicy,
      effectiveFrom: "2026-07-10T00:00:00.000Z",
      recordedAt: "2026-07-10T00:00:00.000Z",
    });

    const resolver = createPolicyResolver({
      db: pool,
      now: () => new Date("2026-07-11T20:00:00.000Z"),
    });
    const runtime = createMarketRollupsRuntime({
      db: pool,
      policies: { resolvePolicy: resolver.resolvePolicy },
    });

    const closer = await runtime.runDailyRollupCloser({ now: "2026-07-11T20:00:00.000Z", limit: 500 });
    expect(closer.rollupDaysRecomputed).toBe(1);

    // An explicit late re-derivation must load v1 from the row, never the live v2 document.
    await recomputeDailyProductRollup(pool, {
      catalogItemId: "cat_runtime_trim",
      productId: "prod_runtime_trim",
      day: "2026-07-01",
    });

    const boundRollups = await pool.query<{
      day: string;
      median_price_amount: string;
      stat_hygiene_policy_revision_id: string;
    }>(
      `SELECT day::text, median_price_amount, stat_hygiene_policy_revision_id
       FROM pricing_daily_product_rollups
       WHERE catalog_catalog_item_id = 'cat_runtime_trim'
         AND product_id = 'prod_runtime_trim'
       ORDER BY day`,
    );
    expect(boundRollups.rows).toEqual([
      {
        day: "2026-07-01",
        median_price_amount: "15.00",
        stat_hygiene_policy_revision_id: "evt_runtime_trim_v1",
      },
      {
        day: "2026-07-10",
        median_price_amount: "10.00",
        stat_hygiene_policy_revision_id: "evt_runtime_trim_v2",
      },
    ]);

    // The convenience windows are current aggregates, so they intentionally use live v2.
    const aggregate = await getProductMarketStatsSnapshot(pool, {
      catalogItemId: "cat_runtime_trim",
      productId: "prod_runtime_trim",
    });
    expect(aggregate.aggregate).toMatchObject({
      lastSoldPriceAmount: "100.00",
      medianPrice30d: "10.00",
      tradeCount30d: 16,
      medianPrice90d: "10.00",
      tradeCount90d: 16,
    });

    // A projection rebuild has no rollup bindings to consult. Replay the policy
    // history too, then resolve each period close and reproduce both sides.
    await pool.query(`DELETE FROM pricing_daily_product_rollups`);
    await pool.query(`DELETE FROM platform_policy_document_history WHERE policy_key = 'pricing.market-stat-hygiene'`);
    await pool.query(`DELETE FROM platform_policy_documents WHERE policy_key = 'pricing.market-stat-hygiene'`);
    await activateStatHygienePolicyRevision(pool, {
      documentId: "pol_runtime_trim",
      revisionEventId: "evt_runtime_trim_v1",
      value: oldPolicy,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    await activateStatHygienePolicyRevision(pool, {
      documentId: "pol_runtime_trim",
      revisionEventId: "evt_runtime_trim_v2",
      value: newPolicy,
      effectiveFrom: "2026-07-10T00:00:00.000Z",
      recordedAt: "2026-07-10T00:00:00.000Z",
    });
    await recomputeDailyProductRollup(pool, {
      catalogItemId: "cat_runtime_trim",
      productId: "prod_runtime_trim",
      day: "2026-07-01",
    });
    await recomputeDailyProductRollup(pool, {
      catalogItemId: "cat_runtime_trim",
      productId: "prod_runtime_trim",
      day: "2026-07-10",
    });
    const replayedRollups = await pool.query(
      `SELECT day::text, median_price_amount, stat_hygiene_policy_revision_id
       FROM pricing_daily_product_rollups
       WHERE catalog_catalog_item_id = 'cat_runtime_trim'
         AND product_id = 'prod_runtime_trim'
       ORDER BY day`,
    );
    expect(replayedRollups.rows).toEqual(boundRollups.rows);
  });

  /**
   * Reads the raw outbox rows for a topic (bypassing `readRealtimePatches`'s
   * `expires_at > now()` filter): the closer's `now` param is a fixture
   * timestamp for deterministic tests (see rollup-maintenance.ts's header),
   * so a historical fixture `now` combined with the default 24h retention
   * window would already read as "expired" against the sandbox Postgres
   * server's real wall clock. Production `now` is always real time (no
   * override), so this mismatch is test-only -- asserting on the durable
   * outbox row directly is the correct, clock-independent check here.
   */
  async function readRawOutboxPatchesForTopic(
    pool: PgTransactionalPool,
    topic: string,
  ): Promise<readonly RealtimeProjectionPatch[]> {
    const result = await pool.query<{ payload_json: string }>(
      `SELECT outbox.payload_json
       FROM realtime_projection_outbox AS outbox
       INNER JOIN realtime_projection_outbox_topics AS topic_row ON topic_row.outbox_id = outbox.outbox_id
       WHERE topic_row.topic = $1
       ORDER BY outbox.outbox_id ASC`,
      [topic],
    );
    return result.rows.map((row) => JSON.parse(row.payload_json) as RealtimeProjectionPatch);
  }

  it("emits a realtime pricing.productMarketStats patch on Discovery's item: topic for products with new trade activity (#4307)", async () => {
    const pool = pools.pricing;
    await seedJuly1Trades(pool);

    const now = "2026-07-01T20:00:00.000Z";
    await runDailyRollupCloser(pool, { now, trailingWindowDays: 7, limit: 500 });

    const patches = await readRawOutboxPatchesForTopic(pool, "item:cat_1");
    const patchMessage = patches.find((patch) =>
      patch.changes.some((change) => change.entity === "pricing.productMarketStats" && change.id === "cat_1:prod_1"),
    );

    expect(patchMessage).toBeDefined();
    expect(patchMessage!.context).toBe("pricing");
    expect(patchMessage!.topics).toEqual(["item:cat_1"]);
    const change = patchMessage!.changes.find((entry) => entry.id === "cat_1:prod_1")!;
    if (change.op !== "summary") {
      throw new Error(`Expected a "summary" change, got "${change.op}".`);
    }
    const stats = change.value as Awaited<ReturnType<typeof getProductMarketStatsSnapshot>>;
    expect(stats.aggregate?.lastSoldPriceAmount).toBe("30.00");
  });

  it("does not emit a realtime patch for products with no trade activity in the trailing window", async () => {
    const pool = pools.pricing;
    // A listing with no trades at all -- present in listActiveOrTradedProductTuples
    // (recomputed every pass) but absent from listRecentTradeDayTuples.
    const marketHandlers = marketInputHandlers(pool);
    await marketHandlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "listing_untraded",
          accountId: "seller_1",
          catalogItemId: "cat_untraded",
          productId: "prod_untraded",
          priceAmount: "5.00",
          quantityCap: 10,
        },
        "2026-07-01T08:00:00.000Z",
        "marketplace.listing-listing_untraded",
      ),
    );
    await marketHandlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "2026-07-01T08:05:00.000Z", "marketplace.listing-listing_untraded"),
    );

    const now = "2026-07-01T20:00:00.000Z";
    await runDailyRollupCloser(pool, { now, trailingWindowDays: 7, limit: 500 });

    const patches = await readRawOutboxPatchesForTopic(pool, "item:cat_untraded");

    expect(patches).toHaveLength(0);
  });
});
