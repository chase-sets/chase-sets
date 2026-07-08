import type { ContextProjectionGroup, ContextSubscriptionRunner } from "@chase-sets/bounded-context-runtime";
import type { ProjectionRunContext } from "@chase-sets/event-core/projector";
import { describe, expect, it, vi } from "vitest";

import type { PlatformControlPlane } from "./control-plane";
import { createWorkerRunnerLoop, DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS } from "./worker";
import {
  createProjectionWakeSchedulerRunners,
  createWorkSignalCleanupRunner,
  startProjectionWakePushDispatcher,
  type ProjectionWakeIntentCompletedEvent,
  type ProjectionWakeIntentLifecycleEvent,
  type ProjectionWakeIntentRetryEvent,
  type ProjectionWakeSchedulerObserver,
} from "./projection-wake-scheduler";
import {
  createWorkSignalEnvelope,
  type PostgresWorkSignalNotification,
  type PostgresWorkSignalWaiter,
  type WaitForPostgresWorkSignalInput,
  type WorkSignalWaitResult,
} from "./work-signal-composite";
import type {
  ClaimProjectionWakeIntentInput,
  CompleteProjectionWakeIntentInput,
  FailProjectionWakeIntentInput,
  DeferProjectionWakeIntentInput,
  ProjectionWakeIntentCompletionResult,
  ProjectionWakeIntentRecord,
  ProjectionWakeIntentWorkSignalPayload,
  RecordCheckpointReadyInput,
  RenewProjectionWakeIntentInput,
} from "./work-signal-store";
import { PROJECTION_WAKE_INTENT_WORK_SIGNAL_CHANNEL } from "./work-signal-store";

const NOW = new Date("2026-06-10T12:00:05.000Z");
const CREATED_AT = new Date("2026-06-10T12:00:00.000Z");

