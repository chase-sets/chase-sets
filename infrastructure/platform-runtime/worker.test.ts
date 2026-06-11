import { describe, expect, it, vi } from "vitest";
import type { PlatformControlPlane } from "./control-plane";
import { collectWorkerRunners, createDurableJobLaneRunners, createWorkerRunnerLoop, type WorkerRunner } from "./worker";

describe("durable job lane runners", () => {
  it("creates stable platform runner names for same-job lanes", async () => {
    const seen: string[] = [];
    const runners = createDurableJobLaneRunners({
      workflowName: "catalog.source-observation-bulk-jobs",
      laneCount: 3,
      runLane: async (context) => {
        seen.push(`${context.laneIndex}:${context.laneName}:${context.laneCount}`);
        return { processed: context.laneIndex, lastGlobalPosition: "0" as never };
      },
    });

    await Promise.all(runners.map((runner) => runner.runOnce()));

    expect(runners.map((runner) => runner.name)).toEqual([
      "job:catalog.source-observation-bulk-jobs.lane-1",
      "job:catalog.source-observation-bulk-jobs.lane-2",
      "job:catalog.source-observation-bulk-jobs.lane-3",
    ]);
    expect(seen).toEqual([
      "1:job:catalog.source-observation-bulk-jobs.lane-1:3",
      "2:job:catalog.source-observation-bulk-jobs.lane-2:3",
      "3:job:catalog.source-observation-bulk-jobs.lane-3:3",
    ]);
  });
});

