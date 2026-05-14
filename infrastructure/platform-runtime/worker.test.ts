import { describe, expect, it, vi } from "vitest";
import type { PlatformControlPlane } from "./control-plane";
import { createWorkerRunnerLoop, type WorkerRunner } from "./worker";

describe("worker runner loop", () => {
  it("rotates through runners when concurrency is lower than the runner count", async () => {
    const calls: string[] = [];
    const controlPlane = createAlwaysLeasedControlPlane();
    const runners = Array.from(
      { length: 5 },
      (_, index): WorkerRunner => {
        const name = `runner-${index + 1}`;
        return {
          name,
          kind: "projector",
          runOnce: async () => {
            calls.push(name);
            return { processed: 0, lastGlobalPosition: "0" as never };
          },
        };
      },
    );
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
});

function createAlwaysLeasedControlPlane(): PlatformControlPlane {
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
    recordRunnerStatus: async () => {},
    listWorkerHeartbeats: async () => [],
    listRunnerStatuses: async () => [],
    listLeases: async () => [],
  };
}
