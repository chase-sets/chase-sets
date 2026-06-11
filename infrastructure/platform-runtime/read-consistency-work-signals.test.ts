import { describe, expect, it } from "vitest";

import { createWorkSignalReadConsistencyGateway } from "./read-consistency-work-signals";
import type { AddCheckpointWaiterInput, EnqueueProjectionWakeIntentInput } from "./work-signal-store";

const NOW = new Date("2026-06-10T12:00:00.000Z");

const WAKE_REQUEST = {
  sourceContextName: "marketplace",
  targetContextName: "checkout",
  projectionName: "checkout-session-pages",
  checkpointKey: "checkout-session-pages:marketplace:v1",
  requiredPosition: "42",
};

describe("read-consistency work-signal gateway", () => {
  it("enqueues hot-lane api-wait wake intents for each request", async () => {
    const enqueued: EnqueueProjectionWakeIntentInput[] = [];
    const gateway = createWorkSignalReadConsistencyGateway({
      workSignalStore: {
        enqueueProjectionWakeIntent: async (input) => {
          enqueued.push(input);
          return {} as never;
        },
        addCheckpointWaiter: async () => ({}) as never,
      },
      now: () => NOW,
    });

    await expect(
      gateway.requestWake?.({
        requests: [WAKE_REQUEST],
        metadata: { mountPath: "/api/marketplace" },
      }),
    ).resolves.toBe(1);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      sourceContextName: "marketplace",
      targetContextName: "checkout",
      projectionName: "checkout-session-pages",
      checkpointKey: "checkout-session-pages:marketplace:v1",
      requiredPosition: "42",
      priorityLane: "hot",
      origin: "api-wait",
      metadata: {
        requestedBy: "read-consistency",
        mountPath: "/api/marketplace",
      },
    });
  });

  it("omits waiter registration by default because no consumer exists yet", () => {
    const gateway = createWorkSignalReadConsistencyGateway({
      workSignalStore: {
        enqueueProjectionWakeIntent: async () => ({}) as never,
        addCheckpointWaiter: async () => ({}) as never,
      },
    });

    expect(gateway.registerWaiters).toBeUndefined();
  });

  it("registers checkpoint waiters with a bounded expiry when explicitly enabled", async () => {
    const waiters: AddCheckpointWaiterInput[] = [];
    const gateway = createWorkSignalReadConsistencyGateway({
      workSignalStore: {
        enqueueProjectionWakeIntent: async () => ({}) as never,
        addCheckpointWaiter: async (input) => {
          waiters.push(input);
          return {} as never;
        },
      },
      registerWaiters: true,
      waiterTtlSlackMs: 5_000,
      now: () => NOW,
    });

    await gateway.registerWaiters?.({
      requests: [WAKE_REQUEST],
      timeoutMs: 2_500,
    });

    expect(waiters).toHaveLength(1);
    expect(waiters[0]).toMatchObject({
      checkpointKey: "checkout-session-pages:marketplace:v1",
      sourceContextName: "marketplace",
      targetContextName: "checkout",
      projectionName: "checkout-session-pages",
      requiredPosition: "42",
      origin: "api-wait",
    });
    expect(waiters[0].expiresAt).toEqual(new Date(NOW.getTime() + 7_500));
  });
});
