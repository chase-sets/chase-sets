import type { ContextProjectionGroup, ContextSubscriptionRunner } from "@chase-sets/bounded-context-runtime";
import { describe, expect, it } from "vitest";

import { createCheckpointReadinessRecorder, createProjectionGroupWorkerRunner } from "./worker";
import type { RecordCheckpointReadyInput } from "./work-signal-store";

const NOW = new Date("2026-06-10T12:00:00.000Z");

describe("polling-path checkpoint readiness", () => {
  it("records readiness for every subscription checkpoint in a group status", async () => {
    const recorded: RecordCheckpointReadyInput[] = [];
    const recorder = createCheckpointReadinessRecorder({
      recordCheckpointReady: async (input) => {
        recorded.push(input);
        return {} as never;
      },
    });

    await recorder(groupStatus(120n));

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      checkpointKey: "checkout-session-pages:checkout:v1",
      sourceContextName: "checkout",
      targetContextName: "checkout",
      projectionName: "checkout-session-pages",
      readyPosition: "120",
      metadata: { recordedBy: "projection-poll" },
    });
  });

  it("records readiness only for subscriptions whose checkpoint advanced", async () => {
    const recorded: RecordCheckpointReadyInput[] = [];
    const recorder = createCheckpointReadinessRecorder({
      recordCheckpointReady: async (input) => {
        recorded.push(input);
        return {} as never;
      },
    });

    await recorder(groupStatus(120n), groupStatus(120n));
    expect(recorded).toHaveLength(0);

    await recorder(groupStatus(125n), groupStatus(120n));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ readyPosition: "125" });
  });

  it("records readiness after polling runs that processed events and never fails the run", async () => {
    const recordedPositions: string[] = [];
    let failRecording = false;
    const projection = checkoutProjection({ position: 100n, headPosition: 120n });
    const runner = createProjectionGroupWorkerRunner(projection.group, {
      onCheckpointsAdvanced: async (status) => {
        if (failRecording) {
          throw new Error("control database unavailable");
        }
        recordedPositions.push(...status.subscriptions.map((subscription) => String(subscription.lastGlobalPosition)));
      },
    });

    const firstRun = await runner.runOnce();
    expect(firstRun.processed).toBeGreaterThan(0);
    expect(recordedPositions).toEqual(["120"]);

    const idleRun = await runner.runOnce();
    expect(idleRun.processed).toBe(0);
    expect(recordedPositions).toEqual(["120"]);

    projection.setHead(140n);
    failRecording = true;
    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 20 });
  });
});

function checkoutProjection(input: Readonly<{ position: bigint; headPosition: bigint }>) {
  let position = input.position;
  let headPosition = input.headPosition;

  const subscriptionRunner: ContextSubscriptionRunner = {
    subscriptionName: "checkout.checkout-session-pages.checkout",
    projectionName: "checkout-session-pages",
    sourceContextName: "checkout",
    targetContextName: "checkout",
    subscriptionVersion: 1,
    checkpointKey: "checkout-session-pages:checkout:v1",
    order: 0,
    runOnce: async () => {
      const processed = Number(headPosition - position);
      position = headPosition;
      return {
        processed,
        lastGlobalPosition: position.toString() as never,
        state: "caught-up",
        blockedStreams: 0,
        poisonEvents: 0,
      };
    },
    getStatus: () => subscriptionStatus(position),
    refreshStatus: async () => subscriptionStatus(position),
    reset: async () => {},
    retryBlockedStream: async () => ({}) as never,
  };

  const group: ContextProjectionGroup = {
    projectionName: "checkout-session-pages",
    projectionRevision: 1,
    targetContextName: "checkout",
    sourceContextNames: ["checkout"],
    optionalSourceContextNames: [],
    ownedTables: ["checkout_session_pages"],
    requiredDuringBootstrap: false,
    subscriptionRunners: [subscriptionRunner],
    reset: async () => {},
    getStatus: () => groupStatusFor(position),
    refreshStatus: async () => groupStatusFor(position),
    markRevisionSynced: async () => {},
  };

  return {
    group,
    setHead: (next: bigint) => {
      headPosition = next;
    },
  };
}

function subscriptionStatus(position: bigint) {
  return {
    checkpointKey: "checkout-session-pages:checkout:v1",
    subscriptionName: "checkout.checkout-session-pages.checkout",
    projectionName: "checkout-session-pages",
    sourceContextName: "checkout",
    targetContextName: "checkout",
    subscriptionVersion: 1,
    initialized: true,
    lastGlobalPosition: position.toString() as never,
    sourceHeadGlobalPosition: position.toString() as never,
    outstandingEventCount: "0",
    processedEvents: 0,
    state: "caught-up" as const,
    lastError: null,
    blockedStreamCount: 0,
    poisonEventCount: 0,
    updatedAt: NOW.toISOString(),
  };
}

function groupStatusFor(position: bigint) {
  return {
    projectionName: "checkout-session-pages",
    projectionRevision: 1,
    storedProjectionRevision: 1,
    revisionStale: false,
    targetContextName: "checkout",
    sourceContextNames: ["checkout"],
    ownedTables: ["checkout_session_pages"],
    requiredDuringBootstrap: false,
    initialized: true,
    caughtUp: true,
    state: "caught-up" as const,
    lastError: null,
    outstandingEventCount: "0",
    blockedStreamCount: 0,
    poisonEventCount: 0,
    updatedAt: NOW.toISOString(),
    subscriptions: [subscriptionStatus(position)],
  };
}

function groupStatus(position: bigint) {
  return groupStatusFor(position);
}
