import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogSyncRun } from "../../source-observations/api/runtime";
import { scopeSyncBatchStatusFromUnits } from "../domain/batch";
import { createScopeSyncBatchWorker, type ClaimedScopeSyncBatchUnit } from "./worker";

const context: EventStoreContext = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
};

function claim(overrides: Partial<ClaimedScopeSyncBatchUnit> = {}): ClaimedScopeSyncBatchUnit {
  const scopeRecordId = overrides.scopeRecordId ?? "scope-1";
  const scope: ClaimedScopeSyncBatchUnit["plan"]["scope"] = {
    scopeVersion: "catalog-sync-scope-v2",
    productDomain: "pokemon",
    reference: { kind: "expansion", scopeRecordId },
  };
  return {
    batchId: "batch-1",
    scopeRecordId,
    state: "queued",
    syncRunId: null,
    budget: {
      maxScopesPerTurn: 1,
      defaultProviderConcurrency: 1,
      providerConcurrency: {},
      providerRequestLimits: {},
      creditedProviderRequestLimits: {},
      providerFailureThreshold: 3,
    },
    context,
    plan: {
      scopeRecordId,
      scopeRecordVersion: "v1",
      mappingVersions: [],
      profileVersions: [],
      providerKeys: ["tcgdex"],
      providerUnitCount: 1,
      estimatedRequestCount: 1,
      creditedProviderRequestEstimates: {},
      scope,
      participationPreview: {
        previewVersion: "catalog-sync-provider-participation-preview-v1",
        scope,
        status: "ready",
        startAllowed: true,
        units: [],
        estimate: {
          totalEstimatedRequestCount: 1,
          estimateState: "estimated",
          estimateReason: null,
          creditConsumingProviders: [],
        },
        blockers: [],
        explanation: "ready",
      },
      blockers: [],
    },
    ...overrides,
  };
}