describe("projection wake scheduler", () => {
  it("nudges a 60s-poll wake loop when a matching wake-intent notification arrives", async () => {
    const calls: string[] = [];
    const waiter = controllableWorkSignalWaiter();
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane: loopControlPlane(),
      runners: [
        {
          name: "wake-claim-runner",
          kind: "job",
          runOnce: async () => {
            calls.push("wake-claim-runner");
            return { processed: 0, lastGlobalPosition: "0" as never };
          },
        },
      ],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 60_000,
    });
    const dispatcher = startProjectionWakePushDispatcher({
      waiter: waiter.waiter,
      nudge: () => loop.nudge(),
      waitTimeoutMs: 60_000,
      targetContextNames: ["checkout"],
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      waiter.notify(
        wakeIntentNotification({
          targetContextName: "checkout",
          projectionName: "checkout-session-pages",
          checkpointKey: "checkout-session-pages:checkout:v1",
        }),
      );
      await vi.waitFor(
        () => {
          expect(calls).toHaveLength(2);
        },
        { timeout: 250 },
      );
    } finally {
      await dispatcher.stop();
      await loop.stop();
    }
  });

  it("does not nudge on listener-unavailable results and leaves poll as the backstop", async () => {
    const calls: string[] = [];
    const waitResults: WorkSignalWaitResult[] = [];
    let nudgeCount = 0;
    const waiter = scriptedWorkSignalWaiter(["listener-unavailable"]);
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane: loopControlPlane(),
      runners: [
        {
          name: "wake-claim-runner",
          kind: "job",
          runOnce: async () => {
            calls.push("wake-claim-runner");
            return { processed: 0, lastGlobalPosition: "0" as never };
          },
        },
      ],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 50,
    });
    const dispatcher = startProjectionWakePushDispatcher({
      waiter,
      nudge: () => {
        nudgeCount += 1;
        loop.nudge();
      },
      waitTimeoutMs: 100,
      targetContextNames: ["checkout"],
      observer: {
        waitEnded: (event) => waitResults.push(event.result),
      },
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(waitResults).toContain("listener-unavailable");
      });
      expect(nudgeCount).toBe(0);
      await vi.waitFor(
        () => {
          expect(calls.length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 500 },
      );
    } finally {
      await dispatcher.stop();
      await loop.stop();
    }
  });

  it("claims lane-filtered intents for hosted targets and completes after a durable checkpoint advance", async () => {
    const projection = checkoutProjection({ position: 90n, headPosition: 120n });
    const store = recordingSchedulerStore([
      claimedIntent({ requiredPosition: 102n, priorityLane: "hot", attemptCount: 1 }),
    ]);
    const controlPlane = recordingControlPlane();
    const completed: ProjectionWakeIntentCompletedEvent[] = [];
    const claimed: ProjectionWakeIntentLifecycleEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      observer: {
        wakeIntentClaimed: (event) => claimed.push(event),
        wakeIntentCompleted: (event) => completed.push(event),
      },
      now: () => NOW,
    });

    expect(runners).toHaveLength(1);
    expect(runners[0].name).toBe("projection-wake-scheduler.hot.lane-1");

    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 1, state: "running" });
    expect(store.claims[0]).toMatchObject({
      claimOwnerId: "worker-a:projection-wake-scheduler.hot.lane-1",
      maxAttempts: 10,
      priorityLanes: ["hot"],
      targetContextNames: ["checkout"],
    });
    expect(projection.runCount()).toBe(1);
    expect(controlPlane.acquiredLeaseNames).toEqual(["projection-group:checkout.checkout-session-pages"]);
    expect(controlPlane.released).toBe(1);
    expect(store.readiness[0]).toMatchObject({
      checkpointKey: "checkout-session-pages:checkout:v1",
      sourceContextName: "checkout",
      targetContextName: "checkout",
      projectionName: "checkout-session-pages",
      readyPosition: 120n,
      correlationId: "corr_1",
    });
    expect(store.completions).toHaveLength(1);
    expect(store.failures).toHaveLength(0);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ queueAgeMs: 5_000, priorityLane: "hot" });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      outcome: "ran",
      checkpointPosition: "120",
      requeued: false,
      processingDurationMs: 0,
    });
  });

  it("passes transaction timeouts into wake projection runs", async () => {
    const runIdleTimeouts: Array<number | undefined> = [];
    const runStatementTimeouts: Array<number | undefined> = [];
    const projection = checkoutProjection({
      position: 90n,
      headPosition: 120n,
      onRunContext: (context) => {
        runIdleTimeouts.push(context?.idleInTransactionSessionTimeoutMs);
        runStatementTimeouts.push(context?.statementTimeoutMs);
      },
    });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n, priorityLane: "hot" })]);
    const controlPlane = recordingControlPlane();

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      statementTimeoutMs: 12_345,
      now: () => NOW,
    });
    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 1 });
    expect(runIdleTimeouts).toEqual([DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS]);
    expect(runStatementTimeouts).toEqual([12_345]);
  });

  it("renews the wake intent claim while a projection drain is still running", async () => {
    vi.useFakeTimers();
    let releaseRun!: () => void;
    const runBlocked = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const projection = checkoutProjection({
      position: 90n,
      headPosition: 120n,
      onRun: () => runBlocked,
    });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n })]);
    const controlPlane = recordingControlPlane();

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      claimTtlMs: 3_000,
      leaseRenewIntervalMs: 10_000,
      now: () => NOW,
    });

    const runPromise = runners[0].runOnce();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(store.renewals).toHaveLength(1);
    expect(store.renewals[0]).toMatchObject({
      wakeIntentId: "projection-wake-1",
      claimOwnerId: "worker-a:projection-wake-scheduler.hot.lane-1",
      claimFencingToken: 7n,
      claimTtlMs: 3_000,
    });

    releaseRun();
    await expect(runPromise).resolves.toMatchObject({ processed: 1 });
    vi.useRealTimers();
  });

  it("stops the wake run as claim-lost when claim renewal is fenced out", async () => {
    vi.useFakeTimers();
    const projection = checkoutProjection({
      position: 90n,
      headPosition: 120n,
      onRun: async (context) => {
        await new Promise<void>((resolve) =>
          context?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        context?.throwIfLeaseLost?.();
      },
    });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n })], { renewResult: false });
    const controlPlane = recordingControlPlane();
    const lost: ProjectionWakeIntentLifecycleEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      claimTtlMs: 3_000,
      observer: { wakeIntentClaimLost: (event) => lost.push(event) },
      now: () => NOW,
    });

    const runPromise = runners[0].runOnce();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(runPromise).resolves.toMatchObject({ processed: 0 });
    expect(store.renewals).toHaveLength(1);
    expect(store.failures).toHaveLength(0);
    expect(lost).toHaveLength(1);
    vi.useRealTimers();
  });

  it("drains multiple projection batches inside one claim until the required position is reached", async () => {
    const projection = checkoutProjection({ position: 90n, headPosition: 120n, stepPerRun: 5n });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n })]);
    const controlPlane = recordingControlPlane();
    const completed: ProjectionWakeIntentCompletedEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      observer: { wakeIntentCompleted: (event) => completed.push(event) },
      now: () => NOW,
    });
    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 1 });
    expect(projection.runCount()).toBe(3);
    expect(projection.subscriptionRefreshCount()).toBe(1);
    expect(controlPlane.acquiredLeaseNames).toHaveLength(1);
    expect(completed[0]).toMatchObject({ outcome: "ran", checkpointPosition: "105" });
  });

  it("completes already-satisfied intents without running the projection group", async () => {
    const projection = checkoutProjection({ position: 200n, headPosition: 200n });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n })]);
    const controlPlane = recordingControlPlane();
    const completed: ProjectionWakeIntentCompletedEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "standard", runnerCount: 1 }],
      observer: { wakeIntentCompleted: (event) => completed.push(event) },
      now: () => NOW,
    });
    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 1 });
    expect(projection.runCount()).toBe(0);
    expect(controlPlane.acquiredLeaseNames).toEqual([]);
    expect(store.completions).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      outcome: "already-satisfied",
      checkpointPosition: "200",
      processingDurationMs: 0,
    });
  });

  it("retries with exponential backoff when the checkpoint makes no progress", async () => {
    const projection = checkoutProjection({ position: 95n, headPosition: 95n, blockedStreamCount: 1 });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n, attemptCount: 3 })]);
    const controlPlane = recordingControlPlane();
    const notReady: ProjectionWakeIntentRetryEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "standard", runnerCount: 1 }],
      retryBackoffBaseMs: 1_000,
      retryBackoffMaxMs: 60_000,
      observer: { wakeIntentNotReady: (event) => notReady.push(event) },
      now: () => NOW,
    });
    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 0, state: "caught-up" });
    expect(projection.runCount()).toBe(1);
    expect(store.completions).toHaveLength(0);
    expect(store.failures).toHaveLength(1);
    expect(store.failures[0]).toMatchObject({ retryAfterMs: 4_000 });
    expect(store.failures[0].error).toMatchObject({
      reason: "checkpoint-not-ready",
      checkpointPosition: "95",
      requiredPosition: "102",
      blockedStreamCount: 1,
    });
    expect(notReady).toHaveLength(1);
  });

  it("retries quickly without escalation while the checkpoint is progressing toward the target", async () => {
    const projection = checkoutProjection({ position: 90n, headPosition: 120n, stepPerRun: 5n });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n, attemptCount: 9 })]);
    const controlPlane = recordingControlPlane();
    const notReady: ProjectionWakeIntentRetryEvent[] = [];
    const exhausted: ProjectionWakeIntentLifecycleEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      maxRunsPerClaim: 1,
      deferredRetryMs: 750,
      maxAttempts: 9,
      observer: {
        wakeIntentNotReady: (event) => notReady.push(event),
        wakeIntentAttemptsExhausted: (event) => exhausted.push(event),
      },
      now: () => NOW,
    });
    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 0 });
    expect(projection.runCount()).toBe(1);
    expect(store.failures[0]).toMatchObject({ retryAfterMs: 750 });
    expect(store.failures[0].error).toMatchObject({
      reason: "checkpoint-progressing",
      checkpointPosition: "95",
      requiredPosition: "102",
    });
    expect(notReady).toHaveLength(1);
    expect(exhausted).toHaveLength(0);
  });

  it("defers with a short retry when the projection group lease is busy", async () => {
    const projection = checkoutProjection({ position: 90n, headPosition: 120n });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n })]);
    const controlPlane = recordingControlPlane({ acquireLease: () => null });
    const deferred: ProjectionWakeIntentRetryEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      deferredRetryMs: 750,
      observer: { wakeIntentDeferred: (event) => deferred.push(event) },
      now: () => NOW,
    });
    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 0 });
    expect(projection.runCount()).toBe(0);
    expect(store.failures).toHaveLength(0);
    expect(store.deferrals[0]).toMatchObject({ retryAfterMs: 750 });
    expect(store.deferrals[0].error).toMatchObject({ reason: "projection-group-lease-busy" });
    expect(deferred).toHaveLength(1);
  });

  it("completes after a lease-busy claim when a concurrent runner advanced the checkpoint", async () => {
    const projection = checkoutProjection({ position: 90n, headPosition: 120n });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n })]);
    const controlPlane = recordingControlPlane({
      acquireLease: () => {
        projection.setPosition(110n);
        return null;
      },
    });
    const completed: ProjectionWakeIntentCompletedEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      observer: { wakeIntentCompleted: (event) => completed.push(event) },
      now: () => NOW,
    });
    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 1 });
    expect(projection.runCount()).toBe(0);
    expect(store.completions).toHaveLength(1);
    expect(completed[0]).toMatchObject({ outcome: "already-satisfied", checkpointPosition: "110" });
  });

  it("defers wake intents while the projection group has a stale revision pending rebuild", async () => {
    const projection = checkoutProjection({ position: 90n, headPosition: 120n, revisionStale: true });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n })]);
    const controlPlane = recordingControlPlane();
    const deferred: ProjectionWakeIntentRetryEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      revisionStaleRetryMs: 20_000,
      observer: { wakeIntentDeferred: (event) => deferred.push(event) },
      now: () => NOW,
    });
    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 0 });
    expect(projection.runCount()).toBe(0);
    expect(projection.resetCount()).toBe(0);
    expect(controlPlane.released).toBe(1);
    expect(store.failures[0]).toMatchObject({ retryAfterMs: 20_000 });
    expect(store.failures[0].error).toMatchObject({ reason: "projection-revision-rebuilding" });
    expect(deferred).toHaveLength(1);
  });

  it("fails the intent durably and ends the pass when the projection run fails", async () => {
    const projection = checkoutProjection({
      position: 90n,
      headPosition: 120n,
      runError: new Error("projection handler exploded"),
    });
    const store = recordingSchedulerStore([
      claimedIntent({ requiredPosition: 102n, attemptCount: 1 }),
      claimedIntent({ wakeIntentId: "projection-wake-2", requiredPosition: 103n }),
    ]);
    const controlPlane = recordingControlPlane();
    const failures: Array<ProjectionWakeIntentRetryEvent & { error: unknown }> = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      observer: { wakeIntentRunFailed: (event) => failures.push(event) },
      now: () => NOW,
    });

    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 0 });
    expect(store.claims).toHaveLength(1);
    expect(store.failures[0].error).toMatchObject({
      reason: "projection-run-failed",
      message: "projection handler exploded",
    });
    expect(failures).toHaveLength(1);
    expect(controlPlane.released).toBe(1);
  });

  it("fails unknown projection targets with the unknown-target retry and keeps claiming", async () => {
    const projection = checkoutProjection({ position: 90n, headPosition: 120n });
    const store = recordingSchedulerStore([
      claimedIntent({
        wakeIntentId: "projection-wake-unknown",
        targetContextName: "ordering",
        projectionName: "missing-projection",
        checkpointKey: "missing-projection:checkout:v1",
        requiredPosition: 10n,
      }),
      claimedIntent({ requiredPosition: 102n }),
    ]);
    const controlPlane = recordingControlPlane();
    const unknown: ProjectionWakeIntentRetryEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      unknownTargetRetryMs: 15_000,
      observer: { wakeIntentUnknownTarget: (event) => unknown.push(event) },
      now: () => NOW,
    });
    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 1 });
    expect(unknown).toHaveLength(1);
    expect(store.failures[0]).toMatchObject({ wakeIntentId: "projection-wake-unknown", retryAfterMs: 15_000 });
    expect(store.failures[0].error).toMatchObject({ reason: "unknown-projection-group" });
    expect(store.completions).toHaveLength(1);
  });

  it("fails unknown checkpoint keys inside a hosted projection group", async () => {
    const projection = checkoutProjection({ position: 90n, headPosition: 120n });
    const store = recordingSchedulerStore([
      claimedIntent({ checkpointKey: "checkout-session-pages:identity:v2", requiredPosition: 10n }),
    ]);
    const controlPlane = recordingControlPlane();

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      now: () => NOW,
    });
    await runners[0].runOnce();

    expect(store.failures[0].error).toMatchObject({ reason: "unknown-checkpoint-key" });
    expect(projection.runCount()).toBe(0);
  });

  it("bounds each pass to maxClaimsPerRun", async () => {
    const projection = checkoutProjection({ position: 200n, headPosition: 200n });
    const store = recordingSchedulerStore([
      claimedIntent({ wakeIntentId: "projection-wake-a", requiredPosition: 10n }),
      claimedIntent({ wakeIntentId: "projection-wake-b", requiredPosition: 11n }),
      claimedIntent({ wakeIntentId: "projection-wake-c", requiredPosition: 12n }),
    ]);
    const controlPlane = recordingControlPlane();

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      maxClaimsPerRun: 2,
      now: () => NOW,
    });
    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 2 });
    expect(store.claims).toHaveLength(2);
  });

  it("stops claiming when the pass is aborted", async () => {
    const projection = checkoutProjection({ position: 200n, headPosition: 200n });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 10n })]);
    const controlPlane = recordingControlPlane();

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      now: () => NOW,
    });
    const result = await runners[0].runOnce({ signal: AbortSignal.abort() } as ProjectionRunContext);

    expect(result).toMatchObject({ processed: 0, state: "caught-up" });
    expect(store.claims).toHaveLength(0);
  });

  it("emits attempts-exhausted once when the configured attempt budget is reached without progress", async () => {
    const projection = checkoutProjection({ position: 95n, headPosition: 95n });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n, attemptCount: 5 })]);
    const controlPlane = recordingControlPlane();
    const exhausted: ProjectionWakeIntentLifecycleEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "standard", runnerCount: 1 }],
      maxAttempts: 5,
      observer: { wakeIntentAttemptsExhausted: (event) => exhausted.push(event) },
      now: () => NOW,
    });
    await runners[0].runOnce();

    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({ attemptCount: 5 });
  });

  it("does not re-emit attempts-exhausted past the attempt budget", async () => {
    const projection = checkoutProjection({ position: 95n, headPosition: 95n });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n, attemptCount: 6 })]);
    const controlPlane = recordingControlPlane();
    const exhausted: ProjectionWakeIntentLifecycleEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "standard", runnerCount: 1 }],
      maxAttempts: 5,
      observer: { wakeIntentAttemptsExhausted: (event) => exhausted.push(event) },
      now: () => NOW,
    });
    await runners[0].runOnce();

    expect(exhausted).toHaveLength(0);
  });

  it("reports requeued completions when newer work arrived during the run", async () => {
    const projection = checkoutProjection({ position: 200n, headPosition: 200n });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n })], {
      completeResult: "requeued",
    });
    const controlPlane = recordingControlPlane();
    const completed: ProjectionWakeIntentCompletedEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      observer: { wakeIntentCompleted: (event) => completed.push(event) },
      now: () => NOW,
    });
    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 1 });
    expect(completed[0]).toMatchObject({ outcome: "already-satisfied", requeued: true });
  });

  it("reports a lost claim when completion is fenced out", async () => {
    const projection = checkoutProjection({ position: 200n, headPosition: 200n });
    const store = recordingSchedulerStore([claimedIntent({ requiredPosition: 102n })], {
      completeResult: "lost",
    });
    const controlPlane = recordingControlPlane();
    const lost: ProjectionWakeIntentLifecycleEvent[] = [];

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      observer: { wakeIntentClaimLost: (event) => lost.push(event) },
      now: () => NOW,
    });
    const result = await runners[0].runOnce();

    expect(result).toMatchObject({ processed: 0 });
    expect(lost).toHaveLength(1);
    expect(store.readiness).toHaveLength(1);
  });

  it("propagates work-signal store claim failures so the worker loop applies failure backoff", async () => {
    const projection = checkoutProjection({ position: 90n, headPosition: 120n });
    const controlPlane = recordingControlPlane();
    const store: Parameters<typeof createProjectionWakeSchedulerRunners>[0]["workSignalStore"] = {
      claimNextProjectionWakeIntent: async () => {
        throw new Error("work-signal store unavailable");
      },
      renewProjectionWakeIntent: async () => {
        throw new Error("not used");
      },
      completeProjectionWakeIntent: async () => {
        throw new Error("not used");
      },
      deferProjectionWakeIntent: async () => {
        throw new Error("not used");
      },
      failProjectionWakeIntent: async () => {
        throw new Error("not used");
      },
      recordCheckpointReady: async () => {
        throw new Error("not used");
      },
    };

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store,
      projectionGroups: [projection.group],
      lanes: [{ lane: "hot", runnerCount: 1 }],
      now: () => NOW,
    });

    await expect(runners[0].runOnce()).rejects.toThrow("work-signal store unavailable");
    expect(projection.runCount()).toBe(0);
    expect(controlPlane.acquiredLeaseNames).toEqual([]);
  });

  it("creates lane runner instances per configured count and skips empty lanes", () => {
    const projection = checkoutProjection({ position: 0n, headPosition: 0n });
    const store = recordingSchedulerStore([]);
    const controlPlane = recordingControlPlane();

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [
        { lane: "hot", runnerCount: 2 },
        { lane: "standard", runnerCount: 1 },
        { lane: "bulk", runnerCount: 0 },
      ],
    });

    expect(runners.map((runner) => runner.name)).toEqual([
      "projection-wake-scheduler.hot.lane-1",
      "projection-wake-scheduler.hot.lane-2",
      "projection-wake-scheduler.standard.lane-1",
    ]);
  });

  it("marks only hot-lane runners as reserved-capacity runners", () => {
    const projection = checkoutProjection({ position: 0n, headPosition: 0n });
    const store = recordingSchedulerStore([]);
    const controlPlane = recordingControlPlane();

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [projection.group],
      lanes: [
        { lane: "hot", runnerCount: 1 },
        { lane: "standard", runnerCount: 1 },
        { lane: "bulk", runnerCount: 1 },
      ],
    });

    expect(runners.map((runner) => ({ name: runner.name, reserved: runner.reservedCapacity === true }))).toEqual([
      { name: "projection-wake-scheduler.hot.lane-1", reserved: true },
      { name: "projection-wake-scheduler.standard.lane-1", reserved: false },
      { name: "projection-wake-scheduler.bulk.lane-1", reserved: false },
    ]);
  });

  it("completes hot-lane intents in the reserved slot while bulk passes occupy the shared wake capacity", async () => {
    const projection = checkoutProjection({ position: 200n, headPosition: 200n });
    const completed: ProjectionWakeIntentCompletedEvent[] = [];
    let releaseBulkClaims: (() => void) | null = null;
    const bulkClaimsBlocked = new Promise<void>((resolve) => {
      releaseBulkClaims = resolve;
    });
    const hotQueue = [claimedIntent({ requiredPosition: 102n, priorityLane: "hot" })];
    const store: Parameters<typeof createProjectionWakeSchedulerRunners>[0]["workSignalStore"] = {
      claimNextProjectionWakeIntent: async (input) => {
        if (input.priorityLanes?.includes("bulk")) {
          // A bulk pass wedges mid-claim for the whole test window, holding
          // its wake-loop slot exactly like a long backlog drain would.
          await bulkClaimsBlocked;
          return null;
        }
        return hotQueue.shift() ?? null;
      },
      renewProjectionWakeIntent: async () => true,
      completeProjectionWakeIntent: async () => "completed",
      deferProjectionWakeIntent: async () => true,
      failProjectionWakeIntent: async () => true,
      recordCheckpointReady: async () => ({}) as never,
    };
    const schedulerControlPlane = recordingControlPlane();
    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: schedulerControlPlane.controlPlane,
      workSignalStore: store,
      projectionGroups: [projection.group],
      lanes: [
        { lane: "bulk", runnerCount: 2 },
        { lane: "hot", runnerCount: 1 },
      ],
      observer: { wakeIntentCompleted: (event) => completed.push(event) },
      now: () => NOW,
    });
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane: loopControlPlane(),
      runners,
      maxConcurrentRunners: 2,
      reservedRunnerSlots: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(completed).toHaveLength(1);
      });
    } finally {
      (releaseBulkClaims as (() => void) | null)?.();
      await loop.stop();
    }

    expect(completed[0]).toMatchObject({ priorityLane: "hot", outcome: "already-satisfied" });
    expect(loop.status()).toMatchObject({ reservedRunnerSlots: 1 });
  });

  it("returns no runners when the worker hosts no projection groups", () => {
    const store = recordingSchedulerStore([]);
    const controlPlane = recordingControlPlane();

    const runners = createProjectionWakeSchedulerRunners({
      workerId: "worker-a",
      controlPlane: controlPlane.controlPlane,
      workSignalStore: store.store,
      projectionGroups: [],
    });

    expect(runners).toHaveLength(0);
  });

  it("scopes each lane lease to the worker's hosted-context cohort so heterogeneous fleets do not collide", () => {
    const checkout = projectionGroupFor({ targetContextName: "checkout", position: 0n, headPosition: 0n });
    const ordering = projectionGroupFor({ targetContextName: "ordering", position: 0n, headPosition: 0n });
    const build = (groups: readonly ContextProjectionGroup[]) =>
      createProjectionWakeSchedulerRunners({
        workerId: "worker",
        controlPlane: recordingControlPlane().controlPlane,
        workSignalStore: recordingSchedulerStore([]).store,
        projectionGroups: groups,
        lanes: [{ lane: "hot", runnerCount: 1 }],
      })[0];

    const checkoutHostRunner = build([checkout.group]);
    const orderingHostRunner = build([ordering.group]);
    const checkoutHostReplica = build([checkout.group]);

    // Stable observability names never change; only the single-flight lease
    // identity carries the cohort so it never starves a context it cannot claim.
    expect(checkoutHostRunner.name).toBe("projection-wake-scheduler.hot.lane-1");
    expect(orderingHostRunner.name).toBe("projection-wake-scheduler.hot.lane-1");
    expect(checkoutHostRunner.leaseName).toContain("projection-wake-scheduler.hot.lane-1@ctx-");
    // Different hosted-context sets => different lease => independent lane.
    expect(checkoutHostRunner.leaseName).not.toBe(orderingHostRunner.leaseName);
    // Identical hosted-context sets => same lease => shared single-flight budget.
    expect(checkoutHostReplica.leaseName).toBe(checkoutHostRunner.leaseName);
  });

  it("does not starve a checkout hot intent when the hot lane is held by a worker that does not host checkout", async () => {
    // Regression for #4643: two workers share one wake store + control plane
    // (an App Platform + DOKS estate cutover on one control DB). Worker A hosts
    // ONLY ordering and grabs the hot lane first; worker B hosts checkout. The
    // single queued checkout hot intent must still be claimed and completed by
    // worker B even while worker A owns a hot-lane lease. Before the cohort-
    // scoped lease fix, A's platform-wide `hot.lane-1` lease locked B out and
    // the checkout intent starved at attempt 0 forever.
    const fleetControlPlane = sharedFleetControlPlane();
    const store = sharedFleetWakeStore([
      queuedIntent({
        wakeIntentId: "wake-checkout-hot",
        targetContextName: "checkout",
        projectionName: "checkout-session-pages",
        checkpointKey: "checkout-session-pages:checkout:v1",
        priorityLane: "hot",
        requiredPosition: 12n,
      }),
    ]);

    // Worker A hosts ONLY ordering (its claim filter can never match checkout).
    const orderingHost = projectionGroupFor({ targetContextName: "ordering", position: 50n, headPosition: 50n });
    // Worker B hosts checkout, already past the required position (ready).
    const checkoutHost = projectionGroupFor({ targetContextName: "checkout", position: 50n, headPosition: 50n });

    const loopA = wakeLoopFor("worker-a", fleetControlPlane, store, [orderingHost.group]);
    const loopB = wakeLoopFor("worker-b", fleetControlPlane, store, [checkoutHost.group]);

    loopA.start();
    try {
      // Let worker A win a hot-lane lease first, exactly as it would in prod.
      await vi.waitFor(() => {
        expect(fleetControlPlane.heldLeaseNames().some((name) => name.includes("hot.lane-1"))).toBe(true);
      });

      loopB.start();
      await vi.waitFor(
        () => {
          expect(store.stateOf("wake-checkout-hot")).toBe("completed");
        },
        { timeout: 2_000 },
      );
    } finally {
      await loopA.stop();
      await loopB.stop();
    }

    // Two distinct hot-lane leases were granted — one per hosted-context cohort.
    const hotLeases = new Set(fleetControlPlane.grantedLeaseNames().filter((name) => name.includes("hot.lane-1")));
    expect(hotLeases.size).toBe(2);
    // Worker B (the checkout host) is the one that claimed and completed it.
    expect(store.claimOwnerHistory("wake-checkout-hot").some((owner) => owner.startsWith("worker-b:"))).toBe(true);
  });
});

