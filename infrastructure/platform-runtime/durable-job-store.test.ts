import { describe, expect, it } from "vitest";
import { createPostgresDurableJobStore, durableJobSchemaSql } from "./durable-job-store";

describe("durable job store", () => {
  it("defines context-owned job and event tables", () => {
    const sql = durableJobSchemaSql({
      jobsTable: "inventory_import_batch_jobs",
      eventsTable: "inventory_import_batch_job_events",
    });

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS inventory_import_batch_jobs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS inventory_import_batch_job_events");
    expect(sql).toContain("PRIMARY KEY (job_id, sequence)");
  });

  it("enqueues and claims jobs with ordered status events", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const row = {
      job_id: "job_1",
      job_kind: "commit",
      status: "queued",
      payload: { batchId: "imb_1" },
      progress: { phase: "queued" },
      result: null,
      error_message: null,
      event_context: { tenantId: "tnt_1" },
      claim_owner_id: null,
      claimed_until: null,
      created_at: "2026-05-28T00:00:00.000Z",
      started_at: null,
      completed_at: null,
      updated_at: "2026-05-28T00:00:00.000Z",
    };
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      {
        query: async (sql, values = []) => {
          calls.push({ sql, values });
          if (sql.includes("RETURNING")) {
            return {
              rows: [
                {
                  ...row,
                  status: sql.includes("WITH claimable") ? "running" : row.status,
                  claim_owner_id: sql.includes("WITH claimable") ? "worker-a" : null,
                },
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 1 };
        },
      },
      {
        jobsTable: "inventory_import_batch_jobs",
        eventsTable: "inventory_import_batch_job_events",
      },
    );

    await expect(
      store.enqueue({
        jobId: "job_1",
        jobKind: "commit",
        payload: { batchId: "imb_1" },
        progress: { phase: "queued" },
        eventContext: { tenantId: "tnt_1" } as never,
      }),
    ).resolves.toMatchObject({ jobId: "job_1", status: "queued" });
    await expect(
      store.claimNext({
        claimOwnerId: "worker-a",
        claimTtlMs: 60_000,
        jobKinds: ["commit"],
      }),
    ).resolves.toMatchObject({ jobId: "job_1", status: "running", claimOwnerId: "worker-a" });

    expect(calls[0].sql).toContain("INSERT INTO inventory_import_batch_jobs");
    expect(calls[1].sql).toContain("INSERT INTO inventory_import_batch_job_events");
    expect(calls[2].sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(calls[3].sql).toContain("coalesce(max(sequence), 0) + 1");
    expect(String(calls[1].values[1])).not.toContain("batchId");
    expect(String(calls[1].values[1])).toContain("queued");
  });

  it("renews claimed leases on progress updates and rejects expired owners", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      {
        query: async (sql, values = []) => {
          calls.push({ sql, values });
          if (sql.includes("RETURNING") && sql.includes("claimed_until > now()")) {
            return {
              rows: [
                {
                  job_id: "job_1",
                  job_kind: "commit",
                  status: "running",
                  payload: { batchId: "imb_1" },
                  progress: { phase: "processing" },
                  result: null,
                  error_message: null,
                  event_context: { tenantId: "tnt_1" },
                  claim_owner_id: "worker-a",
                  claimed_until: "2026-05-28T00:01:00.000Z",
                  created_at: "2026-05-28T00:00:00.000Z",
                  started_at: "2026-05-28T00:00:00.000Z",
                  completed_at: null,
                  updated_at: "2026-05-28T00:00:10.000Z",
                },
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
      },
      {
        jobsTable: "inventory_import_batch_jobs",
        eventsTable: "inventory_import_batch_job_events",
      },
    );

    await expect(
      store.updateProgress({
        jobId: "job_1",
        claimOwnerId: "worker-a",
        claimTtlMs: 120_000,
        progress: { phase: "processing" },
      }),
    ).resolves.toBe(true);

    expect(calls[0].sql).toContain("claimed_until = now() + ($5::text || ' milliseconds')::interval");
    expect(calls[0].sql).toContain("claimed_until > now()");
    expect(calls[0].values[4]).toBe(120_000);
  });
});