function run(status: CatalogSyncRun["status"]): CatalogSyncRun {
  return {
    syncRunId: "run-1",
    scope: claim().plan.scope,
    status,
    progress: {
      childJobs: { total: 1, queued: 0, running: 0, completed: 1, partial: 0, failed: 0, cancelled: 0, stale: 0 },
      providerTargets: { completed: 1, total: 1 },
    },
    selectedUnits: [],
    childJobs: [],
    consistency: {
      duplicateSubmissionPolicy: "reuse-active-sync-run" as const,
      childScopePolicy: "deterministic-from-provider-participation-preview" as const,
      profileSnapshotPolicy: "selected-active-provider-units-snapshotted-at-enqueue" as const,
      childRetryResumeCancelPolicy: "delegated-to-provider-import-jobs" as const,
      partialFailurePolicy: "visible-per-provider-child-job" as const,
    },
    preview: claim().plan.participationPreview,
    errorMessage: status === "failed" ? "provider failed" : null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

describe("Scope Sync Batch worker", () => {
  it("enqueues one Scope Sync Run in one bounded turn", async () => {
    const recordRunning = vi.fn();
    const repository = {
      claimNext: vi.fn().mockResolvedValueOnce(claim()).mockResolvedValueOnce(null),
      recordRunning,
      recordTerminal: vi.fn(),
    };
    const worker = createScopeSyncBatchWorker({
      repository,
      enqueueCatalogSyncRun: vi.fn().mockResolvedValue(run("running")),
      getCatalogSyncRun: vi.fn(),
    });
    await expect(worker.processNext({ claimOwnerId: "worker-1", claimTtlMs: 30_000 })).resolves.toBe(1);
    expect(recordRunning).toHaveBeenCalledWith(expect.objectContaining({ syncRunId: "run-1" }));
    expect(repository.recordTerminal).not.toHaveBeenCalled();
  });

  it("reconciles restart-surviving running units without re-enqueue", async () => {
    const repository = {
      claimNext: vi
        .fn()
        .mockResolvedValueOnce(claim({ state: "running", syncRunId: "run-1" }))
        .mockResolvedValueOnce(null),
      recordRunning: vi.fn(),
      recordTerminal: vi.fn(),
    };
    const enqueue = vi.fn();
    const worker = createScopeSyncBatchWorker({
      repository,
      enqueueCatalogSyncRun: enqueue,
      getCatalogSyncRun: vi.fn().mockResolvedValue(run("completed")),
    });
    await worker.processNext({ claimOwnerId: "replacement-worker", claimTtlMs: 30_000 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(repository.recordTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ state: "completed", errorMessage: null }),
    );
  });

  it("isolates a partial provider failure to its scope unit", async () => {
    const partialRun = run("partial");
    const scope = { provider: "mtgjson", setName: "TSP" };
    const reason = "Provider import failed for https://provider.example/path token=mock-value";
    const child: CatalogSyncRun["childJobs"][number] = {
      providerKey: "mtgjson",
      unitKey: "mtgjson:mtg:single-card:reference-data",
      profileKey: "mtg-single-card",
      profileVersion: "v1",
      displayName: "MTGJSON",
      childExecutionScope: scope,
      childJobId: "job-child",
      syncRunLinkState: "attached-to-child-payload",
      errorMessage: null,
      status: "partial",
      job: {
        jobId: "job-child",
        syncRunId: partialRun.syncRunId,
        action: "import",
        scope,
        profileSnapshot: null,
        reapplyProfileMode: null,
        status: "completed",
        operatorStatus: "partial",
        consistency: {
          duplicateSubmissionPolicy: "reuse-active-job",
          profileSnapshotPolicy: "snapshotted-at-enqueue",
          retryResumePolicy: "skip-completed-outcomes",
          partialFailurePolicy: "mixed-outcomes",
          workUnitClaimPolicy: "leased-job-turns",
        },
        progress: { phase: "completed", completed: 1, total: 1, currentName: null, status: null },
        result: {
          requested: 1,
          imported: 0,
          observed: 0,
          reapplied: 0,
          skipped: 0,
          failed: 1,
          outcomes: [
            {
              providerKey: "mtgjson",
              languageCode: "en",
              expansionId: "TSP",
              status: "failed",
              observed: 0,
              reapplied: 0,
              reason,
            },
          ],
        },
        errorMessage: null,
        createdAt: partialRun.createdAt,
        startedAt: partialRun.createdAt,
        completedAt: partialRun.updatedAt,
        updatedAt: partialRun.updatedAt,
      },
    };
    const repository = {
      claimNext: vi
        .fn()
        .mockResolvedValueOnce(claim({ state: "running", syncRunId: "run-1" }))
        .mockResolvedValueOnce(null),
      recordRunning: vi.fn(),
      recordTerminal: vi.fn(),
    };
    const worker = createScopeSyncBatchWorker({
      repository,
      enqueueCatalogSyncRun: vi.fn(),
      getCatalogSyncRun: vi.fn().mockResolvedValue({ ...partialRun, childJobs: [child] }),
    });
    await worker.processNext({ claimOwnerId: "worker-1", claimTtlMs: 30_000 });
    expect(repository.recordTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        state: "failed",
        errorMessage: "Provider import failed for [redacted-url] [redacted]",
      }),
    );
  });

  it("completes both scopes after their existing runs finish without starting either twice", async () => {
    const first = claim();
    const second = claim({ scopeRecordId: "scope-2" });
    const repository = {
      claimNext: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce({ ...first, state: "running", syncRunId: "run-1" })
        .mockResolvedValueOnce(second)
        .mockResolvedValueOnce({ ...second, state: "running", syncRunId: "run-2" })
        .mockResolvedValueOnce({ ...second, state: "running", syncRunId: "run-2" }),
      recordRunning: vi.fn(),
      recordTerminal: vi.fn(),
    };
    const enqueueCatalogSyncRun = vi
      .fn()
      .mockResolvedValueOnce(run("queued"))
      .mockResolvedValueOnce({ ...run("queued"), syncRunId: "run-2" });
    const worker = createScopeSyncBatchWorker({
      repository,
      enqueueCatalogSyncRun,
      getCatalogSyncRun: vi
        .fn()
        .mockResolvedValueOnce(run("completed"))
        .mockResolvedValueOnce({ ...run("running"), syncRunId: "run-2" })
        .mockResolvedValueOnce({ ...run("completed"), syncRunId: "run-2" }),
    });
    const turn = { claimOwnerId: "worker-1", claimTtlMs: 30_000 };
    for (let step = 0; step < 4; step++) await worker.processNext(turn);
    expect(repository.recordTerminal).toHaveBeenCalledExactlyOnceWith({
      claim: { ...first, state: "running", syncRunId: "run-1" },
      state: "completed",
      errorMessage: null,
    });

    await worker.processNext(turn);
    expect(enqueueCatalogSyncRun).toHaveBeenCalledTimes(2);
    expect(enqueueCatalogSyncRun).toHaveBeenNthCalledWith(1, { scope: first.plan.scope, context });
    expect(enqueueCatalogSyncRun).toHaveBeenNthCalledWith(2, { scope: second.plan.scope, context });
    expect(repository.recordTerminal).toHaveBeenLastCalledWith({
      claim: { ...second, state: "running", syncRunId: "run-2" },
      state: "completed",
      errorMessage: null,
    });
    expect(scopeSyncBatchStatusFromUnits(repository.recordTerminal.mock.calls.map(([unit]) => unit.state))).toBe(
      "completed",
    );
  });

  it("processes no more than the configured scopes per worker turn", async () => {
    const boundedClaim = claim({
      budget: { ...claim().budget, maxScopesPerTurn: 2 },
    });
    const repository = {
      claimNext: vi
        .fn()
        .mockResolvedValueOnce(boundedClaim)
        .mockResolvedValueOnce(claim({ ...boundedClaim, scopeRecordId: "scope-2" })),
      recordRunning: vi.fn(),
      recordTerminal: vi.fn(),
    };
    const worker = createScopeSyncBatchWorker({
      repository,
      enqueueCatalogSyncRun: vi.fn().mockResolvedValue(run("running")),
      getCatalogSyncRun: vi.fn(),
    });

    await expect(worker.processNext({ claimOwnerId: "worker-1", claimTtlMs: 30_000 })).resolves.toBe(2);
    expect(repository.claimNext).toHaveBeenCalledTimes(2);
  });
});