describe("work signal cleanup runner", () => {
  it("cleans expired work signals when the scheduled claim succeeds", async () => {
    const cleanupCalls: Array<{ limit?: number }> = [];
    const scheduledClaims: Array<{ runnerName: string; intervalMs: number }> = [];
    const completions: string[] = [];
    const observed: Array<Parameters<NonNullable<ProjectionWakeSchedulerObserver["workSignalCleanupCompleted"]>>[0]> =
      [];

    const runner = createWorkSignalCleanupRunner({
      controlPlane: {
        claimScheduledRunner: async (input: { runnerName: string; intervalMs: number }) => {
          scheduledClaims.push(input);
          return true;
        },
        recordScheduledRunnerCompleted: async (input: { runnerName: string }) => {
          completions.push(input.runnerName);
        },
      } as never,
      workSignalStore: {
        cleanupExpiredWorkSignals: async (input?: { limit?: number }) => {
          cleanupCalls.push({ limit: input?.limit });
          return {
            expiredWakeIntents: 2,
            prunedWakeIntents: 3,
            prunedCheckpointReadiness: 4,
            prunedCheckpointWaiters: 1,
            immortalWakeIntents: 0,
          };
        },
      },
      intervalMs: 45_000,
      limit: 250,
      observer: { workSignalCleanupCompleted: (event) => observed.push(event) },
    });

    const result = await runner.runOnce();

    expect(result).toMatchObject({ processed: 10, state: "caught-up" });
    expect(scheduledClaims).toEqual([{ runnerName: "work-signals.cleanup", intervalMs: 45_000 }]);
    expect(cleanupCalls).toEqual([{ limit: 250 }]);
    expect(completions).toEqual(["work-signals.cleanup"]);
    expect(observed).toHaveLength(1);
  });

  it("skips cleanup when the scheduled interval has not elapsed", async () => {
    const runner = createWorkSignalCleanupRunner({
      controlPlane: {
        claimScheduledRunner: async () => false,
        recordScheduledRunnerCompleted: async () => {
          throw new Error("should not record completion without a claim");
        },
      } as never,
      workSignalStore: {
        cleanupExpiredWorkSignals: async () => {
          throw new Error("should not clean without a claim");
        },
      },
    });

    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 0, state: "caught-up" });
  });
});

