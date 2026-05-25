import { describe, expect, it, vi } from "vitest";
import type { PlatformControlPlane } from "./control-plane";
import { collectWorkerRunners, createWorkerRunnerLoop, type WorkerRunner } from "./worker";

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
      releaseHighBacklogRunner?.();
      await loop.stop();
    }

    expect(calls[0]).toBe("high-backlog-projection");
    expect(calls.filter((call) => call === "high-backlog-projection")).toHaveLength(1);
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
      projectors: [],
      projectionGroups: [group],
      subscriptionRunners: [subscriptionRunner],
    } as never);

    expect(runners).toHaveLength(1);
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

function createAlwaysLeasedControlPlane(
  overrides: Partial<Pick<PlatformControlPlane, "recordRunnerStatus">> = {},
): PlatformControlPlane {
  return {
    bootstrap: async () => {},
    acquireLease: async (input) => ({
      leaseName: input.leaseName,
      ownerId: input.ownerId,
      fencingToken: "1",
      expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
    }),
    renewLease: async () => true,
    releaseLease: async () => {},
    heartbeatWorker: async () => {},
    recordRunnerStatus: overrides.recordRunnerStatus ?? (async () => {}),
    listWorkerHeartbeats: async () => [],
    listRunnerStatuses: async () => [],
    listLeases: async () => [],
  };
}
