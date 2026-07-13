import { describe, expect, it } from "vitest";
import { createPostgresDurableJobWorkUnitStore, durableJobWorkUnitSchemaSql } from "./durable-job-work-units";

describe("durable job work units", () => {
  it("defines context-owned work-unit tables with claim indexes", () => {
    const sql = durableJobWorkUnitSchemaSql({
      jobsTable: "catalog_source_observation_bulk_review_jobs",
      workUnitsTable: "catalog_source_observation_bulk_review_work_units",
    });

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS catalog_source_observation_bulk_review_work_units");
    expect(sql).toContain("PRIMARY KEY (job_id, unit_id)");
    expect(sql).toContain("catalog_source_observation_bulk_review_work_units_claimable_idx");
    expect(sql).toContain("WHERE state = 'running'");
  });

  it("claims one unit with workflow and per-job budgets", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresDurableJobWorkUnitStore<
      { action: string },
      { completed: number; total: number },
      { completed: number },
      { observationId: string },
      { observationId: string; status: string }
    >(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          if (sql.includes("WITH workflow_budget")) {
            return {
              rows: [
                {
                  ...prefixedJobRow(),
                  ...prefixedUnitRow(),
                },
              ],
              rowCount: 1,
            };
          }
          if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_job_events")) {
            return { rows: [{ sequence: 2 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      },
      {
        jobsTable: "catalog_source_observation_bulk_review_jobs",
        eventsTable: "catalog_source_observation_bulk_review_job_events",
        workUnitsTable: "catalog_source_observation_bulk_review_work_units",
      },
      { workflowName: "catalog.source-observation-bulk-review" },
    );

    const result = await store.claimNext({
      claimOwnerId: "worker-a:lane-1",
      claimTtlMs: 60_000,
      workflowMaxActiveClaims: 3,
      jobMaxActiveClaims: 2,
      jobKinds: ["promote"],
      laneName: "job:catalog.source-observation-bulk-jobs.lane-1",
    });

    expect(result.claim?.unit.unitId).toBe("obs_1");
    expect(result.outcome.reason).toBe("claimed");
    expect(calls[0].sql).toContain("FOR UPDATE OF unit SKIP LOCKED");
    expect(calls[0].sql).toContain("workflow_budget.active_claims < $4");
    expect(calls[0].sql).toContain("coalesce(active_job.active_claims, 0) < $5");
    expect(calls[0].values[3]).toBe(3);
    expect(calls[0].values[4]).toBe(2);
  });

  it("reports cap pressure when work is pending but workflow lanes are full", async () => {
    const store = createPostgresDurableJobWorkUnitStore(
      {
        query: async (sql: string) => {
          if (sql.includes("WITH workflow_budget")) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [{ pending: 4, active_claims: 3 }], rowCount: 1 };
        },
      },
      {
        jobsTable: "catalog_source_observation_bulk_review_jobs",
        eventsTable: "catalog_source_observation_bulk_review_job_events",
        workUnitsTable: "catalog_source_observation_bulk_review_work_units",
      },
      { workflowName: "catalog.source-observation-bulk-review" },
    );

    const result = await store.claimNext({
      claimOwnerId: "worker-a:lane-3",
      claimTtlMs: 60_000,
      workflowMaxActiveClaims: 3,
      jobMaxActiveClaims: 2,
    });

    expect(result.claim).toBeNull();
    expect(result.outcome).toMatchObject({
      claimed: false,
      reason: "workflow_budget_exhausted",
      activeClaims: 3,
    });
  });

  it("records terminal units and parent snapshots without leaking payload", async () => {
    const snapshots: string[] = [];
    const store = createPostgresDurableJobWorkUnitStore<
      { secret: string },
      { completed: number; total: number },
      { completed: number },
      { secretObservationId: string },
      { observationId: string; status: string }
    >(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          if (sql.includes("SELECT job_id") && sql.includes("terminal_unit")) {
            return { rows: [{ job_id: "job_1" }], rowCount: 1 };
          }
          if (sql.includes("UPDATE catalog_source_observation_bulk_review_jobs AS job")) {
            return {
              rows: [
                prefixedJobRow({
                  job_payload: { secret: "do-not-emit" },
                  job_progress: JSON.parse(String(values[1])),
                  job_result: JSON.parse(String(values[2])),
                  job_status: "completed",
                }),
              ],
              rowCount: 1,
            };
          }
          if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_job_events")) {
            snapshots.push(String(values[1]));
            return { rows: [{ sequence: 3 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      },
      {
        jobsTable: "catalog_source_observation_bulk_review_jobs",
        eventsTable: "catalog_source_observation_bulk_review_job_events",
        workUnitsTable: "catalog_source_observation_bulk_review_work_units",
      },
      { workflowName: "catalog.source-observation-bulk-review" },
    );

    await expect(
      store.recordTerminal({
        jobId: "job_1",
        unitId: "obs_1",
        claimOwnerId: "worker-a",
        claimToken: "token-a",
        state: "completed",
        unitResult: { observationId: "obs_1", status: "promoted" },
        parentProgress: { completed: 1, total: 1 },
        parentResult: { completed: 1 },
        completeJob: true,
      }),
    ).resolves.toBe("recorded");

    expect(snapshots[0]).toContain('"completed":1');
    expect(snapshots[0]).not.toContain("do-not-emit");
  });

  it("reconciles a terminal parent without requiring a live work-unit claim", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const snapshots: string[] = [];
    const store = createPostgresDurableJobWorkUnitStore<
      { action: string },
      { completed: number; total: number; phase: string },
      { requested: number; outcomes: readonly unknown[] },
      { observationId: string },
      { observationId: string; status: string }
    >(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          if (sql.includes("SELECT job_id") && sql.includes("FOR UPDATE")) {
            return { rows: [{ job_id: "job_1" }], rowCount: 1 };
          }
          if (sql.includes("state NOT IN ('completed', 'failed', 'skipped')")) {
            return { rows: [{ count: 0 }], rowCount: 1 };
          }
          if (sql.includes("UPDATE catalog_source_observation_bulk_review_jobs AS job")) {
            return {
              rows: [
                prefixedJobRow({
                  job_status: "completed",
                  job_progress: JSON.parse(String(values[1])),
                  job_result: JSON.parse(String(values[2])),
                  job_completed_at: "2026-05-31T00:02:00.000Z",
                }),
              ],
              rowCount: 1,
            };
          }
          if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_job_events")) {
            snapshots.push(String(values[1]));
            return { rows: [{ sequence: 4 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      },
      {
        jobsTable: "catalog_source_observation_bulk_review_jobs",
        eventsTable: "catalog_source_observation_bulk_review_job_events",
        workUnitsTable: "catalog_source_observation_bulk_review_work_units",
      },
      { workflowName: "catalog.source-observation-bulk-review" },
    );

    await expect(
      store.reconcileTerminalParent({
        jobId: "job_1",
        parentProgress: { completed: 2, total: 2, phase: "completed" },
        parentResult: { requested: 2, outcomes: [{ observationId: "obs_1" }, { observationId: "obs_2" }] },
        completeJob: true,
      }),
    ).resolves.toBe(true);

    expect(calls.some((call) => call.sql.includes("claim_token"))).toBe(false);
    expect(snapshots[0]).toContain('"status":"completed"');
    expect(snapshots[0]).toContain('"phase":"completed"');
  });
});

function prefixedJobRow(overrides: Record<string, unknown> = {}) {
  return {
    job_job_id: "job_1",
    job_job_kind: "promote",
    job_status: "running",
    job_payload: { action: "promote" },
    job_progress: { completed: 0, total: 1 },
    job_result: null,
    job_error_message: null,
    job_event_context: { tenantId: "tnt_1" },
    job_claim_owner_id: null,
    job_claimed_until: null,
    job_created_at: "2026-05-31T00:00:00.000Z",
    job_started_at: "2026-05-31T00:00:01.000Z",
    job_completed_at: null,
    job_updated_at: "2026-05-31T00:00:01.000Z",
    ...overrides,
  };
}

function prefixedUnitRow(overrides: Record<string, unknown> = {}) {
  return {
    unit_job_id: "job_1",
    unit_unit_id: "obs_1",
    unit_unit_kind: "promote",
    unit_state: "running",
    unit_payload: { observationId: "obs_1" },
    unit_result: null,
    unit_error_message: null,
    unit_claim_owner_id: "worker-a:lane-1",
    unit_claim_token: "token-a",
    unit_claimed_until: "2026-05-31T00:01:00.000Z",
    unit_attempt_count: 1,
    unit_created_at: "2026-05-31T00:00:00.000Z",
    unit_updated_at: "2026-05-31T00:00:01.000Z",
    unit_completed_at: null,
    ...overrides,
  };
}
