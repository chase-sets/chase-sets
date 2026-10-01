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
import { module as catalogModule } from "../index";
import {
  cacheKeyForProviderOptionQuery,
  createPgCatalogProviderOptionQueryCacheStore,
  queryCatalogProviderIntegrationOptionsWithCache,
} from "../features/source-observations/api/providers/provider-option-query-cache";

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

  it("upgrades the option cache in place and round-trips completed count metadata without changing display", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    const request = {
      providerKey: "scrydex",
      profileKey: "synthetic-card-profile",
      profileVersion: "synthetic-v1",
      ingestionUnitKey: "synthetic-card-unit",
      queryKind: "cards",
      languageCode: "en",
      parentValue: "TFC",
    };
    const store = createPgCatalogProviderOptionQueryCacheStore(pool)!;
    const items = [
      {
        providerKey: "scrydex",
        queryKind: "cards",
        value: "synthetic-tfc-card",
        label: "Synthetic TFC card",
        description: null,
        parentValue: "TFC",
        imageUrl: null,
        aliases: [],
        metadata: {},
      },
    ];
    await queryCatalogProviderIntegrationOptionsWithCache({ request, cacheStore: store, loadLive: async () => items });
    await pool.query("ALTER TABLE catalog_provider_option_query_cache DROP COLUMN total_count, DROP COLUMN page_size");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20261001_catalog_provider_option_query_cache_card_count'",
    );
    await bootstrapContextDatabase(catalogModule, pool);
    expect(await store.read(request)).toMatchObject({
      cacheKey: cacheKeyForProviderOptionQuery(request),
      items,
      itemCount: 1,
      totalCount: null,
      pageSize: null,
    });
    await queryCatalogProviderIntegrationOptionsWithCache({
      request: { ...request, forceRefresh: true },
      cacheStore: store,
      loadLive: async () => items,
      validatedPagination: () => ({ totalCount: 1, pageSize: 100 }),
    });
    expect(await store.read(request)).toMatchObject({ items, itemCount: 1, totalCount: 1, pageSize: 100 });
    await queryCatalogProviderIntegrationOptionsWithCache({
      request: { ...request, forceRefresh: true },
      cacheStore: store,
      loadLive: async () => items,
    });
    expect(await store.read(request)).toMatchObject({ items, itemCount: 1, totalCount: null, pageSize: null });
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