describe("worker runner loop", () => {
  it("rotates through runners when concurrency is lower than the runner count", async () => {
    const calls: string[] = [];
    const controlPlane = createAlwaysLeasedControlPlane();
    const runners = Array.from({ length: 5 }, (_, index): WorkerRunner => {
      const name = `runner-${index + 1}`;
      return {
        name,
        kind: "projector",
        runOnce: async () => {
          calls.push(name);
          return { processed: 0, lastGlobalPosition: "0" as never };
        },
      };
    });
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners,
      maxConcurrentRunners: 2,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(new Set(calls)).toEqual(new Set(runners.map((runner) => runner.name)));
      });
    } finally {
      await loop.stop();
    }
  });

  it("runs one bounded batch per lease turn so busy runners do not monopolize the loop", async () => {
    const calls: string[] = [];
    const statuses: Array<Readonly<{ runnerName: string; state: string; lastProcessed?: number }>> = [];
    const controlPlane = createAlwaysLeasedControlPlane({
      recordRunnerStatus: async (status) => {
        statuses.push(status);
      },
    });
    const busyRunner: WorkerRunner = {
      name: "busy-projector",
      kind: "projector",
      runOnce: async () => {
        calls.push("busy-projector");
        return { processed: 1, lastGlobalPosition: String(calls.length) as never };
      },
    };
    const readyRunner: WorkerRunner = {
      name: "ready-projector",
      kind: "projector",
      runOnce: async () => {
        calls.push("ready-projector");
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [busyRunner, readyRunner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(calls).toContain("ready-projector");
      });
    } finally {
      await loop.stop();
    }

    expect(calls[0]).toBe("busy-projector");
    expect(calls).toContain("ready-projector");
    expect(statuses).toContainEqual(
      expect.objectContaining({
        runnerName: "busy-projector",
        state: "running",
        lastProcessed: 1,
      }),
    );
    expect(statuses).toContainEqual(
      expect.objectContaining({
        runnerName: "ready-projector",
        state: "caught-up",
        lastProcessed: 0,
      }),
    );
  });

  it("prioritizes runners with outstanding backlog ahead of caught-up runners without duplicate same-runner execution", async () => {
    const calls: string[] = [];
    let releaseHighBacklogRunner: (() => void) | null = null;
    const highBacklogRunnerBlocked = new Promise<void>((resolve) => {
      releaseHighBacklogRunner = resolve;
    });
    const controlPlane = createAlwaysLeasedControlPlane();
    const caughtUpRunner: WorkerRunner = {
      name: "caught-up-projection",
      kind: "projection-group",
      priority: () => 0n,
      runOnce: async () => {
        calls.push("caught-up-projection");
        return { processed: 0, lastGlobalPosition: "1" as never };
      },
    };
    const highBacklogRunner: WorkerRunner = {
      name: "high-backlog-projection",
      kind: "projection-group",
      priority: () => 500n,
      runOnce: async () => {
        calls.push("high-backlog-projection");
        await highBacklogRunnerBlocked;
        return { processed: 1, lastGlobalPosition: "500" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [caughtUpRunner, highBacklogRunner],
      maxConcurrentRunners: 2,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(calls).toContain("caught-up-projection");
      });
    } finally {
      (releaseHighBacklogRunner as (() => void) | null)?.();
      await loop.stop();
    }

    expect(calls[0]).toBe("high-backlog-projection");
    expect(calls.filter((call) => call === "high-backlog-projection")).toHaveLength(1);
  });

  it("temporarily backs off failing high-priority runners so other ready runners can make progress", async () => {
    const calls: string[] = [];
    const failed: string[] = [];
    const controlPlane = createAlwaysLeasedControlPlane();
    const failingBacklogRunner: WorkerRunner = {
      name: "failing-backlog-projection",
      kind: "projection-group",
      priority: () => 500n,
      runOnce: async () => {
        calls.push("failing-backlog-projection");
        throw new Error("stale lease fencing token");
      },
    };
    const readyRunner: WorkerRunner = {
      name: "source-observation-projection",
      kind: "projection-group",
      priority: () => 1n,
      runOnce: async () => {
        calls.push("source-observation-projection");
        return { processed: 1, lastGlobalPosition: "1" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [failingBacklogRunner, readyRunner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
      failureBackoffBaseMs: 50,
      failureBackoffMaxMs: 50,
      onError: (_error, runner) => failed.push(runner.name),
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(calls).toContain("source-observation-projection");
      });
    } finally {
      await loop.stop();
    }

    expect(calls[0]).toBe("failing-backlog-projection");
    expect(failed).toContain("failing-backlog-projection");
  });

  it("keeps a reserved slot available for reserved-capacity runners while shared runners saturate the loop", async () => {
    const reservedRuns: number[] = [];
    let activeSharedRuns = 0;
    let maxConcurrentSharedRuns = 0;
    let gatesOpen = false;
    const releaseGates: Array<() => void> = [];
    const controlPlane = createAlwaysLeasedControlPlane();
    const sharedRunners = Array.from({ length: 2 }, (_, index): WorkerRunner => {
      const name = `bulk-wake-lane-${index + 1}`;
      return {
        name,
        kind: "job",
        runOnce: async () => {
          activeSharedRuns += 1;
          maxConcurrentSharedRuns = Math.max(maxConcurrentSharedRuns, activeSharedRuns);
          if (!gatesOpen) {
            await new Promise<void>((resolve) => {
              releaseGates.push(resolve);
            });
          }
          activeSharedRuns -= 1;
          return { processed: 0, lastGlobalPosition: "0" as never };
        },
      };
    });
    const reservedRunner: WorkerRunner = {
      name: "hot-wake-lane",
      kind: "job",
      reservedCapacity: true,
      runOnce: async () => {
        reservedRuns.push(reservedRuns.length + 1);
        return { processed: 1, lastGlobalPosition: "1" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [...sharedRunners, reservedRunner],
      maxConcurrentRunners: 2,
      reservedRunnerSlots: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        // The reserved runner keeps completing passes while a shared runner
        // holds the single shared slot for the whole window.
        expect(reservedRuns.length).toBeGreaterThanOrEqual(3);
      });
      expect(loop.status()).toMatchObject({ reservedRunnerSlots: 1 });
    } finally {
      gatesOpen = true;
      for (const release of releaseGates) {
        release();
      }
      await loop.stop();
    }

    // Shared runners never occupied the reserved slot.
    expect(maxConcurrentSharedRuns).toBe(1);
  });

  it("fills reserved slots before shared slots in a scheduling pass", async () => {
    const calls: string[] = [];
    let gatesOpen = false;
    const releaseGates: Array<() => void> = [];
    const controlPlane = createAlwaysLeasedControlPlane();
    const blockingRunner = (name: string, reservedCapacity?: boolean): WorkerRunner => ({
      name,
      kind: "job",
      reservedCapacity,
      runOnce: async () => {
        calls.push(name);
        if (!gatesOpen) {
          await new Promise<void>((resolve) => {
            releaseGates.push(resolve);
          });
        }
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    });
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [blockingRunner("standard-wake-lane"), blockingRunner("hot-wake-lane", true)],
      maxConcurrentRunners: 2,
      reservedRunnerSlots: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(calls.length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      gatesOpen = true;
      for (const release of releaseGates) {
        release();
      }
      await loop.stop();
    }

    expect(calls[0]).toBe("hot-wake-lane");
    expect(calls[1]).toBe("standard-wake-lane");
  });

  it("clamps over-sized reservations so shared runners always keep one slot", async () => {
    const calls: string[] = [];
    const controlPlane = createAlwaysLeasedControlPlane();
    const quickRunner = (name: string, reservedCapacity?: boolean): WorkerRunner => ({
      name,
      kind: "job",
      reservedCapacity,
      runOnce: async () => {
        calls.push(name);
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    });
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [quickRunner("hot-wake-lane", true), quickRunner("bulk-wake-lane")],
      maxConcurrentRunners: 1,
      reservedRunnerSlots: 5,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(calls).toContain("hot-wake-lane");
        expect(calls).toContain("bulk-wake-lane");
      });
    } finally {
      await loop.stop();
    }

    expect(loop.status()).toMatchObject({ reservedRunnerSlots: 0 });
  });

  it("aborts active runner contexts during stop and releases the lease without recording a runner error", async () => {
    const failures: string[] = [];
    const releasedLeases: string[] = [];
    const statuses: Array<Readonly<{ runnerName: string; state: string }>> = [];
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const controlPlane = createAlwaysLeasedControlPlane({
      releaseLease: async (lease) => {
        releasedLeases.push(lease.leaseName);
      },
      recordRunnerStatus: async (status) => {
        statuses.push(status);
      },
    });
    const runner: WorkerRunner = {
      name: "catalog.source-observation-bulk-jobs",
      kind: "job",
      runOnce: async (context) => {
        markStarted?.();
        await vi.waitFor(() => {
          expect(context?.signal?.aborted).toBe(true);
        });
        context?.throwIfLeaseLost?.();
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [runner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
      onError: (_error, failedRunner) => failures.push(failedRunner.name),
    });

    loop.start();
    await started;
    await loop.stop();

    expect(failures).toEqual([]);
    expect(releasedLeases).toEqual(["job:catalog.source-observation-bulk-jobs"]);
    expect(statuses).toContainEqual(
      expect.objectContaining({
        runnerName: "catalog.source-observation-bulk-jobs",
        state: "running",
      }),
    );
    expect(statuses).not.toContainEqual(
      expect.objectContaining({
        runnerName: "catalog.source-observation-bulk-jobs",
        state: "error",
      }),
    );
  });

  it("records degraded when a projection runner reports blocked streams", async () => {
    const statuses: Array<Readonly<{ runnerName: string; state: string; lastError?: string | null }>> = [];
    const controlPlane = createAlwaysLeasedControlPlane({
      recordRunnerStatus: async (status) => {
        statuses.push(status);
      },
    });
    const runner: WorkerRunner = {
      name: "catalog-item-projection",
      kind: "projector",
      runOnce: async () => ({
        processed: 4,
        lastGlobalPosition: "4" as never,
        state: "degraded",
        blockedStreams: 1,
        poisonEvents: 1,
      }),
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [runner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(statuses).toContainEqual(
          expect.objectContaining({
            runnerName: "catalog-item-projection",
            state: "degraded",
            lastError: "Projection has 1 blocked stream(s) and 1 poison event(s).",
          }),
        );
      });
    } finally {
      await loop.stop();
    }
  });

  it("publishes projection group status snapshots after leased projection batches", async () => {
    const snapshots: Array<
      Readonly<{ projectionKey: string; runnerName: string; ownerId: string; status: Record<string, unknown> }>
    > = [];
    const controlPlane = createAlwaysLeasedControlPlane({
      recordProjectionStatusSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
      },
    });
    const runner: WorkerRunner = {
      name: "inventory.inventory-catalog-item-projection",
      kind: "projection-group",
      projectionStatusSnapshot: () =>
        createProjectionGroup({
          refreshStatus: async () => ({ revisionStale: false }),
        }).getStatus() as never,
      runOnce: async () => ({
        processed: 1,
        lastGlobalPosition: "2" as never,
      }),
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [runner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(snapshots.length).toBeGreaterThan(0);
      });
    } finally {
      await loop.stop();
    }

    expect(snapshots[0]).toMatchObject({
      projectionKey: "inventory.inventory-catalog-item-projection",
      runnerName: "inventory.inventory-catalog-item-projection",
      ownerId: "worker-a",
      status: {
        targetContextName: "inventory",
        projectionName: "inventory-catalog-item-projection",
      },
    });
  });

  it("does not publish projection snapshots for non-projection runners", async () => {
    const snapshots: unknown[] = [];
    const controlPlane = createAlwaysLeasedControlPlane({
      recordProjectionStatusSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
      },
    });
    const runner: WorkerRunner = {
      name: "catalog.bulk-job",
      kind: "job",
      runOnce: async () => ({
        processed: 0,
        lastGlobalPosition: "0" as never,
      }),
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [runner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(loop.status().activeRunnerCount).toBe(0);
      });
    } finally {
      await loop.stop();
    }

    expect(snapshots).toEqual([]);
  });

  it("does not overwrite shared runner status when another worker holds the lease", async () => {
    const statuses: Array<Readonly<{ runnerName: string; state: string }>> = [];
    const controlPlane = createNeverLeasedControlPlane({
      recordRunnerStatus: async (status) => {
        statuses.push(status);
      },
    });
    const runner: WorkerRunner = {
      name: "catalog-item-projection",
      kind: "projection-group",
      runOnce: async () => {
        throw new Error("Lease misses must not run the runner.");
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-b",
      controlPlane,
      runners: [runner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(loop.status().leaseMissCount).toBeGreaterThan(0);
      });
    } finally {
      await loop.stop();
    }

    expect(statuses).toEqual([]);
  });

  it("collects projection group runners instead of raw subscription runners", () => {
    const subscriptionRunner = {
      targetContextName: "inventory",
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      runOnce: async () => ({ processed: 0, lastGlobalPosition: "0" as never }),
    };
    const group = createProjectionGroup({
      subscriptionRunners: [subscriptionRunner],
    });

    const runners = collectWorkerRunners({
      mountedContexts: [],
      services: {},
      projectionGroups: [group],
      subscriptionRunners: [subscriptionRunner],
    } as never);

    expect(runners).toHaveLength(3);
    expect(runners[0]).toMatchObject({
      name: "inventory.inventory-catalog-item-projection",
      kind: "projection-group",
    });
  });

  it("resets stale projection groups once and marks the revision after worker catch-up", async () => {
    const processedByRun = [1, 1, 0];
    const resets: string[] = [];
    let markedRevision = false;
    const subscriptionRunner = {
      targetContextName: "inventory",
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      reset: async () => {
        resets.push("subscription");
      },
      runOnce: async () => ({
        processed: processedByRun.shift() ?? 0,
        lastGlobalPosition: "2" as never,
      }),
    };
    const group = createProjectionGroup({
      subscriptionRunners: [subscriptionRunner],
      refreshStatus: async () => ({
        revisionStale: !markedRevision,
      }),
      markRevisionSynced: async () => {
        markedRevision = true;
      },
      reset: async () => {
        resets.push("group");
      },
    });
    const [runner] = collectWorkerRunners({
      mountedContexts: [],
      services: {},
      projectors: [],
      projectionGroups: [group],
      subscriptionRunners: [subscriptionRunner],
    } as never);

    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 1 });
    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 1 });
    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 0 });

    expect(resets).toEqual(["group", "subscription"]);
    expect(markedRevision).toBe(true);
  });

  it("runs same-order projection group subscriptions concurrently while preserving order barriers", async () => {
    const calls: string[] = [];
    let releaseSlowRunner: (() => void) | null = null;
    const slowRunnerBlocked = new Promise<void>((resolve) => {
      releaseSlowRunner = resolve;
    });
    const slowRunner = {
      subscriptionName: "inventory.catalog-item-projection",
      targetContextName: "inventory",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      order: 10,
      runOnce: async () => {
        calls.push("slow-start");
        await slowRunnerBlocked;
        calls.push("slow-end");
        return { processed: 1, lastGlobalPosition: "2" as never };
      },
    };
    const sameOrderRunner = {
      subscriptionName: "inventory.marketplace-item-projection",
      targetContextName: "inventory",
      sourceContextName: "marketplace",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      checkpointKey: "inventory-catalog-item-projection:marketplace:v1",
      order: 10,
      runOnce: async () => {
        calls.push("same-order");
        return { processed: 1, lastGlobalPosition: "3" as never };
      },
    };
    const laterRunner = {
      subscriptionName: "inventory.order-item-projection",
      targetContextName: "inventory",
      sourceContextName: "ordering",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      checkpointKey: "inventory-catalog-item-projection:ordering:v1",
      order: 20,
      runOnce: async () => {
        calls.push("later-order");
        return { processed: 1, lastGlobalPosition: "4" as never };
      },
    };
    const group = createProjectionGroup({
      subscriptionRunners: [slowRunner, sameOrderRunner, laterRunner],
      refreshStatus: async () => ({
        revisionStale: false,
      }),
    });
    const [runner] = collectWorkerRunners({
      mountedContexts: [],
      services: {},
      projectors: [],
      projectionGroups: [group],
      subscriptionRunners: [slowRunner, sameOrderRunner, laterRunner],
    } as never);

    const run = runner.runOnce();
    await vi.waitFor(() => {
      expect(calls).toContain("same-order");
    });
    expect(calls).not.toContain("later-order");
    (releaseSlowRunner as (() => void) | null)?.();
    await expect(run).resolves.toMatchObject({ processed: 3, lastGlobalPosition: "4" });
    expect(calls).toEqual(["slow-start", "same-order", "slow-end", "later-order"]);
  });

  it("cancels a running projection operation when the operation state requests cancellation", async () => {
    const completedResults: Array<Record<string, unknown> | undefined> = [];
    const subscriptionRunner = {
      targetContextName: "inventory",
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      reset: async () => undefined,
      runOnce: async (context?: { signal?: AbortSignal; throwIfLeaseLost?: () => void }) => {
        await vi.waitFor(() => {
          expect(context?.signal?.aborted).toBe(true);
        });
        context?.throwIfLeaseLost?.();
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    };
    const group = createProjectionGroup({
      subscriptionRunners: [subscriptionRunner],
      refreshStatus: async () => ({ revisionStale: false }),
    });
    const controlPlane = createAlwaysLeasedControlPlane({
      claimProjectionOperation: async () => ({
        operationId: "projection-operation-1",
        operationKind: "rebuild-projection-group",
        state: "running",
        contextName: "inventory",
        projectionName: "inventory-catalog-item-projection",
        projectionKey: null,
        streamId: null,
        requestedByUserId: null,
        requestedByAccountId: null,
        claimOwnerId: "worker-a",
        claimFencingToken: "1",
        claimedUntil: new Date(Date.now() + 60_000).toISOString(),
        progress: {},
        result: null,
        error: null,
        requestedAt: new Date(0).toISOString(),
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        completedAt: null,
      }),
      getProjectionOperation: async () => ({
        operationId: "projection-operation-1",
        operationKind: "rebuild-projection-group",
        state: "cancel_requested",
        contextName: "inventory",
        projectionName: "inventory-catalog-item-projection",
        projectionKey: null,
        streamId: null,
        requestedByUserId: null,
        requestedByAccountId: null,
        claimOwnerId: "worker-a",
        claimFencingToken: "1",
        claimedUntil: new Date(Date.now() + 60_000).toISOString(),
        progress: {},
        result: null,
        error: null,
        requestedAt: new Date(0).toISOString(),
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        completedAt: null,
      }),
      completeProjectionOperation: async (input) => {
        completedResults.push(input.result);
        return true;
      },
    });
    const runners = collectWorkerRunners(
      {
        mountedContexts: [],
        services: {},
        projectors: [],
        projectionGroups: [group],
        subscriptionRunners: [subscriptionRunner],
      } as never,
      {
        controlPlane,
        projectionOperationCancelPollIntervalMs: 1,
      },
    );
    const operationRunner = runners.find((runner) => runner.name === "projection-operations");

    await expect(operationRunner?.runOnce({ ownerId: "worker-a" })).resolves.toMatchObject({
      processed: 1,
      state: "degraded",
    });
    expect(completedResults).toContainEqual(
      expect.objectContaining({
        state: "cancelled",
      }),
    );
  });
});

