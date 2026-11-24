import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { EVENT_STORE_MAX_PAYLOAD_BYTES } from "@chase-sets/event-core-postgres";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { SourceObservationListRow } from "../read-model/queries";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import type { ProviderAdapter } from "./provider-adapters/provider-adapter";
import { staticCatalogProviderIntegrationProfileVersions } from "./source-observation-runtime-contracts";
import { buildCatalogMergeCandidatesFromObservations } from "./promotion/catalog-merge-candidate-matcher";
import { catalogMergeCandidateStreamId, sourceObservationStreamId } from "./source-observation-stream-identity";
import { SOURCE_OBSERVATION_INLINE_EVENT_TARGET_BYTES } from "../domain/source-observation-payload-chunks";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import { reconcileProductionCatalogCompletion } from "../../completion-report/domain/reconcile";
import { completeManifest } from "../../completion-report/domain/__fixtures__/manifest";
import {
  CatalogIntegrationRolloutControlError,
  createCatalogIntegrationRolloutControlPolicy,
  type CatalogIntegrationRolloutControlPolicy,
} from "./governance/catalog-integration-rollout-controls";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
} from "./provider-integration-profiles";
import { YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY } from "./provider-adapters/ygojson";
import { evolveSourceObservation, initialSourceObservationState, type SourceObservationEvent } from "../domain/domain";
import { createSourceObservationRuntime } from "./runtime";
import { createSourceObservationProviderImportRuntime } from "./source-observation-provider-import-runtime";
import { sourceObservationImportFailureDiagnostic } from "./source-observation-import-failure-diagnostic";
import { createSourceObservationMergeCandidateRuntime } from "./source-observation-merge-candidate-runtime";
import { listCatalogProviderIntegrationOptionsFromProfiles } from "./providers/provider-option-query-resolver";
import * as providerOptionQueries from "./providers/provider-option-queries";
import {
  context,
  createActiveTcgplayerProfileVersions,
  createIntegrationJobClaimHandoffHarness,
  createIntegrationJobDedupeHarness,
  createMutableProfileVersionReader,
  currentTcgdexProfileVersion,
  integrationJobRow,
  tcgdexProfileSnapshot,
  tcgdexProfileVersion,
  withoutRolloutUnitKey,
} from "./seeding/runtime-test-harness";

const BASE_SET_SCOPE_RECORD_ID = "scope_pokemon_base_set";

