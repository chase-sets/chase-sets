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
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildMarketplaceListingProjectionHandlers } from "../features/listings/read-model/projection";
import { marketplaceListingSchemaMigrations } from "../features/listings/read-model/schema";
import { module as marketplaceModule } from "../index";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

async function readColumnNames(pool: PgTransactionalPool, tableName: string): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY column_name`,
    [tableName],
  );
  return result.rows.map((row) => row.column_name);
}

describeDb("marketplace schema upgrades", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["marketplace"], "marketplace_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("records the review-hold stream-version migration once across fresh boots", async () => {
    const pool = pools.marketplace;

    await bootstrapContextDatabase(marketplaceModule, pool);
    await bootstrapContextDatabase(marketplaceModule, pool);

    expect(await readColumnNames(pool, "marketplace_review_hold_pages")).toContain("last_stream_version");
    const migration = await pool.query<{ applied_count: string }>(
      `SELECT COUNT(*) AS applied_count
       FROM bounded_context_schema_migrations
       WHERE migration_id = '20260720_marketplace_review_hold_stream_version'`,
    );
    expect(migration.rows).toEqual([{ applied_count: "1" }]);
  });

  it("adds nullable price currency without backfill and fences repaired pairs by listing stream version", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    await pool.query(
      `INSERT INTO marketplace_listing_pages (
         listing_id, account_id, inventory_item_id, catalog_catalog_item_id, product_id,
         ship_from_address, price_amount, marketplace_sales_fee_unit_amount, seller_net_unit_amount,
         fee_quote_fingerprint, quantity_cap
       ) VALUES ('lst_legacy_currency', 'acc_seller', 'inv_legacy', 'cat_legacy', 'cat_legacy::',
         '{}'::jsonb, 20.00, 1.00, 19.00, 'fee_legacy', 1)`,
    );
    await pool.query(`DELETE FROM bounded_context_schema_migrations
      WHERE migration_id = '20260907_marketplace_listing_price_currency'`);
    await pool.query(
      `ALTER TABLE marketplace_listing_pages DROP COLUMN price_currency_code, DROP COLUMN listing_stream_version`,
    );
    await pool.query(`ALTER TABLE marketplace_anonymous_listing_draft_intents DROP COLUMN price_currency_code`);

    await bootstrapContextDatabase(marketplaceModule, pool);

    const legacy = await pool.query<{
      price_amount: string;
      price_currency_code: string | null;
      listing_stream_version: number | null;
    }>(
      `SELECT price_amount::text, price_currency_code, listing_stream_version
       FROM marketplace_listing_pages
       WHERE listing_id = 'lst_legacy_currency'`,
    );
    expect(legacy.rows).toEqual([{ price_amount: "20.00", price_currency_code: null, listing_stream_version: null }]);

    const migration = marketplaceListingSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20260907_marketplace_listing_price_currency",
    );
    expect(migration).toBeDefined();
    expect(migration!.statements.join("\n")).not.toMatch(/\bUPDATE\b/i);

    const handlers = buildMarketplaceListingProjectionHandlers(pool);
    const pair = {
      priceAmount: "20.00",
      priceCurrencyCode: "EUR",
      marketplaceSalesFeeUnitAmount: "1.00",
      sellerNetUnitAmount: "19.00",
      shippingAllowancePercentageBps: 500,
      termsScheduleId: "cts_default",
      termsAgreementId: null,
      termsResolvedAt: "2026-09-07T05:00:00.000Z",
      feeQuoteFingerprint: "fee_eur",
      feeLocks: [],
    };
    await handlers["marketplace.listing.price-updated"]!(
      buildTransportEvent("marketplace.listing.price-updated", pair, {
        streamId: "marketplace.listing-lst_legacy_currency",
        streamVersion: 2,
      }),
    );
    await handlers["marketplace.listing.price-updated"]!(
      buildTransportEvent(
        "marketplace.listing.price-updated",
        { ...pair, priceAmount: "10.00", priceCurrencyCode: null },
        { streamId: "marketplace.listing-lst_legacy_currency", streamVersion: 1 },
      ),
    );

    const repaired = await pool.query<{
      price_amount: string;
      price_currency_code: string | null;
      listing_stream_version: number | null;
    }>(
      `SELECT price_amount::text, price_currency_code, listing_stream_version
       FROM marketplace_listing_pages
       WHERE listing_id = 'lst_legacy_currency'`,
    );
    expect(repaired.rows).toEqual([{ price_amount: "20.00", price_currency_code: "EUR", listing_stream_version: 2 }]);
  });

  it("converges deployed seller-metrics tables to the complete fresh schema", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    const freshSourceColumns = await readColumnNames(pool, "marketplace_seller_metrics_support_request_sources");
    const freshSummaryColumns = await readColumnNames(pool, "marketplace_seller_metrics_summary_pages");

    await pool.query("ALTER TABLE marketplace_seller_metrics_support_request_sources DROP COLUMN responsibility");
    await pool.query("ALTER TABLE marketplace_seller_metrics_summary_pages DROP COLUMN missing_responsibility_count");
    await pool.query(`DELETE FROM bounded_context_schema_migrations
      WHERE migration_id IN (
        '20260718_marketplace_seller_metrics_support_responsibility',
        '20260718_marketplace_seller_metrics_missing_responsibility_count'
      )`);
    await bootstrapContextDatabase(marketplaceModule, pool);

    expect(await readColumnNames(pool, "marketplace_seller_metrics_support_request_sources")).toEqual(
      freshSourceColumns,
    );
    expect(await readColumnNames(pool, "marketplace_seller_metrics_summary_pages")).toEqual(freshSummaryColumns);
    const migrations = await pool.query<{ migration_id: string }>(`SELECT migration_id
      FROM bounded_context_schema_migrations
      WHERE migration_id IN (
        '20260718_marketplace_seller_metrics_support_responsibility',
        '20260718_marketplace_seller_metrics_missing_responsibility_count'
      )
      ORDER BY migration_id`);
    expect(migrations.rows).toEqual([
      { migration_id: "20260718_marketplace_seller_metrics_missing_responsibility_count" },
      { migration_id: "20260718_marketplace_seller_metrics_support_responsibility" },
    ]);
  });
});