function createProjectionGroup(
  overrides: Readonly<{
    subscriptionRunners?: readonly unknown[];
    refreshStatus?: () => Promise<Readonly<{ revisionStale: boolean }>>;
    markRevisionSynced?: () => Promise<void>;
    reset?: () => Promise<void>;
  }> = {},
) {
  return {
    projectionName: "inventory-catalog-item-projection",
    projectionRevision: 2,
    targetContextName: "inventory",
    sourceContextNames: ["catalog"],
    ownedTables: ["inventory_catalog_items"],
    requiredDuringBootstrap: true,
    projectors: [],
    subscriptionRunners: overrides.subscriptionRunners ?? [],
    reset: overrides.reset ?? (async () => undefined),
    getStatus: () => ({
      projectionName: "inventory-catalog-item-projection",
      projectionRevision: 2,
      storedProjectionRevision: 1,
      revisionStale: true,
      targetContextName: "inventory",
      sourceContextNames: ["catalog"],
      ownedTables: ["inventory_catalog_items"],
      requiredDuringBootstrap: true,
      initialized: true,
      caughtUp: false,
      state: "idle",
      outstandingEventCount: "0",
      lastError: null,
      blockedStreamCount: 0,
      poisonEventCount: 0,
      updatedAt: new Date(0).toISOString(),
      subscriptions: [],
    }),
    refreshStatus:
      overrides.refreshStatus ??
      (async () => ({
        revisionStale: true,
      })),
    markRevisionSynced: overrides.markRevisionSynced ?? (async () => undefined),
  };
}

