import { describe, expect, it } from "vitest";
import {
  createProjectionDependencyWaitError,
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
  it("gives a projection the dependency it waits on has not reached another pass in the same drain", async () => {
    // The source applies at most 100 events a pass; the dependent runs first
    // and waits for event 101, which the source reaches only on its second pass.
    let sourcePosition = 0;
    let dependentPosition = 0;
    const source = runner("b-source", async () => {
      const next = Math.min(101, sourcePosition + 100);
      const processed = next - sourcePosition;
      sourcePosition = next;
      return { processed };
    });
    const dependent = runner("a-dependent", async () => {
      if (dependentPosition === 101) return { processed: 0 };
      if (sourcePosition < 101) {
        throw createProjectionDependencyWaitError("b-source has not applied evt_101 yet.", "evt_101");
      }
      dependentPosition = 101;
      return { processed: 1 };
    });

    await drainSubscriptionRunners([source, dependent]);

    expect(sourcePosition).toBe(101);
    expect(dependentPosition).toBe(101);
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