function claimedIntent(
  overrides: Partial<{
    wakeIntentId: string;
    targetContextName: string;
    projectionName: string;
    checkpointKey: string;
    requiredPosition: bigint;
    priorityLane: ProjectionWakeIntentRecord["priorityLane"];
    attemptCount: number;
  }> = {},
): ProjectionWakeIntentRecord {
  const requiredPosition = overrides.requiredPosition ?? 102n;
  return {
    wakeIntentId: overrides.wakeIntentId ?? "projection-wake-1",
    coalescingKey: "projection-wake:checkout:checkout:checkout-session-pages",
    sourceContextName: "checkout",
    targetContextName: overrides.targetContextName ?? "checkout",
    projectionName: overrides.projectionName ?? "checkout-session-pages",
    checkpointKey: overrides.checkpointKey ?? "checkout-session-pages:checkout:v1",
    requiredPosition,
    requiredCursor: `checkout:${requiredPosition}`,
    priorityLane: overrides.priorityLane ?? "hot",
    origin: "relay",
    schemaVersion: 1,
    payloadVersion: 1,
    correlationId: "corr_1",
    metadata: {},
    state: "claimed",
    claimOwnerId: "worker-a:projection-wake-scheduler.hot.lane-1",
    claimFencingToken: 7n,
    claimedRequiredPosition: requiredPosition,
    claimedRequiredCursor: `checkout:${requiredPosition}`,
    claimedUntil: new Date(NOW.getTime() + 120_000),
    nextEligibleAt: CREATED_AT,
    attemptCount: overrides.attemptCount ?? 1,
    lastError: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    expiresAt: new Date(NOW.getTime() + 300_000),
    completedAt: null,
  };
}

