import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BcRetentionSweep } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { executeRetentionSweepBatch } from "./retention-sweep";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const sweep: BcRetentionSweep = {
  name: "expired-test-rows",
  tableName: "retention_test_rows",
  predicateSql: "candidate.expires_at < now() - interval '7 days'",
  orderBySql: "candidate.expires_at ASC",
  intervalMs: 60_000,
  batchLimit: 2,
};

describe("retention sweep Postgres integration", () => {
  let pools: Readonly<Record<"retention", PgTransactionalPool>>;

  beforeAll(async () => {
    if (!adminDatabaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for platform-runtime retention sweep DB tests.");
    }
    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl, ["retention"], "platform_retention");
    await ensureMultiContextTestDatabases(adminDatabaseUrl, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.retention.query(`CREATE TABLE retention_test_rows (
      row_id text PRIMARY KEY,
      expires_at timestamptz NOT NULL
    )`);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("deletes old rows in bounded batches while a recent row survives", async () => {
    await pools.retention.query(
      `INSERT INTO retention_test_rows (row_id, expires_at)
       VALUES
         ('old-1', now() - interval '10 days'),
         ('old-2', now() - interval '9 days'),
         ('old-3', now() - interval '8 days'),
         ('recent', now() - interval '1 day')`,
    );

    await expect(executeRetentionSweepBatch(pools.retention, sweep)).resolves.toBe(2);
    await expect(executeRetentionSweepBatch(pools.retention, sweep)).resolves.toBe(1);

    const rows = await pools.retention.query<{ row_id: string }>(
      "SELECT row_id FROM retention_test_rows ORDER BY row_id",
    );
    expect(rows.rows).toEqual([{ row_id: "recent" }]);
  });
});
