import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
  platformControlPlaneSchemaSql,
} from "./control-plane";
import { createRuntimeLifecycleRegistry } from "./runtime-lifecycle";

describe("platform control plane", () => {
  it("bootstraps additive coordination tables", async () => {
    const statements: string[] = [];

    await bootstrapPlatformControlPlane({
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
      },
    });

    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_control_leases");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_control_lease_fencing_tokens");
    expect(statements[0]).toContain("FROM platform_control_leases");
    expect(statements[0]).toContain("FROM platform_runner_statuses");
    expect(statements[0]).toContain("FROM platform_projection_status_snapshots");
    expect(statements[0]).toContain("max(seed.fencing_token)");
    expect(statements[0]).toContain("GROUP BY seed.lease_name");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_realtime_stream_leases");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_realtime_stream_counters");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_scheduled_runners");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_projection_wake_intents");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_projection_checkpoint_readiness");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_projection_checkpoint_waiters");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_projection_wake_relay_cursors");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_post_write_tokens");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_projection_status_snapshots");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_projection_operations");
    expect(statements[0]).toContain("ADD COLUMN IF NOT EXISTS fencing_token bigint");

    // Bootstrap must also reap stale in-flight operations (running or
    // cancel_requested with an expired or cleared claim) so #4496-style ghost
    // rows converge on the next deploy without manual SQL.
    const reapStatement = statements.find((statement) => statement.includes("stale_claim_reaped"));
    expect(reapStatement).toBeDefined();
    expect(reapStatement).toContain("state IN ('running', 'cancel_requested')");
    expect(reapStatement).toContain("claimed_until IS NULL");
    expect(reapStatement).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("adds projection-operation compatibility columns before any index that references them", () => {
    // Regression guard for issue #4599's staging bootstrap failure: on an upgraded
    // database `CREATE TABLE IF NOT EXISTS platform_projection_operations` is a
    // no-op, so the claimable index over next_eligible_at can only build after the
    // ADD COLUMN backfills that column onto the pre-existing table. Postgres raised
    // 42703 ("column next_eligible_at does not exist") when the index preceded the
    // ALTER. The bootstrap SQL runs as one implicit transaction, so these must stay
    // plain (non-CONCURRENT) index builds ordered after the compatibility ALTERs.
    const sql = platformControlPlaneSchemaSql;
    const addAttemptCount = sql.indexOf("ADD COLUMN IF NOT EXISTS attempt_count");
    const addNextEligibleAt = sql.indexOf("ADD COLUMN IF NOT EXISTS next_eligible_at");
    const claimableIndex = sql.indexOf("platform_projection_operations_claimable_idx");

    expect(addAttemptCount).toBeGreaterThan(-1);
    expect(addNextEligibleAt).toBeGreaterThan(-1);
    expect(claimableIndex).toBeGreaterThan(-1);
    expect(addAttemptCount).toBeLessThan(claimableIndex);
    expect(addNextEligibleAt).toBeLessThan(claimableIndex);
    expect(sql).not.toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS platform_projection_operations_claimable_idx");
  });

  it("uses fenced lease ownership for acquire, renew, and release", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const controlPlane = createPostgresPlatformControlPlane({
      connect: async () => {
        throw new Error("not used");
      },
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("RETURNING lease_name")) {
          return {
            rows: [
              {
                lease_name: "projector:one",
                owner_id: "worker-a",
                fencing_token: "7",
                expires_at: "2026-05-03T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 1 };
      },
    });

    const lease = await controlPlane.acquireLease({
      leaseName: "projector:one",
      ownerId: "worker-a",
      ttlMs: 30_000,
    });

    expect(lease).toMatchObject({
      leaseName: "projector:one",
      ownerId: "worker-a",
      fencingToken: "7",
    });
    await expect(controlPlane.renewLease(lease!, 30_000)).resolves.toBe(true);
    await controlPlane.releaseLease(lease!);
    expect(calls[0].sql).toContain("WITH claimable AS");
    expect(calls[0].sql).toContain("INSERT INTO platform_control_lease_fencing_tokens");
    expect(calls[0].sql).toContain("fencing_token = platform_control_lease_fencing_tokens.fencing_token + 1");
    expect(calls[0].sql).toContain("FROM next_token");
    expect(calls[1].sql).toContain("AND fencing_token = $3::bigint");
    expect(calls[2].sql).toContain("AND fencing_token = $3::bigint");
  });

  it("records and lists projection status snapshots", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const controlPlane = createPostgresPlatformControlPlane({
      connect: async () => {
        throw new Error("not used");
      },
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("FROM platform_projection_status_snapshots")) {
          return {
            rows: [
              {
                projection_key: "inventory.inventory-catalog-item-projection",
                target_context_name: "inventory",
                projection_name: "inventory-catalog-item-projection",
                runner_name: "inventory.inventory-catalog-item-projection",
                owner_id: "worker-a",
                status: {
                  targetContextName: "inventory",
                  projectionName: "inventory-catalog-item-projection",
                },
                updated_at: "2026-05-25T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 1 };
      },
    });

    await controlPlane.recordProjectionStatusSnapshot({
      projectionKey: "inventory.inventory-catalog-item-projection",
      targetContextName: "inventory",
      projectionName: "inventory-catalog-item-projection",
      runnerName: "inventory.inventory-catalog-item-projection",
      ownerId: "worker-a",
      fencingToken: "8",
      status: {
        targetContextName: "inventory",
        projectionName: "inventory-catalog-item-projection",
      },
    });

    await expect(controlPlane.listProjectionStatusSnapshots()).resolves.toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT INTO platform_projection_status_snapshots");
    expect(calls[0].sql).toContain("EXCLUDED.fencing_token >= platform_projection_status_snapshots.fencing_token");
    expect(calls[0].params?.[5]).toBe("8");
    expect(calls[0].params?.[6]).toBe(
      JSON.stringify({
        targetContextName: "inventory",
        projectionName: "inventory-catalog-item-projection",
      }),
    );
  });

  it("records runner status with monotonic fencing", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const controlPlane = createPostgresPlatformControlPlane({
      connect: async () => {
        throw new Error("not used");
      },
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    });

    await controlPlane.recordRunnerStatus({
      runnerName: "inventory.inventory-catalog-item-projection",
      runnerKind: "projection-group",
      state: "running",
      ownerId: "worker-a",
      fencingToken: "9",
    });

    expect(calls[0].sql).toContain("EXCLUDED.fencing_token >= platform_runner_statuses.fencing_token");
  });

  it("persists projection wake relay cursors with active lease fencing", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const cursorRow = {
      source_context_name: "checkout",
      last_fanout_position: "102",
      last_required_cursor: "checkout:102",
      owner_id: "worker-a",
      fencing_token: "7",
      metadata: { reason: "catch-up" },
      updated_at: "2026-06-10T12:00:00.000Z",
    };
    const controlPlane = createPostgresPlatformControlPlane({
      connect: async () => {
        throw new Error("not used");
      },
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("FROM platform_projection_wake_relay_cursors") && !sql.includes("active_lease")) {
          return { rows: [cursorRow], rowCount: 1 };
        }
        if (sql.includes("WITH active_lease")) {
          return { rows: [cursorRow], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
      },
    });

    await expect(controlPlane.getProjectionWakeRelayCursor("checkout")).resolves.toMatchObject({
      sourceContextName: "checkout",
      lastFanOutPosition: 102n,
      lastRequiredCursor: "checkout:102",
      ownerId: "worker-a",
      fencingToken: "7",
    });
    await expect(
      controlPlane.advanceProjectionWakeRelayCursor({
        sourceContextName: "checkout",
        lastFanOutPosition: "102",
        lastRequiredCursor: "checkout:102",
        lease: {
          leaseName: "projection-wake-relay:active",
          ownerId: "worker-a",
          fencingToken: "7",
          expiresAt: "2026-06-10T12:01:00.000Z",
        },
        metadata: { reason: "catch-up" },
      }),
    ).resolves.toMatchObject({
      sourceContextName: "checkout",
      lastFanOutPosition: 102n,
      fencingToken: "7",
    });

    expect(calls[1].sql).toContain("WITH active_lease AS");
    expect(calls[1].sql).toContain("expires_at > now()");
    expect(calls[1].sql).toContain("cursor.last_fanout_position < $2::bigint");
    expect(calls[1].params).toEqual([
      "checkout",
      "102",
      "checkout:102",
      "projection-wake-relay:active",
      "worker-a",
      "7",
      JSON.stringify({ reason: "catch-up" }),
    ]);
  });

  it("lists projection wake relay cursors for operator visibility", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const controlPlane = createPostgresPlatformControlPlane({
      connect: async () => {
        throw new Error("not used");
      },
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return {
          rows: [
            {
              source_context_name: "catalog",
              last_fanout_position: "88",
              last_required_cursor: "catalog:88",
              owner_id: "worker-a",
              fencing_token: "7",
              metadata: { reason: "notify", projectionInterestIndexVersion: "v3" },
              updated_at: "2026-06-10T12:00:00.000Z",
            },
            {
              source_context_name: "checkout",
              last_fanout_position: "102",
              last_required_cursor: null,
              owner_id: "worker-b",
              fencing_token: "9",
              metadata: {},
              updated_at: "2026-06-10T12:00:30.000Z",
            },
          ],
          rowCount: 2,
        };
      },
    });

    await expect(controlPlane.listProjectionWakeRelayCursors()).resolves.toMatchObject([
      {
        sourceContextName: "catalog",
        lastFanOutPosition: 88n,
        lastRequiredCursor: "catalog:88",
        ownerId: "worker-a",
        fencingToken: "7",
        metadata: { reason: "notify", projectionInterestIndexVersion: "v3" },
      },
      {
        sourceContextName: "checkout",
        lastFanOutPosition: 102n,
        lastRequiredCursor: null,
        ownerId: "worker-b",
        fencingToken: "9",
      },
    ]);

    expect(calls[0].sql).toContain("FROM platform_projection_wake_relay_cursors");
    expect(calls[0].sql).toContain("ORDER BY source_context_name");
  });

  it("enqueues and claims projection operations with fencing", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const operationRow = {
      operation_id: "projection-operation-1",
      operation_kind: "rebuild-projection-group",
      state: "queued",
      context_name: "catalog",
      projection_name: "catalog-item-projection",
      projection_key: null,
      stream_id: null,
      requested_by_user_id: "user_1",
      requested_by_account_id: "account_1",
      claim_owner_id: null,
      claim_fencing_token: null,
      claimed_until: null,
      progress: {},
      result: null,
      error: null,
      requested_at: "2026-05-26T00:00:00.000Z",
      started_at: null,
      updated_at: "2026-05-26T00:00:00.000Z",
      completed_at: null,
    };
    const controlPlane = createPostgresPlatformControlPlane({
      connect: async () => {
        const query = async (sql: string, params?: readonly unknown[]) => {
          calls.push({ sql, params });
          if (sql.includes("RETURNING event_sequence")) {
            return {
              rows: [{ event_sequence: calls.filter((call) => call.sql.includes("RETURNING event_sequence")).length }],
              rowCount: 1,
            };
          }
          if (sql.includes("WITH exhausted")) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("RETURNING") && sql.includes("platform_projection_operations")) {
            return {
              rows: [
                {
                  ...operationRow,
                  state: sql.includes("WITH claimable") ? "running" : operationRow.state,
                  claim_owner_id: sql.includes("WITH claimable") ? "worker-a" : null,
                  claim_fencing_token: sql.includes("WITH claimable") ? "1" : null,
                  claimed_until: sql.includes("WITH claimable") ? "2026-05-26T00:01:00.000Z" : null,
                },
              ],
              rowCount: 1,
            };
          }

          return { rows: [], rowCount: 1 };
        };
        return { query, release: () => undefined };
      },
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    });

    const enqueued = await controlPlane.enqueueProjectionOperation({
      operationKind: "rebuild-projection-group",
      contextName: "catalog",
      projectionName: "catalog-item-projection",
      requestedByUserId: "user_1",
      requestedByAccountId: "account_1",
    });
    const claimed = await controlPlane.claimProjectionOperation({
      ownerId: "worker-a",
      claimTtlMs: 60_000,
    });

    expect(enqueued).toMatchObject({
      operationKind: "rebuild-projection-group",
      state: "queued",
      contextName: "catalog",
    });
    expect(claimed).toMatchObject({
      state: "running",
      claimOwnerId: "worker-a",
      claimFencingToken: "1",
    });
    const sweepCall = calls.find((call) => call.sql.includes("WITH exhausted"));
    expect(sweepCall?.sql).toContain("attempt_count >= $2::integer");
    expect(sweepCall?.sql).toContain("'attempts_exhausted'");
    const claimCall = calls.find((call) => call.sql.includes("WITH claimable"));
    expect(claimCall?.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(claimCall?.sql).toContain("claim_fencing_token = COALESCE");
    expect(claimCall?.sql).toContain("attempt_count < $4::integer");
    expect(claimCall?.sql).toContain("next_eligible_at <= now()");
    expect(claimCall?.sql).toContain("attempt_count = operation.attempt_count + 1");
    expect(claimCall?.sql).toContain("RETURNING operation.operation_id");
    expect(calls.some((call) => call.sql.includes("RETURNING event_sequence"))).toBe(true);
    const notifyCall = calls.find((call) => call.sql.includes("pg_notify"));
    expect(notifyCall?.params?.[0]).toBe("platform_projection_operation_events");
    expect(JSON.parse(String(notifyCall?.params?.[1]))).toMatchObject({
      schemaVersion: 1,
      payloadVersion: 1,
      kind: "projection-operation.event",
      source: "platform-control-plane",
      payload: {
        operationId: "projection-operation-1",
      },
    });
  });

  it("filters projection operation history by target, state, and actor", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const controlPlane = createPostgresPlatformControlPlane({
      connect: async () => {
        throw new Error("not used");
      },
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    });

    await controlPlane.listProjectionOperations({
      contextName: "catalog",
      projectionName: "catalog-item-projection",
      state: "failed",
      requestedByUserId: "user_1",
      limit: 25,
    });

    expect(calls[0].sql).toContain("context_name = $1");
    expect(calls[0].sql).toContain("projection_name = $2");
    expect(calls[0].sql).toContain("state = $3");
    expect(calls[0].sql).toContain("requested_by_user_id = $4");
    expect(calls[0].params).toEqual(["catalog", "catalog-item-projection", "failed", "user_1", 25]);
  });

  it("summarizes projection operation backlog and duration metrics", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const controlPlane = createPostgresPlatformControlPlane({
      connect: async () => {
        throw new Error("not used");
      },
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return {
          rows: [
            {
              queued_count: "2",
              running_count: "1",
              failed_count: "3",
              cancel_requested_count: "1",
              oldest_queued_at: "2026-05-26T01:00:00.000Z",
              oldest_running_at: "2026-05-26T01:01:00.000Z",
              average_duration_ms: "1234.4",
            },
          ],
          rowCount: 1,
        };
      },
    });

    await expect(controlPlane.summarizeProjectionOperations({ contextName: "catalog" })).resolves.toEqual({
      queuedCount: "2",
      runningCount: "1",
      failedCount: "3",
      cancelRequestedCount: "1",
      oldestQueuedAt: "2026-05-26T01:00:00.000Z",
      oldestRunningAt: "2026-05-26T01:01:00.000Z",
      averageDurationMs: "1234",
    });
    expect(calls[0].sql).toContain("COUNT(*) FILTER (WHERE state = 'queued')");
    expect(calls[0].sql).toContain("AVG(EXTRACT(EPOCH");
    expect(calls[0].params).toEqual(["catalog"]);
  });

  it("claims scheduled runners from durable cadence state", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const controlPlane = createPostgresPlatformControlPlane({
      connect: async () => {
        throw new Error("not used");
      },
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: sql.includes("UPDATE platform_scheduled_runners") ? 1 : 0 };
      },
    });

    await expect(
      controlPlane.claimScheduledRunner({
        runnerName: "payments.reconciliation",
        intervalMs: 60_000,
      }),
    ).resolves.toBe(true);
    await controlPlane.recordScheduledRunnerCompleted({ runnerName: "payments.reconciliation" });

    expect(calls[0].sql).toContain("INSERT INTO platform_scheduled_runners");
    expect(calls[0].sql).toContain("ON CONFLICT (runner_name) DO NOTHING");
    expect(calls[0].params).toEqual(["payments.reconciliation", 60_000]);
    expect(calls[1].sql).toContain("next_run_at <= now()");
    expect(calls[1].sql).toContain("next_run_at = now() +");
    expect(calls[1].params).toEqual(["payments.reconciliation", 60_000]);
    expect(calls[2].sql).toContain("last_completed_at = now()");
  });

  it("registers and stops the projection operation LISTEN waiter", async () => {
    const lifecycle = createRuntimeLifecycleRegistry();
    const client = createProjectionOperationNotificationClient();
    const controlPlane = createPostgresPlatformControlPlane(
      {
        connect: async () => client,
        query: async () => ({ rows: [], rowCount: 0 }),
      },
      { lifecycle },
    );

    const wait = controlPlane.waitForProjectionOperationEvents({
      operationId: "projection-operation-1",
      timeoutMs: 30_000,
    });

    await vi.waitFor(() => {
      expect(client.queries).toContain("LISTEN platform_projection_operation_events");
    });
    expect(lifecycle.size()).toBe(1);

    await lifecycle.stopAll();
    await expect(wait).resolves.toBeUndefined();

    expect(client.queries).toContain("UNLISTEN platform_projection_operation_events");
    expect(client.isReleased()).toBe(true);
    expect(client.releaseErrors()).toEqual([true]);
  });
});

function createProjectionOperationNotificationClient() {
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