function recordingSchedulerStore(
  intents: readonly ProjectionWakeIntentRecord[],
  options: { completeResult?: ProjectionWakeIntentCompletionResult; renewResult?: boolean } = {},
) {
  const queue = [...intents];
  const claims: ClaimProjectionWakeIntentInput[] = [];
  const renewals: RenewProjectionWakeIntentInput[] = [];
  const completions: CompleteProjectionWakeIntentInput[] = [];
  const deferrals: DeferProjectionWakeIntentInput[] = [];
  const failures: FailProjectionWakeIntentInput[] = [];
  const readiness: RecordCheckpointReadyInput[] = [];

  return {
    claims,
    renewals,
    completions,
    deferrals,
    failures,
    readiness,
    store: {
      claimNextProjectionWakeIntent: async (input: ClaimProjectionWakeIntentInput) => {
        claims.push(input);
        return queue.shift() ?? null;
      },
      renewProjectionWakeIntent: async (input: RenewProjectionWakeIntentInput) => {
        renewals.push(input);
        return options.renewResult ?? true;
      },
      completeProjectionWakeIntent: async (input: CompleteProjectionWakeIntentInput) => {
        completions.push(input);
        return options.completeResult ?? "completed";
      },
      deferProjectionWakeIntent: async (input: DeferProjectionWakeIntentInput) => {
        deferrals.push(input);
        return true;
      },
      failProjectionWakeIntent: async (input: FailProjectionWakeIntentInput) => {
        failures.push(input);
        return true;
      },
      recordCheckpointReady: async (input: RecordCheckpointReadyInput) => {
        readiness.push(input);
        return {} as never;
      },
    },
  };
}

