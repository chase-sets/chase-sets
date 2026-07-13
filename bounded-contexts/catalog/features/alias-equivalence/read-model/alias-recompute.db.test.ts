import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { processCatalogItemAliasRecomputeBatch } from "./alias-recompute";
import { catalogAliasEquivalenceSchemaSql } from "./schema";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

function commandHandler() {
  return vi.fn(async () => ({ state: null, version: 1, newEvents: [], storedEvents: [] }) as never);
}

describeDb("resolved alias recompute Postgres claims", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["catalog"], "catalog_alias_recompute");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools!);
    const pool = pools!.catalog;
    await pool.query(catalogAliasEquivalenceSchemaSql);
    await pool.query(
      `CREATE TABLE catalog_items (
         catalog_item_id text PRIMARY KEY,
         language_code text NOT NULL
       )`,
    );
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("claims disjoint batches under concurrent workers", async () => {
    await seedCatalogItems(["cat_a", "cat_b", "cat_c", "cat_d"]);
    await seedPendingWork(["cat_a", "cat_b", "cat_c", "cat_d"]);

    const published = commandHandler();
    const pool = pools!.catalog;
    const [first, second] = await Promise.all([
      processCatalogItemAliasRecomputeBatch(pool, published, {} as never, { limit: 2 }),
      processCatalogItemAliasRecomputeBatch(pool, published, {} as never, { limit: 2 }),
    ]);

    expect(first.selected).toBe(2);
    expect(second.selected).toBe(2);
    expect(first.processed + second.processed).toBe(4);

    const rows = await pool.query<{ catalog_item_id: string; status: string; attempts: number }>(
      `SELECT catalog_item_id, status, attempts
       FROM catalog_item_alias_recompute_work
       ORDER BY catalog_item_id ASC`,
    );

    expect(rows.rows.map((row) => row.catalog_item_id)).toEqual(["cat_a", "cat_b", "cat_c", "cat_d"]);
    expect(rows.rows.every((row) => row.status === "completed")).toBe(true);
    expect(rows.rows.map((row) => Number(row.attempts))).toEqual([1, 1, 1, 1]);
  });

  it("reclaims running work whose lease has expired", async () => {
    await seedCatalogItems(["cat_stuck"]);
    const pool = pools!.catalog;
    await pool.query(
      `INSERT INTO catalog_item_alias_recompute_work (
         catalog_item_id,
         reason,
         status,
         attempts,
         available_at,
         updated_at
       ) VALUES ($1, 'repair', 'running', 0, now(), now() - interval '10 minutes')`,
      ["cat_stuck"],
    );

    const result = await processCatalogItemAliasRecomputeBatch(pool, commandHandler(), {} as never, {
      runningLeaseMs: 1_000,
    });

    expect(result).toMatchObject({ selected: 1, processed: 1, failed: 0 });
    const row = await pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts
       FROM catalog_item_alias_recompute_work
       WHERE catalog_item_id = $1`,
      ["cat_stuck"],
    );
    expect(row.rows[0]).toMatchObject({ status: "completed", attempts: 1 });
  });

  async function seedCatalogItems(ids: readonly string[]): Promise<void> {
    await pools!.catalog.query(
      `INSERT INTO catalog_items (catalog_item_id, language_code)
       SELECT target_id, 'en'
       FROM unnest($1::text[]) AS target_id`,
      [ids],
    );
  }

  async function seedPendingWork(ids: readonly string[]): Promise<void> {
    await pools!.catalog.query(
      `INSERT INTO catalog_item_alias_recompute_work (
         catalog_item_id,
         reason,
         status,
         attempts,
         available_at,
         updated_at
       )
       SELECT target_id, 'repair', 'pending', 0, now(), now()
       FROM unnest($1::text[]) AS target_id`,
      [ids],
    );
  }
});
