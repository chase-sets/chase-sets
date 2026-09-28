import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { ZERO_GLOBAL_POSITION, type EventStoreContext } from "@chase-sets/event-core/storage";
import { createCatalogListingAuthority } from "../features/product-measures/api/listing-authority";
import { module as catalogModule } from "../index";

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

describeDb("catalog schema upgrades", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["catalog"], "catalog_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("upgrades legacy Product Measure Profiles without pretending their SQL rows have source authority", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    await pool.query("ALTER TABLE catalog_product_measure_profiles DROP COLUMN source_revision");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id='20260927_catalog_product_measure_profile_source_revision'",
    );
    await pool.query(`INSERT INTO catalog_product_measure_profiles (profile_id,key,name,measure_snapshot)
      VALUES ('profile-synthetic','synthetic','Synthetic','{}'::jsonb)`);
    await bootstrapContextDatabase(catalogModule, pool);
    await bootstrapContextDatabase(catalogModule, pool);
    expect(
      (
        await pool.query(
          "SELECT source_revision::text FROM catalog_product_measure_profiles WHERE profile_id='profile-synthetic'",
        )
      ).rows,
    ).toEqual([{ source_revision: "0" }]);
    expect(
      (
        await pool.query(
          "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id='20260927_catalog_product_measure_profile_source_revision'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("reads current Product source revisions in SQL and rejects a mutation between resolution and the final read", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    const eventStore = createPostgresEventStore({ pool });
    const context: EventStoreContext = {
      tenantId: "tnt_synthetic",
      audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
    };
    await eventStore.appendToStream({
      streamId: "catalog.blueprint-bp_synthetic",
      expectedVersion: 0,
      context,
      events: [
        {
          eventType: "catalog.blueprint.created",
          payload: {
            blueprintId: "bp_synthetic",
            key: "synthetic",
            name: { en: "Synthetic" },
            description: { en: "" },
          },
        },
        { eventType: "catalog.blueprint.published", payload: {} },
      ],
    });
    await eventStore.appendToStream({
      streamId: "catalog.item-cat_synthetic",
      expectedVersion: 0,
      context,
      events: [
        {
          eventType: "catalog.catalog-item.created",
          payload: {
            itemId: "cat_synthetic",
            languageCode: "en",
            title: { en: "Synthetic" },
            subtitle: null,
            description: { en: "" },
          },
        },
        { eventType: "catalog.catalog-item.blueprint-assigned", payload: { blueprintId: "bp_synthetic" } },
        { eventType: "catalog.catalog-item.published", payload: { blueprintId: "bp_synthetic" } },
      ],
    });
    let invalidate = false;
    const authority = createCatalogListingAuthority(
      {
        eventStore,
        checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
        db: {
          query: async <Row>(text: string, values?: readonly unknown[]) => {
            if (invalidate && text.includes("WITH expected AS")) {
              invalidate = false;
              await eventStore.appendToStream({
                streamId: "catalog.item-cat_synthetic",
                expectedVersion: 3,
                context,
                events: [{ eventType: "catalog.catalog-item.archived", payload: {} }],
              });
            }
            return pool.query<Row>(text, values);
          },
        },
      },
      () => {
        throw new Error("Read-only test must not request a consumer reservation.");
      },
    );
    const subjects = [{ catalogItemId: "cat_synthetic", productId: "cat_synthetic::", selectedOptions: [] }];
    const result = await authority.readCurrentProducts(subjects, { maxAgeMs: 60_000 });
    expect(result.value).toEqual([
      expect.objectContaining({ ...subjects[0], blueprintId: "bp_synthetic", productMeasureSnapshot: null }),
    ]);
    invalidate = true;
    await expect(authority.readCurrentProducts(subjects, { maxAgeMs: 60_000 })).rejects.toThrow(
      "stale or unreconciled",
    );
  });

  it("converges a deployed scope-sync table to the complete fresh schema", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    const freshColumns = await readColumnNames(pool, "catalog_scope_sync_state");

    await pool.query("ALTER TABLE catalog_scope_sync_state DROP COLUMN scope_record_id");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260718_catalog_scope_sync_state_scope_record_id'",
    );
    await bootstrapContextDatabase(catalogModule, pool);

    expect(await readColumnNames(pool, "catalog_scope_sync_state")).toEqual(freshColumns);
    const migration = await pool.query<{ migration_id: string }>(
      "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20260718_catalog_scope_sync_state_scope_record_id'",
    );
    expect(migration.rows).toEqual([{ migration_id: "20260718_catalog_scope_sync_state_scope_record_id" }]);
  });
});
