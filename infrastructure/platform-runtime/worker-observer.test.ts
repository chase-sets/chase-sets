import { describe, expect, it, vi } from "vitest";
import type { PlatformControlPlane } from "./control-plane";
import {
  createWorkerRunnerLoop,
  type WorkerHolderLifecycleEvent,
  type WorkerLeaseEvent,
  type WorkerProjectionOperationEvent,
} from "./worker";
import { createWorkerObserver } from "./worker-observer";

const syntheticHolder: WorkerHolderLifecycleEvent = {
  workerId: "synthetic-worker",
  runnerName: "synthetic.holder",
  leaseIntervalId: "123e4567-e89b-42d3-a456-426614174000",
  timestamp: "2026-09-30T17:00:00.000Z",
  elapsedMs: 12.5,
  phase: "pass-end",
  passSeq: 1,
  outcome: "success",
  disposition: "retained",
  processed: 2,
};

function collectingLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("worker observer holder lifecycle adapter", () => {
  it("forwards the existing projection snapshot to the count publisher without logger filtering", () => {
    const publish = vi.fn();
    const observer = createWorkerObserver(collectingLogger(), "synthetic-worker", "synthetic-group", publish);
    const status = {
      targetContextName: "synthetic-context",
      projectionName: "synthetic-projection",
      blockedStreamCount: 1,
      poisonEventCount: 0,
    } as Parameters<NonNullable<typeof observer.projectionStatusObserved>>[0];
    observer.projectionStatusObserved?.(status);
    expect(publish).toHaveBeenCalledExactlyOnceWith(status);
    expect(createWorkerObserver(collectingLogger(), "synthetic-worker").projectionStatusObserved).toBeUndefined();
  });
  it("emits the allowlisted holder lifecycle log shape", () => {
    const logger = collectingLogger();
    const observer = createWorkerObserver(logger, "synthetic-worker", "synthetic-projections");
    observer.holderLifecycle?.(syntheticHolder);
    expect(logger.info.mock.calls).toEqual([
      [
        "Worker runner holder lifecycle.",
        {
          type: "worker.runner.holder_lifecycle",
          workerKind: "synthetic-worker",
          runnerGroup: "synthetic-projections",
          ...syntheticHolder,
        },
      ],
    ]);
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("omits secret and payload fields from holder logs", () => {
    const logger = collectingLogger();
    const observer = createWorkerObserver(logger, "synthetic-worker", "synthetic-projections");
    observer.holderLifecycle?.({
      ...syntheticHolder,
      fencingToken: "synthetic-secret-token",
      error: new Error("synthetic-secret-error"),
      payload: { privateData: "synthetic-private-data" },
      lease: { fencingToken: "synthetic-secret-lease" },
    } as unknown as WorkerHolderLifecycleEvent);
    expect(logger.info.mock.calls).toEqual([
      [
        "Worker runner holder lifecycle.",
        {
          type: "worker.runner.holder_lifecycle",
          workerKind: "synthetic-worker",
          runnerGroup: "synthetic-projections",
          ...syntheticHolder,
        },
      ],
    ]);
  });

  it("drops malformed lifecycle fields at every rejection branch", () => {
    const logger = collectingLogger();
    const observer = createWorkerObserver(logger, "synthetic-worker", "synthetic-projections");
    const malformed: unknown[] = [
      null,
      { ...syntheticHolder, workerId: "synthetic worker" },
      { ...syntheticHolder, runnerName: "synthetic/holder" },
      { ...syntheticHolder, leaseIntervalId: 1 },
      { ...syntheticHolder, leaseIntervalId: "synthetic-not-a-uuid" },
      { ...syntheticHolder, timestamp: 0 },
      { ...syntheticHolder, timestamp: "2026-09-30T17:00:00.000+00:00" },
      { ...syntheticHolder, timestamp: "2026-09-30T17:00:00.000" },
      { ...syntheticHolder, timestamp: "2026-99-30T17:00:00.000Z" },
      { ...syntheticHolder, timestamp: "2026-02-30T17:00:00.000Z" },
      { ...syntheticHolder, elapsedMs: -1 },
      { ...syntheticHolder, elapsedMs: Number.NaN },
      { ...syntheticHolder, phase: "pass-start", passSeq: 0 },
      { ...syntheticHolder, phase: "run-start", passSeq: 1.5 },
      { ...syntheticHolder, phase: "run-end", outcome: "unknown" },
      { ...syntheticHolder, outcome: "unknown" },
      { ...syntheticHolder, disposition: "unknown" },
      { ...syntheticHolder, processed: -1 },
      { ...syntheticHolder, processed: 1.5 },
      { ...syntheticHolder, phase: "lost", reason: "idle" },
      { ...syntheticHolder, phase: "released", reason: "unknown" },
      { ...syntheticHolder, phase: "release-failed", reason: "unknown" },
      { ...syntheticHolder, phase: "unknown" },
    ];
    for (const event of malformed) {
      observer.holderLifecycle?.(event as WorkerHolderLifecycleEvent);
      expect(logger.info, JSON.stringify(event)).not.toHaveBeenCalled();
    }
    for (const [kind, group] of [
      ["synthetic worker", "synthetic-projections"],
      ["synthetic-worker", "synthetic/group"],
    ]) {
      createWorkerObserver(logger, kind!, group).holderLifecycle?.(syntheticHolder);
      expect(logger.info).not.toHaveBeenCalled();
    }
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("preserves every existing observer mapping and completion log level", () => {
    const logger = collectingLogger();
    const observer = createWorkerObserver(logger, "synthetic-worker", "synthetic-group");
    const lease: WorkerLeaseEvent = {
      workerId: "synthetic-worker",
      runnerName: "synthetic.job",
      runnerKind: "job",
      leaseName: "job:synthetic.job",
      ownerId: "synthetic-owner",
      fencingToken: "synthetic-token",
    };
    const error = new Error("synthetic failure");
    const operation: WorkerProjectionOperationEvent = {
      operationId: "synthetic-operation",
      operationKind: "rebuild-projection-group",
      operationState: "running",
      workerId: "synthetic-worker",
      ownerId: "synthetic-owner",
      fencingToken: "synthetic-token",
      contextName: "synthetic-context",
      projectionName: "synthetic-projection",
      projectionKey: "synthetic-context.synthetic-projection",
      streamId: "synthetic-stream",
    };
    const cases = [
      {
        level: "debug",
        message: "Worker runner lease missed.",
        type: "worker.runner.lease_missed",
        event: lease,
        emit: () => observer.leaseMissed?.(lease),
      },
      {
        level: "warn",
        message: "Worker runner lease renewal failed.",
        type: "worker.runner.lease_renew_failed",
        event: { ...lease, error },
        emit: () => observer.leaseRenewFailed?.({ ...lease, error }),
      },
      {
        level: "info",
        message: "Worker runner completed.",
        type: "worker.runner.completed",
        event: { ...lease, processed: 1 },
        emit: () => observer.runnerCompleted?.({ ...lease, processed: 1 }),
      },
      {
        level: "debug",
        message: "Worker runner completed.",
        type: "worker.runner.completed",
        event: { ...lease, processed: 0 },
        emit: () => observer.runnerCompleted?.({ ...lease, processed: 0 }),
      },
      {
        level: "info",
        message: "Worker runner completed.",
        type: "worker.runner.completed",
        event: { ...lease, processed: 0, state: "degraded" },
        emit: () => observer.runnerCompleted?.({ ...lease, processed: 0, state: "degraded" }),
      },
      {
        level: "error",
        message: "Worker runner failed.",
        type: "worker.runner.failed",
        event: { ...lease, error },
        emit: () => observer.runnerFailed?.({ ...lease, error }),
      },
      {
        level: "info",
        message: "Projection operation started.",
        type: "projection.operation.started",
        event: operation,
        emit: () => observer.projectionOperationStarted?.(operation),
      },
      {
        level: "info",
        message: "Projection operation completed.",
        type: "projection.operation.completed",
        event: { ...operation, operationState: "succeeded" },
        emit: () => observer.projectionOperationCompleted?.({ ...operation, operationState: "succeeded" }),
      },
      {
        level: "error",
        message: "Projection operation failed.",
        type: "projection.operation.failed",
        event: { ...operation, operationState: "failed", error },
        emit: () => observer.projectionOperationFailed?.({ ...operation, operationState: "failed", error }),
      },
    ] as const;
    for (const entry of cases) {
      Object.values(logger).forEach((log) => log.mockClear());
      entry.emit();
      for (const [level, log] of Object.entries(logger)) {
        expect(log.mock.calls, entry.type).toEqual(
          level === entry.level
            ? [
                [
                  entry.message,
                  { type: entry.type, workerKind: "synthetic-worker", runnerGroup: "synthetic-group", ...entry.event },
                ],
              ]
            : [],
        );
      }
    }
  });

  it("isolates a throwing logger while the real worker loop keeps running", async () => {
    const failure = new Error("synthetic logger failure");
    const logger = {
      ...collectingLogger(),
      info: vi.fn(() => {
        throw failure;
      }),
    };
    const observer = createWorkerObserver(logger, "synthetic-worker", "synthetic-group");
    const unexpectedCall = async (): Promise<never> => {
      throw new Error("Unexpected synthetic control-plane call.");
    };
    const controlPlane: PlatformControlPlane = {
      acquireLease: async (input: Parameters<PlatformControlPlane["acquireLease"]>[0]) => ({
        leaseName: input.leaseName,
        ownerId: input.ownerId,
        fencingToken: "1",
        expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
      }),
      renewLease: async () => true,
      releaseLease: async () => undefined,
      recordRunnerStatus: async () => undefined,
      bootstrap: unexpectedCall,
      heartbeatWorker: unexpectedCall,
      recordProjectionStatusSnapshot: unexpectedCall,
      listProjectionStatusSnapshots: unexpectedCall,
      listWorkerHeartbeats: unexpectedCall,
      readWorkerHeartbeatHistory: unexpectedCall,
      listRunnerStatuses: unexpectedCall,
      listLeases: unexpectedCall,
      enqueueProjectionOperation: unexpectedCall,
      claimProjectionOperation: unexpectedCall,
      recordProjectionOperationProgress: unexpectedCall,
      completeProjectionOperation: unexpectedCall,
      failProjectionOperation: unexpectedCall,
      cancelProjectionOperation: unexpectedCall,
      getProjectionOperation: unexpectedCall,
      listProjectionOperations: unexpectedCall,
      listProjectionOperationEvents: unexpectedCall,
      waitForProjectionOperationEvents: unexpectedCall,
      summarizeProjectionOperations: unexpectedCall,
      claimScheduledRunner: unexpectedCall,
      recordScheduledRunnerCompleted: unexpectedCall,
      getProjectionWakeRelayCursor: unexpectedCall,
      listProjectionWakeRelayCursors: unexpectedCall,
      advanceProjectionWakeRelayCursor: unexpectedCall,
    };
    const runOnce = vi.fn(async () => ({ processed: 0, lastGlobalPosition: "0" as never }));
    const onError = vi.fn();
    const loop = createWorkerRunnerLoop({
      workerId: "synthetic-worker",
      controlPlane,
      runners: [{ name: "synthetic.holder", kind: "projection-group", runOnce }],
      maxConcurrentRunners: 1,
      leaseTtlMs: 60_000,
      leaseRenewIntervalMs: 60_000,
      pollIntervalMs: 5,
      observer,
      onError,
    });
    loop.start();
    try {
      await vi.waitFor(() => expect(runOnce.mock.calls.length).toBeGreaterThanOrEqual(2));
    } finally {
      await loop.stop();
    }
    expect(logger.info.mock.calls.length).toBeGreaterThan(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure, expect.objectContaining({ name: "synthetic.holder" }));
    expect(loop.status().stopped).toBe(true);
  });
});