function loopControlPlane(): PlatformControlPlane {
  return {
    acquireLease: async (input: { leaseName: string; ownerId: string; ttlMs: number }) => ({
      leaseName: input.leaseName,
      ownerId: input.ownerId,
      fencingToken: "1",
      expiresAt: new Date(NOW.getTime() + input.ttlMs).toISOString(),
    }),
    renewLease: async () => true,
    releaseLease: async () => {},
    recordRunnerStatus: async () => {},
    recordProjectionStatusSnapshot: async () => {},
  } as never;
}

function recordingControlPlane(
  options: {
    acquireLease?: () => Readonly<{
      leaseName: string;
      ownerId: string;
      fencingToken: string;
      expiresAt: string;
    }> | null;
  } = {},
) {
  const acquiredLeaseNames: string[] = [];
  const state = {
    controlPlane: null as unknown as PlatformControlPlane,
    acquiredLeaseNames,
    released: 0,
  };

  state.controlPlane = {
    acquireLease: async (input: { leaseName: string; ownerId: string }) => {
      const lease = options.acquireLease
        ? options.acquireLease()
        : {
            leaseName: input.leaseName,
            ownerId: input.ownerId,
            fencingToken: "1",
            expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
          };
      if (lease) {
        acquiredLeaseNames.push(input.leaseName);
      }
      return lease;
    },
    renewLease: async () => true,
    releaseLease: async () => {
      state.released += 1;
    },
  } as never;

  return state;
}

