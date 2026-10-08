import { describe, expect, it, vi } from "vitest";
import type { BcRetentionSweep } from "@chase-sets/bounded-context-module";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  classifyRetentionSweepFailure,
  createRetentionSweepLogObserver,
  createRetentionSweepRunner,
  executeRetentionSweepBatch,
  platformControlRetentionSweeps,
} from "./retention-sweep";

const sweep: BcRetentionSweep = {
  name: "expired-example-rows",
  tableName: "example_rows",
  predicateSql: "candidate.expires_at < now() - interval '7 days'",
  orderBySql: "candidate.expires_at ASC",
  intervalMs: 60_000,
  batchLimit: 2,
};

describe("retention sweep", () => {
  it("registers bounded oldest-first worker-heartbeat retention on the platform control runner", () => {
    expect(platformControlRetentionSweeps).toContainEqual({
      name: "expired-worker-heartbeats",
      tableName: "platform_worker_heartbeats",
      predicateSql: "candidate.heartbeat_at < now() - interval '7 days'",
      orderBySql: "candidate.heartbeat_at ASC, candidate.worker_id ASC",
      intervalMs: 6 * 60 * 60_000,
      batchLimit: 500,
    });
  });

  it("executes one lock-safe bounded delete batch", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 2 });

    await expect(executeRetentionSweepBatch({ query } as PgQueryable, sweep)).resolves.toBe(2);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE SKIP LOCKED"), [
      2,
      "retention:example_rows:expired-example-rows",
    ]);
    expect(query.mock.calls[0][0]).toContain("LIMIT $1");
    expect(query.mock.calls[0][0]).toContain("pg_try_advisory_xact_lock");
    expect(query.mock.calls[0][0]).toContain("DELETE FROM example_rows AS retained");
  });

  it("drains only the configured number of batches and records completion", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const recordScheduledRunnerCompleted = vi.fn().mockResolvedValue(undefined);
    const runner = createRetentionSweepRunner({
      controlPlane: {
        claimScheduledRunner: vi.fn().mockResolvedValue(true),
        recordScheduledRunnerCompleted,
      },
      targets: [{ contextName: "example", db: { query } as PgQueryable, sweep }],
      maxBatchesPerRun: 2,
    });

    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 4, state: "caught-up" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(recordScheduledRunnerCompleted).toHaveBeenCalledWith({
      runnerName: "retention.example.expired-example-rows",
    });
  });

  it("observes one table failure, continues other sweeps, and does not reject", async () => {
    const sweepFailed = vi.fn();
    const healthyQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const runner = createRetentionSweepRunner({
      controlPlane: {
        claimScheduledRunner: vi.fn().mockResolvedValue(true),
        recordScheduledRunnerCompleted: vi.fn().mockResolvedValue(undefined),
      },
      targets: [
        {
          contextName: "broken",
          db: { query: vi.fn().mockRejectedValue(new Error("database unavailable")) } as PgQueryable,
          sweep,
        },
        { contextName: "healthy", db: { query: healthyQuery } as PgQueryable, sweep },
      ],
      observer: { sweepFailed },
    });

    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 1, state: "caught-up" });
    expect(sweepFailed).toHaveBeenCalledWith({
      contextName: "broken",
      sweepName: "expired-example-rows",
      tableName: "example_rows",
      failure: { errorClass: "error", errorCode: null },
    });
    expect(healthyQuery).toHaveBeenCalledOnce();
  });

  it("classifies failures into a bounded class and allowlisted code only", () => {
    const database = Object.assign(new (class DatabaseError extends Error {})("secret row"), { code: "57P01" });
    const forgedCode = Object.assign(new Error("secret row"), { code: "secret row" });
    const system = Object.assign(new Error("secret row"), { code: "ECONNREFUSED", errno: -111 });

    expect(classifyRetentionSweepFailure(database)).toEqual({ errorClass: "database-error", errorCode: "57P01" });
    expect(classifyRetentionSweepFailure(system)).toEqual({ errorClass: "system-error", errorCode: "ECONNREFUSED" });
    expect(classifyRetentionSweepFailure(forgedCode)).toEqual({ errorClass: "error", errorCode: null });
    expect(classifyRetentionSweepFailure(new RangeError("secret row"))).toEqual({
      errorClass: "range-error",
      errorCode: null,
    });
    expect(classifyRetentionSweepFailure({ code: "57P01" })).toEqual({ errorClass: "non-error", errorCode: null });
  });

  it("logs completed and failed sweeps without raw error text or unsafe names", () => {
    const info = vi.fn();
    const error = vi.fn();
    const observer = createRetentionSweepLogObserver({ info, error });

    observer.sweepCompleted?.({ contextName: "example", sweepName: "expired-example-rows", deleted: 0 });
    observer.sweepCompleted?.({ contextName: "example", sweepName: "expired-example-rows", deleted: 3 });
    observer.sweepFailed?.({
      contextName: "Example Secret",
      sweepName: "expired-example-rows",
      tableName: "example_rows",
      failure: { errorClass: "database-error", errorCode: "40P01" },
    });

    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith("Retention sweep completed.", {
      type: "retention.sweep.completed",
      contextName: "example",
      sweepName: "expired-example-rows",
      deleted: 3,
    });
    expect(error).toHaveBeenCalledWith("Retention sweep failed; it will retry on its next interval.", {
      type: "retention.sweep.failed",
      contextName: "invalid-name",
      sweepName: "expired-example-rows",
      tableName: "example_rows",
      errorClass: "database-error",
      errorCode: "40P01",
    });
  });

  it("rejects unsafe registration fragments before querying", async () => {
    const query = vi.fn();
    await expect(
      executeRetentionSweepBatch({ query } as PgQueryable, { ...sweep, predicateSql: "true; DROP TABLE users" }),
    ).rejects.toThrow("trusted, parameter-free SQL fragment");
    expect(query).not.toHaveBeenCalled();
  });
});
