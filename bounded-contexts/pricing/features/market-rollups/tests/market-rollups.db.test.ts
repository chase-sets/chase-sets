import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
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
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["pricing"] as const;

function event(type: string, data: Record<string, unknown>, recordedAt: string, streamId?: string) {
  return {
    type,
    streamId: streamId ?? `stream_${type}`,
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

  it("carries the trade count on a below-threshold day but suppresses the median only in the query layer", async () => {
    const pool = pools.pricing;
    const handlers = tradeHandlers(pool);

    // Only 2 trades this day -- below ROLLUP_MINIMUM_TRADE_SAMPLE (3).
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
    await recomputeDailyProductRollup(pool, { catalogItemId: "cat_1", productId: "prod_1", day: "2026-07-01" });

    const before = await pool.query(
      `SELECT first_price_amount, last_price_amount, min_price_amount, max_price_amount, median_price_amount,
              unit_volume, trade_count, verified_trade_count
       FROM pricing_daily_product_rollups
       WHERE catalog_catalog_item_id = 'cat_1' AND product_id = 'prod_1' AND day = '2026-07-01'`,
    );
    expect(before.rowCount).toBe(1);

    // Wipe the tape and the rollup, then replay the identical event sequence
    // from scratch through fresh projection handlers.
    await pool.query(`DELETE FROM pricing_market_trades`);
    await pool.query(`DELETE FROM pricing_daily_product_rollups`);
    await seedJuly1Trades(pool);
    await recomputeDailyProductRollup(pool, { catalogItemId: "cat_1", productId: "prod_1", day: "2026-07-01" });

    const after = await pool.query(
      `SELECT first_price_amount, last_price_amount, min_price_amount, max_price_amount, median_price_amount,
              unit_volume, trade_count, verified_trade_count
       FROM pricing_daily_product_rollups
       WHERE catalog_catalog_item_id = 'cat_1' AND product_id = 'prod_1' AND day = '2026-07-01'`,
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
});