function controllableWorkSignalWaiter() {
  let pending: Readonly<{
    input: WaitForPostgresWorkSignalInput;
    resolve: (result: WorkSignalWaitResult) => void;
  }> | null = null;
  let stopped = false;

  const waiter: PostgresWorkSignalWaiter = {
    wait: (input) => {
      if (stopped || input.signal?.aborted) {
        return Promise.resolve("aborted");
      }

      return new Promise<WorkSignalWaitResult>((resolve) => {
        const finish = (result: WorkSignalWaitResult) => {
          input.signal?.removeEventListener("abort", onAbort);
          if (pending?.resolve === resolve) {
            pending = null;
          }
          resolve(result);
        };
        const onAbort = () => finish("aborted");
        pending = { input, resolve: finish };
        input.signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    stop: async () => {
      stopped = true;
      pending?.resolve("aborted");
      pending = null;
    },
  };

  return {
    waiter,
    notify: (notification: PostgresWorkSignalNotification) => {
      if (pending?.input.matches(notification)) {
        pending.resolve("notified");
      }
    },
  };
}

function scriptedWorkSignalWaiter(results: readonly WorkSignalWaitResult[]): PostgresWorkSignalWaiter {
  const remaining = [...results];
  let pendingResolve: ((result: WorkSignalWaitResult) => void) | null = null;

  return {
    wait: (input) => {
      if (input.signal?.aborted) {
        return Promise.resolve("aborted");
      }

      const next = remaining.shift();
      if (next) {
        return Promise.resolve(next);
      }

      return new Promise<WorkSignalWaitResult>((resolve) => {
        pendingResolve = resolve;
        input.signal?.addEventListener(
          "abort",
          () => {
            pendingResolve = null;
            resolve("aborted");
          },
          { once: true },
        );
      });
    },
    stop: async () => {
      pendingResolve?.("aborted");
      pendingResolve = null;
    },
  };
}

function wakeIntentNotification(
  payload: Partial<ProjectionWakeIntentWorkSignalPayload> = {},
): PostgresWorkSignalNotification {
  return {
    channel: PROJECTION_WAKE_INTENT_WORK_SIGNAL_CHANNEL,
    envelope: createWorkSignalEnvelope({
      kind: "projection.wake-intent",
      source: "test",
      payload: {
        outcome: "created",
        wakeIntentId: "projection-wake-1",
        sourceContextName: "catalog",
        targetContextName: "checkout",
        projectionName: "checkout-session-pages",
        checkpointKey: "checkout-session-pages:checkout:v1",
        requiredPosition: "12",
        requiredCursor: "catalog:12",
        priorityLane: "hot",
        origin: "relay",
        state: "queued",
        nextEligibleAt: NOW.toISOString(),
        ...payload,
      },
    }),
  };
}

function checkoutProjection(
  input: Readonly<{
    position: bigint;
    headPosition: bigint;
    stepPerRun?: bigint;
    blockedStreamCount?: number;
    runError?: Error;
    revisionStale?: boolean;
    onRunContext?: (context: ProjectionRunContext | undefined) => void;
    onRun?: (context: ProjectionRunContext | undefined) => void | Promise<void>;
  }>,
) {
  let position = input.position;
  let runCount = 0;
  let resetCount = 0;
  let subscriptionRefreshCount = 0;

  const subscriptionRunner: ContextSubscriptionRunner = {
    subscriptionName: "checkout.checkout-session-pages.checkout",
    projectionName: "checkout-session-pages",
    sourceContextName: "checkout",
    targetContextName: "checkout",
    subscriptionVersion: 1,
    checkpointKey: "checkout-session-pages:checkout:v1",
    order: 0,
    runOnce: async (context) => {
      input.onRunContext?.(context);
      await input.onRun?.(context);
      runCount += 1;
      if (input.runError) {
        throw input.runError;
      }

      const next = input.stepPerRun ? position + input.stepPerRun : input.headPosition;
      const advanced = next > input.headPosition ? input.headPosition : next;
      const processed = Number(advanced - position);
      position = advanced;
      return {
        processed,
        lastGlobalPosition: position.toString() as never,
        state: "caught-up",
        blockedStreams: input.blockedStreamCount ?? 0,
        poisonEvents: 0,
      };
    },
    getStatus: () => subscriptionStatus(position, input.blockedStreamCount ?? 0),
    refreshStatus: async () => {
      subscriptionRefreshCount += 1;
      return subscriptionStatus(position, input.blockedStreamCount ?? 0);
    },
    reset: async () => {
      resetCount += 1;
    },
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
    reset: async () => {
      resetCount += 1;
    },
    getStatus: () => groupStatus(position, input.blockedStreamCount ?? 0, input.revisionStale ?? false),
    refreshStatus: async () => groupStatus(position, input.blockedStreamCount ?? 0, input.revisionStale ?? false),
    markRevisionSynced: async () => {},
  };

  return {
    group,
    runCount: () => runCount,
    resetCount: () => resetCount,
    subscriptionRefreshCount: () => subscriptionRefreshCount,
    setPosition: (next: bigint) => {
      position = next;
    },
  };
}

function subscriptionStatus(position: bigint, blockedStreamCount: number) {
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
    blockedStreamCount,
    poisonEventCount: 0,
    updatedAt: NOW.toISOString(),
  };
}

function groupStatus(position: bigint, blockedStreamCount: number, revisionStale: boolean) {
  return {
    projectionName: "checkout-session-pages",
    projectionRevision: 1,
    storedProjectionRevision: revisionStale ? 0 : 1,
    revisionStale,
    targetContextName: "checkout",
    sourceContextNames: ["checkout"],
    ownedTables: ["checkout_session_pages"],
    requiredDuringBootstrap: false,
    initialized: true,
    caughtUp: true,
    state: "caught-up" as const,
    lastError: null,
    outstandingEventCount: "0",
    blockedStreamCount,
    poisonEventCount: 0,
    updatedAt: NOW.toISOString(),
    subscriptions: [subscriptionStatus(position, blockedStreamCount)],
  };
}

// --- Heterogeneous-fleet starvation regression helpers (issue #4643) ---

function projectionGroupFor(
  input: Readonly<{
    targetContextName: string;
    projectionName?: string;
    checkpointKey?: string;
    position: bigint;
    headPosition: bigint;
  }>,
) {
  const projectionName = input.projectionName ?? `${input.targetContextName}-session-pages`;
  const checkpointKey = input.checkpointKey ?? `${projectionName}:${input.targetContextName}:v1`;
  const subscriptionName = `${input.targetContextName}.${projectionName}.${input.targetContextName}`;
  let position = input.position;

  const status = () => ({
    checkpointKey,
    subscriptionName,
    projectionName,
    sourceContextName: input.targetContextName,
    targetContextName: input.targetContextName,
    subscriptionVersion: 1,
    initialized: true,
    lastGlobalPosition: position.toString() as never,
    sourceHeadGlobalPosition: input.headPosition.toString() as never,
    outstandingEventCount: "0",
    processedEvents: 0,
    state: "caught-up" as const,
    lastError: null,
    blockedStreamCount: 0,
    poisonEventCount: 0,
    updatedAt: NOW.toISOString(),
  });

  const subscriptionRunner: ContextSubscriptionRunner = {
    subscriptionName,
    projectionName,
    sourceContextName: input.targetContextName,
    targetContextName: input.targetContextName,
    subscriptionVersion: 1,
    checkpointKey,
    order: 0,
    runOnce: async () => {
      position = input.headPosition;
      return {
        processed: 0,
        lastGlobalPosition: position.toString() as never,
        state: "caught-up",
        blockedStreams: 0,
        poisonEvents: 0,
      };
    },
    getStatus: status,
    refreshStatus: async () => status(),
    reset: async () => {},
    retryBlockedStream: async () => ({}) as never,
  };

  const group: ContextProjectionGroup = {
    projectionName,
    projectionRevision: 1,
    targetContextName: input.targetContextName,
    sourceContextNames: [input.targetContextName],
    optionalSourceContextNames: [],
    ownedTables: [`${input.targetContextName}_session_pages`],
    requiredDuringBootstrap: false,
    subscriptionRunners: [subscriptionRunner],
    reset: async () => {},
    getStatus: () => ({
      projectionName,
      projectionRevision: 1,
      storedProjectionRevision: 1,
      revisionStale: false,
      targetContextName: input.targetContextName,
      sourceContextNames: [input.targetContextName],
      ownedTables: [`${input.targetContextName}_session_pages`],
      requiredDuringBootstrap: false,
      initialized: true,
      caughtUp: true,
      state: "caught-up" as const,
      lastError: null,
      outstandingEventCount: "0",
      blockedStreamCount: 0,
      poisonEventCount: 0,
      updatedAt: NOW.toISOString(),
      subscriptions: [status()],
    }),
    refreshStatus: async () => group.getStatus(),
    markRevisionSynced: async () => {},
  };

  return { group };
}

function queuedIntent(
  overrides: Partial<{
    wakeIntentId: string;
    targetContextName: string;
    projectionName: string;
    checkpointKey: string;
    requiredPosition: bigint;
    priorityLane: ProjectionWakeIntentRecord["priorityLane"];
  }> = {},
): ProjectionWakeIntentRecord {
  const targetContextName = overrides.targetContextName ?? "checkout";
  const projectionName = overrides.projectionName ?? `${targetContextName}-session-pages`;
  const requiredPosition = overrides.requiredPosition ?? 12n;
  return {
    wakeIntentId: overrides.wakeIntentId ?? "projection-wake-1",
    coalescingKey: `projection-wake:${targetContextName}:${targetContextName}:${projectionName}`,
    sourceContextName: targetContextName,
    targetContextName,
    projectionName,
    checkpointKey: overrides.checkpointKey ?? `${projectionName}:${targetContextName}:v1`,
    requiredPosition,
    requiredCursor: `${targetContextName}:${requiredPosition}`,
    priorityLane: overrides.priorityLane ?? "hot",
    origin: "relay",
    schemaVersion: 1,
    payloadVersion: 1,
    correlationId: "corr_1",
    metadata: {},
    state: "queued",
    claimOwnerId: null,
    claimFencingToken: null,
    claimedRequiredPosition: null,
    claimedRequiredCursor: null,
    claimedUntil: null,
    nextEligibleAt: CREATED_AT,
    attemptCount: 0,
    lastError: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    expiresAt: new Date(NOW.getTime() + 300_000),
    completedAt: null,
  };
}

function sharedFleetControlPlane() {
  const held = new Map<string, string>();
  const granted: string[] = [];

  const controlPlane = {
    acquireLease: async (input: { leaseName: string; ownerId: string; ttlMs: number }) => {
      const owner = held.get(input.leaseName);
      if (owner && owner !== input.ownerId) {
        return null;
      }
      held.set(input.leaseName, input.ownerId);
      granted.push(input.leaseName);
      return {
        leaseName: input.leaseName,
        ownerId: input.ownerId,
        fencingToken: "1",
        expiresAt: new Date(NOW.getTime() + input.ttlMs).toISOString(),
      };
    },
    renewLease: async (lease: { leaseName: string; ownerId: string }) => held.get(lease.leaseName) === lease.ownerId,
    releaseLease: async (lease: { leaseName: string; ownerId: string }) => {
      if (held.get(lease.leaseName) === lease.ownerId) {
        held.delete(lease.leaseName);
      }
    },
    recordRunnerStatus: async () => {},
    recordProjectionStatusSnapshot: async () => {},
  } as unknown as PlatformControlPlane;

  return {
    controlPlane,
    heldLeaseNames: () => [...held.keys()],
    grantedLeaseNames: () => [...granted],
  };
}

function sharedFleetWakeStore(intents: readonly ProjectionWakeIntentRecord[]) {
  const records = intents.map((intent) => ({ ...intent }));
  const byId = new Map(records.map((record) => [record.wakeIntentId, record]));
  const ownerHistory = new Map<string, string[]>();
  const laneRank = (lane: ProjectionWakeIntentRecord["priorityLane"]) =>
    lane === "hot" ? 0 : lane === "standard" ? 1 : 2;
  const nowMs = NOW.getTime();

  const store = {
    claimNextProjectionWakeIntent: async (input: ClaimProjectionWakeIntentInput) => {
      if (input.targetContextNames && input.targetContextNames.length === 0) {
        return null;
      }
      const lanes: readonly string[] = input.priorityLanes?.length ? input.priorityLanes : ["hot", "standard", "bulk"];
      const contexts = input.targetContextNames?.length ? new Set(input.targetContextNames) : null;
      const maxAttempts = input.maxAttempts ?? Number.MAX_SAFE_INTEGER;
      const eligible = records
        .filter((record) => {
          const claimable =
            (record.state === "queued" && record.nextEligibleAt.getTime() <= nowMs) ||
            (record.state === "failed" &&
              record.attemptCount < maxAttempts &&
              record.nextEligibleAt.getTime() <= nowMs) ||
            (record.state === "claimed" &&
              record.attemptCount < maxAttempts &&
              (record.claimedUntil?.getTime() ?? 0) <= nowMs);
          return (
            claimable &&
            record.expiresAt.getTime() > nowMs &&
            lanes.includes(record.priorityLane) &&
            (!contexts || contexts.has(record.targetContextName))
          );
        })
        .sort(
          (left, right) =>
            laneRank(left.priorityLane) - laneRank(right.priorityLane) ||
            left.createdAt.getTime() - right.createdAt.getTime(),
        );

      const record = eligible[0];
      if (!record) {
        return null;
      }
      record.state = "claimed";
      record.attemptCount += 1;
      record.claimFencingToken = (record.claimFencingToken ?? 0n) + 1n;
      record.claimOwnerId = input.claimOwnerId;
      record.claimedRequiredPosition = record.requiredPosition;
      record.claimedRequiredCursor = record.requiredCursor;
      record.claimedUntil = new Date(nowMs + Math.max(1, input.claimTtlMs));
      const history = ownerHistory.get(record.wakeIntentId) ?? [];
      history.push(input.claimOwnerId);
      ownerHistory.set(record.wakeIntentId, history);
      return { ...record };
    },
    renewProjectionWakeIntent: async (input: RenewProjectionWakeIntentInput) => {
      const record = byId.get(input.wakeIntentId);
      return Boolean(
        record &&
        record.state === "claimed" &&
        record.claimOwnerId === input.claimOwnerId &&
        record.claimFencingToken === input.claimFencingToken,
      );
    },
    completeProjectionWakeIntent: async (
      input: CompleteProjectionWakeIntentInput,
    ): Promise<ProjectionWakeIntentCompletionResult> => {
      const record = byId.get(input.wakeIntentId);
      if (
        !record ||
        record.state !== "claimed" ||
        record.claimOwnerId !== input.claimOwnerId ||
        record.claimFencingToken !== input.claimFencingToken ||
        (record.claimedUntil?.getTime() ?? 0) <= nowMs
      ) {
        return "lost";
      }
      record.state = "completed";
      record.claimOwnerId = null;
      record.claimedUntil = null;
      record.completedAt = NOW;
      return "completed";
    },
    deferProjectionWakeIntent: async (input: DeferProjectionWakeIntentInput) => {
      const record = byId.get(input.wakeIntentId);
      if (!record) {
        return false;
      }
      record.state = "failed";
      record.claimOwnerId = null;
      record.claimedUntil = null;
      record.nextEligibleAt = new Date(nowMs + Math.max(0, input.retryAfterMs));
      return true;
    },
    failProjectionWakeIntent: async (input: FailProjectionWakeIntentInput) => {
      const record = byId.get(input.wakeIntentId);
      if (!record) {
        return false;
      }
      record.state = "failed";
      record.claimOwnerId = null;
      record.claimedUntil = null;
      record.nextEligibleAt = new Date(nowMs + Math.max(0, input.retryAfterMs));
      return true;
    },
    recordCheckpointReady: async (_input: RecordCheckpointReadyInput) => ({}) as never,
  };

  return {
    store,
    stateOf: (wakeIntentId: string) => byId.get(wakeIntentId)?.state ?? null,
    claimOwnerHistory: (wakeIntentId: string) => ownerHistory.get(wakeIntentId) ?? [],
  };
}

function wakeLoopFor(
  workerId: string,
  fleetControlPlane: ReturnType<typeof sharedFleetControlPlane>,
  store: ReturnType<typeof sharedFleetWakeStore>,
  groups: readonly ContextProjectionGroup[],
) {
  const runners = createProjectionWakeSchedulerRunners({
    workerId,
    controlPlane: fleetControlPlane.controlPlane,
    workSignalStore: store.store,
    projectionGroups: groups,
    lanes: [{ lane: "hot", runnerCount: 1 }],
    now: () => NOW,
  });

  return createWorkerRunnerLoop({
    workerId,
    controlPlane: fleetControlPlane.controlPlane,
    runners,
    maxConcurrentRunners: 1,
    leaseTtlMs: 1_000,
    leaseRenewIntervalMs: 100,
    pollIntervalMs: 5,
  });
}
