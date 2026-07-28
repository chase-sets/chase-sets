import { describe, expect, it, vi } from "vitest";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import { createSourceObservationRuntime } from "./runtime";
import {
  context,
  createBulkReviewJobHarness,
  createMutableProfileVersionReader,
  currentTcgdexProfileVersion,
  providerProfileVersionForProvider,
  sourceObservationDetailRow,
} from "./seeding/runtime-test-harness";

describe("source observation runtime: bulk review jobs", () => {
  it("processes persisted bulk review jobs through durable work-unit turns", async () => {
    const harness = createBulkReviewJobHarness(30);
    const recordBulkReviewWorkUnit = vi.fn();
    const services = createSourceObservationRuntime(
      {
        ...harness.deps,
        sourceObservationTelemetry: {
          recordBulkReviewWorkUnit,
        },
      } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(
      services.processNextBulkReviewJob({
        claimOwnerId: "worker-1",
        claimTtlMs: 120_000,
      }),
    ).resolves.toBe(1);

    expect(harness.job.status).toBe("running");
    expect(harness.job.progress).toMatchObject({
      phase: "processing",
      completed: 1,
      total: 30,
    });
    expect(harness.job.result?.outcomes).toHaveLength(1);
    expect(harness.appendedEvents).toHaveLength(1);

    await expect(
      services.processNextBulkReviewJob({
        claimOwnerId: "worker-2",
        claimTtlMs: 120_000,
      }),
    ).resolves.toBe(1);

    expect(harness.job.status).toBe("running");
    expect(harness.job.progress).toMatchObject({
      phase: "processing",
      completed: 2,
      total: 30,
    });
    expect(harness.job.result).toMatchObject({
      requested: 30,
      rejected: 2,
      skipped: 0,
      failed: 0,
    });
    expect(harness.job.result?.outcomes).toHaveLength(2);
    expect(harness.appendedEvents).toHaveLength(2);
    expect(recordBulkReviewWorkUnit).toHaveBeenCalledTimes(2);
    expect(recordBulkReviewWorkUnit.mock.calls).toEqual([
      [{ jobKind: "reject", result: "completed" }],
      [{ jobKind: "reject", result: "completed" }],
    ]);
  });

  it("reconciles terminal bulk review jobs whose stale parent total is no longer reachable", async () => {
    const harness = createBulkReviewJobHarness(2, {
      status: "running",
      progressTotal: 5,
      carriedOutcomes: [
        { observationId: "obs_carried_1", status: "rejected" },
        { observationId: "obs_carried_2", status: "rejected" },
      ],
      terminalWorkUnits: true,
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(
      services.processNextBulkReviewJob({
        claimOwnerId: "worker-reconcile",
        claimTtlMs: 120_000,
      }),
    ).resolves.toBe(1);

    expect(harness.job.status).toBe("completed");
    expect(harness.job.progress).toMatchObject({
      phase: "completed",
      completed: 4,
      total: 4,
    });
    expect(harness.job.result).toMatchObject({
      requested: 4,
      rejected: 4,
      skipped: 0,
      failed: 0,
    });
    expect(harness.job.result?.outcomes).toHaveLength(4);
    expect(harness.appendedEvents).toEqual([]);
  });

  it("snapshots selected reapply work units from each observation provider instead of the default provider", async () => {
    const insertedWorkUnits: Array<Readonly<{ unitId: string; payload: Record<string, unknown> }>> = [];
    const altdexProfile = providerProfileVersionForProvider("altdex", "altdex-pokemon-tcg", "2026.06.10");
    const altdexObservation = sourceObservationDetailRow({
      observation_id: "obs_altdex",
      provider_key: "altdex",
      external_key: "product:610001",
      source_url: "https://altdex.example/products/610001",
      source_profile_key: "altdex-pokemon-tcg",
      source_profile_version: "2026.06.10",
      source_mapping_fingerprint: "altdex-fingerprint",
      status: "promoted",
      promoted_catalog_item_id: "cat_altdex",
    });
    const deps = {
      db: {
        query: async <T>(sql: string, values: readonly unknown[] = []) => {
          if (sql.includes("FROM catalog_source_observations") && sql.includes("WHERE observation_id = $1")) {
            return { rowCount: 1, rows: [altdexObservation] as T[] };
          }

          if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_jobs")) {
            const payload = JSON.parse(String(values[2])) as Record<string, unknown>;
            return {
              rowCount: 1,
              rows: [
                {
                  job_id: values[0],
                  job_kind: values[1],
                  payload,
                  event_context: JSON.parse(String(values[4])),
                  status: "queued",
                  progress: JSON.parse(String(values[3])),
                  result: null,
                  error_message: null,
                  claim_owner_id: null,
                  claimed_until: null,
                  created_at: "2026-05-28T00:00:00.000Z",
                  started_at: null,
                  completed_at: null,
                  updated_at: "2026-05-28T00:00:00.000Z",
                },
              ] as T[],
            };
          }

          if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_work_units")) {
            const units = JSON.parse(String(values[1])) as Array<{
              unit_id: string;
              payload: Record<string, unknown>;
            }>;
            insertedWorkUnits.push(...units.map((unit) => ({ unitId: unit.unit_id, payload: unit.payload })));
            return { rowCount: units.length, rows: [] as T[] };
          }

          if (sql.includes("INSERT INTO catalog_source_observation_bulk_review_job_events")) {
            return { rowCount: 1, rows: [{ sequence: 1 }] as T[] };
          }

          if (sql.includes("SELECT pg_notify")) {
            return { rowCount: 1, rows: [] as T[] };
          }

          return { rowCount: 0, rows: [] as T[] };
        },
      },
      eventStore: {
        readStream: async () => [],
        appendToStream: async () => [],
        readAll: async () => [],
      },
      checkpointStore: {
        loadCheckpoint: async () => "0",
        saveCheckpoint: async () => undefined,
      },
    } as unknown as CatalogRuntimeDeps;
    const services = createSourceObservationRuntime(
      deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createMutableProfileVersionReader([currentTcgdexProfileVersion(), altdexProfile]),
    );

    await services.enqueueBulkReviewJob({
      action: "reapply",
      observationIds: ["obs_altdex"],
      context,
    });

    expect(insertedWorkUnits).toHaveLength(1);
    expect(insertedWorkUnits[0]?.payload).toMatchObject({
      observationId: "obs_altdex",
      reapplyProfileMode: "current-active-profile",
      profileSnapshot: {
        providerKey: "altdex",
        profileKey: "altdex-pokemon-tcg",
      },
    });
  });
});