function acceptedScopeMappingRow(
  overrides: Readonly<{
    providerKey: string;
    unitKey: string;
    productLineId?: string | null;
    seriesId?: string | null;
    setId?: string | null;
    setName?: string | null;
  }>,
): ProviderScopeMappingRow {
  return {
    mapping_id: `mapping_${overrides.providerKey}_${overrides.unitKey}`,
    scope_record_id: BASE_SET_SCOPE_RECORD_ID,
    provider_key: overrides.providerKey,
    unit_key: overrides.unitKey,
    product_line_id: overrides.productLineId ?? null,
    series_id: overrides.seriesId ?? null,
    set_id: overrides.setId ?? null,
    set_name: overrides.setName ?? null,
    language_coordinates: null,
    confidence: "manual",
    review_status: "accepted",
    provenance: {},
    evidence: {},
    last_actor: null,
    last_reason: null,
    policy_version: "v1",
    proposed_at: "2026-07-01T00:00:00.000Z",
    reviewed_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
}

function tcgdexBaseSetMappingRow(): Record<string, unknown> {
  return acceptedScopeMappingRow({
    providerKey: "tcgdex",
    unitKey: "tcgdex:pokemon:single-card:source-observation-import",
    setId: "base1",
    seriesId: "base",
  });
}

function createClaimExhaustionHarness() {
  const harness = createIntegrationJobDedupeHarness({ acceptedScopeMappings: [tcgdexBaseSetMappingRow()] });
  const coverage: Record<string, unknown> = {};
  let beforeNextCoverageUpsert: (() => Promise<void>) | undefined;
  const scope = {
    scopeVersion: "catalog-sync-scope-v2",
    productDomain: "pokemon",
    productForm: "single-card",
    languageCode: "en",
    reference: { kind: "expansion", scopeRecordId: BASE_SET_SCOPE_RECORD_ID },
    providerParticipation: { selectedUnitKeys: ["tcgdex:pokemon:single-card:source-observation-import"] },
  } as const;
  const exhaustedAt = "2026-08-03T00:00:00.000Z";
  const services = createSourceObservationRuntime(
    {
      ...harness.deps,
      db: {
        query: async <T>(sql: string, values: readonly unknown[] = []) => {
          const result = (rows: Record<string, unknown>[]) => ({ rowCount: rows.length, rows: rows as T[] });
          if (
            sql.includes("FROM catalog_source_observation_integration_durable_jobs") &&
            sql.includes("status IN ('queued', 'running')")
          ) {
            const kinds = values[0] as string[];
            return result(
              harness.insertedJobs.filter((job) => job.status === "queued" && kinds.includes(String(job.job_kind))),
            );
          }
          if (
            sql.includes("WITH exhausted AS") &&
            sql.includes("catalog_source_observation_integration_durable_jobs")
          ) {
            const [kinds, maxAttempts] = values as [string[], number];
            const exhausted = harness.insertedJobs.filter(
              (job) =>
                kinds.includes(String(job.job_kind)) &&
                job.status === "running" &&
                String(job.claimed_until) < exhaustedAt &&
                String(job.next_eligible_at) <= exhaustedAt &&
                Number(job.attempt_count) >= maxAttempts,
            );
            expect(maxAttempts).toBe(10);
            for (const job of exhausted) {
              Object.assign(job, {
                status: "failed",
                claim_owner_id: null,
                claimed_until: null,
                error_message: job.error_message ?? "Durable job retry attempts exhausted.",
                completed_at: exhaustedAt,
                updated_at: exhaustedAt,
              });
            }
            return result(exhausted);
          }
          if (sql.includes("INSERT INTO catalog_scope_sync_state")) {
            const beforeUpsert = beforeNextCoverageUpsert;
            beforeNextCoverageUpsert = undefined;
            await beforeUpsert?.();
            Object.assign(coverage, {
              scope_key: values[0],
              provider_key: values[1],
              unit_key: values[2],
              state: values[12],
              last_sync_run_id: values[13],
              last_job_id: values[14],
              last_operator_status: values[15],
              error_message: values[20],
              last_completed_at: values[22],
              updated_at: values[23],
            });
            return result([]);
          }
          if (sql.includes("UPDATE catalog_scope_sync_state")) {
            expect(sql).toContain("WHERE last_job_id = $1");
            if (coverage.last_job_id !== values[0]) return result([]);
            Object.assign(coverage, {
              state: values[1],
              last_operator_status: "failed",
              error_message: values[2],
              last_completed_at: values[8],
              updated_at: values[9],
            });
            return { rowCount: 1, rows: [] as T[] };
          }
          if (sql.includes("FROM catalog_scope_sync_state")) {
            return result(coverage.scope_key === values[0] ? [coverage] : []);
          }
          return harness.deps.db.query<T>(sql, values);
        },
      },
    },
    {} as CatalogItemServices,
    {} as ReferenceDataServices,
    createMutableProfileVersionReader([currentTcgdexProfileVersion()]),
  );
  return {
    services,
    harness,
    coverage,
    scope,
    exhaustedAt,
    beforeCoverageUpsert(callback: () => Promise<void>) {
      beforeNextCoverageUpsert = callback;
    },
    markLastClaimExpired(jobId: string | null) {
      const job = harness.insertedJobs.find((candidate) => candidate.job_id === jobId);
      if (!job) throw new Error("Missing import job in claim exhaustion fixture.");
      Object.assign(job, {
        status: "running",
        claim_owner_id: "worker-expired",
        claimed_until: "2026-08-02T00:00:00.000Z",
        attempt_count: 10,
      });
    },
  };
}

describe("source observation runtime: import claim exhaustion", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider requests are not allowed in this test."));
  });
  afterEach(() => {
    const fetch = vi.mocked(globalThis.fetch);
    try {
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it.each(["new child", "reused standalone import"] as const)(
    "records a linked %s as a terminal failure when its claims are exhausted",
    async (link) => {
      const { services, coverage, scope, exhaustedAt, markLastClaimExpired } = createClaimExhaustionHarness();
      Object.assign(coverage, { observed_count: 12, changed_count: 2, failed_count: 0 });
      let standalone;
      if (link === "reused standalone import") {
        const preview = await services.previewCatalogSyncScope({ scope, context });
        const childScope = preview.units.find((unit) => unit.selected)?.childExecutionScope;
        if (!childScope) throw new Error("Missing selected provider scope in claim exhaustion fixture.");
        standalone = await services.enqueueIntegrationJob({ action: "import", scope: childScope, context });
      }
      const run = await services.enqueueCatalogSyncRun({ scope, context });
      const childId = run.childJobs[0].childJobId;
      expect(childId).toBeTruthy();
      if (standalone) expect(childId).toBe(standalone.jobId);
      expect(run.childJobs[0].syncRunLinkState).toBe(
        standalone ? "reused-active-child-job" : "attached-to-child-payload",
      );
      expect(coverage).toMatchObject({
        last_job_id: childId,
        state: "pending",
        last_operator_status: standalone ? "reused-active-job" : "queued",
      });
      markLastClaimExpired(childId);

      await expect(
        services.processNextIntegrationJob({ claimOwnerId: "worker-next", claimTtlMs: 120_000 }),
      ).resolves.toBe(0);
      const errorMessage = "Durable job retry attempts exhausted.";
      await expect(services.getCatalogSyncRun({ syncRunId: run.syncRunId, context })).resolves.toMatchObject({
        status: "failed",
        progress: { childJobs: { total: 1, failed: 1, queued: 0, running: 0 } },
        childJobs: [{ childJobId: childId, status: "failed", job: { errorMessage } }],
      });
      const state = await services.getCatalogScopeSyncState({ scope, context });
      expect(state).toMatchObject([
        {
          state: "failed",
          lastOperatorStatus: "failed",
          lastSyncRunId: run.syncRunId,
          lastJobId: childId,
          errorMessage,
          lastCompletedAt: exhaustedAt,
          observedCount: 12,
          changedCount: 2,
          failedCount: 0,
        },
      ]);
      const unit = { providerKey: state[0].providerKey, unitKey: state[0].unitKey };
      const expectedUnit = { ...unit, scopeRecordId: BASE_SET_SCOPE_RECORD_ID };
      const manifest = completeManifest();
      const report = reconcileProductionCatalogCompletion(
        {
          ...manifest,
          providerUnits: [{ ...unit, productionClass: "production", lifecycle: "active", active: true }],
          scopes: [{ scopeRecordId: BASE_SET_SCOPE_RECORD_ID, eligible: true, acceptedMappings: [unit] }],
          expectedUnits: [expectedUnit],
          observedUnits: [
            {
              ...expectedUnit,
              state: state[0].state,
              lastCompletedAt: state[0].lastCompletedAt,
              syncRunId: state[0].lastSyncRunId,
              observedCount: Number(state[0].observedCount),
              changedCount: Number(state[0].changedCount),
              failedCount: Number(state[0].failedCount),
            },
          ],
          providerUsage: [],
        },
        { generatedAt: exhaustedAt },
      );
      expect(report.providerUnitStates).toEqual({ failed: 1 });
      expect(report.blockers.map((blocker) => blocker.code)).toContain("failed-job");
      expect(report.blockers.map((blocker) => blocker.code)).not.toContain("non-terminal-unit");
      expect(report.result).toBe("incomplete");
    },
  );

  it.each([false, true])("retains exhaustion after the fan-out snapshot (existing link: %s)", async (existingLink) => {
    const { services, coverage, scope, exhaustedAt, beforeCoverageUpsert, markLastClaimExpired } =
      createClaimExhaustionHarness();
    const preview = await services.previewCatalogSyncScope({ scope, context });
    const childScope = preview.units.find((unit) => unit.selected)?.childExecutionScope;
    if (!childScope) throw new Error("Missing selected provider scope in claim exhaustion fixture.");
    const child = await services.enqueueIntegrationJob({ action: "import", scope: childScope, context });
    const errorMessage = "Durable job retry attempts exhausted.";
    if (existingLink) Object.assign(coverage, { last_job_id: child.jobId, state: "pending" });

    beforeCoverageUpsert(async () => {
      markLastClaimExpired(child.jobId);
      await expect(
        services.processNextIntegrationJob({ claimOwnerId: "worker-next", claimTtlMs: 120_000 }),
      ).resolves.toBe(0);
      expect(coverage.state).toBe(existingLink ? "failed" : undefined);
    });

    const run = await services.enqueueCatalogSyncRun({ scope, context });
    expect(run.childJobs).toMatchObject([{ childJobId: child.jobId, syncRunLinkState: "reused-active-child-job" }]);
    await expect(services.getCatalogSyncRun({ syncRunId: run.syncRunId, context })).resolves.toMatchObject({
      status: "failed",
      childJobs: [{ childJobId: child.jobId, status: "failed", job: { errorMessage } }],
    });
    expect(coverage).toMatchObject({
      last_job_id: child.jobId,
      last_sync_run_id: run.syncRunId,
      state: "failed",
      last_operator_status: "failed",
      last_completed_at: exhaustedAt,
      error_message: errorMessage,
    });
  });

  it("leaves coverage unchanged when an unlinked or superseded import exhausts its claims", async () => {
    const { services, harness, coverage, scope, markLastClaimExpired } = createClaimExhaustionHarness();
    const run = await services.enqueueCatalogSyncRun({ scope, context });
    const childId = run.childJobs[0].childJobId;
    markLastClaimExpired(childId);
    coverage.last_job_id = "job_newer";
    const before = { ...coverage };
    const unlinked = integrationJobRow({ jobId: "job_unlinked", action: "import", scope: {}, eventContext: context });
    harness.insertedJobs.push(unlinked);
    markLastClaimExpired(unlinked.job_id);

    await expect(
      services.processNextIntegrationJob({ claimOwnerId: "worker-next", claimTtlMs: 120_000 }),
    ).resolves.toBe(0);
    expect(harness.insertedJobs.filter((job) => job.status === "failed").map((job) => job.job_id)).toEqual([
      childId,
      unlinked.job_id,
    ]);
    expect(coverage).toEqual(before);
  });
});

describe("source observation runtime: provider integration jobs", () => {
  it("reuses an active provider integration job with the same actor action and scope", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: integrationJobRow({
        jobId: "job_existing",
        action: "import",
        scope: { provider: "tcgdex", language: "en" },
        profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
        eventContext: context,
      }),
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createActiveTcgplayerProfileVersions({ profileKey: "mtg-single-card-product-sku" }),
    );

    const job = await services.enqueueIntegrationJob({
      action: "import",
      scope: { provider: "tcgdex", language: "en", seriesId: undefined, setId: undefined },
      context,
    });

    expect(job.jobId).toBe("job_existing");
    expect(harness.insertedJobs).toEqual([]);
    expect(harness.activeLookupValues[0]).toEqual(["import"]);
  });

  it("does not reuse a stale active provider integration job for a fresh import command", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T00:20:00.000Z"));
    try {
      const harness = createIntegrationJobDedupeHarness({
        existingJob: {
          ...integrationJobRow({
            jobId: "job_stale_existing",
            action: "import",
            scope: { provider: "tcgdex", language: "en" },
            profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
            eventContext: context,
            progress: {
              phase: "processing",
              completed: 0,
              total: 1,
              currentName: "Base Set",
              status: null,
            },
          }),
          status: "running",
          claim_owner_id: "worker-stopped",
          claimed_until: "2026-05-28T00:10:00.000Z",
        },
      });
      const services = createSourceObservationRuntime(
        harness.deps,
        {} as CatalogItemServices,
        {} as ReferenceDataServices,
      );

      const job = await services.enqueueIntegrationJob({
        action: "import",
        scope: { provider: "tcgdex", language: "en", seriesId: undefined, setId: undefined },
        context,
      });

      expect(job.jobId).not.toBe("job_stale_existing");
      expect(job.status).toBe("queued");
      expect(harness.insertedJobs).toHaveLength(1);
      expect(harness.insertedJobs[0]).toMatchObject({
        job_kind: "import",
        payload: expect.objectContaining({
          action: "import",
          scope: {
            provider: "tcgdex",
            language: "en",
          },
        }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects production import jobs for explicitly selected inactive provider profile versions before enqueue", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createActiveTcgplayerProfileVersions({ profileKey: "mtg-single-card-product-sku" }),
    );

    await expect(
      services.enqueueIntegrationJob({
        action: "import",
        scope: {
          provider: "tcgplayer",
          profileKey: "pokemon-single-card-product-sku",
          ingestionUnitKey: "tcgplayer:pokemon:single-card:source-observation-import",
          productLineId: "3",
          setName: "Prismatic Evolutions",
        },
        context,
      }),
    ).rejects.toThrow("TCGplayer server transport is retired; use the browser handoff.");
    expect(harness.insertedJobs).toEqual([]);
  });

  it("does not reuse active provider integration jobs from a different account context", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: integrationJobRow({
        jobId: "job_other_account",
        action: "import",
        scope: { provider: "tcgdex", language: "en" },
        profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
        eventContext: {
          ...context,
          audit: {
            ...context.audit,
            forAccountId: "acc_other" as never,
          },
        },
      }),
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.enqueueIntegrationJob({
      action: "import",
      scope: { provider: "tcgdex", language: "en", seriesId: undefined, setId: undefined },
      context,
    });

    expect(job.jobId).not.toBe("job_other_account");
    expect(job.profileSnapshot).toMatchObject({
      providerKey: "tcgdex",
      profileKey: "pokemon-tcg",
      profileVersion: "2026.06.03",
      ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
      lifecycle: "active",
      connectorKind: "tcgdex-json",
      connectorSourceVersion: null,
    });
    expect(job.consistency.workUnitClaimPolicy).toBe("leased-job-turns");
    expect(job.profileSnapshot?.sourceMappingFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.insertedJobs).toHaveLength(1);
  });

  it("records a durable status event when enqueueing a provider integration job", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.enqueueIntegrationJob({
      action: "import",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
      context,
    });

    expect(harness.jobEvents).toEqual([
      {
        jobKind: "integration",
        jobId: job.jobId,
        snapshot: expect.objectContaining({
          jobId: job.jobId,
          action: "import",
          status: "queued",
        }),
      },
    ]);
  });

  it("enqueues a parent Catalog sync run and fans out selected provider child import jobs", async () => {
    const harness = createIntegrationJobDedupeHarness({
      acceptedScopeMappings: [tcgdexBaseSetMappingRow()],
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createMutableProfileVersionReader([currentTcgdexProfileVersion()]),
    );

    const run = await services.enqueueCatalogSyncRun({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        reference: { kind: "expansion", scopeRecordId: BASE_SET_SCOPE_RECORD_ID },
        providerParticipation: {
          selectedUnitKeys: ["tcgdex:pokemon:single-card:source-observation-import"],
        },
      },
      context,
    });

    expect(run).toMatchObject({
      status: "queued",
      progress: {
        childJobs: {
          total: 1,
          queued: 1,
        },
      },
      selectedUnits: [
        expect.objectContaining({
          unitKey: "tcgdex:pokemon:single-card:source-observation-import",
          profileVersion: "2026.06.03",
          childExecutionScope: expect.objectContaining({
            provider: "tcgdex",
            profileKey: "pokemon-tcg",
            ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
            language: "en",
            seriesId: "base",
            setId: "base1",
          }),
        }),
      ],
      childJobs: [
        expect.objectContaining({
          unitKey: "tcgdex:pokemon:single-card:source-observation-import",
          syncRunLinkState: "attached-to-child-payload",
          status: "queued",
          job: expect.objectContaining({
            syncRunId: run.syncRunId,
            action: "import",
          }),
        }),
      ],
      consistency: {
        duplicateSubmissionPolicy: "reuse-active-sync-run",
        childScopePolicy: "deterministic-from-provider-participation-preview",
        profileSnapshotPolicy: "selected-active-provider-units-snapshotted-at-enqueue",
        childRetryResumeCancelPolicy: "delegated-to-provider-import-jobs",
        partialFailurePolicy: "visible-per-provider-child-job",
      },
    });

    const parentRow = harness.insertedJobs.find((job) => job.job_id === run.syncRunId);
    const childRow = harness.insertedJobs.find(
      (job) => job.job_kind === "import" && (job.payload as { syncRunId?: string | null }).syncRunId === run.syncRunId,
    );
    expect(parentRow).toMatchObject({
      job_kind: "catalog-sync-scope",
      status: "completed",
      result: {
        childJobs: [
          expect.objectContaining({
            childJobId: childRow?.job_id,
            syncRunLinkState: "attached-to-child-payload",
          }),
        ],
      },
    });
    expect(childRow).toBeTruthy();

    await expect(services.getCatalogSyncRun({ syncRunId: run.syncRunId, context })).resolves.toMatchObject({
      syncRunId: run.syncRunId,
      childJobs: [
        expect.objectContaining({
          childJobId: childRow?.job_id,
        }),
      ],
    });
  });

  it("keeps parent Catalog sync run partial-failure visibility when a child provider job cannot enqueue", async () => {
    const harness = createIntegrationJobDedupeHarness({
      acceptedScopeMappings: [tcgdexBaseSetMappingRow()],
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      createMutableProfileVersionReader([currentTcgdexProfileVersion()]),
      createCatalogIntegrationRolloutControlPolicy({ disabledImports: ["tcgdex"] }),
    );

    const run = await services.enqueueCatalogSyncRun({
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        reference: { kind: "expansion", scopeRecordId: BASE_SET_SCOPE_RECORD_ID },
        providerParticipation: {
          selectedUnitKeys: ["tcgdex:pokemon:single-card:source-observation-import"],
        },
      },
      context,
    });

    expect(run).toMatchObject({
      status: "failed",
      progress: {
        childJobs: {
          total: 1,
          failed: 1,
        },
      },
      childJobs: [
        expect.objectContaining({
          childJobId: null,
          syncRunLinkState: "child-enqueue-failed",
          status: "failed",
          errorMessage: "Catalog integration imports are disabled for the configured provider scope.",
        }),
      ],
    });
    expect(harness.insertedJobs.filter((job) => job.job_kind === "import")).toEqual([]);
    expect(harness.insertedJobs.find((job) => job.job_id === run.syncRunId)).toMatchObject({
      job_kind: "catalog-sync-scope",
      status: "failed",
      result: {
        childJobs: [
          expect.objectContaining({
            syncRunLinkState: "child-enqueue-failed",
            childJobId: null,
          }),
        ],
      },
    });
  });

  it("snapshots reapply profile mode on integration jobs and work units", async () => {
    const harness = createIntegrationJobDedupeHarness({
      reapplyObservationIds: ["obs_promoted_1", "obs_promoted_2"],
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.enqueueIntegrationJob({
      action: "reapply",
      scope: { provider: "tcgdex", language: "en", setId: "base1" },
      context,
    });

    expect(job).toMatchObject({
      action: "reapply",
      reapplyProfileMode: "current-active-profile",
      profileSnapshot: {
        providerKey: "tcgdex",
        profileVersion: "2026.06.03",
        ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
        connectorKind: "tcgdex-json",
        connectorSourceVersion: null,
      },
      operatorStatus: "queued",
      consistency: {
        duplicateSubmissionPolicy: "reuse-active-job",
        profileSnapshotPolicy: "snapshotted-at-enqueue",
        retryResumePolicy: "skip-completed-outcomes",
        partialFailurePolicy: "mixed-outcomes",
        workUnitClaimPolicy: "leased-work-units",
      },
      progress: {
        total: 2,
      },
    });
    expect(harness.insertedWorkUnits.map((unit) => unit.payload)).toEqual([
      expect.objectContaining({
        observationId: "obs_promoted_1",
        reapplyProfileMode: "current-active-profile",
        profileSnapshot: expect.objectContaining({
          providerKey: "tcgdex",
          profileVersion: "2026.06.03",
          ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
        }),
      }),
      expect.objectContaining({
        observationId: "obs_promoted_2",
        reapplyProfileMode: "current-active-profile",
        profileSnapshot: expect.objectContaining({
          providerKey: "tcgdex",
          profileVersion: "2026.06.03",
          ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
        }),
      }),
    ]);
  });

  it("lists active provider connector options for Catalog integration discovery", async () => {
    const services = createSourceObservationRuntime(
      { db: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const providers = await services.listIntegrationOptions({
      providerKey: "tcgdex",
      queryKind: "providers",
    });

    expect(providers).toEqual([
      expect.objectContaining({
        providerKey: "lorcanajson",
        value: "lorcanajson",
        label: "LorcanaJSON",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "lorcanajson-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "lorcanajson",
        value: "lorcanajson",
        label: "LorcanaJSON Set Reference",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "lorcanajson-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "lorcast",
        value: "lorcast",
        label: "Lorcast",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "lorcast-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "lorcast",
        value: "lorcast",
        label: "Lorcast Set Reference",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "lorcast-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "mtgjson",
        value: "mtgjson",
        label: "MTGJSON",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "mtgjson-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "mtgjson",
        value: "mtgjson",
        label: "MTGJSON Set Reference",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "mtgjson-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        value: "scrydex",
        label: "Scrydex Lorcana Cards",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "scrydex-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        value: "scrydex",
        label: "Scrydex Lorcana Set Reference",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "scrydex-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        value: "scrydex",
        label: "Scrydex One Piece Cards",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "scrydex-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        value: "scrydex",
        label: "Scrydex One Piece Set Reference",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "scrydex-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        value: "scrydex",
        label: "Scrydex One Piece Sealed Products",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "scrydex-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "scryfall",
        value: "scryfall",
        label: "Scryfall",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "scryfall-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "tcgdex",
        value: "tcgdex",
        label: "TCGdex",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "tcgdex-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "ygojson",
        value: "ygojson",
        label: "YGOJSON",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "ygojson-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "ygojson",
        value: "ygojson",
        label: "YGOJSON Sealed Products",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "ygojson-json",
        }),
      }),
      expect.objectContaining({
        providerKey: "ygoprodeck",
        value: "ygoprodeck",
        label: "YGOPRODeck",
        metadata: expect.objectContaining({
          status: "active",
          connectorKind: "ygoprodeck-json",
        }),
      }),
    ]);
  });

  it("uses newly activated persisted profile versions for subsequent option queries", async () => {
    const profileVersions = createMutableProfileVersionReader([
      currentTcgdexProfileVersion(),
      tcgdexProfileVersion({
        profileVersion: "2026.06.04",
        lifecycle: "test",
        active: false,
        displayName: "TCGdex Candidate",
      }),
    ]);
    const services = createSourceObservationRuntime(
      { db: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      profileVersions,
    );

    await expect(
      services.listIntegrationOptions({
        providerKey: "tcgdex",
        queryKind: "providers",
      }),
    ).resolves.toEqual([expect.objectContaining({ providerKey: "tcgdex", label: "TCGdex" })]);

    profileVersions.activate("tcgdex", "2026.06.04");

    await expect(
      services.listIntegrationOptions({
        providerKey: "tcgdex",
        queryKind: "providers",
      }),
    ).resolves.toEqual([expect.objectContaining({ providerKey: "tcgdex", label: "TCGdex Candidate" })]);
  });

  it("does not run option queries against inactive provider profile versions", async () => {
    const services = createSourceObservationRuntime(
      { db: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(
      services.listIntegrationOptions({
        providerKey: "tcgplayer",
        queryKind: "languages",
      }),
    ).rejects.toThrow("Unsupported Catalog integration provider: tcgplayer.");
  });

  it("lists MTGJSON set and card options through the public JSON adapter", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mtgjsonFetch() as typeof globalThis.fetch;
    const services = createSourceObservationRuntime(
      { db: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    try {
      const sets = await services.listIntegrationOptions({
        providerKey: "mtgjson",
        queryKind: "sets",
        ingestionUnitKey: "mtgjson:mtg:set:reference-data",
      });
      const cards = await services.listIntegrationOptions({
        providerKey: "mtgjson",
        queryKind: "cards",
        ingestionUnitKey: "mtgjson:mtg:single-card:reference-data",
        parentValue: "TSP",
      });

      expect(sets).toEqual([
        expect.objectContaining({
          providerKey: "mtgjson",
          queryKind: "sets",
          value: "TSP",
          label: "Time Spiral",
          metadata: expect.objectContaining({ totalSetSize: 301, mtgjsonVersion: "5.3.0+20260605" }),
        }),
      ]);
      expect(cards).toEqual([
        expect.objectContaining({
          providerKey: "mtgjson",
          queryKind: "cards",
          value: "13fd9d47-9aa7-5f7c-8f47-fury-sliver",
          label: "Fury Sliver #157",
          parentValue: "TSP",
          metadata: expect.objectContaining({
            collectorNumber: "157",
            scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
          }),
        }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lists Lorcast set and card options through the public API adapter", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = lorcastFetch() as typeof globalThis.fetch;
    const services = createSourceObservationRuntime(
      { db: {} } as CatalogRuntimeDeps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    try {
      const sets = await services.listIntegrationOptions({
        providerKey: "lorcast",
        queryKind: "sets",
        ingestionUnitKey: "lorcast:lorcana:set:reference-data",
      });
      const cards = await services.listIntegrationOptions({
        providerKey: "lorcast",
        queryKind: "cards",
        ingestionUnitKey: "lorcast:lorcana:single-card:reference-data",
        parentValue: "1",
      });

      expect(sets).toEqual([
        expect.objectContaining({
          providerKey: "lorcast",
          queryKind: "sets",
          value: "1",
          label: "The First Chapter",
          metadata: expect.objectContaining({ cacheGuidance: "cache-at-least-24h" }),
        }),
      ]);
      expect(cards).toEqual([
        expect.objectContaining({
          providerKey: "lorcast",
          queryKind: "cards",
          value: "crd_elsa_snow_queen_1_041",
          label: "Elsa - Snow Queen #41",
          parentValue: "1",
          imageUrl: "https://cards.lorcast.io/card/digital/large/crd_elsa_snow_queen_1_041.avif",
          metadata: expect.objectContaining({
            cardNumber: "41",
            tcgplayerProductId: "1005010",
          }),
        }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries provider integration jobs by preserving successful outcomes and pruning failed outcomes", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: {
        ...integrationJobRow({
          jobId: "job_retry",
          action: "import",
          scope: { provider: "tcgdex", language: "en", seriesId: "base" },
          profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
          eventContext: context,
        }),
        status: "completed",
        progress: {
          phase: "completed",
          completed: 2,
          total: 2,
          currentName: null,
          status: "failed",
        },
        result: {
          requested: 2,
          imported: 1,
          observed: 102,
          reapplied: 0,
          skipped: 0,
          failed: 1,
          outcomes: [
            {
              providerKey: "tcgdex",
              languageCode: "en",
              expansionId: "base1",
              status: "imported",
              observed: 102,
              reapplied: 0,
              reason: null,
            },
            {
              providerKey: "tcgdex",
              languageCode: "en",
              expansionId: "base2",
              status: "failed",
              observed: 0,
              reapplied: 0,
              reason: "Provider timeout.",
            },
          ],
        },
        completed_at: "2026-05-28T00:00:05.000Z",
      },
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.retryIntegrationJob({ jobId: "job_retry", context });

    expect(job).toMatchObject({
      jobId: "job_retry",
      status: "queued",
      progress: {
        phase: "queued",
        completed: 1,
        total: 2,
      },
      result: {
        requested: 2,
        imported: 1,
        failed: 0,
      },
    });
    expect(job.result?.outcomes).toEqual([expect.objectContaining({ expansionId: "base1", status: "imported" })]);
    expect(harness.jobEvents[harness.jobEvents.length - 1]?.snapshot).toMatchObject({
      jobId: "job_retry",
      status: "queued",
    });
  });

  it("cancels provider integration jobs as operator-cancelled failed durable jobs", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: {
        ...integrationJobRow({
          jobId: "job_cancel",
          action: "import",
          scope: { provider: "tcgdex", language: "en", seriesId: "base" },
          profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
          eventContext: context,
          progress: {
            phase: "processing",
            completed: 1,
            total: 2,
            currentName: "Base Set",
            status: "imported",
          },
        }),
        status: "running",
        claim_owner_id: "worker-1",
        claimed_until: "2026-05-28T00:10:00.000Z",
      },
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const job = await services.cancelIntegrationJob({ jobId: "job_cancel", context });

    expect(job).toMatchObject({
      jobId: "job_cancel",
      status: "failed",
      operatorStatus: "cancelled",
      progress: {
        phase: "failed",
        completed: 1,
        total: 2,
      },
      errorMessage: "Operator cancelled provider import job.",
    });
  });

  it("enumerates unscoped TCGdex expansion import targets from the provider expansion list", async () => {
    const originalFetch = globalThis.fetch;
    let seriesId = "synthetic-series";
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "https://api.tcgdex.net/v2/en/series/synthetic-series") {
        throw new Error(`Unexpected synthetic TCGdex request: ${String(input)}`);
      }
      return jsonResponse({
        id: seriesId,
        name: "Synthetic Series",
        sets: [
          { id: "synthetic-set-a", name: "Synthetic Expansion A" },
          { id: "synthetic-set-b", name: "Synthetic Expansion B" },
        ],
      });
    });
    globalThis.fetch = fetch as typeof globalThis.fetch;
    try {
      const harness = createIntegrationJobClaimHandoffHarness();
      const profileVersions = createActiveTcgplayerProfileVersions();
      const items = {} as CatalogItemServices;
      const services = createSourceObservationRuntime(harness.deps, items, harness.referenceData, profileVersions);
      const scope = { provider: "tcgdex", language: "en", seriesId: "synthetic-series" } as const;
      const preview = await services.previewIntegrationImport({ scope, context });
      expect(preview.targetCount).toBe(2);
      expect(preview.targets.map(({ targetId, name, languageCode }) => ({ targetId, name, languageCode }))).toEqual([
        { targetId: "synthetic-set-a", name: "Synthetic Expansion A", languageCode: "en" },
        { targetId: "synthetic-set-b", name: "Synthetic Expansion B", languageCode: "en" },
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);

      const providerImport = createSourceObservationProviderImportRuntime({
        deps: harness.deps,
        items,
        referenceData: harness.referenceData,
        aliasCandidateSink: vi.fn(async () => undefined),
        commandHandler: services.commandHandler,
        providerAdapterRegistry: services.providerAdapterRegistry,
        mergeCandidates: createSourceObservationMergeCandidateRuntime({ deps: harness.deps, profileVersions }),
      });
      const profileVersion = currentTcgdexProfileVersion();
      const targets = await providerImport.resolveProviderAdapterImportTargets(scope, profileVersion);
      expect(targets.map((target) => target.values)).toEqual([
        { languageCode: "en", setId: "synthetic-set-a", expansionId: "synthetic-set-a", seriesId: "synthetic-series" },
        { languageCode: "en", setId: "synthetic-set-b", expansionId: "synthetic-set-b", seriesId: "synthetic-series" },
      ]);
      seriesId = "synthetic-wrong-series";
      const wrongParentTargets = await providerImport.resolveProviderAdapterImportTargets(scope, profileVersion);
      expect(wrongParentTargets.map((target) => target.values.seriesId)).toEqual([
        "synthetic-wrong-series",
        "synthetic-wrong-series",
      ]);
      expect(wrongParentTargets.map((target) => target.values)).not.toEqual(targets.map((target) => target.values));

      fetch.mockClear();
      const scopedPreview = await services.previewIntegrationImport({
        scope: { ...scope, setId: "synthetic-set-a" },
        context,
      });
      expect(scopedPreview.targetCount).toBe(1);
      expect(scopedPreview.targets[0]?.targetId).toBe("synthetic-set-a");
      expect(fetch).not.toHaveBeenCalled();
      expect(
        await listCatalogProviderIntegrationOptionsFromProfiles({
          profiles: [profileVersion.profile],
          providerKey: "tcgdex",
          defaultProviderKey: "tcgdex",
          queryKind: "expansions",
          languageCode: "en",
          parentValue: "synthetic-series",
          transports: {
            listTcgdexExpansions: async () => [{ expansionId: "synthetic-missing-name", seriesId: "synthetic-series" }],
          },
        }),
      ).toEqual([]);

      const normalizedRefeed = vi
        .spyOn(providerOptionQueries, "tcgdexExpansionOptionRecord")
        .mockImplementation((item) => ({
          value: item.value,
          label: item.label,
          parentValue: item.parentValue ?? "synthetic-series",
          aliases: providerOptionQueries.providerOptionAliasesToJson(item.aliases),
          ...item.metadata,
        }));
      try {
        const mutantPreview = await services.previewIntegrationImport({ scope, context });
        expect(normalizedRefeed).toHaveBeenCalledTimes(2);
        expect(mutantPreview.targetCount).toBe(0);
        expect(mutantPreview.targetCount).not.toBe(preview.targetCount);
      } finally {
        normalizedRefeed.mockRestore();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    ["retries a transient second-page transport failure", "reset", 2, null],
    ["persists a redacted reason after one retry", "timeout", 2, "/cards/search page 2 failed (ETIMEDOUT)"],
    ["omits an unrecognized cause code", "unknown", 1, "/cards/search page 2 failed"],
    ["does not retry HTTP 404", 404, 1, "/cards/search page 2 failed (HTTP 404)"],
    ["does not retry HTTP 429", 429, 1, "/cards/search page 2 failed (HTTP 429)"],
    ["does not retry HTTP 503", 503, 1, "/cards/search page 2 failed (HTTP 503)"],
    [
      "does not retry an invalid HTTP response body",
      "invalid-json",
      1,
      "/cards/search page 2 returned invalid JSON (HTTP 200)",
    ],
  ] as const)("Scryfall set import %s", async (_name, failure, pageTwoAttempts, failureReason) => {
    const secret = "SYNTHETIC_PRIVATE_VALUE";
    const firstPage = "https://api.scryfall.com/cards/search?q=set%3Atsp&unique=prints";
    const secondPage = `https://api.scryfall.com/cards/search?page=2&token=${secret}`;
    const card = (id: string, collectorNumber: string) => ({
      id,
      uri: `https://api.scryfall.com/cards/${id}`,
      name: "Synthetic Time Spiral Card",
      lang: "en",
      set: "tsp",
      set_id: "c1d109bc-ffd8-428f-8d7d-3f8d7e648046",
      set_name: "Time Spiral",
      collector_number: collectorNumber,
      rarity: "common",
      tcgplayer_id: 900000 + Number(collectorNumber),
      released_at: "2006-10-06",
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === firstPage) {
        return jsonResponse({ data: [card("synthetic-one", "1")], has_more: true, next_page: secondPage });
      }
      if (String(input) !== secondPage) throw new Error("Unexpected synthetic page request");
      if (typeof failure === "number") return new Response(secret, { status: failure });
      if (failure === "invalid-json") return new Response(secret);
      if (failure === "reset" && fetch.mock.calls.length === 3) {
        return jsonResponse({ data: [card("synthetic-two", "2")], has_more: false });
      }
      const code = failure === "reset" ? "ECONNRESET" : failure === "timeout" ? "ETIMEDOUT" : secret;
      throw new TypeError(`fetch failed: ${secret}`, { cause: Object.assign(new Error(secret), { code }) });
    });
    const harness = createIntegrationJobClaimHandoffHarness({
      scope: {
        provider: "scryfall",
        profileKey: "mtg-card-print-reference-data",
        ingestionUnitKey: "scryfall:mtg:single-card:reference-data",
        setId: "tsp",
      },
      renewSucceeds: true,
    });
    const services = createSourceObservationRuntime(harness.deps, {} as CatalogItemServices, harness.referenceData);

    try {
      await expect(services.processNextIntegrationJob({ claimOwnerId: "worker-1", claimTtlMs: 120_000 })).resolves.toBe(
        1,
      );
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        firstPage,
        ...Array<string>(pageTwoAttempts).fill(secondPage),
      ]);
    } finally {
      fetch.mockRestore();
    }

    const observed = failureReason === null ? 2 : 0;
    expect(harness.job.status).toBe("completed");
    expect(harness.job.result?.outcomes).toMatchObject([
      {
        providerKey: "scryfall",
        status: failureReason === null ? "imported" : "failed",
        observed,
        reason: failureReason === null ? null : `Scryfall ${failureReason}.`,
      },
    ]);
    expect(JSON.stringify(harness.job.result)).not.toContain(secret);
    expect(
      harness.appendedSourceEvents.filter((event) => event.eventType === "catalog.source-observation.recorded"),
    ).toHaveLength(observed);
  });

  it("generates merge candidates from successful catalog-sync child imports without waiting for projection catch-up", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mtgjsonFetch() as typeof globalThis.fetch;
    const harness = createIntegrationJobClaimHandoffHarness({
      scope: {
        provider: "mtgjson",
        profileKey: "mtg-set-reference-data",
        ingestionUnitKey: "mtgjson:mtg:set:reference-data",
        setId: "TSP",
      },
      syncRunId: "job_sync_mtgjson",
      acceptedScopeRecordId: "scope_time_spiral",
      acceptedUnitKey: "mtgjson:mtg:set:reference-data",
      renewSucceeds: true,
    });
    const services = createSourceObservationRuntime(harness.deps, {} as CatalogItemServices, harness.referenceData);
    try {
      await expect(services.processNextIntegrationJob({ claimOwnerId: "worker-1", claimTtlMs: 120_000 })).resolves.toBe(
        1,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(harness.job.status).toBe("completed");
    expect(harness.appendedSourceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "catalog.source-observation.recorded",
          payload: expect.objectContaining({ providerKey: "mtgjson", syncRunId: "job_sync_mtgjson" }),
        }),
      ]),
    );
  });

  it.each([true, false])(
    "reconciles Time Spiral candidates only while the import claim renews: %s",
    async (canRenew) => {
      const unitKey = "mtgjson:mtg:single-card:reference-data";
      const harness = createIntegrationJobClaimHandoffHarness({
        scope: {
          provider: "mtgjson",
          profileKey: "mtg-card-reference-data",
          ingestionUnitKey: unitKey,
          setId: "TSP",
          setName: "Time Spiral",
        },
        syncRunId: "job_sync_time_spiral",
        acceptedScopeRecordId: "scope_time_spiral",
        acceptedUnitKey: unitKey,
        renewSucceeds: true,
      });
      const query = harness.deps.db.query;
      const claimTtlMs = 120_000;
      let claimDeadline = 0;
      let foundCandidates = false;
      let markCandidateRead!: () => void;
      const candidateRead = new Promise<void>((resolve) => (markCandidateRead = resolve));
      let resumeRead!: () => void;
      const readResumed = new Promise<void>((resolve) => (resumeRead = resolve));
      const db: CatalogRuntimeDeps["db"] = {
        query: async <Row>(sql: string, params: readonly unknown[] = []) => {
          if (sql.includes("SELECT candidate_id") && sql.includes("FROM catalog_merge_candidates")) {
            foundCandidates = true;
            claimDeadline = Date.now() + claimTtlMs;
            markCandidateRead();
            await readResumed;
          }
          if (foundCandidates && sql.includes("UPDATE catalog_source_observation_integration_durable_jobs")) {
            if (Date.now() >= claimDeadline) return { rowCount: 0, rows: [] as Row[] };
            if (sql.includes("SET claimed_until")) {
              if (!canRenew) return { rowCount: 0, rows: [] as Row[] };
              claimDeadline = Date.now() + claimTtlMs;
            }
          }
          return query<Row>(sql, params);
        },
      };
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(mtgjsonFetch());
      vi.useFakeTimers();
      const services = createSourceObservationRuntime(
        { ...harness.deps, db },
        {} as CatalogItemServices,
        harness.referenceData,
      );
      const turn = services.processNextIntegrationJob({ claimOwnerId: "worker-1", claimTtlMs });
      try {
        await Promise.race([candidateRead, turn]);
        expect(foundCandidates, JSON.stringify(harness.appendedSourceEvents[0]?.payload.normalized)).toBe(true);
        await vi.advanceTimersByTimeAsync(claimTtlMs + 5_000);
        resumeRead();
        await expect(turn).resolves.toBe(canRenew ? 1 : 0);
        await vi.advanceTimersByTimeAsync(0);
        const writes = harness.appendedSourceEvents.map(({ eventType }) => eventType);
        if (canRenew) {
          expect(harness.job).toMatchObject({ status: "completed", result: { imported: 1, failed: 0 } });
          expect(writes).toContain("catalog.merge-candidate.created");
        } else {
          expect(harness.job).toMatchObject({ status: "running", result: null, error_message: null });
          expect(writes).toEqual(["catalog.source-observation.recorded"]);
        }
      } finally {
        resumeRead();
        await turn.catch(() => undefined);
        vi.useRealTimers();
        fetch.mockRestore();
      }
    },
  );

  it.each([
    ["complete", null, null],
    ["missing-member", null, null],
    ["metadata-only", "mtgjson", "promoted"],
    ["identical-payload", "scryfall", "promoted"],
    ["metadata-only", "mtgjson", "rejected"],
    ["identical-payload", "scryfall", "rejected"],
    ["changed-rarity", "mtgjson", "promoted"],
    ["changed-reference", "scryfall", "promoted"],
    ["missing-reviewed-revision", "scryfall", "promoted"],
    ["unknown-member", "mtgjson", "promoted"],
    ["known-plus-extra-member", "mtgjson", "rejected"],
  ] as const)(
    "reconciles Time Spiral child imports without candidate projection catch-up: %s (%s, %s)",
    async (scenario, replayProvider, terminalStatus) => {
      const { eventStore, streams } = createInMemoryEventStore();
      const storedRows = new Map<string, SourceObservationListRow>();
      const readableRows = new Map<string, SourceObservationListRow>();
      const memberReadIds: string[] = [];
      const mappings = ["scryfall", "mtgjson"].map((provider) => ({
        ...acceptedScopeMappingRow({
          providerKey: provider,
          unitKey: `${provider}:mtg:single-card:reference-data`,
          setId: provider === "mtgjson" ? "TSP" : "tsp",
          setName: "Time Spiral",
        }),
        scope_record_id: "scope_time_spiral",
      }));
      const db: CatalogRuntimeDeps["db"] = {
        query: async <Row>(sql: string, values: readonly unknown[] = []) => {
          if (sql.includes("FROM catalog_provider_scope_mappings"))
            return { rows: mappings as Row[], rowCount: mappings.length };
          if (sql.includes("FROM catalog_source_observations")) {
            const ids = values[0];
            if (Array.isArray(ids)) memberReadIds.push(...ids);
            const rows = [...readableRows.values()].filter(
              (row) => Array.isArray(ids) && ids.includes(row.observation_id),
            );
            return { rows: rows as Row[], rowCount: rows.length };
          }
          return { rows: [] as Row[], rowCount: 0 };
        },
      };
      const deps: CatalogRuntimeDeps = {
        db,
        eventStore,
        checkpointStore: { loadCheckpoint: async () => "0" as never, saveCheckpoint: async () => undefined },
      };
      const profiles = staticCatalogProviderIntegrationProfileVersions;
      const mergeCandidates = createSourceObservationMergeCandidateRuntime({ deps, profileVersions: profiles });
      const referenceData = {} as ReferenceDataServices;
      const services = createSourceObservationRuntime(deps, {} as CatalogItemServices, referenceData);
      const importRuntime = createSourceObservationProviderImportRuntime({
        deps,
        items: {} as CatalogItemServices,
        referenceData,
        aliasCandidateSink: async () => undefined,
        providerAdapterRegistry: services.providerAdapterRegistry,
        mergeCandidates,
        commandHandler: async (input) => {
          const result = await services.commandHandler(input);
          if (input.command.type === "RecordSourceObservation")
            storedRows.set(
              input.command.observationId,
              mergeCandidates.sourceObservationRecordToCandidateRow(input.command),
            );
          return result;
        },
      });
      const snapshots: SourceObservationListRow[] = [];
      const providers = ["scryfall", "mtgjson"];
      if (replayProvider) providers.push(replayProvider);
      let terminalStreamId: string | null = null;
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network permitted by this fixture"));
      try {
        for (const [turn, provider] of providers.entries()) {
          const replaying = turn === 2;
          const unitKey = `${provider}:mtg:single-card:reference-data`;
          const version = (await profiles.listProfileVersions(provider)).find(
            (item) =>
              item.profileVersion === "2026.06.19" && catalogProviderProfileVersionIngestionUnitKey(item) === unitKey,
          )!;
          const payload =
            provider === "scryfall"
              ? {
                  kind: "single-card",
                  card: {
                    id: "synthetic-scryfall-card",
                    uri: "https://provider.example/scryfall",
                    name: "Amrou Scout",
                    lang: "en",
                    set: "tsp",
                    set_id: "c1d109bc-ffd8-428f-8d7d-3f8d7e648046",
                    set_name: "Time Spiral",
                    collector_number: "1",
                    rarity: "common",
                    tcgplayer_id: replaying && scenario === "changed-reference" ? 900002 : 900001,
                    released_at: "2006-10-06",
                  },
                }
              : {
                  kind: "single-card",
                  sourceUrl: "https://provider.example/mtgjson",
                  meta: { date: "2026-07-14", version: replaying ? "5.2.1" : "5.2.0" },
                  set: { code: "TSP", name: "Time Spiral", releaseDate: "2006-10-06" },
                  card: {
                    uuid:
                      replaying && scenario === "unknown-member" ? "synthetic-new-member" : "synthetic-mtgjson-card",
                    name: "Amrou Scout",
                    number: "1",
                    rarity: replaying && scenario === "changed-rarity" ? "rare" : "common",
                    identifiers: { scryfallId: "synthetic-scryfall-card" },
                  },
                };
          const adapter: ProviderAdapter = {
            providerKey: provider,
            capabilities: { supportsOptionQueries: false, supportsImportPlanning: true, supportsPayloadFetch: true },
            listIntegrationUnits: async () => [],
            listOptions: async () => ({ items: [] }),
            planImport: async (scope) => ({
              unitKey: scope.unitKey,
              planKey: `synthetic-${provider}`,
              scope,
              transportSteps: [],
              estimatedPayloads: 1,
            }),
            fetchPayloads: async function* (plan) {
              yield {
                unitKey: plan.unitKey,
                providerKey: provider,
                externalKey: "synthetic-1",
                payload,
                provenance: { fetchedAt: "2026-07-14T12:00:00.000Z" },
              };
              if (replaying && scenario === "known-plus-extra-member" && "meta" in payload) {
                yield {
                  unitKey: plan.unitKey,
                  providerKey: provider,
                  externalKey: "synthetic-2",
                  payload: { ...payload, card: { ...payload.card, uuid: "synthetic-new-member" } },
                  provenance: { fetchedAt: "2026-07-14T12:00:00.000Z" },
                };
              }
            },
            getCredentialReadiness: async () => [],
            getTransportDiagnostics: async () => [],
          };
          // Prior units may be queryable, but the current import is never
          // projected. Candidate discovery stays empty across both units.
          readableRows.clear();
          if (scenario !== "missing-member") {
            for (const [id, row] of storedRows) {
              readableRows.set(id, { ...row, observed_at: row.observed_at.replace("Z", "000Z") });
            }
          }
          if (replaying && scenario === "missing-reviewed-revision") {
            // A stream with the right hash but no revision from the reviewed run cannot prove equality.
            const sourceId = sourceObservationStreamId(
              snapshots.find((row) => row.provider_key === provider)!.observation_id,
            );
            streams.set(
              sourceId,
              streams.get(sourceId)!.map((event) => ({
                ...event,
                payload: { ...event.payload, syncRunId: "job_unreviewed_time_spiral" },
              })),
            );
          }
          const terminalHistory = terminalStreamId ? [...streams.get(terminalStreamId)!] : null;
          const syncRunId = replaying ? "job_repeat_time_spiral" : "job_shared_time_spiral";
          const outcome = await importRuntime.importProviderAdapterIntegrationTarget({
            target: {
              targetId: "tsp",
              name: "Time Spiral",
              scopeKey: "set",
              values: { setId: "tsp", languageCode: "en" },
              languageCode: "en",
            },
            providerProfile: version.profile,
            providerProfileVersion: version,
            syncRunId,
            context,
            adapterOverride: adapter,
            observedAtForEnvelope: () => (replaying ? "2026-07-15T12:00:00.000Z" : "2026-07-14T12:00:00.000Z"),
          });
          if (replaying) {
            if (scenario === "known-plus-extra-member") {
              expect([...storedRows.values()].filter((row) => row.sync_run_id === syncRunId)).toHaveLength(2);
            }
            if (scenario === "changed-rarity" || scenario === "changed-reference") {
              const oldRow = snapshots.find((row) => row.provider_key === provider)!;
              const newRow = storedRows.get(oldRow.observation_id)!;
              const proposal = (row: SourceObservationListRow) =>
                buildCatalogMergeCandidatesFromObservations([row], {
                  addedAt: row.observed_at,
                  acceptedScopeMappings: mappings,
                  providerUnitKeyByObservationId: { [row.observation_id]: unitKey },
                }).candidates[0]!;
              const before = proposal(oldRow);
              const after = proposal(newRow);
              expect(catalogMergeCandidateStreamId(after.candidateId)).toBe(terminalStreamId);
              expect(after.candidateId).toBe(before.candidateId);
              if (scenario === "changed-rarity") {
                expect(before.snapshot.proposedCatalogItemFacts.rarity).toBe("common");
                expect(after.snapshot.proposedCatalogItemFacts.rarity).toBe("rare");
              } else {
                expect(before.snapshot.proposedExternalCatalogItemReferences).toContainEqual(
                  expect.objectContaining({ providerKey: "tcgplayer", externalKey: "product:900001" }),
                );
                expect(after.snapshot.proposedExternalCatalogItemReferences).toContainEqual(
                  expect.objectContaining({ providerKey: "tcgplayer", externalKey: "product:900002" }),
                );
              }
            }
            if (scenario !== "metadata-only" && scenario !== "identical-payload") {
              expect(outcome).toMatchObject({
                status: "failed",
                reason: "Terminal Catalog Merge Candidates cannot be changed.",
              });
            } else {
              expect(outcome, outcome.reason ?? "import outcome").toMatchObject({ status: "imported", observed: 1 });
              const oldRow = snapshots.find((row) => row.provider_key === provider)!;
              const newRow = storedRows.get(oldRow.observation_id)!;
              expect(newRow.sync_run_id).toBe(syncRunId);
              if (scenario === "metadata-only") {
                expect(newRow.source_record_hash).not.toBe(oldRow.source_record_hash);
              } else {
                expect(newRow.source_record_hash).toBe(oldRow.source_record_hash);
              }
              expect(streams.get(sourceObservationStreamId(newRow.observation_id))?.at(-1)).toMatchObject({
                eventType:
                  scenario === "metadata-only"
                    ? "catalog.source-observation.recorded"
                    : "catalog.source-observation.refreshed",
                payload: { syncRunId, sourceRecordHash: newRow.source_record_hash },
              });
            }
            expect(streams.get(terminalStreamId!)).toEqual(terminalHistory);
            expect(
              [...streams.values()].filter((events) => events[0]?.eventType === "catalog.merge-candidate.created"),
            ).toHaveLength(1);
          } else if (scenario === "missing-member" && provider === "mtgjson") {
            expect(outcome).toMatchObject({
              status: "failed",
              reason: expect.stringContaining("could not prove every existing member row"),
            });
            expect(
              [...streams.values()]
                .filter((events) => events[0]?.eventType === "catalog.merge-candidate.created")
                .flat(),
            ).toHaveLength(1);
          } else {
            expect(outcome, outcome.reason ?? "import outcome").toMatchObject({ status: "imported", observed: 1 });
            snapshots.splice(0, snapshots.length, ...storedRows.values());
            const oracle = buildCatalogMergeCandidatesFromObservations(
              snapshots.map((row) => readableRows.get(row.observation_id) ?? row),
              {
                addedAt: "2026-07-14T12:00:00.000Z",
                acceptedScopeMappings: mappings,
                providerUnitKeyByObservationId: Object.fromEntries(
                  snapshots.map((row) => [row.observation_id, `${row.provider_key}:mtg:single-card:reference-data`]),
                ),
              },
            );
            expect(oracle.candidates).toHaveLength(1);
            const loaded = await mergeCandidates.loadCatalogMergeCandidateForReview(oracle.candidates[0]!.candidateId);
            const withoutAddedAt = (snapshot: unknown) =>
              JSON.parse(JSON.stringify(snapshot, (key, value: unknown) => (key === "addedAt" ? undefined : value)));
            expect(withoutAddedAt(loaded.state.snapshot)).toEqual(withoutAddedAt(oracle.candidates[0]!.snapshot));
            expect(
              streams
                .get(catalogMergeCandidateStreamId(oracle.candidates[0]!.candidateId))
                ?.map((event) => event.eventType),
            ).toEqual(
              provider === "scryfall"
                ? ["catalog.merge-candidate.created"]
                : ["catalog.merge-candidate.created", "catalog.merge-candidate.refreshed"],
            );
            if (turn === 1 && terminalStatus) {
              const candidateId = oracle.candidates[0]!.candidateId;
              const decision = {
                candidateId,
                expectedVersion: loaded.version,
                reason: "Reviewed both Time Spiral sources",
                context,
              };
              const reviewed =
                terminalStatus === "promoted"
                  ? await mergeCandidates.services.promoteCatalogMergeCandidate({
                      ...decision,
                      conflictResolutions: [],
                    })
                  : await mergeCandidates.services.ignoreCatalogMergeCandidate(decision);
              expect(reviewed.status).toBe(terminalStatus);
              terminalStreamId = catalogMergeCandidateStreamId(candidateId);
            }
          }
        }
        expect(fetch).not.toHaveBeenCalled();
        expect(memberReadIds).not.toContain("mtgjson_card_en_synthetic-mtgjson-card");
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it("imports an MTGJSON set document larger than 64 KiB as bounded Source Observation events", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mtgjsonFetch({ oversizedSet: true }) as typeof globalThis.fetch;
    const harness = createIntegrationJobClaimHandoffHarness({
      scope: {
        provider: "mtgjson",
        profileKey: "mtg-set-reference-data",
        ingestionUnitKey: "mtgjson:mtg:set:reference-data",
        setId: "TSP",
      },
      renewSucceeds: true,
    });
    const services = createSourceObservationRuntime(harness.deps, {} as CatalogItemServices, harness.referenceData);

    try {
      await expect(services.processNextIntegrationJob({ claimOwnerId: "worker-1", claimTtlMs: 120_000 })).resolves.toBe(
        1,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(harness.job.status).toBe("completed");
    expect(harness.job.result).toMatchObject({ requested: 1, imported: 1, observed: 1, failed: 0 });
    expect(harness.appendedSourceEvents[0]).toMatchObject({
      eventType: "catalog.source-observation.recorded",
      payload: expect.objectContaining({
        observationId: "mtgjson_set_en_TSP",
        sourcePayloadEncoding: "json-utf8-base64-v1",
      }),
    });
    expect(
      harness.appendedSourceEvents
        .slice(1)
        .every((event) => event.eventType === "catalog.source-observation.source-payload-chunk-recorded"),
    ).toBe(true);
    expect(harness.appendedSourceEvents.length).toBeGreaterThan(2);
    expect(
      harness.appendedSourceEvents.every(
        (event) => Buffer.byteLength(JSON.stringify(event.payload), "utf8") <= EVENT_STORE_MAX_PAYLOAD_BYTES,
      ),
    ).toBe(true);
  });

  it("processes queued YGOJSON Beginner's Edition 2 imports through the durable integration worker with complete normalized evidence", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ygojsonBeginnerEditionTwoFetch();
    const harness = createIntegrationJobClaimHandoffHarness({
      scope: {
        provider: "ygojson",
        profileKey: "yugioh-set-reference-data",
        language: "en",
        setId: "000f0093-1847-4db7-a315-5bd07f055c7a",
      },
      acceptedScopeRecordId: "scope_yugioh_official_card_game",
      acceptedUnitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
      renewSucceeds: true,
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      harness.referenceData,
      createActiveTcgplayerProfileVersions(),
    );

    try {
      await expect(services.processNextIntegrationJob({ claimOwnerId: "worker-1", claimTtlMs: 120_000 })).resolves.toBe(
        1,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(harness.job.result?.outcomes).toMatchObject([{ status: "imported", reason: null }]);
    expect(harness.job.status).toBe("completed");
    expect(harness.job.result).toMatchObject({ requested: 1, imported: 1, observed: 1, failed: 0 });
    expect(harness.appendedSourceEvents[0]).toMatchObject({
      eventType: "catalog.source-observation.recorded",
      payload: {
        normalizedEvidenceEncoding: "json-utf8-base64-v1",
        sourcePayloadEncoding: "json-utf8-base64-v1",
      },
    });
    expect(
      harness.appendedSourceEvents.every(
        (event) =>
          Buffer.byteLength(JSON.stringify(event.payload), "utf8") <= SOURCE_OBSERVATION_INLINE_EVENT_TARGET_BYTES,
      ),
    ).toBe(true);

    const state = harness.appendedSourceEvents
      .map(({ eventType, payload }) => ({ type: eventType, data: payload }) as SourceObservationEvent)
      .reduce(evolveSourceObservation, initialSourceObservationState);
    expect(state.status).toBe("observed");
    expect(state.normalized).toMatchObject({
      kind: "yugioh-set-reference",
      tcg: "yugioh",
      name: "Beginner's Edition 2",
      productLineName: "Yu-Gi-Oh!",
    });
    expect(state.normalized).toEqual(
      expect.objectContaining({
        localeEvidence: expect.anything(),
        cardPrintEvidence: expect.anything(),
      }),
    );
    expect(state.pendingNormalizedEvidenceChunks).toBeNull();
    expect(state.pendingSourcePayloadChunks).toBeNull();
    expect(state.sourcePayload).toEqual(expect.objectContaining({ kind: "set-reference" }));
  });

  it.each([
    {
      profileKey: "lorcana-card-reference-data",
      ingestionUnitKey: "lorcanajson:lorcana:single-card:reference-data",
      observationId: "lorcanajson_card_en_1-041",
      externalKey: "card:1-041",
      normalizedKind: "lorcana-card-print",
    },
    {
      profileKey: "lorcana-set-reference-data",
      ingestionUnitKey: "lorcanajson:lorcana:set:reference-data",
      observationId: "lorcanajson_set_en_1",
      externalKey: "set:1",
      normalizedKind: "lorcana-set-reference",
    },
  ])(
    "processes queued LorcanaJSON $profileKey imports through the durable integration worker",
    async ({ profileKey, ingestionUnitKey, observationId, externalKey, normalizedKind }) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = lorcanajsonFetch() as typeof globalThis.fetch;
      const harness = createIntegrationJobClaimHandoffHarness({
        scope: { provider: "lorcanajson", profileKey, ingestionUnitKey, setId: "1" },
        renewSucceeds: true,
      });
      const services = createSourceObservationRuntime(harness.deps, {} as CatalogItemServices, harness.referenceData);

      try {
        await expect(
          services.processNextIntegrationJob({
            claimOwnerId: "worker-1",
            claimTtlMs: 120_000,
          }),
        ).resolves.toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(harness.job.status).toBe("completed");
      expect(harness.job.result).toMatchObject({
        requested: 1,
        imported: 1,
        observed: 1,
        failed: 0,
      });
      expect(harness.appendedSourceEvents).toHaveLength(1);
      expect(harness.appendedSourceEvents[0]?.payload).toMatchObject({
        observationId,
        providerKey: "lorcanajson",
        externalKey,
        sourceProfileKey: profileKey,
        sourceProfileVersion: "2026.06.23",
        normalized: expect.objectContaining({
          kind: normalizedKind,
          setCode: "1",
          setName: "The First Chapter",
        }),
      });
    },
  );

  it("lists Scrydex One Piece set options through the shared provider option interface", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.SCRYDEX_API_KEY;
    const originalTeamId = process.env.SCRYDEX_TEAM_ID;
    process.env.SCRYDEX_API_KEY = "test-key";
    process.env.SCRYDEX_TEAM_ID = "main";
    globalThis.fetch = scrydexOnePieceFetch() as typeof globalThis.fetch;
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    try {
      const options = await services.listIntegrationOptions({
        providerKey: "scrydex",
        profileKey: "one-piece-card-print-source-observation",
        ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
        queryKind: "sets",
        languageCode: "en",
      });

      expect(options).toEqual([
        expect.objectContaining({
          providerKey: "scrydex",
          queryKind: "sets",
          value: "op-01",
          label: "Romance Dawn",
          metadata: expect.objectContaining({
            expansionId: "op-01",
            code: "OP-01",
            total: 121,
          }),
        }),
      ]);
    } finally {
      restoreEnvValue("SCRYDEX_API_KEY", originalApiKey);
      restoreEnvValue("SCRYDEX_TEAM_ID", originalTeamId);
      globalThis.fetch = originalFetch;
    }
  });

  it("previews Scrydex One Piece set imports without fetching provider payloads", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.SCRYDEX_API_KEY;
    const originalTeamId = process.env.SCRYDEX_TEAM_ID;
    process.env.SCRYDEX_API_KEY = "test-key";
    process.env.SCRYDEX_TEAM_ID = "main";
    const fetch = vi.fn(scrydexOnePieceFetch());
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const harness = createIntegrationJobClaimHandoffHarness();
    const services = createSourceObservationRuntime(harness.deps, {} as CatalogItemServices, harness.referenceData);

    try {
      const preview = await services.previewIntegrationImport({
        scope: {
          provider: "scrydex",
          profileKey: "one-piece-card-print-source-observation",
          ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
          language: "en",
          setId: "op-01",
        },
        context,
      });

      expect(preview).toMatchObject({
        action: "import",
        providerKey: "scrydex",
        targetCount: 1,
        targets: [
          expect.objectContaining({
            targetId: "set:op-01",
            name: "op-01",
            languageCode: "en",
            scopeKey: "expansion-cards",
            planKey: "scrydex:one-piece:expansion:op-01:cards",
            estimatedPayloads: null,
            transportSteps: [
              "Search Scrydex One Piece cards by printings set with max page size",
              "Sanitize card payloads",
              "Attach payload provenance",
            ],
            usageEstimate: expect.objectContaining({
              requestStrategy: "bulk-first",
              estimateState: "estimate-unavailable",
              estimatedRequestCount: null,
              usageCheckState: "checked",
              perRecordFallbackReason: null,
              selectedFields: expect.arrayContaining(["id", "name", "number", "expansion", "printings", "variants"]),
              pageSize: 250,
            }),
          }),
        ],
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.scrydex.com/account/v1/usage");
      expect(harness.appendedSourceEvents).toEqual([]);
    } finally {
      restoreEnvValue("SCRYDEX_API_KEY", originalApiKey);
      restoreEnvValue("SCRYDEX_TEAM_ID", originalTeamId);
      globalThis.fetch = originalFetch;
    }
  });

  it("carries a guided YGOPRODeck set selection into card import planning", async () => {
    const harness = createIntegrationJobClaimHandoffHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const preview = await services.previewIntegrationImport({
      scope: {
        provider: "ygoprodeck",
        ingestionUnitKey: "ygoprodeck:yugioh:single-card:reference-data",
        language: "en",
        setId: "25th Anniversary Rarity Collection",
      },
      context,
    });

    expect(preview).toMatchObject({
      action: "import",
      providerKey: "ygoprodeck",
      targetCount: 1,
      targets: [
        expect.objectContaining({
          targetId: "set:25th Anniversary Rarity Collection",
          name: "25th Anniversary Rarity Collection",
          languageCode: "en",
          scopeKey: "set",
          planKey: "ygoprodeck:cards:set:25th-anniversary-rarity-collection",
          transportSteps: [
            "Fetch YGOPRODeck cards by card set",
            "Select card print payloads",
            "Attach card provenance",
          ],
        }),
      ],
    });
  });

  it("processes queued Scrydex One Piece set imports through the durable integration worker", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.SCRYDEX_API_KEY;
    const originalTeamId = process.env.SCRYDEX_TEAM_ID;
    process.env.SCRYDEX_API_KEY = "test-key";
    process.env.SCRYDEX_TEAM_ID = "main";
    globalThis.fetch = scrydexOnePieceFetch() as typeof globalThis.fetch;
    const harness = createIntegrationJobClaimHandoffHarness({
      scope: {
        provider: "scrydex",
        profileKey: "one-piece-card-print-source-observation",
        ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
        language: "en",
        setId: "op-01",
      },
      renewSucceeds: true,
    });
    const services = createSourceObservationRuntime(harness.deps, {} as CatalogItemServices, harness.referenceData);

    try {
      await expect(
        services.processNextIntegrationJob({
          claimOwnerId: "worker-1",
          claimTtlMs: 120_000,
        }),
      ).resolves.toBe(1);
    } finally {
      restoreEnvValue("SCRYDEX_API_KEY", originalApiKey);
      restoreEnvValue("SCRYDEX_TEAM_ID", originalTeamId);
      globalThis.fetch = originalFetch;
    }

    expect(harness.job.status).toBe("completed");
    expect(harness.job.result).toMatchObject({
      requested: 1,
      imported: 1,
      observed: 1,
      failed: 0,
      outcomes: [
        expect.objectContaining({
          providerKey: "scrydex",
          expansionId: "set:op-01",
          providerUsageEvidence: expect.objectContaining({
            unitKey: "scrydex:one-piece:single-card:source-observation-import",
            requestStrategy: "bulk-first",
            estimateState: "estimate-unavailable",
            estimatedRequestCount: null,
            estimateReason:
              "Card page count requires fresh exact-query Scrydex count evidence; set imports use q=printings:<set> to include reprints.",
            actualRequestCount: 1,
            pageCount: 1,
            cacheHitCount: null,
            cacheMissCount: null,
            usageCheckState: "checked",
            bulkFirstConfirmed: true,
            perRecordFallbackReason: null,
            selectedFields: [
              "id",
              "name",
              "number",
              "printed_number",
              "rarity",
              "rarity_code",
              "type",
              "images",
              "language",
              "language_code",
              "expansion",
              "printings",
              "variants",
            ],
            pageSize: 250,
          }),
        }),
      ],
    });
    expect(harness.appendedSourceEvents).toHaveLength(1);
    expect(harness.appendedSourceEvents[0]?.payload).toMatchObject({
      observationId: "scrydex_one_piece_card_en_op01-001",
      providerKey: "scrydex",
      externalKey: "card:op01-001",
      sourceProfileKey: "one-piece-card-print-source-observation",
      sourceProfileVersion: "2026.06.22",
      normalized: expect.objectContaining({
        kind: "one-piece-card-print",
        tcg: "one-piece",
        name: "Monkey.D.Luffy",
        cardNumber: "OP01-001",
        setId: "op-01",
        setName: "Romance Dawn",
      }),
    });
  });

  it("records one English observation per Scrydex Lorcana set card with a language label but no code", async () => {
    const { harness } = await runQueuedScrydexLorcanaCardImport("English", [
      { id: "synthetic-card-1", name: "Synthetic Lorcana Card 1", number: "1" },
      { id: "synthetic-card-2", name: "Synthetic Lorcana Card 2", number: "2" },
    ]);

    expect(harness.job.result).toMatchObject({
      imported: 1,
      observed: 2,
      failed: 0,
      outcomes: [{ status: "imported", observed: 2, reason: null }],
    });
    expect(harness.appendedSourceEvents).toMatchObject(
      [1, 2].map((index) => ({
        payload: {
          observationId: `scrydex_lorcana_card_en_synthetic-card-${index}`,
          externalKey: `card:synthetic-card-${index}`,
          normalized: {
            kind: "lorcana-card-print",
            languageCode: "en",
            name: `Synthetic Lorcana Card ${index}`,
            cardNumber: String(index),
            setId: "synthetic-set",
            setName: "Synthetic Lorcana Set",
            mergeIdentity: { languageCode: "en" },
          },
        },
      })),
    );
  });

  it("reports a support-safe language diagnostic for an unsupported Scrydex Lorcana card language", async () => {
    const { harness } = await runQueuedScrydexLorcanaCardImport("unsupported-language-label", [
      { id: "synthetic-card-1", name: "Synthetic Lorcana Card 1", number: "1" },
    ]);

    const reason =
      "Catalog provider 'scrydex' source observation normalization failed at normalizedObservation.languageCode.";
    expect(harness.job.result).toMatchObject({
      observed: 0,
      failed: 1,
      outcomes: [{ status: "failed", reason }],
    });
    expect(sourceObservationImportFailureDiagnostic("scrydex", reason)).toEqual({
      code: "source-observation-normalization-failed",
      fieldPath: "normalizedObservation.languageCode",
    });
    expect(harness.appendedSourceEvents).toEqual([]);
  });

  it("processes queued imports with the snapshotted profile version after a newer version is activated", async () => {
    const harness = createIntegrationJobClaimHandoffHarness({
      profileSnapshot: tcgdexProfileSnapshot("2026.06.03"),
      renewSucceeds: true,
    });
    const profileVersions = createMutableProfileVersionReader([
      tcgdexProfileVersion({
        profileVersion: "2026.06.03",
        lifecycle: "deprecated",
        active: false,
        displayName: "TCGdex",
      }),
      tcgdexProfileVersion({
        profileVersion: "2026.06.04",
        lifecycle: "active",
        active: true,
        displayName: "TCGdex Candidate",
      }),
    ]);
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      const body =
        fetchCount === 1
          ? {
              id: "base1",
              name: "Base Set",
              serie: { id: "base", name: "Base" },
              cardCount: { official: 102, total: 102 },
              cards: [{ id: "base1-1", localId: "1", name: "Abra" }],
            }
          : {
              id: "base1-1",
              localId: "1",
              name: "Abra",
              category: "Pokemon",
              rarity: "Common",
              set: { id: "base1", name: "Base Set" },
              variants: { normal: true },
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      harness.referenceData,
      profileVersions,
    );

    try {
      await expect(
        services.processNextIntegrationJob({
          claimOwnerId: "worker-1",
          claimTtlMs: 120_000,
        }),
      ).resolves.toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(harness.job.status).toBe("completed");
    expect(harness.appendedSourceEvents[0]?.payload).toMatchObject({
      providerKey: "tcgdex",
      sourceProfileVersion: "2026.06.03",
    });
  });

  it("hands off provider integration imports when the durable claim is lost before recording observations", async () => {
    const harness = createIntegrationJobClaimHandoffHarness();
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      const body =
        fetchCount === 1
          ? {
              id: "base1",
              name: "Base Set",
              serie: { id: "base", name: "Base" },
              cardCount: { official: 102, total: 102 },
              cards: [{ id: "base1-1", localId: "1", name: "Abra" }],
            }
          : {
              id: "base1-1",
              localId: "1",
              name: "Abra",
              category: "Pokemon",
              rarity: "Common",
              set: { id: "base1", name: "Base Set" },
              variants: { normal: true },
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const services = createSourceObservationRuntime(harness.deps, {} as CatalogItemServices, harness.referenceData);

    try {
      await expect(
        services.processNextIntegrationJob({
          claimOwnerId: "worker-1",
          claimTtlMs: 120_000,
        }),
      ).resolves.toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(harness.job.status).toBe("running");
    expect(harness.job.result).toBeNull();
    expect(harness.job.error_message).toBeNull();
    expect(harness.appendedSourceEvents).toEqual([]);
    expect(harness.renewAttempts).toBe(1);
  });

  it("returns an empty active integration job list when request context is missing", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(services.listActiveIntegrationJobs({ context: null })).resolves.toEqual([]);
    expect(harness.queryCount).toBe(0);
  });

  it("uses one context-scoped active snapshot for the overview and endpoint seam", async () => {
    const harness = createIntegrationJobDedupeHarness({
      existingJob: integrationJobRow({
        jobId: "job_active_import",
        action: "import",
        scope: { provider: "tcgdex", language: "en", setId: "base1" },
        eventContext: context,
      }),
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const snapshot = await services.listActiveIntegrationJobSnapshot?.({ context });

    expect(snapshot).toMatchObject({ completeness: "complete" });
    expect(snapshot?.items).toMatchObject([{ jobId: "job_active_import", status: "queued" }]);
    expect(harness.activeLookupValues).toEqual([
      ["import", "reapply"],
      context.tenantId,
      context.audit?.forAccountId,
      context.audit?.performedByUserId,
      51,
    ]);
  });

  it("lists recent terminal integration jobs for the current request context", async () => {
    const terminalJob = {
      ...integrationJobRow({
        jobId: "job_completed_import",
        action: "import",
        scope: {
          provider: "scrydex",
          profileKey: "one-piece-card-print-source-observation",
          ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
          language: "en",
          setId: "op-01",
        },
        profileSnapshot: {
          providerKey: "scrydex",
          profileKey: "one-piece-card-print-source-observation",
          profileVersion: "2026.06.22",
          ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
          lifecycle: "active",
          connectorKind: "scrydex-api",
          connectorSourceVersion: null,
          sourceMappingFingerprint: "sha256:scrydex-one-piece",
        },
        eventContext: context,
        progress: {
          phase: "completed",
          completed: 1,
          total: 1,
          currentName: null,
          status: "imported",
        },
      }),
      status: "completed",
      result: {
        requested: 1,
        imported: 1,
        observed: 1,
        reapplied: 0,
        skipped: 0,
        failed: 0,
        outcomes: [],
      },
      completed_at: "2026-06-23T05:32:42.000Z",
      updated_at: "2026-06-23T05:32:42.000Z",
    };
    const harness = createIntegrationJobDedupeHarness({ recentJobs: [terminalJob] });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(services.listRecentIntegrationJobs({ context })).resolves.toMatchObject([
      {
        jobId: "job_completed_import",
        status: "completed",
        operatorStatus: "completed",
        scope: {
          provider: "scrydex",
          language: "en",
          setId: "op-01",
        },
      },
    ]);
    expect(harness.recentLookupValues).toEqual([
      ["import", "reapply"],
      context.tenantId,
      context.audit?.forAccountId,
      context.audit?.performedByUserId,
      50,
    ]);
  });

  it("reports queued durable rows with active or terminal progress by their effective operator state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T00:20:00.000Z"));
    try {
      const runningProgress = {
        phase: "processing",
        completed: 1,
        total: 2,
        currentName: "Fifth Dawn",
        status: "imported",
      };
      const completedProgress = {
        phase: "completed",
        completed: 1,
        total: 1,
        currentName: null,
        status: "imported",
      };
      const base = {
        action: "import",
        scope: { provider: "mtgjson", language: "en", setName: "Fifth Dawn" },
        profileSnapshot: {
          providerKey: "mtgjson",
          profileKey: "mtg-set-reference-data",
          profileVersion: "2026.06.23",
          ingestionUnitKey: "mtgjson:mtg:set:reference-data",
          lifecycle: "active",
          connectorKind: "mtgjson-json",
          connectorSourceVersion: null,
          sourceMappingFingerprint: "sha256:mtgjson",
        },
        eventContext: context,
      };
      const harness = createIntegrationJobDedupeHarness({
        recentJobs: [
          {
            ...integrationJobRow({
              ...base,
              jobId: "job_stale_progress",
              progress: runningProgress,
            }),
            status: "queued",
            claimed_until: "2026-05-28T00:10:00.000Z",
          },
          {
            ...integrationJobRow({
              ...base,
              jobId: "job_running_progress",
              progress: runningProgress,
            }),
            status: "queued",
            claimed_until: "2026-05-28T00:30:00.000Z",
          },
          {
            ...integrationJobRow({
              ...base,
              jobId: "job_completed_progress",
              progress: completedProgress,
            }),
            status: "queued",
            result: {
              requested: 1,
              imported: 1,
              observed: 1,
              reapplied: 0,
              skipped: 0,
              failed: 0,
              outcomes: [],
            },
          },
        ],
      });
      const services = createSourceObservationRuntime(
        harness.deps,
        {} as CatalogItemServices,
        {} as ReferenceDataServices,
      );

      const jobs = await services.listRecentIntegrationJobs({ context });
      const statusByJobId = new Map(jobs.map((job) => [job.jobId, job.operatorStatus]));

      expect(statusByJobId.get("job_stale_progress")).toBe("stale");
      expect(statusByJobId.get("job_running_progress")).toBe("running");
      expect(statusByJobId.get("job_completed_progress")).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an empty recent integration job list when request context is missing", async () => {
    const harness = createIntegrationJobDedupeHarness({
      recentJobs: [
        integrationJobRow({
          jobId: "job_completed_import",
          action: "import",
          scope: { provider: "scrydex", language: "en", setId: "op-01" },
          eventContext: context,
        }),
      ],
    });
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    await expect(services.listRecentIntegrationJobs({ context: null })).resolves.toEqual([]);
    expect(harness.queryCount).toBe(0);
  });

  it("propagates credential readiness separately from semantic readiness", async () => {
    const harness = createIntegrationJobDedupeHarness();
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
    );

    const readiness = await services.getCatalogIntegrationControlPlaneReadiness();
    const unitsByKey = Object.fromEntries(readiness.units.map((unit) => [unit.unitKey, unit]));

    expect(unitsByKey["reference-cards:pokemon:single-card:source-observation-proof"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
    });
    expect(unitsByKey["tcgdex:pokemon:single-card:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
    });
    expect(unitsByKey["mtgjson:mtg:single-card:reference-data"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
      transportReadiness: "ready",
      dryRunStatus: "completed",
    });
    expect(unitsByKey["mtgjson:mtg:set:reference-data"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
      transportReadiness: "ready",
      dryRunStatus: "completed",
    });
    expect(unitsByKey["scryfall:mtg:single-card:reference-data"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
      transportReadiness: "ready",
      dryRunStatus: "completed",
    });
    expect(unitsByKey["scryfall:mtg:single-card:image-evidence"]).toMatchObject({
      semanticReadiness: "ready",
      credentialReadiness: "not-required",
      credentialReadinessState: "not-required",
      transportReadiness: "ready",
      dryRunStatus: "completed",
    });
    expect(unitsByKey["tcgplayer:mtg:single-card:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "unknown",
      credentialDiagnosticCode: "provider-retired",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["tcgplayer:mtg:sealed-product:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "unknown",
      credentialDiagnosticCode: "provider-retired",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["tcgplayer:pokemon:single-card:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "unknown",
      credentialDiagnosticCode: "provider-retired",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["tcgplayer:lorcana:single-card:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "unknown",
      credentialDiagnosticCode: "provider-retired",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["tcgplayer:lorcana:sealed-product:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "unknown",
      credentialDiagnosticCode: "provider-retired",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["tcgplayer:one-piece:single-card:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "unknown",
      credentialDiagnosticCode: "provider-retired",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["tcgplayer:one-piece:sealed-product:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "unknown",
      credentialDiagnosticCode: "provider-retired",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["scrydex:one-piece:single-card:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "missing",
      credentialDiagnosticCode: "credential-missing",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["scrydex:one-piece:set:reference-data"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "missing",
      credentialDiagnosticCode: "credential-missing",
      transportReadiness: "blocked",
    });
    expect(unitsByKey["scrydex:one-piece:sealed-product:source-observation-import"]).toMatchObject({
      semanticReadiness: "ready",
      fixtureValidationStatus: "ready",
      dryRunStatus: "completed",
      observationFacts: 1,
      credentialReadiness: "blocked",
      credentialReadinessState: "missing",
      credentialDiagnosticCode: "credential-missing",
      transportReadiness: "blocked",
    });
  });
});

function ygojsonBeginnerEditionTwoFetch(): typeof globalThis.fetch {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("./__fixtures__/ygojson-yugioh-set-reference-data/beginners-edition-2.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { set: Record<string, unknown> };
  const url =
    "https://raw.githubusercontent.com/iconmaster5326/YGOJSON/refs/heads/v1/individual/sets/000f0093-1847-4db7-a315-5bd07f055c7a.json";

  return (async (input: RequestInfo | URL) => {
    if (String(input) !== url) {
      return new Response(null, { status: 404 });
    }
    return new Response(JSON.stringify(fixture.set), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function mtgjsonFetch(options: Readonly<{ oversizedSet?: boolean }> = {}): typeof globalThis.fetch {
  const card = {
    uuid: "13fd9d47-9aa7-5f7c-8f47-fury-sliver",
    name: "Fury Sliver",
    number: "157",
    rarity: "uncommon",
    layout: "normal",
    identifiers: {
      scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
      scryfallOracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
    },
  };
  const responses: Record<string, unknown> = {
    "https://mtgjson.com/api/v5/SetList.json": {
      meta: { date: "2026-06-05", version: "5.3.0+20260605" },
      data: [
        {
          code: "TSP",
          name: "Time Spiral",
          releaseDate: "2006-10-06",
          totalSetSize: 301,
          type: "expansion",
        },
      ],
    },
    "https://mtgjson.com/api/v5/TSP.json": {
      meta: { date: "2026-06-05", version: "5.3.0+20260605" },
      data: {
        code: "TSP",
        name: "Time Spiral",
        releaseDate: "2006-10-06",
        totalSetSize: 301,
        type: "expansion",
        cards: options.oversizedSet
          ? Array.from({ length: 1_500 }, (_, index) => ({
              ...card,
              uuid: `oversized-set-card-${index}`,
              name: `Oversized Set Card ${index}`,
              number: String(index + 1),
              flavorText: "Retained normalized provenance for the oversized provider document. ".repeat(2),
            }))
          : [card],
      },
    },
  };

  return (async (input: RequestInfo | URL) => {
    const body = responses[String(input)];
    if (!body) {
      return new Response(null, { status: 404 });
    }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function lorcanajsonFetch(): typeof globalThis.fetch {
  const responses: Record<string, unknown> = {
    "https://lorcanajson.org/files/current/en/allCards.json": {
      metadata: {
        formatVersion: "2.3.2",
        generatedOn: "2026-05-26T19:11:58",
        language: "en",
      },
      sets: {
        "1": {
          id: "1",
          code: "1",
          name: "The First Chapter",
          releaseDate: "2023-09-01",
          type: "expansion",
          number: 1,
        },
      },
      cards: [
        {
          id: "1-041",
          fullName: "Elsa - Snow Queen",
          number: "41",
          setCode: "1",
          rarity: "Super Rare",
          type: "Storyborn Hero Queen",
          color: "Amethyst",
          images: {
            full: "https://images.lorcanajson.org/cards/en/1/041.webp",
            thumbnail: "https://images.lorcanajson.org/cards/en/1/041-small.webp",
          },
          externalLinks: { tcgPlayerId: "1005010" },
        },
      ],
    },
    "https://lorcanajson.org/files/current/en/sets/setdata.1.json": {
      metadata: {
        formatVersion: "2.3.2",
        generatedOn: "2026-05-26T19:11:58",
        language: "en",
      },
      code: "1",
      name: "The First Chapter",
      releaseDate: "2023-09-01",
      cards: [
        {
          id: "1-041",
          fullName: "Elsa - Snow Queen",
          number: "41",
          setCode: "1",
          rarity: "Super Rare",
          type: "Storyborn Hero Queen",
          color: "Amethyst",
          images: {
            full: "https://images.lorcanajson.org/cards/en/1/041.webp",
            thumbnail: "https://images.lorcanajson.org/cards/en/1/041-small.webp",
          },
          externalLinks: { tcgPlayerId: "1005010" },
        },
      ],
    },
  };

  return (async (input: RequestInfo | URL) => {
    const body = responses[String(input)];
    if (!body) {
      return new Response(null, { status: 404 });
    }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function lorcastFetch(): typeof globalThis.fetch {
  const responses: Record<string, unknown> = {
    "https://api.lorcast.com/v0/sets": {
      results: [
        {
          id: "set_7ecb0e0c71af496a9e0110e23824e0a5",
          code: "1",
          name: "The First Chapter",
          released_at: "2023-08-18",
          prereleased_at: "2023-08-18",
        },
      ],
    },
    "https://api.lorcast.com/v0/sets/1/cards": [
      {
        id: "crd_elsa_snow_queen_1_041",
        name: "Elsa",
        version: "Snow Queen",
        released_at: "2023-08-18",
        image_uris: {
          digital: {
            large: "https://cards.lorcast.io/card/digital/large/crd_elsa_snow_queen_1_041.avif",
          },
        },
        ink: "Amethyst",
        type: ["Character"],
        rarity: "Super Rare",
        collector_number: "41",
        lang: "en",
        tcgplayer_id: 1005010,
        set: {
          id: "set_7ecb0e0c71af496a9e0110e23824e0a5",
          code: "1",
          name: "The First Chapter",
        },
        prices: { usd: "1.23" },
      },
    ],
  };

  return (async (input: RequestInfo | URL) => {
    const body = responses[String(input)];
    if (!body) {
      return new Response(null, { status: 404 });
    }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function scrydexOnePieceFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/account/v1/usage")) {
      // Synthetic values in the real Scrydex usage envelope; the period covers the read.
      return jsonResponse({
        data: {
          total_credits_consumed: 100,
          overage_credits_consumed: 0,
          credits_remaining: 900,
          period_start: new Date(Date.now() - 86_400_000).toISOString(),
          period_end: new Date(Date.now() + 29 * 86_400_000).toISOString(),
          daily_usage: [{ date: "2026-06-21", credits_consumed: 100 }],
        },
      });
    }

    if (url.includes("/onepiece/v1/cards") && url.includes("q=printings%3Aop-01")) {
      return jsonResponse({
        data: [
          {
            id: "op01-001",
            name: "Monkey.D.Luffy",
            number: "001",
            printed_number: "OP01-001",
            rarity: "Leader",
            rarity_code: "L",
            type: "Leader",
            language_code: "en",
            expansion: {
              id: "op-01",
              name: "Romance Dawn",
              code: "OP-01",
              total: 121,
              release_date: "2022-12-02",
              language_code: "en",
            },
            printings: ["OP-01", "PRB01"],
            variants: [{ name: "normal", printings: ["OP-01"] }],
          },
        ],
        total_pages: 1,
      });
    }

    if (url.includes("/onepiece/v1/expansions")) {
      return jsonResponse({
        data: [
          {
            id: "op-01",
            name: "Romance Dawn",
            code: "OP-01",
            total: 121,
            release_date: "2022-12-02",
            language_code: "en",
          },
        ],
        total_pages: 1,
      });
    }

    if (url.includes("/lorcana/v1/expansions/1/cards")) {
      return jsonResponse({
        data: [
          {
            id: "tfc-041",
            name: "Elsa - Snow Queen",
            number: "41",
            printed_number: "41/204",
            rarity: "Super Rare",
            rarity_code: "SR",
            type: "Character",
            ink: "Amethyst",
            language_code: "en",
            expansion: { id: "1", name: "The First Chapter", code: "TFC", total: 204, release_date: "2023-08-18" },
            printings: ["TFC"],
            variants: [{ name: "standard", printings: ["TFC"] }],
            tcgplayer_id: "1005010",
          },
        ],
        total_pages: 1,
      });
    }

    if (url.includes("/lorcana/v1/expansions")) {
      return jsonResponse({
        data: [
          {
            id: "1",
            name: "The First Chapter",
            code: "TFC",
            total: 204,
            release_date: "2023-08-18",
            language_code: "en",
          },
        ],
        total_pages: 1,
      });
    }

    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function expectUnitRolloutDenial(error: unknown, controlId: string, unitKey: string) {
  expect(error).toBeInstanceOf(CatalogIntegrationRolloutControlError);
  expect((error as CatalogIntegrationRolloutControlError).decision.controls).toEqual([
    expect.objectContaining({ controlId, status: "blocked", unitKeys: expect.arrayContaining([unitKey]) }),
  ]);
}

const SCRYDEX_ONE_PIECE_PROFILE_KEY = "one-piece-card-print-source-observation";
const SCRYDEX_ONE_PIECE_SET_PROFILE_KEY = "one-piece-set-reference-data";
const SCRYDEX_LORCANA_PROFILE_KEY = "lorcana-card-print-source-observation";
const SCRYDEX_ONE_PIECE_SCOPE = {
  provider: "scrydex",
  profileKey: SCRYDEX_ONE_PIECE_PROFILE_KEY,
  language: "en",
  setId: "op-01",
};
const SCRYDEX_ONE_PIECE_SET_SCOPE = {
  provider: "scrydex",
  profileKey: SCRYDEX_ONE_PIECE_SET_PROFILE_KEY,
  language: "en",
  setId: "op-01",
};
const SCRYDEX_LORCANA_SCOPE = {
  provider: "scrydex",
  profileKey: SCRYDEX_LORCANA_PROFILE_KEY,
  language: "en",
  setId: "1",
};

function sharedScrydexProfileVersions() {
  return createMutableProfileVersionReader(
    catalogProviderIntegrationProfileVersions.filter(
      (version) =>
        version.providerKey === "scrydex" &&
        [SCRYDEX_ONE_PIECE_PROFILE_KEY, SCRYDEX_ONE_PIECE_SET_PROFILE_KEY, SCRYDEX_LORCANA_PROFILE_KEY].includes(
          version.profileKey,
        ),
    ),
  );
}

async function resolvedScrydexUnitKey(profileKey: string): Promise<string> {
  const version = await sharedScrydexProfileVersions().getActiveProfileVersion("scrydex", { profileKey });
  if (!version) throw new Error(`Expected an active Scrydex profile for ${profileKey}.`);
  return catalogProviderProfileVersionIngestionUnitKey(version);
}

async function runQueuedScrydexImport(input: {
  policy: CatalogIntegrationRolloutControlPolicy;
  scope: Record<string, unknown>;
  fetch?: typeof globalThis.fetch;
  profileSnapshot?: Record<string, unknown> | null;
  profileVersions?: ReturnType<typeof sharedScrydexProfileVersions>;
}) {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SCRYDEX_API_KEY;
  const originalTeamId = process.env.SCRYDEX_TEAM_ID;
  process.env.SCRYDEX_API_KEY = "test-key";
  process.env.SCRYDEX_TEAM_ID = "main";
  const fetch = vi.fn(input.fetch ?? scrydexOnePieceFetch());
  globalThis.fetch = fetch as typeof globalThis.fetch;
  const harness = createIntegrationJobClaimHandoffHarness({
    scope: input.scope,
    profileSnapshot: input.profileSnapshot ?? null,
    renewSucceeds: true,
  });
  try {
    const services = createSourceObservationRuntime(
      harness.deps,
      {} as CatalogItemServices,
      harness.referenceData,
      input.profileVersions ?? sharedScrydexProfileVersions(),
      input.policy,
    );
    await expect(services.processNextIntegrationJob({ claimOwnerId: "worker-1", claimTtlMs: 120_000 })).resolves.toBe(
      1,
    );
  } finally {
    restoreEnvValue("SCRYDEX_API_KEY", originalApiKey);
    restoreEnvValue("SCRYDEX_TEAM_ID", originalTeamId);
    globalThis.fetch = originalFetch;
  }
  return { harness, transportCalls: fetch.mock.calls };
}

function runQueuedScrydexLorcanaCardImport(
  language: string,
  cards: readonly { id: string; name: string; number: string }[],
) {
  const fixtureFetch = scrydexOnePieceFetch();
  return runQueuedScrydexImport({
    scope: { ...SCRYDEX_LORCANA_SCOPE, setId: "synthetic-set" },
    policy: createCatalogIntegrationRolloutControlPolicy(),
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/lorcana/v1/cards" && url.searchParams.get("q") === "expansion.id:synthetic-set") {
        return jsonResponse({
          data: cards.map((card) => ({
            ...card,
            language,
            tcgplayer_id: Number(card.number),
            expansion: { id: "synthetic-set", name: "Synthetic Lorcana Set" },
          })),
          total_pages: 1,
        });
      }
      return fixtureFetch(input);
    },
  });
}

describe("source observation runtime: resolved-unit import rollout enforcement", () => {
  it("denies import preview and start for a stopped resolved unit while a sibling Scrydex unit proceeds", async () => {
    const stoppedUnitKey = await resolvedScrydexUnitKey(SCRYDEX_ONE_PIECE_PROFILE_KEY);
    const policy = createCatalogIntegrationRolloutControlPolicy({ disabledImportUnits: [stoppedUnitKey] });
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.SCRYDEX_API_KEY;
    const originalTeamId = process.env.SCRYDEX_TEAM_ID;
    process.env.SCRYDEX_API_KEY = "test-key";
    process.env.SCRYDEX_TEAM_ID = "main";
    const fetch = vi.fn(scrydexOnePieceFetch());
    globalThis.fetch = fetch as typeof globalThis.fetch;
    try {
      const previewServices = createSourceObservationRuntime(
        { db: {} } as CatalogRuntimeDeps,
        {} as CatalogItemServices,
        {} as ReferenceDataServices,
        sharedScrydexProfileVersions(),
        policy,
      );
      const previewError = await previewServices
        .previewIntegrationImport({ scope: SCRYDEX_ONE_PIECE_SCOPE, context })
        .catch((error: unknown) => error);
      expectUnitRolloutDenial(previewError, "imports-disabled", stoppedUnitKey);
      expect(fetch).not.toHaveBeenCalled();

      await expect(
        previewServices.previewIntegrationImport({ scope: SCRYDEX_LORCANA_SCOPE, context }),
      ).resolves.toMatchObject({
        profileSnapshot: {
          providerKey: "scrydex",
          ingestionUnitKey: await resolvedScrydexUnitKey(SCRYDEX_LORCANA_PROFILE_KEY),
        },
      });

      const startHarness = createIntegrationJobDedupeHarness();
      const startServices = createSourceObservationRuntime(
        startHarness.deps,
        {} as CatalogItemServices,
        {} as ReferenceDataServices,
        sharedScrydexProfileVersions(),
        policy,
      );
      const startError = await startServices
        .enqueueIntegrationJob({ action: "import", scope: SCRYDEX_ONE_PIECE_SCOPE, context })
        .catch((error: unknown) => error);
      expectUnitRolloutDenial(startError, "imports-disabled", stoppedUnitKey);
      expect(startHarness.insertedJobs).toEqual([]);
      await expect(
        startServices.enqueueIntegrationJob({ action: "import", scope: SCRYDEX_LORCANA_SCOPE, context }),
      ).resolves.toMatchObject({ status: "queued" });
      expect(startHarness.insertedJobs).toHaveLength(1);
    } finally {
      restoreEnvValue("SCRYDEX_API_KEY", originalApiKey);
      restoreEnvValue("SCRYDEX_TEAM_ID", originalTeamId);
      globalThis.fetch = originalFetch;
    }
  });

  it("denies queued import execution when a unit stop is introduced after enqueue", async () => {
    const stoppedUnitKey = await resolvedScrydexUnitKey(SCRYDEX_ONE_PIECE_PROFILE_KEY);
    const enqueueHarness = createIntegrationJobDedupeHarness();
    await createSourceObservationRuntime(
      enqueueHarness.deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      sharedScrydexProfileVersions(),
      createCatalogIntegrationRolloutControlPolicy(),
    ).enqueueIntegrationJob({ action: "import", scope: SCRYDEX_ONE_PIECE_SCOPE, context });
    const enqueuedPayload = enqueueHarness.insertedJobs[0]?.payload as {
      scope: Record<string, unknown>;
      profileSnapshot: Record<string, unknown>;
    };
    expect(enqueuedPayload.profileSnapshot).toMatchObject({ ingestionUnitKey: stoppedUnitKey });
    const denied = await runQueuedScrydexImport({
      policy: createCatalogIntegrationRolloutControlPolicy({ disabledImportUnits: [stoppedUnitKey] }),
      scope: enqueuedPayload.scope,
      profileSnapshot: enqueuedPayload.profileSnapshot,
      profileVersions: sharedScrydexProfileVersions(),
    });
    expect(denied.harness.job.status).toBe("failed");
    expect(denied.harness.job.error_message).toBe(
      "Catalog integration imports are disabled for the configured ingestion-unit scope.",
    );
    expect(denied.transportCalls).toEqual([]);
    expect(denied.harness.appendedSourceEvents).toEqual([]);
    const sibling = await runQueuedScrydexImport({
      policy: createCatalogIntegrationRolloutControlPolicy({ disabledImportUnits: [stoppedUnitKey] }),
      scope: SCRYDEX_ONE_PIECE_SET_SCOPE,
    });
    expect(sibling.harness.job.status).toBe("completed");
    expect(sibling.harness.appendedSourceEvents.length).toBeGreaterThan(0);
  });

  it("enforces the existing One Piece signoff per resolved unit without gating another game on the shared Scrydex provider", async () => {
    const onePieceUnitKey = await resolvedScrydexUnitKey(SCRYDEX_ONE_PIECE_PROFILE_KEY);
    const unsignedPolicy = createCatalogIntegrationRolloutControlPolicy({ onePieceProductionSignoffReference: null });
    const unsigned = await runQueuedScrydexImport({ policy: unsignedPolicy, scope: SCRYDEX_ONE_PIECE_SCOPE });
    expect(unsigned.harness.job.status).toBe("failed");
    expect(unsigned.harness.job.error_message).toContain(
      "One Piece production sync requires recorded provider-data signoff",
    );
    expect(unsigned.transportCalls).toEqual([]);
    expect(unsigned.harness.appendedSourceEvents).toEqual([]);
    const unsignedStartError = await createSourceObservationRuntime(
      createIntegrationJobDedupeHarness().deps,
      {} as CatalogItemServices,
      {} as ReferenceDataServices,
      sharedScrydexProfileVersions(),
      unsignedPolicy,
    )
      .enqueueIntegrationJob({ action: "import", scope: SCRYDEX_ONE_PIECE_SCOPE, context })
      .catch((error: unknown) => error);
    expectUnitRolloutDenial(unsignedStartError, "one-piece-production-signoff-required", onePieceUnitKey);
    const otherGame = await runQueuedScrydexImport({ policy: unsignedPolicy, scope: SCRYDEX_LORCANA_SCOPE });
    expect(otherGame.harness.job.status).toBe("completed");
    const signed = await runQueuedScrydexImport({
      policy: createCatalogIntegrationRolloutControlPolicy({
        onePieceProductionSignoffReference: "#2285 UI-only staging UAT evidence",
      }),
      scope: SCRYDEX_ONE_PIECE_SCOPE,
    });
    expect(signed.harness.job.status).toBe("completed");
    expect(signed.harness.appendedSourceEvents.length).toBeGreaterThan(0);
  });

  it("keeps global, provider and unit emergency denials effective at queued import execution", async () => {
    const unitKey = await resolvedScrydexUnitKey(SCRYDEX_ONE_PIECE_PROFILE_KEY);
    const denials = [
      {
        policy: createCatalogIntegrationRolloutControlPolicy({ controlPlaneMode: "dry-run-only" }),
        message: "Catalog Integration Control Plane dry-run-only mode is active.",
      },
      {
        policy: createCatalogIntegrationRolloutControlPolicy({ providerApiEmergencyStop: ["scrydex"] }),
        message: "Provider API emergency stop is active for the configured provider scope.",
      },
      {
        policy: createCatalogIntegrationRolloutControlPolicy({ providerApiEmergencyStopUnits: [unitKey] }),
        message: "Provider API emergency stop is active for the configured ingestion-unit scope.",
      },
    ];
    for (const denial of denials) {
      const result = await runQueuedScrydexImport({ policy: denial.policy, scope: SCRYDEX_ONE_PIECE_SCOPE });
      expect(result.harness.job.status).toBe("failed");
      expect(result.harness.job.error_message).toBe(denial.message);
      expect(result.transportCalls).toEqual([]);
    }
  });
});

describe("source observation runtime: resolved-unit import rollout enforcement", () => {
  it("denies starting a current-active reapply for the resolved stopped unit and defers original-source reapply to per-unit execution", async () => {
    const tcgdexUnitKey = catalogProviderProfileVersionIngestionUnitKey(currentTcgdexProfileVersion());
    const policy = createCatalogIntegrationRolloutControlPolicy({ disabledReapplyUnits: [tcgdexUnitKey] });
    const reapplyScope = { provider: "tcgdex", language: "en", setId: "base1" };
    const runtimeWith = (rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy) => {
      const harness = createIntegrationJobDedupeHarness({ reapplyObservationIds: ["obs_promoted_1"] });
      const services = createSourceObservationRuntime(
        harness.deps,
        {} as CatalogItemServices,
        {} as ReferenceDataServices,
        createMutableProfileVersionReader([currentTcgdexProfileVersion()]),
        rolloutControlPolicy,
      );
      return { harness, services };
    };

    const denied = runtimeWith(policy);
    const error = await denied.services
      .enqueueIntegrationJob({ action: "reapply", scope: reapplyScope, context })
      .catch((caught: unknown) => caught);
    expectUnitRolloutDenial(error, "reapply-disabled", tcgdexUnitKey);
    expect(denied.harness.insertedJobs).toEqual([]);

    const unscoped = runtimeWith(withoutRolloutUnitKey(policy));
    await expect(
      unscoped.services.enqueueIntegrationJob({ action: "reapply", scope: reapplyScope, context }),
    ).resolves.toMatchObject({ operatorStatus: "queued" });

    // Original-source reapply carries no job-wide profile; each work unit enforces its recorded unit.
    const originalSource = runtimeWith(policy);
    await expect(
      originalSource.services.enqueueIntegrationJob({
        action: "reapply",
        scope: reapplyScope,
        reapplyProfileMode: "original-source-profile",
        context,
      }),
    ).resolves.toMatchObject({ operatorStatus: "queued", profileSnapshot: null });
  });

  it("denies starting a filter-scoped bulk reapply for the resolved stopped unit", async () => {
    const tcgdexUnitKey = catalogProviderProfileVersionIngestionUnitKey(currentTcgdexProfileVersion());
    const policy = createCatalogIntegrationRolloutControlPolicy({ disabledReapplyUnits: [tcgdexUnitKey] });
    const insertedSql: string[] = [];
    const runtimeWith = (rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy) =>
      createSourceObservationRuntime(
        {
          db: {
            query: async <T>(sql: string) => {
              if (sql.includes("INSERT INTO")) {
                insertedSql.push(sql);
              }
              return { rowCount: 0, rows: [] as T[] };
            },
          },
        } as unknown as CatalogRuntimeDeps,
        {} as CatalogItemServices,
        {} as ReferenceDataServices,
        createMutableProfileVersionReader([currentTcgdexProfileVersion()]),
        rolloutControlPolicy,
      );

    const error = await runtimeWith(policy)
      .enqueueBulkReviewJob({ action: "reapply", scope: { provider: "tcgdex" }, context })
      .catch((caught: unknown) => caught);
    expectUnitRolloutDenial(error, "reapply-disabled", tcgdexUnitKey);
    expect(insertedSql).toEqual([]);

    const unscopedError = await runtimeWith(withoutRolloutUnitKey(policy))
      .enqueueBulkReviewJob({ action: "reapply", scope: { provider: "tcgdex" }, context })
      .catch((caught: unknown) => caught);
    expect(unscopedError).not.toBeInstanceOf(CatalogIntegrationRolloutControlError);
  });
});
