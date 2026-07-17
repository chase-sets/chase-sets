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
import {
  DEFAULT_EXPIRED_WORKER_HEARTBEAT_DIAGNOSTIC_LIMIT,
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
} from "./control-plane";
import { executeRetentionSweepBatch, platformControlRetentionSweeps } from "./retention-sweep";

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

  it("returns every current worker and only the capped newest expired diagnostics from 20,000 rows", async () => {
    await bootstrapPlatformControlPlane(pools.retention);
    await pools.retention.query(
      `INSERT INTO platform_worker_heartbeats (
         worker_id, worker_kind, metadata, started_at, heartbeat_at
       )
       SELECT
         'expired-' || lpad(value::text, 5, '0'),
         'platform-worker',
         jsonb_build_object('fixture', value),
         now() - interval '1 day',
         now() - interval '11 minutes' - (value * interval '1 second')
       FROM generate_series(1, 20000) AS fixture(value)
       UNION ALL
       SELECT 'current-worker', 'platform-worker', '{}'::jsonb, now(), now()`,
    );
    const controlPlane = createPostgresPlatformControlPlane(pools.retention);

    const workers = await controlPlane.listWorkerHeartbeats();
    const history = await controlPlane.summarizeWorkerHeartbeatHistory();

    expect(workers).toHaveLength(DEFAULT_EXPIRED_WORKER_HEARTBEAT_DIAGNOSTIC_LIMIT + 1);
    expect(workers[0]).toMatchObject({ worker_id: "current-worker" });
    expect(workers.slice(1).map((worker) => worker.worker_id)).toEqual(
      [...workers.slice(1)]
        .sort((left, right) => Date.parse(String(right.heartbeat_at)) - Date.parse(String(left.heartbeat_at)))
        .map((worker) => worker.worker_id),
    );
    expect(history).toEqual({
      activeOrStaleCount: 1,
      expiredTotalCount: 20_000,
      expiredWithinDiagnosticWindowCount: 20_000,
      expiredReturnedCount: DEFAULT_EXPIRED_WORKER_HEARTBEAT_DIAGNOSTIC_LIMIT,
      expiredTruncated: true,
      expiredDiagnosticLimit: DEFAULT_EXPIRED_WORKER_HEARTBEAT_DIAGNOSTIC_LIMIT,
      diagnosticWindowMs: 7 * 24 * 60 * 60_000,
    });
  });

  it("deletes expired worker heartbeats in one indexed bounded batch while preserving diagnostic and active rows", async () => {
    await bootstrapPlatformControlPlane(pools.retention);
    await pools.retention.query(
      `INSERT INTO platform_worker_heartbeats (
         worker_id, worker_kind, metadata, started_at, heartbeat_at
       )
       SELECT
         'old-' || lpad(value::text, 3, '0'),
         'platform-worker',
         '{}'::jsonb,
         now() - interval '10 days',
         now() - interval '10 days' - (value * interval '1 second')
       FROM generate_series(1, 501) AS fixture(value)
       UNION ALL
       SELECT 'recent-expired', 'platform-worker', '{}'::jsonb, now() - interval '1 day', now() - interval '1 day'
       UNION ALL
       SELECT 'active', 'platform-worker', '{}'::jsonb, now(), now()`,
    );
    const heartbeatSweep = platformControlRetentionSweeps.find(
      (candidate) => candidate.name === "expired-worker-heartbeats",
    );
    expect(heartbeatSweep).toBeDefined();

    await expect(executeRetentionSweepBatch(pools.retention, heartbeatSweep!)).resolves.toBe(500);

    const rows = await pools.retention.query<{
      row_count: string;
      preserved_count: string;
      remaining_old_count: string;
    }>(
      `SELECT
         count(*) AS row_count,
         count(*) FILTER (WHERE worker_id IN ('active', 'recent-expired')) AS preserved_count,
         count(*) FILTER (WHERE worker_id LIKE 'old-%') AS remaining_old_count
       FROM platform_worker_heartbeats`,
    );
    expect(rows.rows).toEqual([{ row_count: "3", preserved_count: "2", remaining_old_count: "1" }]);
  });
});
