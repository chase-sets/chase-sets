import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createScopeSyncBatchWorker, type ClaimedScopeSyncBatchUnit } from "./worker";

const context: EventStoreContext = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
};

function claim(overrides: Partial<ClaimedScopeSyncBatchUnit> = {}): ClaimedScopeSyncBatchUnit {
  return {
    batchId: "batch-1",
    scopeRecordId: "scope-1",
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
      scopeRecordId: "scope-1",
      scopeRecordVersion: "v1",
      mappingVersions: [],
      profileVersions: [],
      providerKeys: ["tcgdex"],
      providerUnitCount: 1,
      estimatedRequestCount: 1,
      creditedProviderRequestEstimates: {},
      scope: {
        scopeVersion: "catalog-sync-scope-v2",
        productDomain: "pokemon",
        reference: { kind: "expansion", scopeRecordId: "scope_base_set" },
      },
      participationPreview: {
        previewVersion: "catalog-sync-provider-participation-preview-v1",
        scope: {
          scopeVersion: "catalog-sync-scope-v2",
          productDomain: "pokemon",
          reference: { kind: "expansion", scopeRecordId: "scope_base_set" },
        },
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

function run(status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled") {
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
      getCatalogSyncRun: vi.fn().mockResolvedValue(run("partial")),
    });
    await worker.processNext({ claimOwnerId: "worker-1", claimTtlMs: 30_000 });
    expect(repository.recordTerminal).toHaveBeenCalledWith(expect.objectContaining({ state: "failed" }));
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
