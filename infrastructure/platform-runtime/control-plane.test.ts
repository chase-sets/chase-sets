import { describe, expect, it } from "vitest";
import { bootstrapPlatformControlPlane, createPostgresPlatformControlPlane } from "./control-plane";

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
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_realtime_stream_leases");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_realtime_stream_counters");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_scheduled_runners");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_projection_status_snapshots");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_projection_operations");
    expect(statements[0]).toContain("ADD COLUMN IF NOT EXISTS fencing_token bigint");
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
    const claimCall = calls.find((call) => call.sql.includes("FOR UPDATE SKIP LOCKED"));
    expect(claimCall?.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(claimCall?.sql).toContain("claim_fencing_token = COALESCE");
    expect(claimCall?.sql).toContain("RETURNING operation.operation_id");
    expect(calls.some((call) => call.sql.includes("RETURNING event_sequence"))).toBe(true);
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
        return { rows: [], rowCount: sql.includes("UPDATE platform_scheduled_runners AS runner") ? 1 : 0 };
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
    expect(calls[0].sql).toContain("next_run_at <= now()");
    expect(calls[0].sql).toContain("next_run_at = now() +");
    expect(calls[0].params).toEqual(["payments.reconciliation", 60_000]);
    expect(calls[1].sql).toContain("last_completed_at = now()");
  });
});
