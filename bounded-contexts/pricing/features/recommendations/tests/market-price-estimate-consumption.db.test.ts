import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { createPricingRecommendationRuntime } from "../api/runtime";

// This is deliberately a real Postgres test: freshness belongs in the read
// query, so a mock cannot prove expired estimates are excluded before the
// recommendation fallback runs.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["pricing"] as const;

describeDb("pricing recommendations consume Market Price estimates (#5582)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "pricing_recommendations");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
    await pools.pricing.query(
      `INSERT INTO pricing_market_listing_inputs (
         listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id,
         price_amount, quantity_cap, status, updated_at, last_stream_version
       ) VALUES
         ('lst_seller', 'acc_seller', 'inv_seller', 'cat_1', 'prod_1', 20.00, 1, 'active', CURRENT_TIMESTAMP, 1),
         ('lst_competitor', 'acc_competitor', 'inv_competitor', 'cat_1', 'prod_1', 18.00, 1, 'active', CURRENT_TIMESTAMP, 1)`,
    );
    await pools.pricing.query(
      `INSERT INTO pricing_market_price_estimates (
         catalog_catalog_item_id, product_id, estimate_version, window_started_at, window_ended_at,
         amount, currency_code, band_low_amount, band_high_amount, confidence,
         platform_verified_trade_count, platform_trade_count, external_comp_count,
         previous_amount, estimated_at, fresh_until, disclosure, updated_at
       ) VALUES (
         'cat_1', 'prod_1', 1, CURRENT_TIMESTAMP - interval '1 day', CURRENT_TIMESTAMP,
         19.50, 'USD', 18.00, 21.00, 'medium',
         2, 3, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '1 hour', 'account', CURRENT_TIMESTAMP
       )`,
    );
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("uses a fresh estimate, then degrades to the lowest competing ask after it expires", async () => {
    const eventStore = createPostgresEventStore({ pool: pools.pricing });
    const recommendations = createPricingRecommendationRuntime({
      eventStore,
      checkpointStore: {} as never,
      db: pools.pricing,
    });
    const context = {
      tenantId: "ten_1" as never,
      audit: { performedByUserId: "usr_1" as never, forAccountId: "acc_seller" as never },
    };

    await recommendations.refreshRecommendations({ accountId: "acc_seller" }, context);
    let events = await eventStore.readStream({
      streamId: "pricing.recommendation-rec_acc_seller_active_listing_price_update_lst_seller",
    });
    expect(events.at(-1)?.payload).toMatchObject({
      marketPriceAmount: 19.5,
      marketSignalType: "market-estimate",
      recommendedListAmount: 19.49,
    });

    await pools.pricing.query(
      "UPDATE pricing_market_price_estimates SET fresh_until = CURRENT_TIMESTAMP - interval '1 minute' WHERE catalog_catalog_item_id = 'cat_1' AND product_id = 'prod_1'",
    );
    await recommendations.refreshRecommendations({ accountId: "acc_seller" }, context);
    events = await eventStore.readStream({
      streamId: "pricing.recommendation-rec_acc_seller_active_listing_price_update_lst_seller",
    });
    expect(events.at(-1)?.payload).toMatchObject({
      marketPriceAmount: 18,
      marketSignalType: "competition",
      recommendedListAmount: 17.99,
    });
  });
});
