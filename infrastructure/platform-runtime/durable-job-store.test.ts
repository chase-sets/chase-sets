import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDurableJobProgressCheckpoint,
  createPostgresDurableJobStore,
  durableJobSchemaMigrations,
  durableJobSchemaSql,
  DurableJobHandoffError,
  runDurableJobSideEffect,
} from "./durable-job-store";
import {
  createWorkSignalEnvelope,
  parseWorkSignalEnvelope,
  serializeWorkSignalEnvelope,
} from "./work-signal-composite";
import { attachRuntimeLifecycleRegistry, createRuntimeLifecycleRegistry } from "./runtime-lifecycle";

describe("durable job store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("can move next-eligible-at backfills out of boot schema SQL", () => {
    const sql = durableJobSchemaSql({
      jobsTable: "catalog_source_observation_jobs",
      eventsTable: "catalog_source_observation_job_events",
      includeBootReshapes: false,
    });
    const migrations = durableJobSchemaMigrations({
      jobsTable: "catalog_source_observation_jobs",
    });

    expect(sql).toContain("ADD COLUMN IF NOT EXISTS next_eligible_at timestamptz NULL");
    expect(sql).not.toContain("UPDATE catalog_source_observation_jobs");
    expect(sql).not.toContain("ALTER COLUMN next_eligible_at SET NOT NULL");
    expect(migrations).toEqual([
      expect.objectContaining({
        migrationId: "20260703_catalog_source_observation_jobs_next_eligible_at_backfill",
        statements: [
          expect.stringContaining("ADD COLUMN IF NOT EXISTS next_eligible_at timestamptz NULL"),
          expect.stringContaining("UPDATE catalog_source_observation_jobs"),
        ],
      }),
    ]);
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
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          if (sql.includes("RETURNING") && !sql.includes("INSERT INTO inventory_import_batch_job_events")) {
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
          if (sql.includes("INSERT INTO inventory_import_batch_job_events")) {
            return { rows: [{ sequence: calls.length }], rowCount: 1 };
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
    expect(String(calls[1].values[1])).not.toContain("batchId");
    expect(String(calls[1].values[1])).toContain("queued");

    // Notifications ride the work-signal composite: versioned envelope on the
    // store channel with only opaque job identifiers.
    const notifyCall = calls.find((call) => call.sql.includes("pg_notify"));
    expect(notifyCall?.values[0]).toBe("durable_job_events");
    const envelope = parseWorkSignalEnvelope(String(notifyCall?.values[1]));
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      payloadVersion: 1,
      kind: "durable-job.event",
      source: "durable-job-store",
      payload: { jobId: "job_1" },
    });
    expect(String(notifyCall?.values[1])).not.toContain("batchId");
  });

  it("renews claimed leases on progress updates and rejects expired owners", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          if (sql.includes("INSERT INTO inventory_import_batch_job_events")) {
            return { rows: [{ sequence: 1 }], rowCount: 1 };
          }
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

  it("releases bounded-turn jobs only for the live claim owner", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          if (sql.includes("INSERT INTO inventory_import_batch_job_events")) {
            return { rows: [{ sequence: 1 }], rowCount: 1 };
          }
          if (sql.includes("UPDATE inventory_import_batch_jobs") && sql.includes("status = 'queued'")) {
            return {
              rows: [
                {
                  job_id: "job_1",
                  job_kind: "commit",
                  status: "queued",
                  payload: { batchId: "imb_1" },
                  progress: { phase: "processing" },
                  result: { committed: 1 },
                  error_message: null,
                  event_context: { tenantId: "tnt_1" },
                  claim_owner_id: null,
                  claimed_until: null,
                  created_at: "2026-05-28T00:00:00.000Z",
                  started_at: "2026-05-28T00:00:00.000Z",
                  completed_at: null,
                  updated_at: "2026-05-28T00:00:10.000Z",
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
      store.releaseClaim({
        jobId: "job_1",
        claimOwnerId: "worker-a",
        progress: { phase: "processing" },
        result: { committed: 1 },
      }),
    ).resolves.toBe(true);

    expect(calls[0].sql).toContain("status = 'queued'");
    expect(calls[0].sql).toContain("claim_owner_id = $2");
    expect(calls[0].sql).toContain("claimed_until > now()");
  });

  it("requeues terminal jobs without changing payload or job identity", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          if (sql.includes("INSERT INTO inventory_import_batch_job_events")) {
            return { rows: [{ sequence: 1 }], rowCount: 1 };
          }
          if (sql.includes("UPDATE inventory_import_batch_jobs") && sql.includes("completed_at = NULL")) {
            return {
              rows: [
                {
                  job_id: "job_1",
                  job_kind: "commit",
                  status: "queued",
                  payload: { batchId: "imb_1" },
                  progress: { phase: "queued" },
                  result: { committed: 1 },
                  error_message: null,
                  event_context: { tenantId: "tnt_1" },
                  claim_owner_id: null,
                  claimed_until: null,
                  created_at: "2026-05-28T00:00:00.000Z",
                  started_at: "2026-05-28T00:00:00.000Z",
                  completed_at: null,
                  updated_at: "2026-05-28T00:00:10.000Z",
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
      store.requeue({
        jobId: "job_1",
        progress: { phase: "queued" },
        result: { committed: 1 },
        allowedStatuses: ["failed", "completed"],
      }),
    ).resolves.toMatchObject({ jobId: "job_1", status: "queued", result: { committed: 1 } });

    expect(calls[0].sql).toContain("status = 'queued'");
    expect(calls[0].sql).toContain("completed_at = NULL");
    expect(calls[0].sql).toContain("claim_owner_id = NULL");
    expect(calls[0].sql).toContain("status = ANY($5::text[])");
    expect(calls[0].sql).toContain("claimed_until IS NULL OR claimed_until <= now()");
    expect(calls[0].values[4]).toEqual(["failed", "completed"]);
    expect(calls[0].values[5]).toBe(false);
  });

  it("can guard requeue against a newly active claim", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          return { rows: [], rowCount: 0 };
        },
      },
      {
        jobsTable: "inventory_import_batch_jobs",
        eventsTable: "inventory_import_batch_job_events",
      },
    );

    await expect(
      store.requeue({
        jobId: "job_1",
        progress: { phase: "queued" },
        allowedStatuses: ["running"],
        requireExpiredClaim: true,
      }),
    ).resolves.toBeNull();

    expect(calls[0].sql).toContain("claimed_until IS NULL OR claimed_until <= now()");
    expect(calls[0].values[4]).toEqual(["running"]);
    expect(calls[0].values[5]).toBe(true);
  });

  it("cancels queued or running jobs as terminal failures with a status event", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          if (sql.includes("INSERT INTO inventory_import_batch_job_events")) {
            return { rows: [{ sequence: 1 }], rowCount: 1 };
          }
          if (sql.includes("UPDATE inventory_import_batch_jobs") && sql.includes("status = 'failed'")) {
            return {
              rows: [
                {
                  job_id: "job_1",
                  job_kind: "commit",
                  status: "failed",
                  payload: { batchId: "imb_1" },
                  progress: { phase: "failed" },
                  result: null,
                  error_message: "Operator cancelled job.",
                  event_context: { tenantId: "tnt_1" },
                  claim_owner_id: null,
                  claimed_until: null,
                  created_at: "2026-05-28T00:00:00.000Z",
                  started_at: "2026-05-28T00:00:00.000Z",
                  completed_at: "2026-05-28T00:00:10.000Z",
                  updated_at: "2026-05-28T00:00:10.000Z",
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
      store.cancel({
        jobId: "job_1",
        progress: { phase: "failed" },
        errorMessage: "Operator cancelled job.",
        allowedStatuses: ["queued", "running"],
      }),
    ).resolves.toMatchObject({ jobId: "job_1", status: "failed", errorMessage: "Operator cancelled job." });

    expect(calls[0].sql).toContain("status = 'failed'");
    expect(calls[0].sql).toContain("completed_at = now()");
    expect(calls[0].sql).toContain("claim_owner_id = NULL");
    expect(calls[0].sql).toContain("status = ANY($4::text[])");
    expect(calls[0].values[3]).toEqual(["queued", "running"]);
    expect(calls.some((call) => call.sql.includes("INSERT INTO inventory_import_batch_job_events"))).toBe(true);
  });

  it("prunes terminal jobs with a bounded limit", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          return { rows: [{ job_id: "job_1" }, { job_id: "job_2" }], rowCount: 2 };
        },
      },
      {
        jobsTable: "inventory_import_batch_jobs",
        eventsTable: "inventory_import_batch_job_events",
      },
    );

    await expect(store.pruneTerminalJobs({ completedBefore: "2026-05-21T00:00:00.000Z", limit: 2 })).resolves.toBe(2);

    expect(calls[0].sql).toContain("status IN ('completed', 'failed')");
    expect(calls[0].sql).toContain("DELETE FROM inventory_import_batch_jobs");
    expect(calls[0].values[1]).toBe(2);
  });

  it("lists recent jobs for an event context without dropping terminal records", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const eventContext = {
      tenantId: "tnt_1",
      audit: {
        performedByUserId: "usr_1",
        forAccountId: "acc_1",
      },
      requestId: "req_enqueue",
    } as const;
    const requestContext = {
      ...eventContext,
      requestId: "req_overview",
    } as const;
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          return {
            rows: [
              {
                job_id: "job_1",
                job_kind: "commit",
                status: "completed",
                payload: { batchId: "imb_1" },
                progress: { phase: "completed" },
                result: { committed: 1 },
                error_message: null,
                event_context: eventContext,
                claim_owner_id: null,
                claimed_until: null,
                created_at: "2026-05-28T00:00:00.000Z",
                started_at: "2026-05-28T00:00:01.000Z",
                completed_at: "2026-05-28T00:00:02.000Z",
                updated_at: "2026-05-28T00:00:02.000Z",
              },
            ],
            rowCount: 1,
          };
        },
      },
      {
        jobsTable: "inventory_import_batch_jobs",
        eventsTable: "inventory_import_batch_job_events",
      },
    );

    await expect(
      store.listRecent({
        jobKinds: ["commit"],
        eventContext: requestContext,
        limit: 12,
      }),
    ).resolves.toMatchObject([{ jobId: "job_1", status: "completed", result: { committed: 1 } }]);

    expect(calls[0].sql).not.toContain("status IN ('queued', 'running')");
    expect(calls[0].sql).toContain("event_context->>'tenantId' = $2::text");
    expect(calls[0].sql).toContain("event_context->'audit'->>'forAccountId' = $3::text");
    expect(calls[0].sql).toContain("event_context->'audit'->>'performedByUserId' = $4::text");
    expect(calls[0].sql).toContain("ORDER BY updated_at DESC");
    expect(calls[0].values).toEqual([["commit"], "tnt_1", "acc_1", "usr_1", 12]);
  });

  it("falls back to polling when notification LISTEN cannot be established", async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    const listenAttempts: string[] = [];
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      {
        query: async () => ({ rows: [], rowCount: 0 }),
        connect: async () => ({
          query: async (sql: string) => {
            if (sql.includes("LISTEN")) {
              listenAttempts.push(sql);
              throw new Error("LISTEN is unavailable on this connection.");
            }
            return { rows: [], rowCount: 0 };
          },
          release,
          on: vi.fn(),
          off: vi.fn(),
        }),
      } as never,
      {
        jobsTable: "inventory_import_batch_jobs",
        eventsTable: "inventory_import_batch_job_events",
      },
      { notificationRetryCooldownMs: 10_000 },
    );

    const wait = store.waitForEvents({ jobId: "job_1", timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(wait).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.any(Error));

    const secondWait = store.waitForEvents({ jobId: "job_1", timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(secondWait).resolves.toBeUndefined();
    expect(listenAttempts).toHaveLength(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses the configured notification waiter pool for event waits", async () => {
    const queryPoolClient = createJobNotificationClient();
    const waiterPoolClient = createJobNotificationClient();
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      {
        query: async () => ({ rows: [], rowCount: 0 }),
        connect: async () => queryPoolClient,
      } as never,
      {
        jobsTable: "inventory_import_batch_jobs",
        eventsTable: "inventory_import_batch_job_events",
      },
      {
        notificationWaiterPool: {
          query: async () => ({ rows: [], rowCount: 0 }),
          connect: async () => waiterPoolClient,
        } as never,
      },
    );

    const wait = store.waitForEvents({ jobId: "job_1", timeoutMs: 30_000 });

    await vi.waitFor(() => {
      expect(waiterPoolClient.queries).toContain("LISTEN durable_job_events");
    });
    expect(queryPoolClient.queries).not.toContain("LISTEN durable_job_events");

    waiterPoolClient.emit("notification", {
      channel: "durable_job_events",
      payload: JSON.stringify({ jobId: "job_1", sequence: 1 }),
    });

    await expect(wait).resolves.toBeUndefined();
  });

  it("wakes event waiters from composite envelopes and legacy notification payloads", async () => {
    const client = createJobNotificationClient();
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      {
        query: async () => ({ rows: [], rowCount: 0 }),
        connect: async () => client,
      } as never,
      {
        jobsTable: "inventory_import_batch_jobs",
        eventsTable: "inventory_import_batch_job_events",
      },
    );

    const compositeWait = store.waitForEvents({ jobId: "job_1", timeoutMs: 30_000 });
    const legacyWait = store.waitForEvents({ jobId: "job_2", timeoutMs: 30_000 });
    let otherJobSettled = false;
    const otherJobWait = store.waitForEvents({ jobId: "job_3", timeoutMs: 150 }).then(() => {
      otherJobSettled = true;
    });

    await vi.waitFor(() => {
      expect(client.queries).toContain("LISTEN durable_job_events");
    });

    client.emit("notification", {
      channel: "durable_job_events",
      payload: serializeWorkSignalEnvelope(
        createWorkSignalEnvelope({
          kind: "durable-job.event",
          source: "durable-job-store",
          payload: { jobId: "job_1", sequence: 3 },
        }),
      ),
    });
    // Rolling-deploy compatibility: pre-composite emitters send raw payloads.
    client.emit("notification", {
      channel: "durable_job_events",
      payload: JSON.stringify({ jobId: "job_2", sequence: 1 }),
    });

    await expect(compositeWait).resolves.toBeUndefined();
    await expect(legacyWait).resolves.toBeUndefined();
    // The unrelated job waiter is not woken; it waits out its bounded timeout.
    expect(otherJobSettled).toBe(false);
    await expect(otherJobWait).resolves.toBeUndefined();
  });

  it("stops active notification waiters through the runtime lifecycle registry", async () => {
    const lifecycle = createRuntimeLifecycleRegistry();
    const client = createJobNotificationClient();
    const pool = attachRuntimeLifecycleRegistry(
      {
        query: async () => ({ rows: [], rowCount: 0 }),
        connect: async () => client,
      },
      lifecycle,
    );
    const store = createPostgresDurableJobStore<{ batchId: string }, { phase: string }, { committed: number }>(
      pool as never,
      {
        jobsTable: "inventory_import_batch_jobs",
        eventsTable: "inventory_import_batch_job_events",
      },
    );

    const wait = store.waitForEvents({ jobId: "job_1", timeoutMs: 30_000 });

    await vi.waitFor(() => {
      expect(client.queries).toContain("LISTEN durable_job_events");
    });
    expect(lifecycle.size()).toBe(1);

    await lifecycle.stopAll();
    await expect(wait).resolves.toBeUndefined();

    expect(client.queries).toContain("UNLISTEN durable_job_events");
    expect(client.isReleased()).toBe(true);
    expect(client.releaseErrors()).toEqual([true]);
  });

  it("throttles public checkpoints and skipped renew writes separately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T00:00:00.000Z"));
    const checkpointProgress = vi.fn(async () => undefined);
    const renew = vi.fn(async () => undefined);
    const throwIfCancelled = vi.fn();
    const checkpoint = createDurableJobProgressCheckpoint<{ completed: number; phase: string }, { done: number }>(
      {
        throwIfCancelled,
        renew,
        checkpointProgress,
      },
      {
        minIntervalMs: 10_000,
        minCompletedDelta: 10,
        minRenewIntervalMs: 1_000,
        completed: (progress) => progress.completed,
        isTerminal: (progress) => progress.phase === "completed",
      },
    );

    await checkpoint.checkpoint({ phase: "processing", completed: 1 });
    await checkpoint.checkpoint({ phase: "processing", completed: 2 });
    await checkpoint.checkpoint({ phase: "processing", completed: 3 });
    await vi.advanceTimersByTimeAsync(1_000);
    await checkpoint.checkpoint({ phase: "processing", completed: 4 });
    await checkpoint.checkpoint({ phase: "processing", completed: 11 });
    await checkpoint.checkpoint({ phase: "completed", completed: 12 }, { done: 12 });

    expect(checkpointProgress).toHaveBeenCalledTimes(3);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(throwIfCancelled).toHaveBeenCalledTimes(3);
    expect(checkpointProgress).toHaveBeenLastCalledWith({ phase: "completed", completed: 12 }, { done: 12 });
    vi.useRealTimers();
  });

  it("fails an in-flight side effect when renewal loses the durable claim", async () => {
    vi.useFakeTimers();
    const renew = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Durable job claim was lost before renewal completed."));
    const sideEffect = runDurableJobSideEffect(
      {
        throwIfCancelled: vi.fn(),
        renew,
        checkpointProgress: vi.fn(),
      },
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      { renewIntervalMs: 1_000 },
    );

    const assertion = expect(sideEffect).rejects.toThrow("claim was lost");
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(renew).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("normalizes initial side-effect renewal failures as durable handoffs", async () => {
    const cause = new Error("database connection reset");
    const renew = vi.fn<() => Promise<void>>().mockRejectedValueOnce(cause);
    const work = vi.fn(async () => "should not run");

    await expect(
      runDurableJobSideEffect(
        {
          throwIfCancelled: vi.fn(),
          renew,
          checkpointProgress: vi.fn(),
        },
        work,
      ),
    ).rejects.toBeInstanceOf(DurableJobHandoffError);
    expect(work).not.toHaveBeenCalled();
  });
});

function createJobNotificationClient() {
  const emitter = new EventEmitter();
  const queries: string[] = [];
  const releaseErrors: unknown[] = [];
  let released = false;

  return Object.assign(emitter, {
    queries,
    isReleased: () => released,
    releaseErrors: () => releaseErrors,
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release: (error?: unknown) => {
      releaseErrors.push(error);
      released = true;
    },
  });
}
