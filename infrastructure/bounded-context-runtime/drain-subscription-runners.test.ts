import { describe, expect, it } from "vitest";
import {
  createProjectionDependencyWaitError,
  drainContextProcesses,
  drainSubscriptionRunners,
  type ContextSubscriptionRunner,
} from "./subscriptions";

function runner(
  projectionName: string,
  runOnce: () => Promise<Readonly<{ processed: number }>>,
): ContextSubscriptionRunner {
  return {
    subscriptionName: projectionName,
    projectionName,
    sourceContextName: "catalog",
    targetContextName: "catalog",
    subscriptionVersion: 1,
    checkpointKey: `${projectionName}:catalog:v1`,
    order: 0,
    runOnce,
  } as unknown as ContextSubscriptionRunner;
}

describe("drainSubscriptionRunners", () => {
  // The source applies at most 100 events a pass; the dependent runs first and
  // waits for event 101, which the source reaches only on its second pass.
  function mixedBacklog() {
    const positions = { source: 0, dependent: 0 };
    const source = runner("b-source", async () => {
      const next = Math.min(101, positions.source + 100);
      const processed = next - positions.source;
      positions.source = next;
      return { processed };
    });
    const dependent = runner("a-dependent", async () => {
      if (positions.dependent === 101) return { processed: 0 };
      if (positions.source < 101) {
        throw createProjectionDependencyWaitError("b-source has not applied evt_101 yet.", "evt_101");
      }
      positions.dependent = 101;
      return { processed: 1 };
    });
    return { positions, runners: [source, dependent] };
  }

  it("gives a projection the dependency it waits on has not reached another pass in the same drain", async () => {
    const backlog = mixedBacklog();

    await drainSubscriptionRunners(backlog.runners);

    expect(backlog.positions).toEqual({ source: 101, dependent: 101 });
  });

  it("drains the same backlog through the context drain and counts every pass", async () => {
    const backlog = mixedBacklog();

    await expect(drainContextProcesses({ subscriptionRunners: backlog.runners })).resolves.toBe(102);

    expect(backlog.positions).toEqual({ source: 101, dependent: 101 });
  });

  it("fails when a pass leaves the same wait and applies nothing", async () => {
    let dependentRuns = 0;
    const source = runner("b-source", async () => ({ processed: 0 }));
    const dependent = runner("a-dependent", async () => {
      dependentRuns += 1;
      throw createProjectionDependencyWaitError("b-source has not applied evt_7 yet.", "evt_7");
    });

    await expect(drainSubscriptionRunners([source, dependent])).rejects.toThrow("b-source has not applied evt_7 yet.");
    expect(dependentRuns).toBe(2);
    await expect(drainContextProcesses({ subscriptionRunners: [source, dependent] })).rejects.toThrow(
      "b-source has not applied evt_7 yet.",
    );
    expect(dependentRuns).toBe(4);
  });

  it("rethrows any other failure at once", async () => {
    let sourceRuns = 0;
    const source = runner("b-source", async () => {
      sourceRuns += 1;
      return { processed: 1 };
    });
    const failing = runner("a-failing", async () => {
      throw new Error("handler broke");
    });

    await expect(drainSubscriptionRunners([source, failing])).rejects.toThrow("handler broke");
    expect(sourceRuns).toBe(0);
  });
});