function createAlwaysLeasedControlPlane(overrides: Partial<PlatformControlPlane> = {}): PlatformControlPlane {
  return {
    bootstrap: async () => {},
    acquireLease:
      overrides.acquireLease ??
      (async (input) => ({
        leaseName: input.leaseName,
        ownerId: input.ownerId,
        fencingToken: "1",
        expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
      })),
    renewLease: overrides.renewLease ?? (async () => true),
    releaseLease: overrides.releaseLease ?? (async () => {}),
    heartbeatWorker: overrides.heartbeatWorker ?? (async () => {}),
    recordRunnerStatus: overrides.recordRunnerStatus ?? (async () => {}),
    recordProjectionStatusSnapshot: overrides.recordProjectionStatusSnapshot ?? (async () => {}),
    listProjectionStatusSnapshots: overrides.listProjectionStatusSnapshots ?? (async () => []),
    listWorkerHeartbeats: overrides.listWorkerHeartbeats ?? (async () => []),
    listRunnerStatuses: overrides.listRunnerStatuses ?? (async () => []),
    listLeases: overrides.listLeases ?? (async () => []),
    enqueueProjectionOperation:
      overrides.enqueueProjectionOperation ??
      (async () => {
        throw new Error("not used");
      }),
    claimProjectionOperation: overrides.claimProjectionOperation ?? (async () => null),
    recordProjectionOperationProgress: async () => false,
    completeProjectionOperation: overrides.completeProjectionOperation ?? (async () => false),
    failProjectionOperation: overrides.failProjectionOperation ?? (async () => false),
    cancelProjectionOperation: overrides.cancelProjectionOperation ?? (async () => false),
    getProjectionOperation: overrides.getProjectionOperation ?? (async () => null),
    listProjectionOperations: overrides.listProjectionOperations ?? (async () => []),
    listProjectionOperationEvents: overrides.listProjectionOperationEvents ?? (async () => []),
    waitForProjectionOperationEvents: overrides.waitForProjectionOperationEvents ?? (async () => undefined),
    summarizeProjectionOperations:
      overrides.summarizeProjectionOperations ?? (async () => defaultProjectionOperationSummary()),
    claimScheduledRunner: overrides.claimScheduledRunner ?? (async () => true),
    recordScheduledRunnerCompleted: overrides.recordScheduledRunnerCompleted ?? (async () => {}),
    getProjectionWakeRelayCursor: overrides.getProjectionWakeRelayCursor ?? (async () => null),
    listProjectionWakeRelayCursors: overrides.listProjectionWakeRelayCursors ?? (async () => []),
    advanceProjectionWakeRelayCursor: overrides.advanceProjectionWakeRelayCursor ?? (async () => null),
  };
}

