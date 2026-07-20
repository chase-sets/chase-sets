import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  MARKET_STAT_HYGIENE_COMPILED_REVISION_ID,
  MARKET_STAT_HYGIENE_LEGACY_UNTRIMMED_REVISION_ID,
} from "../features/market-rollups/read-model/stat-hygiene-policy-revision";
import { module as pricingModule } from "../index";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("pricing schema upgrades", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["pricing"], "pricing_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("binds deployed rollups to legacy semantics and is idempotent across two boots", async () => {
    const pool = pools.pricing;
    await bootstrapContextDatabase(pricingModule, pool);
    await pool.query("ALTER TABLE pricing_daily_product_rollups DROP COLUMN stat_hygiene_policy_revision_id");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260720_pricing_daily_rollup_policy_revision_binding'",
    );
    await pool.query(
      `INSERT INTO pricing_daily_product_rollups (
         catalog_catalog_item_id, product_id, day, median_price_amount,
         unit_volume, trade_count, verified_trade_count, updated_at
       ) VALUES ('cat_deployed', 'prod_deployed', '2026-07-01', 15.00, 8, 8, 0, now())`,
    );

    await bootstrapContextDatabase(pricingModule, pool);
    await bootstrapContextDatabase(pricingModule, pool);

    const deployed = await pool.query<{ stat_hygiene_policy_revision_id: string }>(
      `SELECT stat_hygiene_policy_revision_id
       FROM pricing_daily_product_rollups
       WHERE catalog_catalog_item_id = 'cat_deployed'`,
    );
    expect(deployed.rows).toEqual([
      { stat_hygiene_policy_revision_id: MARKET_STAT_HYGIENE_LEGACY_UNTRIMMED_REVISION_ID },
    ]);

    await pool.query(
      `INSERT INTO pricing_daily_product_rollups (
         catalog_catalog_item_id, product_id, day, median_price_amount,
         unit_volume, trade_count, verified_trade_count, updated_at
       ) VALUES ('cat_new', 'prod_new', '2026-07-02', 10.00, 8, 8, 0, now())`,
    );
    const fresh = await pool.query<{ stat_hygiene_policy_revision_id: string }>(
      `SELECT stat_hygiene_policy_revision_id
       FROM pricing_daily_product_rollups
       WHERE catalog_catalog_item_id = 'cat_new'`,
    );
    expect(fresh.rows).toEqual([{ stat_hygiene_policy_revision_id: MARKET_STAT_HYGIENE_COMPILED_REVISION_ID }]);

    const migration = await pool.query<{ applied_count: number }>(
      `SELECT COUNT(*)::integer AS applied_count
       FROM bounded_context_schema_migrations
       WHERE migration_id = '20260720_pricing_daily_rollup_policy_revision_binding'`,
    );
    expect(migration.rows).toEqual([{ applied_count: 1 }]);
  });
});
