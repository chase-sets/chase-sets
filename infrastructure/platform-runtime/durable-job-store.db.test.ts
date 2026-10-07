import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresDurableJobStore, durableJobSchemaSql } from "./durable-job-store";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
describe("durable job retention PostgreSQL parameter regression", () => {
  let pools: Readonly<Record<"retention", PgTransactionalPool>>;
  const tables = { jobsTable: "retention_jobs", eventsTable: "retention_events" };
  beforeAll(async () => {
    if (!adminDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for durable job retention DB proof.");
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl, ["retention"], "durable_job_retention");
    await ensureMultiContextTestDatabases(adminDatabaseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.retention.query(durableJobSchemaSql(tables));
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  it.each([{ exempt: false }, { exempt: true }])(
    "ordinary/exempt retention uses matching PostgreSQL binds ($exempt)",
    async ({ exempt }) => {
      const store = createPostgresDurableJobStore(pools.retention, {
        ...tables,
        retentionExemptJobKinds: exempt ? ["maintenance"] : [],
      });
      await store.enqueue({ jobId: "ordinary", jobKind: "ordinary", payload: {}, progress: {} });
      await store.enqueue({ jobId: "maintenance", jobKind: "maintenance", payload: {}, progress: {} });
      await pools.retention.query(
        "UPDATE retention_jobs SET status = 'completed', completed_at = '2020-01-01T00:00:00Z' WHERE status = 'queued'",
      );
      expect(await store.pruneTerminalJobs({ completedBefore: "2026-01-01T00:00:00Z" })).toBe(exempt ? 1 : 2);
      const rows = await pools.retention.query("SELECT job_id FROM retention_jobs ORDER BY job_id");
      expect(rows.rows).toEqual(exempt ? [{ job_id: "maintenance" }] : []);
      await store.stop?.();
    },
  );
});