function createNeverLeasedControlPlane(
  overrides: Partial<Pick<PlatformControlPlane, "recordRunnerStatus">> = {},
): PlatformControlPlane {
  return {
    bootstrap: async () => {},
    acquireLease: async () => null,
    renewLease: async () => false,
    releaseLease: async () => {},
    heartbeatWorker: async () => {},
    recordRunnerStatus: overrides.recordRunnerStatus ?? (async () => {}),
    recordProjectionStatusSnapshot: async () => {},
    listProjectionStatusSnapshots: async () => [],
    listWorkerHeartbeats: async () => [],
    listRunnerStatuses: async () => [],
    listLeases: async () => [],
    enqueueProjectionOperation: async () => {
      throw new Error("not used");
    },
    claimProjectionOperation: async () => null,
    recordProjectionOperationProgress: async () => false,
    completeProjectionOperation: async () => false,
    failProjectionOperation: async () => false,
    cancelProjectionOperation: async () => false,
    getProjectionOperation: async () => null,
    listProjectionOperations: async () => [],
    listProjectionOperationEvents: async () => [],
    waitForProjectionOperationEvents: async () => undefined,
    summarizeProjectionOperations: async () => defaultProjectionOperationSummary(),
    claimScheduledRunner: async () => false,
    recordScheduledRunnerCompleted: async () => {},
    getProjectionWakeRelayCursor: async () => null,
    listProjectionWakeRelayCursors: async () => [],
    advanceProjectionWakeRelayCursor: async () => null,
  };
}

function defaultProjectionOperationSummary() {
  return {
    queuedCount: "0",
    runningCount: "0",
    failedCount: "0",
    cancelRequestedCount: "0",
    oldestQueuedAt: null,
    oldestRunningAt: null,
    averageDurationMs: null,
  };
}
