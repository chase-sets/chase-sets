import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as discoveryModule } from "../../../index";
import { listDiscoveryRecentSavedLists } from "./queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("Discovery Saved List picker freshness read model", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["discovery"], "saved_list_freshness");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    const pools = createMultiContextTestPools(databaseUrls);
    pool = pools.discovery;
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(discoveryModule, pool);
  }, 120_000);

  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ discovery: pool });
  });

  it("reads the newly projected active List with its title, counts, and version while excluding archived rows", async () => {
    await pool.query(
      `INSERT INTO discovery_saved_list_picker
         (list_id, owner_account_id, title, lifecycle, line_count, tracked_unit_count, line_quantities, list_version, created_at, changed_at)
       VALUES
         ('svl_new', 'acc_picker', 'New Favorites', 'active', 1, 2, '{"line_1":2}', 2, '2026-10-16T00:00:00Z', '2026-10-16T00:01:00Z'),
         ('svl_archived', 'acc_picker', 'Old Favorites', 'archived', 4, 4, '{}', 4, '2026-10-15T00:00:00Z', '2026-10-15T00:01:00Z')`,
    );

    await expect(listDiscoveryRecentSavedLists(pool, { ownerAccountId: "acc_picker" })).resolves.toEqual([
      {
        listId: "svl_new",
        title: "New Favorites",
        lineCount: 1,
        trackedUnitCount: 2,
        version: 2,
        changedAt: "2026-10-16T00:01:00.000Z",
      },
    ]);
  });
});
