import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { module as pricingModule } from "../../../index";
import { getAccountRecommendation, listAccountRecommendations } from "../read-model/queries";

type MigrationFixture = Readonly<{
  provenance: Readonly<{ commit: string; rawSha256: string; commands: readonly string[] }>;
  migrations: readonly Readonly<{
    migrationId: string;
    description: string;
    statements: readonly string[];
  }>[];
}>;

type FeedColumn = Readonly<{ column_name: string; ordinal_position: number; data_type: string }>;

const retainedSchemaFixture = readFileSync(
  new URL("./fixtures/pricing-boot-schema-3edef8e9.sql", import.meta.url),
  "utf8",
);
const failedRecommendationSchemaFixture = readFileSync(
  new URL("./fixtures/pricing-recommendation-boot-schema-6feb1454.sql", import.meta.url),
  "utf8",
);
const retainedLedgerFixture = JSON.parse(
  readFileSync(new URL("./fixtures/pricing-boot-schema-ledger-3edef8e9.json", import.meta.url), "utf8"),
) as MigrationFixture;

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for the Pricing recommendation-feed schema upgrade tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

function rawSqlFixture(fixture: string): string {
  const headerEnd = fixture.indexOf("\n\n");
  if (headerEnd === -1) {
    throw new Error("Pinned SQL fixture is missing its provenance header separator.");
  }
  return fixture.slice(headerEnd + 2);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("Pricing recommendation-feed upgrade fixture provenance", () => {
  it("keeps the retained schema, failed boot SQL, and ledger pinned to their derivation hashes", () => {
    expect(sha256(rawSqlFixture(retainedSchemaFixture))).toBe(
      "ea46df37b030b6639c103642332683852ede8b08d295f5e57c68a2829e981b93",
    );
    expect(sha256(rawSqlFixture(failedRecommendationSchemaFixture))).toBe(
      "c85eb210d5a6970893ffe172407d1cd7133952d1af14a2fc5754fc6b784fe646",
    );
    expect(sha256(`${JSON.stringify(retainedLedgerFixture.migrations, null, 2)}\n`)).toBe(
      retainedLedgerFixture.provenance.rawSha256,
    );
    expect(retainedLedgerFixture.provenance.commit).toBe("3edef8e981847f1aa16c97e13efcdeda7063608e");
  });
});

describeDb("Pricing recommendation-feed retained-schema upgrades", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      ["pricing"],
      "pricing_recommendation_feed_upgrade",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  async function installRetainedState(pool: PgTransactionalPool): Promise<void> {
    await pool.query(retainedSchemaFixture);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS bounded_context_schema_migrations (
         migration_id text PRIMARY KEY,
         description text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    for (const migration of retainedLedgerFixture.migrations) {
      await pool.query(
        `INSERT INTO bounded_context_schema_migrations (migration_id, description)
         VALUES ($1, $2)`,
        [migration.migrationId, migration.description],
      );
    }
    await pool.query(
      `INSERT INTO pricing_catalog_item_inputs (
         catalog_item_id, title, status, updated_at
       ) VALUES (
         'synthetic-7751-catalog-legacy', 'Synthetic retained item', 'active', '2026-09-01T00:00:00Z'
       );

       INSERT INTO pricing_inventory_item_inputs (
         item_id, seller_account_id, catalog_catalog_item_id, product_id,
         total_quantity, acquisition_cost_amount, updated_at, last_stream_version
       ) VALUES (
         'synthetic-7751-inventory-legacy', 'synthetic-7751-seller-legacy',
         'synthetic-7751-catalog-legacy', 'synthetic-7751-product-legacy',
         3, 11.25, '2026-09-01T00:00:00Z', 7
       );

       INSERT INTO pricing_market_listing_inputs (
         listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id,
         price_amount, quantity_cap, status, updated_at, last_stream_version
       ) VALUES (
         'synthetic-7751-listing-legacy', 'synthetic-7751-seller-legacy',
         'synthetic-7751-inventory-legacy', 'synthetic-7751-catalog-legacy',
         'synthetic-7751-product-legacy', 19.50, 1, 'active', '2026-09-01T00:00:00Z', 7
       );

       INSERT INTO pricing_buyer_offer_inputs (
         offer_id, buyer_account_id, seller_account_id, catalog_catalog_item_id, product_id,
         price_amount, quantity_requested, status, updated_at, last_stream_version
       ) VALUES (
         'synthetic-7751-offer-legacy', 'synthetic-7751-buyer-legacy', NULL,
         'synthetic-7751-catalog-legacy', 'synthetic-7751-product-legacy',
         17.25, 1, 'submitted', '2026-09-01T00:00:00Z', 8
       );

       INSERT INTO pricing_recommendation_pages (
         recommendation_id, catalog_catalog_item_id, seller_account_id, listing_id, inventory_item_id,
         market_price_amount, market_currency, market_observed_at, current_price_amount,
         recommended_list_amount, recommendation_reason, updated_at
       ) VALUES (
         'synthetic-7751-recommendation-legacy', 'synthetic-7751-catalog-legacy',
         'synthetic-7751-seller-legacy', 'synthetic-7751-listing-legacy',
         'synthetic-7751-inventory-legacy', 18.00, 'EUR', '2026-09-01T00:00:00Z',
         19.50, 18.50, 'synthetic retained recommendation', '2026-09-01T00:00:00Z'
       )`,
    );
  }

  async function addSourceCurrenciesOnly(pool: PgTransactionalPool): Promise<void> {
    await pool.query(
      `ALTER TABLE pricing_market_listing_inputs
         ADD COLUMN IF NOT EXISTS price_currency_code text NULL;
       ALTER TABLE pricing_buyer_offer_inputs
         ADD COLUMN IF NOT EXISTS price_currency_code text NULL`,
    );
  }

  async function bootTwice(pool: PgTransactionalPool): Promise<void> {
    await bootstrapContextDatabase(pricingModule, pool);
    await bootstrapContextDatabase(pricingModule, pool);
  }

  async function readFeedColumns(pool: PgTransactionalPool): Promise<readonly FeedColumn[]> {
    const result = await pool.query<FeedColumn>(
      `SELECT column_name, ordinal_position::integer, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'pricing_recommendation_feed'
       ORDER BY ordinal_position`,
    );
    return result.rows;
  }

  async function capturePostgresError(
    action: () => Promise<unknown>,
  ): Promise<Readonly<{ code?: string; message: string }>> {
    try {
      await action();
    } catch (error) {
      if (error instanceof Error) {
        return error as Error & { code?: string };
      }
      throw error;
    }
    throw new Error("Expected PostgreSQL to reject the candidate boot SQL.");
  }

  it("upgrades the deployed 3edef pricing schema to the currency-aware recommendation feed", async () => {
    const pool = pools.pricing;
    await installRetainedState(pool);

    await bootTwice(pool);

    expect((await readFeedColumns(pool)).at(-1)).toEqual({
      column_name: "current_price_currency_code",
      ordinal_position: 33,
      data_type: "text",
    });
  });

  it("fails with 42703 on the deployed schema before the repair", async () => {
    const pool = pools.pricing;
    await installRetainedState(pool);

    const error = await capturePostgresError(() => pool.query(failedRecommendationSchemaFixture));

    expect(error.code).toBe("42703");
    expect(error.message).toContain("price_currency_code");
  });

  it("rejects a columns-only repair that renames an existing feed output", async () => {
    const pool = pools.pricing;
    await installRetainedState(pool);
    await addSourceCurrenciesOnly(pool);

    const error = await capturePostgresError(() => pool.query(failedRecommendationSchemaFixture));

    expect(error.code).toBe("42P16");
    expect(error.message).toContain("recommended_list_amount");
  });

  it("converges retained, fresh and partially expanded boots to one feed shape", async () => {
    const pool = pools.pricing;
    const shapes: FeedColumn[][] = [];
    const setups = [
      installRetainedState,
      async () => undefined,
      async (statePool: PgTransactionalPool) => {
        await installRetainedState(statePool);
        await addSourceCurrenciesOnly(statePool);
      },
    ];

    for (const setup of setups) {
      await resetMultiContextTestSchemas(pools);
      await setup(pool);
      await bootstrapContextDatabase(pricingModule, pool);
      const firstBoot = [...(await readFeedColumns(pool))];
      await bootstrapContextDatabase(pricingModule, pool);
      expect(await readFeedColumns(pool)).toEqual(firstBoot);
      shapes.push(firstBoot);
    }

    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  it("preserves the prior 32 recommendation-feed outputs and appends currency at ordinal 33", async () => {
    const pool = pools.pricing;
    await installRetainedState(pool);
    const retainedColumns = await readFeedColumns(pool);

    await bootTwice(pool);
    const upgradedColumns = await readFeedColumns(pool);

    expect(retainedColumns).toHaveLength(32);
    expect(upgradedColumns.slice(0, 32)).toEqual(retainedColumns);
    expect(upgradedColumns[32]).toEqual({
      column_name: "current_price_currency_code",
      ordinal_position: 33,
      data_type: "text",
    });
  });

  it("keeps the migration ledger complete and inert across retained and fresh reboots", async () => {
    const pool = pools.pricing;
    for (const setup of [installRetainedState, async () => undefined]) {
      await resetMultiContextTestSchemas(pools);
      await setup(pool);
      await bootstrapContextDatabase(pricingModule, pool);
      const firstBoot = await pool.query<{ migration_id: string }>(
        "SELECT migration_id FROM bounded_context_schema_migrations ORDER BY migration_id",
      );
      await bootstrapContextDatabase(pricingModule, pool);
      const secondBoot = await pool.query<{ migration_id: string }>(
        "SELECT migration_id FROM bounded_context_schema_migrations ORDER BY migration_id",
      );

      expect(secondBoot.rows).toEqual(firstBoot.rows);
      expect(firstBoot.rows.map((row) => row.migration_id)).toEqual(
        expect.arrayContaining([
          "20260907_pricing_recommendation_source_money_currencies",
          "20260907_pricing_market_listing_input_price_currency",
        ]),
      );
    }
  });

  it("leaves synthetic legacy rows and amount-only currencies untouched", async () => {
    const pool = pools.pricing;
    await installRetainedState(pool);
    const before = await readLegacyRows(pool);

    await bootTwice(pool);
    const after = await readLegacyRows(pool);
    const currencies = await pool.query<{ row_id: string; price_currency_code: string | null }>(
      `SELECT listing_id AS row_id, price_currency_code FROM pricing_market_listing_inputs
       UNION ALL
       SELECT offer_id AS row_id, price_currency_code FROM pricing_buyer_offer_inputs
       ORDER BY row_id`,
    );

    expect(after).toEqual(before);
    expect(currencies.rows).toEqual([
      { row_id: "synthetic-7751-listing-legacy", price_currency_code: null },
      { row_id: "synthetic-7751-offer-legacy", price_currency_code: null },
    ]);
  });

  it("serves equal-currency EUR and legacy-null recommendations from the upgraded feed", async () => {
    const pool = pools.pricing;
    await installRetainedState(pool);
    await bootTwice(pool);
    await seedCurrencyAwareRows(pool);

    const eurList = await listAccountRecommendations(pool, { accountId: "synthetic-7751-seller-eur" });
    const eurItem = await getAccountRecommendation(
      pool,
      "synthetic-7751-recommendation-eur",
      "synthetic-7751-seller-eur",
    );
    const legacyList = await listAccountRecommendations(pool, { accountId: "synthetic-7751-seller-legacy" });
    const legacyItem = await getAccountRecommendation(
      pool,
      "synthetic-7751-recommendation-legacy",
      "synthetic-7751-seller-legacy",
    );

    expect(eurList.total).toBe(1);
    expect(eurList.items[0]).toMatchObject({
      current_price_currency_code: "EUR",
      lowest_listing_price_amount: expect.anything(),
      highest_offer_price_amount: expect.anything(),
    });
    expect(Number(eurList.items[0]?.lowest_listing_price_amount)).toBe(18);
    expect(Number(eurList.items[0]?.highest_offer_price_amount)).toBe(17);
    expect(eurItem).toEqual(eurList.items[0]);
    expect(legacyList.items[0]).toMatchObject({
      current_price_currency_code: null,
      lowest_listing_price_amount: null,
      highest_offer_price_amount: null,
    });
    expect(legacyItem).toEqual(legacyList.items[0]);
  });

  it("keeps currency-mismatched and unversioned market signals ineligible", async () => {
    const pool = pools.pricing;
    await installRetainedState(pool);
    await bootTwice(pool);
    await seedRefusedMarketSignals(pool);

    const result = await pool.query<{
      lowest_listing_price_amount: string | null;
      highest_offer_price_amount: string | null;
    }>(
      `SELECT lowest_listing_price_amount, highest_offer_price_amount
       FROM pricing_recommendation_feed
       WHERE recommendation_id = 'synthetic-7751-recommendation-refused'`,
    );

    expect(result.rows).toEqual([{ lowest_listing_price_amount: null, highest_offer_price_amount: null }]);
  });
});

async function readLegacyRows(pool: PgTransactionalPool) {
  const result = await pool.query<{
    row_kind: string;
    row_id: string;
    amount: string;
    secondary_amount: string | null;
  }>(
    `SELECT 'inventory' AS row_kind, item_id AS row_id,
            acquisition_cost_amount::text AS amount, NULL::text AS secondary_amount
     FROM pricing_inventory_item_inputs
     WHERE item_id = 'synthetic-7751-inventory-legacy'
     UNION ALL
     SELECT 'listing', listing_id, price_amount::text, NULL::text
     FROM pricing_market_listing_inputs
     WHERE listing_id = 'synthetic-7751-listing-legacy'
     UNION ALL
     SELECT 'offer', offer_id, price_amount::text, NULL::text
     FROM pricing_buyer_offer_inputs
     WHERE offer_id = 'synthetic-7751-offer-legacy'
     UNION ALL
     SELECT 'recommendation', recommendation_id, current_price_amount::text, recommended_list_amount::text
     FROM pricing_recommendation_pages
     WHERE recommendation_id = 'synthetic-7751-recommendation-legacy'
     ORDER BY row_kind, row_id`,
  );
  return result.rows;
}

async function seedCurrencyAwareRows(pool: PgTransactionalPool): Promise<void> {
  await pool.query(
    `INSERT INTO pricing_catalog_item_inputs (catalog_item_id, title, status, updated_at)
     VALUES ('synthetic-7751-catalog-eur', 'Synthetic EUR item', 'active', '2026-09-02T00:00:00Z');

     INSERT INTO pricing_market_listing_inputs (
       listing_id, seller_account_id, catalog_catalog_item_id, product_id, price_amount,
       price_currency_code, quantity_cap, status, updated_at, last_stream_version
     ) VALUES
       ('synthetic-7751-listing-eur', 'synthetic-7751-seller-eur', 'synthetic-7751-catalog-eur',
        'synthetic-7751-product-eur', 20.00, 'EUR', 1, 'active', '2026-09-02T00:00:00Z', 2),
       ('synthetic-7751-listing-eur-competitor', 'synthetic-7751-seller-competitor',
        'synthetic-7751-catalog-eur', 'synthetic-7751-product-eur', 18.00, 'EUR', 1, 'active',
        '2026-09-02T00:00:00Z', 2);

     INSERT INTO pricing_buyer_offer_inputs (
       offer_id, buyer_account_id, catalog_catalog_item_id, product_id, price_amount,
       price_currency_code, quantity_requested, status, updated_at, last_stream_version
     ) VALUES (
       'synthetic-7751-offer-eur', 'synthetic-7751-buyer-eur', 'synthetic-7751-catalog-eur',
       'synthetic-7751-product-eur', 17.00, 'EUR', 1, 'submitted', '2026-09-02T00:00:00Z', 2
     );

     INSERT INTO pricing_recommendation_pages (
       recommendation_id, catalog_catalog_item_id, seller_account_id, listing_id,
       market_price_amount, market_currency, market_observed_at, current_price_amount,
       recommended_list_amount, updated_at
     ) VALUES (
       'synthetic-7751-recommendation-eur', 'synthetic-7751-catalog-eur',
       'synthetic-7751-seller-eur', 'synthetic-7751-listing-eur', 18.50, 'EUR',
       '2026-09-02T00:00:00Z', 20.00, 19.00, '2026-09-02T00:00:00Z'
     )`,
  );
}

async function seedRefusedMarketSignals(pool: PgTransactionalPool): Promise<void> {
  await pool.query(
    `INSERT INTO pricing_catalog_item_inputs (catalog_item_id, title, status, updated_at)
     VALUES ('synthetic-7751-catalog-refused', 'Synthetic refused item', 'active', '2026-09-03T00:00:00Z');

     INSERT INTO pricing_market_listing_inputs (
       listing_id, seller_account_id, catalog_catalog_item_id, product_id, price_amount,
       price_currency_code, quantity_cap, status, updated_at, last_stream_version
     ) VALUES
       ('synthetic-7751-listing-mismatch', 'synthetic-7751-seller-refused',
        'synthetic-7751-catalog-refused', 'synthetic-7751-product-refused', 21.00, 'USD', 1, 'active',
        '2026-09-03T00:00:00Z', 2),
       ('synthetic-7751-listing-unversioned', 'synthetic-7751-seller-other',
        'synthetic-7751-catalog-refused', 'synthetic-7751-product-refused', 16.00, 'EUR', 1, 'active',
        '2026-09-03T00:00:00Z', 0);

     INSERT INTO pricing_buyer_offer_inputs (
       offer_id, buyer_account_id, catalog_catalog_item_id, product_id, price_amount,
       price_currency_code, quantity_requested, status, updated_at, last_stream_version
     ) VALUES
       ('synthetic-7751-offer-mismatch', 'synthetic-7751-buyer-mismatch',
        'synthetic-7751-catalog-refused', 'synthetic-7751-product-refused', 15.00, 'USD', 1, 'submitted',
        '2026-09-03T00:00:00Z', 2),
       ('synthetic-7751-offer-unversioned', 'synthetic-7751-buyer-unversioned',
        'synthetic-7751-catalog-refused', 'synthetic-7751-product-refused', 19.00, 'EUR', 1, 'submitted',
        '2026-09-03T00:00:00Z', 0);

     INSERT INTO pricing_recommendation_pages (
       recommendation_id, catalog_catalog_item_id, seller_account_id, listing_id,
       market_price_amount, market_currency, market_observed_at, current_price_amount,
       recommended_list_amount, updated_at
     ) VALUES (
       'synthetic-7751-recommendation-refused', 'synthetic-7751-catalog-refused',
       'synthetic-7751-seller-refused', 'synthetic-7751-listing-mismatch', 18.00, 'EUR',
       '2026-09-03T00:00:00Z', 21.00, 20.00, '2026-09-03T00:00:00Z'
     )`,
  );
}
