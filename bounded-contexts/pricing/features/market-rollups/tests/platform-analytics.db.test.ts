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
import { recomputePlatformDailyRollup, runDailyRollupCloser } from "../read-model/rollup-maintenance";
import {
  getPlatformGmvForMonth,
  getPlatformGmvSeries,
  getPlatformKpiSummary,
  getPlatformLiquiditySummary,
  getSellerCohortGmvSummary,
  getSellerCohortWeeklyGmv,
  getTopCatalogItemsByGmv,
} from "../read-model/platform-queries";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
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

describeDb("pricing platform-wide market analytics SQL persistence boundary", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "pricing_platform_analytics",
    );
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

  /**
   * Two products, two sellers, two buyers, on 2026-07-01: an included
   * $10 x 1 trade (buyer_1/seller_1/cat_1) and an included $20 x 2 trade
   * (buyer_2/seller_1/cat_2), plus a $50 x 1 trade that gets CANCELLED
   * (buyer_1/seller_2/cat_1, excluded). GMV should only count the two
   * included trades: 10 + 40 = 50.00, across 2 orders, 3 total units,
   * 1 buyer distinct from seller_1's two trades (buyer_1, buyer_2 = 2
   * distinct buyers), 2 distinct sellers (seller_1 included, seller_2
   * excluded from the buyer/seller counts because its only trade is
   * cancelled).
   */
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
        { orderId: "ord_1", readyForFulfillmentAt: "2026-07-01T09:30:00.000Z" },
        "2026-07-01T09:30:00.000Z",
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
            { lineId: "line_1", catalogItemId: "cat_2", productId: "prod_2", unitPriceAmount: "20.00", quantity: 2 },
          ],
        },
        "2026-07-01T10:00:00.000Z",
      ),
    );
    await handlers["ordering.order.ready-for-fulfillment-recorded"]!(
      event(
        "ordering.order.ready-for-fulfillment-recorded",
        { orderId: "ord_2", readyForFulfillmentAt: "2026-07-01T10:30:00.000Z" },
        "2026-07-01T10:30:00.000Z",
      ),
    );

    await handlers["ordering.order.created"]!(
      event(
        "ordering.order.created",
        {
          orderId: "ord_3",
          sourceType: "cart-checkout",
          buyerAccountId: "buyer_1",
          sellerAccountId: "seller_2",
          lines: [
            { lineId: "line_1", catalogItemId: "cat_1", productId: "prod_1", unitPriceAmount: "50.00", quantity: 1 },
          ],
        },
        "2026-07-01T11:00:00.000Z",
      ),
    );
    await handlers["ordering.order.ready-for-fulfillment-recorded"]!(
      event(
        "ordering.order.ready-for-fulfillment-recorded",
        { orderId: "ord_3", readyForFulfillmentAt: "2026-07-01T11:30:00.000Z" },
        "2026-07-01T11:30:00.000Z",
      ),
    );
    await handlers["ordering.order.cancelled"]!(
      event(
        "ordering.order.cancelled",
        { orderId: "ord_3", cancelledAt: "2026-07-01T12:00:00.000Z" },
        "2026-07-01T12:00:00.000Z",
      ),
    );
  }

  it("recomputePlatformDailyRollup sums GMV/counts across products, omitting cancelled trades", async () => {
    await seedJuly1Trades(pools.pricing);

    await recomputePlatformDailyRollup(pools.pricing, "2026-07-01");

    const row = await pools.pricing.query<{
      gmv_amount: string;
      trade_count: number;
      unit_volume: number;
      order_count: number;
      verified_trade_count: number;
    }>(`SELECT gmv_amount, trade_count, unit_volume, order_count, verified_trade_count
        FROM pricing_platform_daily_rollups WHERE day = '2026-07-01'`);

    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].gmv_amount).toBe("50.00");
    expect(row.rows[0].trade_count).toBe(2);
    expect(row.rows[0].unit_volume).toBe(3);
    expect(row.rows[0].order_count).toBe(2);
    expect(row.rows[0].verified_trade_count).toBe(0);
  });

  it("recomputePlatformDailyRollup is idempotent (recompute-safe replay convergence)", async () => {
    await seedJuly1Trades(pools.pricing);
    await recomputePlatformDailyRollup(pools.pricing, "2026-07-01");
    await recomputePlatformDailyRollup(pools.pricing, "2026-07-01");

    const row = await pools.pricing.query<{ gmv_amount: string }>(
      `SELECT gmv_amount FROM pricing_platform_daily_rollups WHERE day = '2026-07-01'`,
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].gmv_amount).toBe("50.00");
  });

  it("runDailyRollupCloser also recomputes the deduped platform daily rollup for the trailing window", async () => {
    await seedJuly1Trades(pools.pricing);

    const result = await runDailyRollupCloser(pools.pricing, { now: "2026-07-02T00:00:00.000Z" });

    expect(result.platformDaysRecomputed).toBe(1);
    const row = await pools.pricing.query<{ gmv_amount: string }>(
      `SELECT gmv_amount FROM pricing_platform_daily_rollups WHERE day = '2026-07-01'`,
    );
    expect(row.rows[0]?.gmv_amount).toBe("50.00");
  });

  it("getPlatformGmvSeries returns daily rows and correctly bucketed weekly/monthly sums", async () => {
    await seedJuly1Trades(pools.pricing);
    await recomputePlatformDailyRollup(pools.pricing, "2026-07-01");

    const daily = await getPlatformGmvSeries(pools.pricing, { from: "2026-06-25", to: "2026-07-05" });
    expect(daily).toEqual([
      expect.objectContaining({ day: "2026-07-01", gmvAmount: "50.00", tradeCount: 2, orderCount: 2, unitVolume: 3 }),
    ]);

    const monthly = await getPlatformGmvSeries(pools.pricing, {
      from: "2026-06-01",
      to: "2026-07-31",
      granularity: "monthly",
    });
    expect(monthly).toEqual([expect.objectContaining({ day: "2026-07-01", gmvAmount: "50.00" })]);
  });

  it("getPlatformGmvForMonth sums the whole month for the tape-vs-ledger reconciliation check", async () => {
    await seedJuly1Trades(pools.pricing);
    await recomputePlatformDailyRollup(pools.pricing, "2026-07-01");

    expect(await getPlatformGmvForMonth(pools.pricing, { yearMonth: "2026-07" })).toBe("50.00");
    expect(await getPlatformGmvForMonth(pools.pricing, { yearMonth: "2026-08" })).toBe("0.00");
  });

  it("getPlatformKpiSummary computes distinct buyer/seller counts directly off the tape for the exact range", async () => {
    await seedJuly1Trades(pools.pricing);

    const summary = await getPlatformKpiSummary(pools.pricing, { from: "2026-07-01", to: "2026-07-01" });

    expect(summary.gmvAmount).toBe("50.00");
    expect(summary.tradeCount).toBe(2);
    expect(summary.orderCount).toBe(2);
    expect(summary.unitVolume).toBe(3);
    // Only seller_1's two included trades count; seller_2's only trade is cancelled/excluded.
    expect(summary.activeSellerCount).toBe(1);
    expect(summary.activeBuyerCount).toBe(2);
  });

  it("getTopCatalogItemsByGmv ranks catalog items by GMV over the requested range", async () => {
    await seedJuly1Trades(pools.pricing);

    const topItems = await getTopCatalogItemsByGmv(pools.pricing, { from: "2026-07-01", to: "2026-07-01", limit: 5 });

    expect(topItems).toHaveLength(2);
    expect(topItems[0]).toMatchObject({ catalogItemId: "cat_2", gmvAmount: "40.00", tradeCount: 1, unitVolume: 2 });
    expect(topItems[1]).toMatchObject({ catalogItemId: "cat_1", gmvAmount: "10.00", tradeCount: 1, unitVolume: 1 });
  });

  it("getSellerCohortGmvSummary sums GMV for only the requested seller accounts (#4075 offer-economics monitor)", async () => {
    await seedJuly1Trades(pools.pricing);

    const cohort = await getSellerCohortGmvSummary(pools.pricing, {
      sellerAccountIds: ["seller_1"],
      from: "2026-07-01",
      to: "2026-07-01",
    });
    expect(cohort).toEqual({ gmvAmount: "50.00", tradeCount: 2, unitVolume: 3 });

    // seller_2's only trade was cancelled/excluded, so its cohort GMV is zero.
    const excludedSeller = await getSellerCohortGmvSummary(pools.pricing, {
      sellerAccountIds: ["seller_2"],
      from: "2026-07-01",
      to: "2026-07-01",
    });
    expect(excludedSeller).toEqual({ gmvAmount: "0.00", tradeCount: 0, unitVolume: 0 });

    // An empty cohort returns zeros without querying.
    const emptyCohort = await getSellerCohortGmvSummary(pools.pricing, {
      sellerAccountIds: [],
      from: "2026-07-01",
      to: "2026-07-01",
    });
    expect(emptyCohort).toEqual({ gmvAmount: "0.00", tradeCount: 0, unitVolume: 0 });
  });

  it("getSellerCohortWeeklyGmv buckets a seller cohort's trades by week", async () => {
    await seedJuly1Trades(pools.pricing);

    const weekly = await getSellerCohortWeeklyGmv(pools.pricing, {
      sellerAccountIds: ["seller_1"],
      from: "2026-06-25",
      to: "2026-07-05",
    });

    expect(weekly).toEqual([expect.objectContaining({ weekStart: "2026-06-29", gmvAmount: "50.00", tradeCount: 2 })]);

    const emptyCohort = await getSellerCohortWeeklyGmv(pools.pricing, {
      sellerAccountIds: [],
      from: "2026-06-25",
      to: "2026-07-05",
    });
    expect(emptyCohort).toEqual([]);
  });

  it("getPlatformLiquiditySummary reports sell-through and spread with an honest empty state when there is no data", async () => {
    const empty = await getPlatformLiquiditySummary(pools.pricing, { asOfDay: "2026-07-01" });
    expect(empty.sellThroughRate).toBeNull();
    expect(empty.medianSpreadAmount).toBeNull();
    expect(empty.spreadSampleCount).toBe(0);

    const marketInputs = marketInputHandlers(pools.pricing);
    await marketInputs["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "listing_1",
          accountId: "seller_1",
          catalogItemId: "cat_1",
          productId: "prod_1",
          priceAmount: "12.00",
          quantityCap: 5,
        },
        "2026-07-01T08:00:00.000Z",
      ),
    );
    await marketInputs["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "2026-07-01T08:05:00.000Z", "marketplace.listing-listing_1"),
    );
    await marketInputs["marketplace.offer.submitted"]!(
      event(
        "marketplace.offer.submitted",
        {
          offerId: "offer_1",
          buyerAccountId: "buyer_1",
          catalogItemId: "cat_1",
          productId: "prod_1",
          priceAmount: "9.00",
          quantityRequested: 1,
        },
        "2026-07-01T08:10:00.000Z",
      ),
    );

    const { recomputeMarketStateSnapshot } = await import("../read-model/rollup-maintenance");
    await recomputeMarketStateSnapshot(pools.pricing, {
      catalogItemId: "cat_1",
      productId: "prod_1",
      day: "2026-07-01",
    });

    const withSpread = await getPlatformLiquiditySummary(pools.pricing, { asOfDay: "2026-07-01" });
    expect(withSpread.medianSpreadAmount).toBe("3.00");
    expect(withSpread.spreadSampleCount).toBe(1);
  });
});
