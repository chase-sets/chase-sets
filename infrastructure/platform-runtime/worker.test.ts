import { describe, expect, it, vi } from "vitest";
import type { ProjectionRunContext } from "@chase-sets/event-core/projector";
import type { ContextProjectionGroup } from "@chase-sets/bounded-context-runtime";
import type { PlatformControlPlane, PlatformLease, ProjectionOperationRecord } from "./control-plane";
import {
  collectProjectionOperationRunners,
  collectWorkerRunners,
  createDurableJobLaneRunners,
  createWorkerRunnerLeaseName,
  createWorkerRunnerLoop,
  DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS,
  type WorkerHolderLifecycleEvent,
  type WorkerRuntimeObserver,
  type WorkerRunner,
} from "./worker";

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
  it("holder observation preserves worker lifecycle", async () => {
    vi.useFakeTimers();
    try {
      const runScenario = async (observer?: WorkerRuntimeObserver) => {
        const trace: string[] = [];
        const errors: string[] = [];
        const outcomes: Array<Parameters<PlatformControlPlane["recordRunnerStatus"]>[0]> = [];
        const sequences = [[1, 1, 0], [1, new Error("synthetic pass failure"), 0], [0]];
        const runners: WorkerRunner[] = sequences.map((sequence, runnerIndex) => {
          let pass = 0;
          return {
            name: `synthetic.runner-${runnerIndex}`,
            kind: runnerIndex === 2 ? "job" : "projection-group",
            runOnce: async () => {
              trace.push(`run:${runnerIndex}#${pass}`);
              const result = sequence[pass++] ?? 0;
              if (result instanceof Error) throw result;
              return { processed: result, lastGlobalPosition: "1" as never };
            },
          };
        });
        const controlPlane = createAlwaysLeasedControlPlane({
          acquireLease: async (input) => {
            trace.push(`acquire:${input.leaseName}`);
            return {
              leaseName: input.leaseName,
              ownerId: input.ownerId,
              fencingToken: "1",
              expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
            };
          },
          releaseLease: async (lease) => {
            trace.push(`release:${lease.leaseName}`);
          },
          recordRunnerStatus: async (status) => {
            outcomes.push(status);
          },
        });
        const loop = createWorkerRunnerLoop({
          workerId: "synthetic-worker",
          controlPlane,
          runners,
          maxConcurrentRunners: 1,
          leaseTtlMs: 60_000,
          leaseRenewIntervalMs: 60_000,
          pollIntervalMs: 1,
          failureBackoffBaseMs: 0,
          observer,
          onError: (error) => {
            errors.push(error instanceof Error ? error.message : String(error));
          },
        });
        loop.start();
        try {
          await vi.advanceTimersByTimeAsync(20);
        } finally {
          await loop.stop();
        }
        expect(trace).toEqual(expect.arrayContaining(["run:0#2", "run:1#2", "run:2#0"]));
        expect(outcomes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ runnerName: "synthetic.runner-0", state: "caught-up", lastProcessed: 0 }),
            expect.objectContaining({
              runnerName: "synthetic.runner-1",
              state: "error",
              lastError: "synthetic pass failure",
            }),
            expect.objectContaining({ runnerName: "synthetic.runner-1", state: "caught-up", lastProcessed: 0 }),
          ]),
        );
        return { trace, errors, outcomes };
      };
      const baseline = await runScenario();
      const observations: WorkerHolderLifecycleEvent[] = [];
      const recording = await runScenario({
        holderLifecycle: (event) => {
          observations.push(event);
        },
      });
      const throwing = await runScenario({
        holderLifecycle: () => {
          throw new Error("synthetic observer failure");
        },
      });
      expect(observations.length).toBeGreaterThan(0);
      expect(recording).toEqual(baseline);
      expect(throwing.trace).toEqual(baseline.trace);
      expect(throwing.outcomes).toEqual(baseline.outcomes);
      expect(throwing.errors.filter((error) => error !== "synthetic observer failure")).toEqual(baseline.errors);
      expect(throwing.errors.filter((error) => error === "synthetic observer failure")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes projection-group holder intervals", async () => {
    const events: WorkerHolderLifecycleEvent[] = [];
    const runGate = holderTestGate();
    const statusGate = holderTestGate();
    const statusCalls: string[] = [];
    const names = ["synthetic.holder-a", "synthetic.holder-b"];
    const runners: WorkerRunner[] = names.map((name) => {
      let passes = 0;
      return {
        name,
        kind: "projection-group",
        runOnce: async (context) => {
          if (++passes === 1) await runGate.promise;
          else await holderTestAbort(context);
          return { processed: 1, lastGlobalPosition: "1" as never };
        },
      };
    });
    const loop = createWorkerRunnerLoop({
      workerId: "synthetic-worker",
      controlPlane: createAlwaysLeasedControlPlane({
        recordRunnerStatus: async (status) => {
          if (status.lastProcessed === 1) {
            statusCalls.push(status.runnerName);
            await statusGate.promise;
          }
        },
      }),
      runners,
      maxConcurrentRunners: 2,
      leaseTtlMs: 60_000,
      leaseRenewIntervalMs: 60_000,
      pollIntervalMs: 5,
      observer: {
        holderLifecycle: (event) => {
          events.push(event);
        },
      },
    });
    loop.start();
    try {
      await vi.waitFor(() => expect(events.filter((event) => event.phase === "run-start")).toHaveLength(2));
      for (const name of names) {
        expect(events.filter((event) => event.runnerName === name).map((event) => event.phase)).toEqual([
          "acquired",
          "pass-start",
          "run-start",
        ]);
      }
      runGate.resolve();
      await vi.waitFor(() => expect(statusCalls).toHaveLength(2));
      for (const name of names) {
        expect(events.filter((event) => event.runnerName === name).map((event) => event.phase)).toEqual([
          "acquired",
          "pass-start",
          "run-start",
          "run-end",
        ]);
      }
      statusGate.resolve();
      await vi.waitFor(() => expect(events.filter((event) => event.phase === "run-start")).toHaveLength(4));
      const acquired = events.filter((event) => event.phase === "acquired");
      expect(new Set(acquired.map((event) => event.leaseIntervalId))).toHaveLength(2);
      for (const acquisition of acquired) {
        const interval = events.filter((event) => event.leaseIntervalId === acquisition.leaseIntervalId);
        expect(interval.every((event) => event.runnerName === acquisition.runnerName)).toBe(true);
        expect(events.filter((event) => event.runnerName === acquisition.runnerName)).toEqual(interval);
        expect(interval).toMatchObject([
          { phase: "acquired" },
          { phase: "pass-start", passSeq: 1 },
          { phase: "run-start", passSeq: 1 },
          { phase: "run-end", passSeq: 1, outcome: "success" },
          { phase: "pass-end", passSeq: 1, outcome: "success", disposition: "retained", processed: 1 },
          { phase: "pass-start", passSeq: 2 },
          { phase: "run-start", passSeq: 2 },
        ]);
      }
    } finally {
      runGate.resolve();
      statusGate.resolve();
      await loop.stop();
    }
    for (const name of names) {
      expect(events.filter((event) => event.runnerName === name).slice(-3)).toMatchObject([
        { phase: "run-end", outcome: "cancelled" },
        { phase: "pass-end", outcome: "cancelled", disposition: "release-pending" },
        { phase: "released", reason: "stop" },
      ]);
    }
    expect(events.every((event) => Number.isFinite(Date.parse(event.timestamp)) && event.elapsedMs >= 0)).toBe(true);
  });

  it("observes idle yield and a fresh holder interval on reacquisition", async () => {
    const events: WorkerHolderLifecycleEvent[] = [];
    let passes = 0;
    const loop = createWorkerRunnerLoop({
      workerId: "synthetic-worker",
      controlPlane: createAlwaysLeasedControlPlane(),
      runners: [
        {
          name: "synthetic.holder-idle",
          kind: "projection-group",
          runOnce: async (context) => {
            if (++passes > 1) await holderTestAbort(context);
            return { processed: 0, lastGlobalPosition: "0" as never };
          },
        },
      ],
      maxConcurrentRunners: 1,
      leaseTtlMs: 60_000,
      leaseRenewIntervalMs: 60_000,
      pollIntervalMs: 5,
      observer: {
        holderLifecycle: (event) => {
          events.push(event);
        },
      },
    });
    loop.start();
    try {
      await vi.waitFor(() => expect(events.filter((event) => event.phase === "run-start")).toHaveLength(2));
      const [first, second] = events.filter((event) => event.phase === "acquired");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(second?.leaseIntervalId).not.toBe(first?.leaseIntervalId);
      expect(events.filter((event) => event.leaseIntervalId === first?.leaseIntervalId)).toMatchObject([
        { phase: "acquired" },
        { phase: "pass-start", passSeq: 1 },
        { phase: "run-start", passSeq: 1 },
        { phase: "run-end", outcome: "success" },
        { phase: "pass-end", outcome: "success", disposition: "release-pending", processed: 0 },
        { phase: "released", reason: "idle" },
      ]);
      expect(events.slice(6)).toMatchObject([
        { phase: "acquired", leaseIntervalId: second?.leaseIntervalId },
        { phase: "pass-start", passSeq: 1, leaseIntervalId: second?.leaseIntervalId },
        { phase: "run-start", passSeq: 1, leaseIntervalId: second?.leaseIntervalId },
      ]);
    } finally {
      await loop.stop();
    }
  });

  it("observes renewal loss during a run and a new lease incarnation", async () => {
    const events: WorkerHolderLifecycleEvent[] = [];
    let renewals = 0;
    const loop = createWorkerRunnerLoop({
      workerId: "synthetic-worker",
      controlPlane: createAlwaysLeasedControlPlane({ renewLease: async () => ++renewals > 1 }),
      runners: [
        {
          name: "synthetic.holder-renewal-loss",
          kind: "projection-group",
          runOnce: async (context) => {
            await holderTestAbort(context);
            return { processed: 1, lastGlobalPosition: "1" as never };
          },
        },
      ],
      maxConcurrentRunners: 1,
      leaseTtlMs: 60_000,
      leaseRenewIntervalMs: 5,
      pollIntervalMs: 5,
      observer: {
        holderLifecycle: (event) => {
          events.push(event);
        },
      },
    });
    loop.start();
    try {
      await vi.waitFor(() => expect(events.filter((event) => event.phase === "run-start")).toHaveLength(2));
      const [first, second] = events.filter((event) => event.phase === "acquired");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(second?.leaseIntervalId).not.toBe(first?.leaseIntervalId);
      expect(events.filter((event) => event.leaseIntervalId === first?.leaseIntervalId)).toMatchObject([
        { phase: "acquired" },
        { phase: "pass-start", passSeq: 1 },
        { phase: "run-start", passSeq: 1 },
        { phase: "lost", reason: "renewal-loss" },
        { phase: "run-end", outcome: "lease-lost" },
        { phase: "pass-end", outcome: "lease-lost", disposition: "lost" },
        { phase: "released", reason: "renewal-loss" },
      ]);
      expect(events.slice(7)).toMatchObject([
        { phase: "acquired", leaseIntervalId: second?.leaseIntervalId },
        { phase: "pass-start", passSeq: 1, leaseIntervalId: second?.leaseIntervalId },
        { phase: "run-start", passSeq: 1, leaseIntervalId: second?.leaseIntervalId },
      ]);
    } finally {
      await loop.stop();
    }
  });

  it("observes failed idle release without a false released boundary", async () => {
    const events: WorkerHolderLifecycleEvent[] = [];
    const failure = new Error("synthetic release failure");
    const onError = vi.fn();
    const loop = createWorkerRunnerLoop({
      workerId: "synthetic-worker",
      controlPlane: createAlwaysLeasedControlPlane({
        releaseLease: async () => {
          throw failure;
        },
      }),
      runners: [
        {
          name: "synthetic.holder-failed-release",
          kind: "projection-group",
          runOnce: async () => ({ processed: 0, lastGlobalPosition: "0" as never }),
        },
      ],
      maxConcurrentRunners: 1,
      leaseTtlMs: 60_000,
      leaseRenewIntervalMs: 60_000,
      pollIntervalMs: 60_000,
      observer: {
        holderLifecycle: (event) => {
          events.push(event);
        },
      },
      onError,
    });
    loop.start();
    try {
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure, expect.anything()));
      expect(events).toMatchObject([
        { phase: "acquired" },
        { phase: "pass-start", passSeq: 1 },
        { phase: "run-start", passSeq: 1 },
        { phase: "run-end", outcome: "success" },
        { phase: "pass-end", outcome: "success", disposition: "release-pending", processed: 0 },
        { phase: "release-failed", reason: "idle" },
      ]);
    } finally {
      await loop.stop();
    }
    expect(new Set(events.map((event) => event.leaseIntervalId))).toHaveLength(1);
    expect(events.some((event) => event.phase === "released")).toBe(false);
  });

  it("deduplicates stale-lease release while idle release is in flight", async () => {
    const events: WorkerHolderLifecycleEvent[] = [];
    const releaseGate = holderTestGate();
    const releaseLease = vi.fn(async () => releaseGate.promise);
    let passes = 0;
    const loop = createWorkerRunnerLoop({
      workerId: "synthetic-worker",
      controlPlane: createAlwaysLeasedControlPlane({ releaseLease }),
      runners: [
        {
          name: "synthetic.holder-stale",
          kind: "projection-group",
          runOnce: async (context) => {
            if (++passes > 1) await holderTestAbort(context);
            return { processed: 0, lastGlobalPosition: "0" as never };
          },
        },
      ],
      maxConcurrentRunners: 1,
      leaseTtlMs: 60_000,
      leaseRenewIntervalMs: 60_000,
      pollIntervalMs: 60_000,
      observer: {
        holderLifecycle: (event) => {
          events.push(event);
        },
      },
    });
    loop.start();
    try {
      await vi.waitFor(() => expect(releaseLease).toHaveBeenCalledTimes(1));
      expect(loop.status().activeRunnerCount).toBe(0);
      loop.nudge();
      await vi.waitFor(() => expect(loop.status().activeRunnerCount).toBe(1));
      expect(events.map((event) => event.phase)).toEqual([
        "acquired",
        "pass-start",
        "run-start",
        "run-end",
        "pass-end",
      ]);
      releaseGate.resolve();
      await vi.waitFor(() => expect(events.filter((event) => event.phase === "run-start")).toHaveLength(2));
      expect(releaseLease).toHaveBeenCalledTimes(1);
      const firstId = events[0]?.leaseIntervalId;
      expect(events.filter((event) => event.leaseIntervalId === firstId)).toMatchObject([
        { phase: "acquired" },
        { phase: "pass-start" },
        { phase: "run-start" },
        { phase: "run-end", outcome: "success" },
        { phase: "pass-end", disposition: "release-pending", processed: 0 },
        { phase: "released", reason: "idle" },
      ]);
    } finally {
      releaseGate.resolve();
      await loop.stop();
    }
    const terminals = events.filter(
      (event) =>
        event.leaseIntervalId === events[0]?.leaseIntervalId &&
        (event.phase === "released" || event.phase === "release-failed"),
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ phase: "released", reason: "idle" });
  });

  it("distinguishes retained and blocked synthetic holder intervals", async () => {
    const controls = new Map<string, WorkerHolderLifecycleEvent[]>();
    for (const mode of ["retained", "blocked"] as const) {
      const events: WorkerHolderLifecycleEvent[] = [];
      controls.set(mode, events);
      let passes = 0;
      const loop = createWorkerRunnerLoop({
        workerId: "synthetic-worker",
        controlPlane: createAlwaysLeasedControlPlane(),
        runners: [
          {
            name: `synthetic.holder-${mode}`,
            kind: "projection-group",
            runOnce: async (context) => {
              if (++passes > 1 || mode === "blocked") await holderTestAbort(context);
              return { processed: 1, lastGlobalPosition: "1" as never };
            },
          },
        ],
        maxConcurrentRunners: 1,
        leaseTtlMs: 60_000,
        leaseRenewIntervalMs: 60_000,
        pollIntervalMs: 60_000,
        observer: {
          holderLifecycle: (event) => {
            events.push(event);
          },
        },
      });
      loop.start();
      try {
        await vi.waitFor(() =>
          expect(events.filter((event) => event.phase === "run-start")).toHaveLength(mode === "retained" ? 2 : 1),
        );
        if (mode === "retained") {
          expect(events.map((event) => event.phase)).toEqual([
            "acquired",
            "pass-start",
            "run-start",
            "run-end",
            "pass-end",
            "pass-start",
            "run-start",
          ]);
          const end = events[4];
          const next = events[5];
          expect(end).toMatchObject({ phase: "pass-end", disposition: "retained", passSeq: 1 });
          expect(next).toMatchObject({ phase: "pass-start", passSeq: 2, leaseIntervalId: end?.leaseIntervalId });
          expect(next!.elapsedMs).toBeGreaterThan(end!.elapsedMs);
        } else {
          expect(events.map((event) => event.phase)).toEqual(["acquired", "pass-start", "run-start"]);
        }
      } finally {
        await loop.stop();
      }
      expect(events.slice(-3)).toMatchObject([
        { phase: "run-end", outcome: "cancelled" },
        { phase: "pass-end", outcome: "cancelled", disposition: "release-pending" },
        { phase: "released", reason: "stop" },
      ]);
      expect(events.filter((event) => event.phase === "pass-end" && event.outcome === "cancelled")).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ disposition: "retained" })]),
      );
    }
    expect(
      controls.get("retained")?.filter((event) => event.phase === "pass-end" && event.disposition === "retained"),
    ).toHaveLength(1);
    expect(
      controls.get("blocked")?.filter((event) => event.phase === "pass-end" && event.disposition === "retained"),
    ).toHaveLength(0);
  });

  it("keeps holder observation silent for non-projection runners", async () => {
    const holderLifecycle = vi.fn();
    const runOnce = vi.fn(async (context?: ProjectionRunContext) => {
      await holderTestAbort(context);
      return { processed: 0, lastGlobalPosition: "0" as never };
    });
    const loop = createWorkerRunnerLoop({
      workerId: "synthetic-worker",
      controlPlane: createAlwaysLeasedControlPlane(),
      runners: [{ name: "synthetic.job", kind: "job", runOnce }],
      maxConcurrentRunners: 1,
      leaseTtlMs: 60_000,
      leaseRenewIntervalMs: 60_000,
      pollIntervalMs: 60_000,
      observer: { holderLifecycle },
    });
    loop.start();
    try {
      await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(1));
    } finally {
      await loop.stop();
    }
    expect(holderLifecycle).not.toHaveBeenCalled();
  });

  it("retains a thrown projection-group pass through failure backoff", async () => {
    const events: Array<Record<string, unknown>> = [];
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane: createAlwaysLeasedControlPlane(),
      runners: [
        {
          name: "catalog.listing",
          kind: "projection-group",
          runOnce: async (context) => {
            if (events.filter((event) => event.phase === "pass-end").length >= 2) {
              await new Promise<void>((resolve) =>
                context?.signal?.addEventListener("abort", () => resolve(), { once: true }),
              );
            }
            throw new Error("synthetic failure");
          },
        },
      ],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
      failureBackoffBaseMs: 20,
      failureBackoffMaxMs: 20,
      observer: {
        holderLifecycle: (event) => events.push(event as unknown as Record<string, unknown>),
      },
      onError: () => undefined,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(events.filter((event) => event.phase === "pass-end").length).toBeGreaterThanOrEqual(1);
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: "run-end", outcome: "error" }),
          expect.objectContaining({ phase: "pass-end", outcome: "error", disposition: "retained" }),
        ]),
      );
      expect(events.some((event) => event.phase === "released")).toBe(false);
      await vi.waitFor(() => {
        expect(events.filter((event) => event.phase === "pass-end").length).toBeGreaterThanOrEqual(2);
      });
      const acquired = events.find((event) => event.phase === "acquired");
      expect(
        events
          .filter((event) => event.phase === "pass-start")
          .every((event) => event.leaseIntervalId === acquired?.leaseIntervalId),
      ).toBe(true);
    } finally {
      await loop.stop();
    }
  });

  it("isolates a throwing holder callback and reports it once", async () => {
    const onError = vi.fn();
    const callback = vi.fn(() => {
      throw new Error("observer failure");
    });
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane: createAlwaysLeasedControlPlane(),
      runners: [
        {
          name: "catalog.listing",
          kind: "projection-group",
          runOnce: async () => ({ processed: 0, lastGlobalPosition: "0" as never }),
        },
      ],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
      observer: { holderLifecycle: callback },
      onError,
    });

    loop.start();
    try {
      await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    } finally {
      await loop.stop();
    }
    expect(onError).toHaveBeenCalledTimes(1);
    expect(loop.status().stopped).toBe(true);
  });

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

  it("runs one bounded batch per scheduling turn so busy runners do not monopolize the loop", async () => {
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

  it("holds an idle runner lease across passes and renews without reacquire or release churn", async () => {
    let acquireCalls = 0;
    let renewCalls = 0;
    let releaseCalls = 0;
    let runs = 0;
    const controlPlane = createAlwaysLeasedControlPlane({
      acquireLease: async (input) => {
        acquireCalls += 1;
        return {
          leaseName: input.leaseName,
          ownerId: input.ownerId,
          fencingToken: String(acquireCalls),
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
        };
      },
      renewLease: async () => {
        renewCalls += 1;
        return true;
      },
      releaseLease: async () => {
        releaseCalls += 1;
      },
    });
    // Non-projection-group runners (jobs, wake lanes) keep their leases across
    // idle passes — only projection-group leases yield on idle (#4730), since
    // wake runners and recovery operations contend for that exact lease.
    const runner: WorkerRunner = {
      name: "idle-job",
      kind: "job",
      runOnce: async () => {
        runs += 1;
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [runner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 25,
      pollIntervalMs: 2,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(runs).toBeGreaterThanOrEqual(3);
      });
      expect(acquireCalls).toBe(1);
      expect(releaseCalls).toBe(0);

      await vi.waitFor(() => {
        expect(renewCalls).toBeGreaterThanOrEqual(1);
      });
      expect(acquireCalls).toBe(1);
      expect(releaseCalls).toBe(0);
    } finally {
      await loop.stop();
    }

    expect(releaseCalls).toBe(1);
  });

  it("yields a degraded projection-group lease when idle so a blocked-stream retry operation can acquire it", async () => {
    // Regression for #4496: a caught-up projection-group runner that still has
    // parked blocked streams must release the shared `projection-group:<name>`
    // lease between idle passes so the queued blocked-stream retry operation
    // (which acquires that exact lease, frequently on another worker) can take
    // it and re-apply the parked poison. Before the fix the idle group runner
    // hoarded the lease and every retry operation failed with "Projection
    // runner lease ... is already active", so no projection-handler/config/
    // migration fix could ever bite.
    let acquireCalls = 0;
    let releaseCalls = 0;
    let runs = 0;
    const controlPlane = createAlwaysLeasedControlPlane({
      acquireLease: async (input) => {
        acquireCalls += 1;
        return {
          leaseName: input.leaseName,
          ownerId: input.ownerId,
          fencingToken: String(acquireCalls),
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
        };
      },
      renewLease: async () => true,
      releaseLease: async () => {
        releaseCalls += 1;
      },
    });
    const degradedGroupRunner: WorkerRunner = {
      name: "discovery.discovery-item-detail-projection",
      kind: "projection-group",
      // Caught up (nothing new to process) but still parking blocked streams.
      runOnce: async () => {
        runs += 1;
        return {
          processed: 0,
          lastGlobalPosition: "0" as never,
          state: "degraded",
          blockedStreams: 3,
          poisonEvents: 3,
        };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [degradedGroupRunner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 2,
    });

    loop.start();
    try {
      // Each idle-but-degraded pass releases the lease and re-acquires on the
      // next pass, so the queued retry operation gets a window to acquire it.
      await vi.waitFor(() => {
        expect(runs).toBeGreaterThanOrEqual(3);
        expect(releaseCalls).toBeGreaterThanOrEqual(2);
      });
      expect(acquireCalls).toBeGreaterThanOrEqual(3);
    } finally {
      await loop.stop();
    }
  });

  it("yields a healthy idle projection-group lease so wake runners on other workers can run the group", async () => {
    // Regression for #4730: the polling loop used to hold a caught-up group's
    // lease across idle passes ("never churned"). In multi-worker topology
    // that starved the wake fast path completely — a checkout hot wake intent
    // was observed claim/deferring "projection group lease was busy" every
    // second for 3+ minutes and finally completing `already-satisfied` only
    // after the holder's polling rotation advanced the checkpoint itself.
    // Read-after-write freshness must run at wake latency, not rotation
    // latency, so every idle pass releases the lease and re-acquires on the
    // next visit.
    let acquireCalls = 0;
    let releaseCalls = 0;
    let runs = 0;
    const controlPlane = createAlwaysLeasedControlPlane({
      acquireLease: async (input) => {
        acquireCalls += 1;
        return {
          leaseName: input.leaseName,
          ownerId: input.ownerId,
          fencingToken: String(acquireCalls),
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
        };
      },
      renewLease: async () => true,
      releaseLease: async () => {
        releaseCalls += 1;
      },
    });
    const healthyGroupRunner: WorkerRunner = {
      name: "checkout.checkout.session-projection",
      kind: "projection-group",
      runOnce: async () => {
        runs += 1;
        return { processed: 0, lastGlobalPosition: "0" as never, state: "caught-up", blockedStreams: 0 };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [healthyGroupRunner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 2,
    });

    loop.start();
    try {
      // Every idle pass releases the lease (a wake or recovery operation can
      // acquire it in the gap) and the next pass re-acquires.
      await vi.waitFor(() => {
        expect(runs).toBeGreaterThanOrEqual(3);
        expect(releaseCalls).toBeGreaterThanOrEqual(2);
      });
      expect(acquireCalls).toBeGreaterThanOrEqual(3);
    } finally {
      await loop.stop();
    }
  });

  it("busy-group-exact-receipt-read: selection of another group does not retain an inactive holder", async () => {
    vi.useFakeTimers();
    const leases = new Map<string, PlatformLease>();
    const order: string[] = [];
    const inactiveHolders: string[] = [];
    let fence = 0;
    const controlPlane = createAlwaysLeasedControlPlane({
      acquireLease: async (input) => {
        if (leases.has(input.leaseName)) return null;
        const lease = {
          leaseName: input.leaseName,
          ownerId: input.ownerId,
          fencingToken: String(++fence),
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
        };
        leases.set(lease.leaseName, lease);
        order.push(`acquire:${lease.leaseName}`);
        return lease;
      },
      releaseLease: async (lease) => {
        if (leases.get(lease.leaseName)?.fencingToken === lease.fencingToken) leases.delete(lease.leaseName);
        order.push(`release:${lease.leaseName}`);
      },
    });
    const backlog = [["target-1", "target-2"], ["competitor-1"]];
    const runners: WorkerRunner[] = backlog.map((events, index) => ({
      name: index === 0 ? "marketplace.receipt-target" : "inventory.competitor",
      kind: "projection-group",
      priority: () => events.length,
      runOnce: async () => {
        const event = events.shift();
        if (event) order.push(`apply:${event}`);
        return { processed: event ? 1 : 0, lastGlobalPosition: "0" as never };
      },
    }));
    const targetLeaseName = createWorkerRunnerLeaseName(runners[0]);
    const loop = createWorkerRunnerLoop({
      workerId: "receipt-poll",
      controlPlane,
      runners,
      maxConcurrentRunners: 1,
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      pollIntervalMs: 1000,
      observer: {
        holderLifecycle: (event) => {
          if (event.phase === "pass-start" && event.runnerName === runners[1].name) {
            order.push("competitor-selected");
            const inactiveHolder = leases.get(targetLeaseName);
            if (inactiveHolder) inactiveHolders.push(inactiveHolder.ownerId);
          }
        },
      },
    });
    try {
      loop.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(order.indexOf("apply:target-1")).toBeLessThan(order.indexOf("competitor-selected"));
      expect(order.indexOf("competitor-selected")).toBeLessThan(order.indexOf("apply:target-2"));
      expect(backlog).toEqual([[], []]);
      expect(inactiveHolders).toEqual([]);
    } finally {
      await loop.stop();
      vi.useRealTimers();
    }
  });

  it("releases a drained unselected holder for a contender, then resumes new work after polling and restart", async () => {
    vi.useFakeTimers();
    const leases = new Map<string, PlatformLease>();
    const events: WorkerHolderLifecycleEvent[] = [];
    let fence = 0;
    const controlPlane = createAlwaysLeasedControlPlane({
      acquireLease: async (input) => {
        if (leases.has(input.leaseName)) return null;
        const lease = {
          ...input,
          fencingToken: String(++fence),
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
        };
        leases.set(input.leaseName, lease);
        return lease;
      },
      releaseLease: async (lease) => {
        if (leases.get(lease.leaseName)?.fencingToken === lease.fencingToken) leases.delete(lease.leaseName);
      },
    });
    const pending = [1, 2, 2];
    let contender: PlatformLease | null | undefined;
    const runners: WorkerRunner[] = pending.map((_, index) => ({
      name: `handoff-${index}`,
      kind: "projection-group",
      priority: () => pending[index],
      runOnce: async () => {
        if (index === 2 && contender === undefined) {
          contender = await controlPlane.acquireLease({
            leaseName: "projection-group:handoff-0",
            ownerId: "wake",
            ttlMs: 30_000,
          });
          if (contender) await controlPlane.releaseLease(contender);
        }
        const processed = pending[index] > 0 ? 1 : 0;
        pending[index] -= processed;
        return { processed, lastGlobalPosition: "0" as never };
      },
    }));
    const options = {
      workerId: "poll",
      controlPlane,
      runners,
      maxConcurrentRunners: 2,
      leaseTtlMs: 30_000,
      leaseRenewIntervalMs: 10_000,
      pollIntervalMs: 1000,
      observer: { holderLifecycle: (event: WorkerHolderLifecycleEvent) => events.push(event) },
    };
    let loop = createWorkerRunnerLoop(options);
    try {
      loop.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(contender).toBeDefined();
      expect(contender).not.toBeNull();
      const target = events.filter(
        (event) => event.runnerName === runners[0].name && !["run-start", "run-end"].includes(event.phase),
      );
      expect(target.slice(0, 4).map((event) => event.phase)).toEqual([
        "acquired",
        "pass-start",
        "pass-end",
        "released",
      ]);
      expect(target[2]).toMatchObject({ processed: 1, disposition: "retained", outcome: "success" });
      expect(target[3]).toMatchObject({ reason: "idle", leaseIntervalId: target[0].leaseIntervalId });
      expect(pending[0]).toBe(0);
      const laterContender = await controlPlane.acquireLease({
        leaseName: createWorkerRunnerLeaseName(runners[0]),
        ownerId: "wake",
        ttlMs: 30_000,
      });
      expect(laterContender).not.toBeNull();
      await controlPlane.releaseLease(laterContender!);
      const completed = events.filter((event) => event.runnerName === runners[0].name).length;
      await vi.advanceTimersByTimeAsync(500);
      expect(events.filter((event) => event.runnerName === runners[0].name)).toHaveLength(completed);
      pending[0] = 1;
      await vi.advanceTimersByTimeAsync(500);
      expect(pending[0]).toBe(0);
      await loop.stop();
      expect(leases.size).toBe(0);
      pending[0] = 1;
      loop = createWorkerRunnerLoop(options);
      loop.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(pending[0]).toBe(0);
    } finally {
      await loop.stop();
      vi.useRealTimers();
    }
  });

  it("keeps an actively draining projection-group lease held so backlog replay is never churned", async () => {
    // Busy passes (processed > 0) keep single lease ownership and reschedule
    // immediately — only IDLE passes yield (#4730). Backlog draining must not
    // pay an acquire/release round trip per batch.
    let acquireCalls = 0;
    let releaseCalls = 0;
    let runs = 0;
    const controlPlane = createAlwaysLeasedControlPlane({
      acquireLease: async (input) => {
        acquireCalls += 1;
        return {
          leaseName: input.leaseName,
          ownerId: input.ownerId,
          fencingToken: String(acquireCalls),
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
        };
      },
      renewLease: async () => true,
      releaseLease: async () => {
        releaseCalls += 1;
      },
    });
    const drainingGroupRunner: WorkerRunner = {
      name: "discovery.discovery-search-item-projection",
      kind: "projection-group",
      runOnce: async () => {
        runs += 1;
        return { processed: 25, lastGlobalPosition: String(runs * 25) as never, state: "running", blockedStreams: 0 };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [drainingGroupRunner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 2,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(runs).toBeGreaterThanOrEqual(3);
      });
      expect(acquireCalls).toBe(1);
      expect(releaseCalls).toBe(0);
    } finally {
      await loop.stop();
    }

    expect(releaseCalls).toBe(1);
  });

  it("drops a held runner lease after renewal failure and reacquires on the next eligible pass", async () => {
    let acquireCalls = 0;
    let renewCalls = 0;
    let releaseCalls = 0;
    const renewFailures: string[] = [];
    const fencingTokens: string[] = [];
    const controlPlane = createAlwaysLeasedControlPlane({
      acquireLease: async (input) => {
        acquireCalls += 1;
        return {
          leaseName: input.leaseName,
          ownerId: input.ownerId,
          fencingToken: String(acquireCalls),
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
        };
      },
      renewLease: async () => {
        renewCalls += 1;
        return renewCalls !== 1;
      },
      releaseLease: async () => {
        releaseCalls += 1;
      },
    });
    // kind "job": renewal-failure drop/reacquire semantics are loop-generic,
    // and a job lease is held across idle passes so the reacquire count stays
    // deterministic (projection-group leases yield on idle per #4730).
    const runner: WorkerRunner = {
      name: "renewal-sensitive-job",
      kind: "job",
      runOnce: async (context) => {
        fencingTokens.push(context?.fencingToken ?? "");
        if (fencingTokens.length === 1) {
          await vi.waitFor(() => {
            expect(context?.signal?.aborted).toBe(true);
          });
        }
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [runner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 10,
      pollIntervalMs: 5,
      observer: {
        leaseRenewFailed: (event) => renewFailures.push(event.fencingToken ?? ""),
      },
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(fencingTokens.slice(0, 2)).toEqual(["1", "2"]);
      });
    } finally {
      await loop.stop();
    }

    expect(acquireCalls).toBe(2);
    expect(releaseCalls).toBeGreaterThanOrEqual(2);
    expect(renewFailures).toEqual(["1"]);
  });

  it("lets a second worker acquire after the first worker stops without double-running the runner", async () => {
    const coordinator = createInMemoryLeaseCoordinator();
    const firstControlPlane = coordinator.createControlPlane();
    const secondControlPlane = coordinator.createControlPlane();
    const activeOwners = new Set<string>();
    const runOwners: string[] = [];
    let doubleRunCount = 0;
    const firstRunner: WorkerRunner = {
      name: "catalog-shared-projection",
      kind: "projection-group",
      runOnce: async (context) => {
        runOwners.push(context?.ownerId ?? "");
        activeOwners.add(context?.ownerId ?? "");
        doubleRunCount = Math.max(doubleRunCount, activeOwners.size > 1 ? activeOwners.size : 0);
        await vi.waitFor(() => {
          expect(context?.signal?.aborted).toBe(true);
        });
        activeOwners.delete(context?.ownerId ?? "");
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    };
    const secondRunner: WorkerRunner = {
      name: firstRunner.name,
      kind: firstRunner.kind,
      runOnce: async (context) => {
        runOwners.push(context?.ownerId ?? "");
        activeOwners.add(context?.ownerId ?? "");
        doubleRunCount = Math.max(doubleRunCount, activeOwners.size > 1 ? activeOwners.size : 0);
        activeOwners.delete(context?.ownerId ?? "");
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    };
    const firstLoop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane: firstControlPlane,
      runners: [firstRunner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });
    const secondLoop = createWorkerRunnerLoop({
      workerId: "worker-b",
      controlPlane: secondControlPlane,
      runners: [secondRunner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    firstLoop.start();
    try {
      await vi.waitFor(() => {
        expect(runOwners).toEqual(["worker-a"]);
      });
      secondLoop.start();
      await vi.waitFor(() => {
        expect(secondLoop.status().leaseMissCount).toBeGreaterThan(0);
      });
      expect(runOwners).toEqual(["worker-a"]);

      await firstLoop.stop();
      await vi.waitFor(() => {
        expect(runOwners).toContain("worker-b");
      });
    } finally {
      await Promise.allSettled([firstLoop.stop(), secondLoop.stop()]);
    }

    expect(doubleRunCount).toBe(0);
    expect(runOwners).toContain("worker-a");
    expect(runOwners).toContain("worker-b");
  });

  it("reschedules immediately after productive runner completion without waiting for the poll timer", async () => {
    const calls: string[] = [];
    const controlPlane = createAlwaysLeasedControlPlane();
    const producer: WorkerRunner = {
      name: "producer-projection",
      kind: "projection-group",
      runOnce: async () => {
        calls.push("producer-projection");
        return { processed: 1, lastGlobalPosition: "1" as never };
      },
    };
    const follower: WorkerRunner = {
      name: "follower-projection",
      kind: "projection-group",
      runOnce: async () => {
        calls.push("follower-projection");
        return { processed: 0, lastGlobalPosition: "1" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [producer, follower],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 60_000,
    });

    loop.start();
    try {
      await vi.waitFor(
        () => {
          expect(calls).toEqual(["producer-projection", "follower-projection"]);
        },
        { timeout: 250 },
      );
    } finally {
      await loop.stop();
    }
  });

  it("does not reschedule caught-up runner completion before the next poll timer", async () => {
    const calls: string[] = [];
    const controlPlane = createAlwaysLeasedControlPlane();
    const runner: WorkerRunner = {
      name: "caught-up-projection",
      kind: "projection-group",
      runOnce: async () => {
        calls.push("caught-up-projection");
        return { processed: 0, lastGlobalPosition: "1" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [runner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 60_000,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(calls).toHaveLength(1);
    } finally {
      await loop.stop();
    }
  });

  it("nudge schedules caught-up runners immediately without waiting for the poll timer", async () => {
    const calls: string[] = [];
    const controlPlane = createAlwaysLeasedControlPlane();
    const runner: WorkerRunner = {
      name: "wake-claim-runner",
      kind: "job",
      runOnce: async () => {
        calls.push("wake-claim-runner");
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
      pollIntervalMs: 60_000,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      loop.nudge();
      await vi.waitFor(
        () => {
          expect(calls).toHaveLength(2);
        },
        { timeout: 250 },
      );
    } finally {
      await loop.stop();
    }
  });

  it("reschedules immediately after a runner claims wake-lane work without completing it", async () => {
    const calls: string[] = [];
    const controlPlane = createAlwaysLeasedControlPlane();
    const wakeLane: WorkerRunner = {
      name: "projection-wake-scheduler.hot.lane-1",
      kind: "job",
      rescheduleOnCompletion: () => true,
      runOnce: async () => {
        calls.push("projection-wake-scheduler.hot.lane-1");
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    };
    const standardLane: WorkerRunner = {
      name: "projection-wake-scheduler.standard.lane-1",
      kind: "job",
      runOnce: async () => {
        calls.push("projection-wake-scheduler.standard.lane-1");
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [wakeLane, standardLane],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 60_000,
    });

    loop.start();
    try {
      await vi.waitFor(
        () => {
          expect(calls).toEqual(["projection-wake-scheduler.hot.lane-1", "projection-wake-scheduler.standard.lane-1"]);
        },
        { timeout: 250 },
      );
    } finally {
      await loop.stop();
    }
  });

  it("reports reschedule predicate failures without breaking the runner loop", async () => {
    const calls: string[] = [];
    const failures: string[] = [];
    const controlPlane = createAlwaysLeasedControlPlane();
    const predicateFailure: WorkerRunner = {
      name: "predicate-failure-projection",
      kind: "projection-group",
      rescheduleOnCompletion: () => {
        throw new Error("reschedule predicate failed");
      },
      runOnce: async () => {
        calls.push("predicate-failure-projection");
        return { processed: 0, lastGlobalPosition: "1" as never };
      },
    };
    const follower: WorkerRunner = {
      name: "follower-projection",
      kind: "projection-group",
      runOnce: async () => {
        calls.push("follower-projection");
        return { processed: 0, lastGlobalPosition: "1" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [predicateFailure, follower],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
      onError: (_error, runner) => failures.push(runner.name),
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(calls).toContain("follower-projection");
      });
    } finally {
      await loop.stop();
    }

    expect(failures).toContain("predicate-failure-projection");
    expect(new Set(failures)).toEqual(new Set(["predicate-failure-projection"]));
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

  it("refreshes an idle behind-group's cached priority so it is not starved behind always-positive backlog runners (#4763)", async () => {
    // Reproduces the staging starvation: two always-positive high-backlog
    // groups (the discovery cascade) saturate both slots, while a group that
    // fell behind WITHOUT running keeps a cached priority of 0 and is only ever
    // a fallback candidate — which never fires while positive runners exist.
    const calls: string[] = [];
    let idleRefreshCalls = 0;
    const controlPlane = createAlwaysLeasedControlPlane();
    const makeHotRunner = (name: string): WorkerRunner => ({
      name,
      kind: "projection-group",
      priority: () => 500n,
      runOnce: async () => {
        calls.push(name);
        // Busy passes reschedule immediately, keeping both slots hot.
        return { processed: 1, lastGlobalPosition: "500" as never };
      },
    });
    // Backlog accrued while idle: invisible to selection until refreshed.
    let idleCachedPriority = 0n;
    const idleBehindRunner: WorkerRunner = {
      name: "idle-behind-projection",
      kind: "projection-group",
      priority: () => idleCachedPriority,
      refreshPriority: async () => {
        idleRefreshCalls += 1;
        idleCachedPriority = 5n;
      },
      runOnce: async () => {
        calls.push("idle-behind-projection");
        idleCachedPriority = 0n;
        return { processed: 5, lastGlobalPosition: "5" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [makeHotRunner("hot-a-projection"), makeHotRunner("hot-b-projection"), idleBehindRunner],
      maxConcurrentRunners: 2,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
      priorityRefreshIntervalMs: 10,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(calls).toContain("idle-behind-projection");
      });
    } finally {
      await loop.stop();
    }

    expect(idleRefreshCalls).toBeGreaterThan(0);
    expect(calls).toContain("idle-behind-projection");
  });

  it("does not refresh idle runner priorities when the sweep is disabled (interval 0)", async () => {
    const calls: string[] = [];
    let idleRefreshCalls = 0;
    const controlPlane = createAlwaysLeasedControlPlane();
    const hotRunner: WorkerRunner = {
      name: "hot-projection",
      kind: "projection-group",
      priority: () => 500n,
      runOnce: async () => {
        calls.push("hot-projection");
        return { processed: 1, lastGlobalPosition: "500" as never };
      },
    };
    const idleRunner: WorkerRunner = {
      name: "idle-projection",
      kind: "projection-group",
      priority: () => 0n,
      refreshPriority: async () => {
        idleRefreshCalls += 1;
      },
      runOnce: async () => {
        calls.push("idle-projection");
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    };
    const loop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [hotRunner, idleRunner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
      // priorityRefreshIntervalMs omitted -> sweep disabled.
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(calls.filter((call) => call === "hot-projection").length).toBeGreaterThan(2);
      });
    } finally {
      await loop.stop();
    }

    expect(idleRefreshCalls).toBe(0);
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

  it("records degraded reaction failures separately from projection lag", async () => {
    const statuses: Array<Readonly<{ runnerName: string; state: string; lastError?: string | null }>> = [];
    const controlPlane = createAlwaysLeasedControlPlane({
      recordRunnerStatus: async (status) => {
        statuses.push(status);
      },
    });
    const runner: WorkerRunner = {
      name: "ordering.inventory-reservation-outcomes",
      kind: "projection-group",
      projectionStatusSnapshot: () =>
        ({
          ...createProjectionGroup().getStatus(),
          handlerKind: "reaction",
          projectionName: "ordering-inventory-reservation-outcomes",
        }) as never,
      runOnce: async () => ({
        processed: 1,
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
            runnerName: "ordering.inventory-reservation-outcomes",
            state: "degraded",
            lastError: "Reaction has 1 blocked stream(s) and 1 poison event(s).",
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

  it.each(["degraded", "caught-up"] as const)(
    "observes durable %s counts on idle passes, after restart and without snapshot-write heartbeat",
    async (state) => {
      const observed = vi.fn();
      const status = {
        ...createProjectionGroup().getStatus(),
        state,
        blockedStreamCount: state === "degraded" ? 1 : 0,
        poisonEventCount: state === "degraded" ? 2 : 0,
      } as ReturnType<ContextProjectionGroup["getStatus"]>;
      const snapshots = vi.fn(async () => undefined);
      const runner: WorkerRunner = {
        name: "synthetic-context.synthetic-projection",
        kind: "projection-group",
        projectionStatusSnapshot: () => status,
        runOnce: async () => ({ processed: 0, lastGlobalPosition: "0" as never, state }),
      };
      for (let restart = 0; restart < 2; restart += 1) {
        const before = observed.mock.calls.length;
        const loop = createWorkerRunnerLoop({
          workerId: "synthetic-worker",
          runners: [runner],
          controlPlane: createAlwaysLeasedControlPlane({ recordProjectionStatusSnapshot: snapshots }),
          maxConcurrentRunners: 1,
          leaseTtlMs: 1_000,
          leaseRenewIntervalMs: 100,
          pollIntervalMs: 5,
          statusHeartbeatIntervalMs: 60_000,
          observer: { projectionStatusObserved: observed },
        });
        loop.start();
        try {
          await vi.waitFor(() => expect(observed.mock.calls.length).toBeGreaterThanOrEqual(before + 3));
        } finally {
          await loop.stop();
        }
      }
      expect(observed.mock.calls.every(([snapshot]) => snapshot === status)).toBe(true);
      expect(observed.mock.calls.length).toBeGreaterThanOrEqual(6);
      expect(snapshots).toHaveBeenCalled();
    },
  );

  it("does not change projection outcomes when count publication throws", async () => {
    const statuses: unknown[] = [];
    const loop = createWorkerRunnerLoop({
      workerId: "synthetic-worker",
      controlPlane: createAlwaysLeasedControlPlane({
        recordRunnerStatus: async (status) => {
          statuses.push(status);
        },
      }),
      runners: [
        {
          name: "synthetic.projection",
          kind: "projection-group",
          projectionStatusSnapshot: () =>
            createProjectionGroup().getStatus() as ReturnType<ContextProjectionGroup["getStatus"]>,
          runOnce: async () => ({ processed: 0, lastGlobalPosition: "0" as never }),
        },
      ],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
      observer: {
        projectionStatusObserved: () => {
          throw new Error("synthetic exporter unavailable");
        },
      },
    });
    loop.start();
    try {
      await vi.waitFor(() => expect(statuses).toContainEqual(expect.objectContaining({ state: "caught-up" })));
    } finally {
      await loop.stop();
    }
    expect(statuses).not.toContainEqual(expect.objectContaining({ state: "error" }));
  });

  it("skips unchanged idle runner status and projection snapshot writes before heartbeat", async () => {
    let runs = 0;
    const statuses: unknown[] = [];
    const snapshots: unknown[] = [];
    const controlPlane = createAlwaysLeasedControlPlane({
      recordRunnerStatus: async (status) => {
        statuses.push(status);
      },
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
      runOnce: async () => {
        runs += 1;
        return {
          processed: 0,
          lastGlobalPosition: "0" as never,
        };
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
      statusHeartbeatIntervalMs: 60_000,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(runs).toBeGreaterThanOrEqual(3);
      });
    } finally {
      await loop.stop();
    }

    expect(statuses).toHaveLength(2);
    expect(statuses).toEqual([
      expect.objectContaining({ state: "running" }),
      expect.objectContaining({ state: "caught-up" }),
    ]);
    expect(snapshots).toHaveLength(1);
  });

  it("republishes unchanged idle runner status and projection snapshots on heartbeat", async () => {
    const statuses: unknown[] = [];
    const snapshots: unknown[] = [];
    const controlPlane = createAlwaysLeasedControlPlane({
      recordRunnerStatus: async (status) => {
        statuses.push(status);
      },
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
      statusHeartbeatIntervalMs: 10,
    });

    loop.start();
    try {
      await vi.waitFor(() => {
        expect(statuses.length).toBeGreaterThan(2);
        expect(snapshots.length).toBeGreaterThan(1);
      });
    } finally {
      await loop.stop();
    }
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

  it("passes default idle transaction timeouts into projection group runs", async () => {
    const idleTimeouts: Array<number | undefined> = [];
    const subscriptionRunner = {
      targetContextName: "inventory",
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      runOnce: async (context?: ProjectionRunContext) => {
        idleTimeouts.push(context?.idleInTransactionSessionTimeoutMs);
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    };
    const group = createProjectionGroup({
      subscriptionRunners: [subscriptionRunner],
      refreshStatus: async () => ({
        revisionStale: false,
      }),
    });
    const [runner] = collectWorkerRunners({
      mountedContexts: [],
      services: {},
      projectors: [],
      projectionGroups: [group],
      subscriptionRunners: [subscriptionRunner],
    } as never);

    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 0 });

    expect(idleTimeouts).toEqual([DEFAULT_PROJECTION_TRANSACTION_IDLE_TIMEOUT_MS]);
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

  it("projection-group-recovery-marker retains its captured token across busy and blocked passes", async () => {
    const passResults = [
      { processed: 1, blockedStreams: 0 },
      { processed: 0, blockedStreams: 1 },
      { processed: 0, blockedStreams: 0 },
    ];
    const capturedTokens = ["2", "3", "4"].map((generation) =>
      Object.freeze({ generation, startedAt: "2026-01-01T00:00:00.000Z" }),
    );
    const firstToken = capturedTokens[0];
    const completionContexts: Array<Parameters<ContextProjectionGroup["markRevisionSynced"]>[1]> = [];
    const markedTokens: Array<Parameters<ContextProjectionGroup["markRevisionSynced"]>[0]> = [];
    const subscriptionRunner = {
      targetContextName: "inventory",
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      runOnce: async () => ({
        ...(passResults.shift() ?? { processed: 0, blockedStreams: 0 }),
        lastGlobalPosition: "2" as never,
      }),
    };
    const group = createProjectionGroup({
      subscriptionRunners: [subscriptionRunner],
      refreshStatus: async () => ({
        revisionStale: false,
        revisionSyncToken: capturedTokens.shift(),
      }),
      markRevisionSynced: async (expectedToken, context) => {
        markedTokens.push(expectedToken);
        completionContexts.push(context);
      },
    });
    const [runner] = collectWorkerRunners({
      mountedContexts: [],
      services: {},
      projectors: [],
      projectionGroups: [group],
      subscriptionRunners: [subscriptionRunner],
    } as never);

    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 1, blockedStreams: 0 });
    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 0, blockedStreams: 1 });
    expect(markedTokens).toEqual([]);
    const throwIfLeaseLost = () => undefined;
    await expect(runner.runOnce({ throwIfLeaseLost })).resolves.toMatchObject({ processed: 0, blockedStreams: 0 });

    expect(markedTokens).toEqual([firstToken]);
    expect(completionContexts).toEqual([expect.objectContaining({ throwIfLeaseLost })]);
    expect(markedTokens[0]).toBe(firstToken); // call-local identity survives later captures
    expect(markedTokens).not.toEqual([null]); // settle-without-token mutant
  });

  it("resets crash-truncated projection groups to checkpoint zero before replay", async () => {
    const resets: string[] = [];
    let recoveryRequired = true;
    const subscriptionRunner = {
      targetContextName: "inventory",
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      refreshStatus: async () => undefined,
      reset: async () => {
        resets.push("subscription");
        recoveryRequired = false;
      },
      runOnce: async () => ({ processed: 1, lastGlobalPosition: "1" as never }),
    };
    const group = createProjectionGroup({
      subscriptionRunners: [subscriptionRunner],
      recoveryRequired: () => recoveryRequired,
      refreshStatus: async () => ({ revisionStale: false }),
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

    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 1, lastGlobalPosition: "1" });
    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 1, lastGlobalPosition: "1" });

    expect(resets).toEqual(["group", "subscription"]);
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

  it("shares source-head cache across subscription runners in one projection group pass", async () => {
    let sourceHeadReads = 0;
    const readSourceHead = (context: ProjectionRunContext | undefined, sourceContextName: string) => {
      const cache = (
        context as
          | (ProjectionRunContext & {
              sourceHeadGlobalPositionCache?: Map<string, Promise<string>>;
            })
          | undefined
      )?.sourceHeadGlobalPositionCache;
      if (!cache) {
        sourceHeadReads += 1;
        return Promise.resolve("5");
      }

      let sourceHead = cache.get(sourceContextName);
      if (!sourceHead) {
        sourceHeadReads += 1;
        sourceHead = Promise.resolve("5");
        cache.set(sourceContextName, sourceHead);
      }

      return sourceHead;
    };
    const firstCatalogRunner = {
      subscriptionName: "inventory.catalog-a",
      targetContextName: "inventory",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      checkpointKey: "inventory-catalog-item-projection:catalog-a:v1",
      order: 10,
      runOnce: async (context?: ProjectionRunContext) => ({
        processed: 0,
        lastGlobalPosition: (await readSourceHead(context, "catalog")) as never,
      }),
    };
    const secondCatalogRunner = {
      ...firstCatalogRunner,
      subscriptionName: "inventory.catalog-b",
      checkpointKey: "inventory-catalog-item-projection:catalog-b:v1",
    };
    const marketplaceRunner = {
      ...firstCatalogRunner,
      subscriptionName: "inventory.marketplace",
      sourceContextName: "marketplace",
      checkpointKey: "inventory-catalog-item-projection:marketplace:v1",
      runOnce: async (context?: ProjectionRunContext) => ({
        processed: 0,
        lastGlobalPosition: (await readSourceHead(context, "marketplace")) as never,
      }),
    };
    const group = createProjectionGroup({
      subscriptionRunners: [firstCatalogRunner, secondCatalogRunner, marketplaceRunner],
      refreshStatus: async () => ({ revisionStale: false }),
    });
    const [runner] = collectWorkerRunners({
      mountedContexts: [],
      services: {},
      projectors: [],
      projectionGroups: [group],
      subscriptionRunners: [firstCatalogRunner, secondCatalogRunner, marketplaceRunner],
    } as never);

    await expect(runner.runOnce()).resolves.toMatchObject({ processed: 0, lastGlobalPosition: "5" });
    expect(sourceHeadReads).toBe(2);
  });

  it("routes a claimed blocked-stream retry through the exact runner under a renewed projection-group lease", async () => {
    const projectionKey = "inventory-catalog-item-projection:catalog:v1";
    const streamId = "catalog.item-cat_blocked";
    const operation = createClaimedOperationRecord({
      operationKind: "retry-blocked-stream",
      projectionKey,
      streamId,
    });
    const routeCalls: Array<Readonly<{ streamId: string; context?: ProjectionRunContext }>> = [];
    const acquiredLeases: Array<Readonly<{ leaseName: string; metadata?: Record<string, unknown> }>> = [];
    const renewedLeases: string[] = [];
    let signalRenewedLease: (() => void) | undefined;
    const renewedLease = new Promise<void>((resolve) => {
      signalRenewedLease = resolve;
    });
    const runOnce = vi.fn(async () => ({ processed: 0, lastGlobalPosition: "0" as never }));
    const reset = vi.fn(async () => undefined);
    const retryBlockedStream = vi.fn(async (claimedStreamId: string, context?: ProjectionRunContext) => {
      await renewedLease;
      routeCalls.push({ streamId: claimedStreamId, context });
      return {
        projectionKey,
        streamId: claimedStreamId,
        state: "resolved" as const,
        inspectedEvents: 5,
        appliedEvents: 5,
        errorMessage: null,
      };
    });
    const decoyRetry = vi.fn(async () => {
      throw new Error("decoy runner must not receive the claimed operation");
    });
    const targetRunner = {
      targetContextName: "inventory",
      projectionName: "inventory-catalog-item-projection",
      checkpointKey: projectionKey,
      reset,
      runOnce,
      retryBlockedStream,
    };
    const decoyRunner = {
      ...targetRunner,
      checkpointKey: "inventory-catalog-item-projection:marketplace:v1",
      retryBlockedStream: decoyRetry,
    };
    const group = createProjectionGroup({ subscriptionRunners: [decoyRunner, targetRunner] });
    const controlPlane = createAlwaysLeasedControlPlane({
      acquireLease: async (input) => {
        acquiredLeases.push({ leaseName: input.leaseName, metadata: input.metadata });
        return {
          leaseName: input.leaseName,
          ownerId: input.ownerId,
          fencingToken: "projection-group-fence-7",
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
        };
      },
      renewLease: async (lease) => {
        renewedLeases.push(lease.leaseName);
        signalRenewedLease?.();
        return true;
      },
      claimProjectionOperation: async () => operation,
      recordProjectionOperationProgress: async () => true,
      getProjectionOperation: async () => operation,
      completeProjectionOperation: async () => true,
    });
    const [operationRunner] = collectProjectionOperationRunners(
      {
        mountedContexts: [],
        services: {},
        projectors: [],
        projectionGroups: [group],
        subscriptionRunners: [decoyRunner, targetRunner],
      } as never,
      { controlPlane, leaseRenewIntervalMs: 1, cancelPollIntervalMs: 50 },
    );

    await expect(operationRunner.runOnce({ ownerId: "worker-a" })).resolves.toMatchObject({ processed: 1 });

    expect(acquiredLeases).toContainEqual({
      leaseName: "projection-group:inventory.inventory-catalog-item-projection",
      metadata: {
        operationId: operation.operationId,
        operationKind: "retry-blocked-stream",
        projectionKey,
        streamId,
      },
    });
    expect(renewedLeases).toContain("projection-group:inventory.inventory-catalog-item-projection");
    expect(retryBlockedStream).toHaveBeenCalledTimes(1);
    expect(routeCalls).toEqual([
      {
        streamId,
        context: expect.objectContaining({
          ownerId: "worker-a",
          fencingToken: "projection-group-fence-7",
          operationId: operation.operationId,
        }),
      },
    ]);
    expect(decoyRetry).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
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
        attemptCount: 1,
        nextEligibleAt: new Date(0).toISOString(),
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
        attemptCount: 1,
        nextEligibleAt: new Date(0).toISOString(),
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
    const runners = collectProjectionOperationRunners(
      {
        mountedContexts: [],
        services: {},
        projectors: [],
        projectionGroups: [group],
        subscriptionRunners: [subscriptionRunner],
      } as never,
      {
        controlPlane,
        cancelPollIntervalMs: 1,
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

  it("aborts a hung in-flight operation at its deadline and requeues it with backoff", async () => {
    // Regression for #4496 recovery 7 + #4611: a hung operation renewed its
    // claim forever, pinned the single operation executor, and the queue
    // backed up behind it (operationSummary running:1 since 19:05Z, queued
    // 33 -> 84; then two retry ops running 50+ min at attemptCount 0). The
    // execution deadline must abort the operation even while its claim renews,
    // and — because a timeout is a slow-but-progressing symptom, not poison —
    // requeue it with backoff so its charged attempt budget bounds it rather
    // than dead-lettering a transiently slow pass.
    const failures: Array<Record<string, unknown>> = [];
    const subscriptionRunner = {
      targetContextName: "inventory",
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      reset: async () => undefined,
      // Hangs forever and ignores the abort signal.
      runOnce: () => new Promise<never>(() => {}),
    };
    const group = createProjectionGroup({
      subscriptionRunners: [subscriptionRunner],
      refreshStatus: async () => ({ revisionStale: false }),
    });
    const controlPlane = createAlwaysLeasedControlPlane({
      // attemptCount 1 of a default budget of 5: still retryable.
      claimProjectionOperation: async () => createClaimedOperationRecord(),
      recordProjectionOperationProgress: async () => true,
      getProjectionOperation: async () => createClaimedOperationRecord(),
      failProjectionOperation: async (input) => {
        failures.push(input as unknown as Record<string, unknown>);
        return true;
      },
    });
    const [operationRunner] = collectProjectionOperationRunners(
      {
        mountedContexts: [],
        services: {},
        projectors: [],
        projectionGroups: [group],
        subscriptionRunners: [subscriptionRunner],
      } as never,
      {
        controlPlane,
        rebuildOperationTimeoutMs: 25,
      },
    );

    await expect(operationRunner.runOnce({ ownerId: "worker-a" })).rejects.toThrow(/timed out after 25ms/);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      operationId: "projection-operation-1",
      retryable: true,
      error: expect.objectContaining({
        message: expect.stringContaining("timed out after 25ms"),
      }),
    });
  });

  it("dead-letters a hung operation once its retry attempts are exhausted", async () => {
    // The requeue path is attempt-bounded: a persistently hung operation that
    // has burned its budget times out terminally instead of retrying forever
    // (issue #4611).
    const failures: Array<Record<string, unknown>> = [];
    const subscriptionRunner = {
      targetContextName: "inventory",
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      reset: async () => undefined,
      runOnce: () => new Promise<never>(() => {}),
    };
    const group = createProjectionGroup({
      subscriptionRunners: [subscriptionRunner],
      refreshStatus: async () => ({ revisionStale: false }),
    });
    const controlPlane = createAlwaysLeasedControlPlane({
      // Final attempt: attemptCount === maxAttempts, so no requeue.
      claimProjectionOperation: async () => createClaimedOperationRecord({ attemptCount: 3 }),
      recordProjectionOperationProgress: async () => true,
      getProjectionOperation: async () => createClaimedOperationRecord({ attemptCount: 3 }),
      failProjectionOperation: async (input) => {
        failures.push(input as unknown as Record<string, unknown>);
        return true;
      },
    });
    const [operationRunner] = collectProjectionOperationRunners(
      {
        mountedContexts: [],
        services: {},
        projectors: [],
        projectionGroups: [group],
        subscriptionRunners: [subscriptionRunner],
      } as never,
      {
        controlPlane,
        rebuildOperationTimeoutMs: 25,
        maxAttempts: 3,
      },
    );

    await expect(operationRunner.runOnce({ ownerId: "worker-a" })).rejects.toThrow(/timed out after 25ms/);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ retryable: false });
  });

  it("stops renewing the shared projection-group lease the instant an operation is aborted", async () => {
    // #4611 slot/lease isolation: a timed-out (or cancelled) operation must not
    // keep the `projection-group:<name>` lease alive while its leaked work
    // settles — otherwise the scheduled group runner is starved and staging
    // catch-up backs up. The upstream operation signal is chained into the held
    // lease so renewal ceases immediately rather than one poll interval later.
    let renewCount = 0;
    const subscriptionRunner = {
      targetContextName: "inventory",
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      reset: async () => undefined,
      // Hangs forever ignoring abort, standing in for a leaked in-flight apply.
      runOnce: () => new Promise<never>(() => {}),
    };
    const group = createProjectionGroup({
      subscriptionRunners: [subscriptionRunner],
      refreshStatus: async () => ({ revisionStale: false }),
    });
    const controlPlane = createAlwaysLeasedControlPlane({
      renewLease: async () => {
        renewCount += 1;
        return true;
      },
      claimProjectionOperation: async () => createClaimedOperationRecord(),
      recordProjectionOperationProgress: async () => true,
      getProjectionOperation: async () => createClaimedOperationRecord(),
      failProjectionOperation: async () => true,
    });
    const [operationRunner] = collectProjectionOperationRunners(
      {
        mountedContexts: [],
        services: {},
        projectors: [],
        projectionGroups: [group],
        subscriptionRunners: [subscriptionRunner],
      } as never,
      {
        controlPlane,
        rebuildOperationTimeoutMs: 25,
        leaseRenewIntervalMs: 5,
        // A long cancel poll proves the lease stops renewing via the chained
        // signal, not the `shouldAbort` poll.
        cancelPollIntervalMs: 60_000,
      },
    );

    await expect(operationRunner.runOnce({ ownerId: "worker-a" })).rejects.toThrow(/timed out after 25ms/);
    const renewsAtAbort = renewCount;
    // Well past several renew intervals: the chained abort has frozen renewal,
    // so the lease now lapses by TTL and the scheduled group runner reacquires.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(renewCount).toBe(renewsAtAbort);
  });

  it("isolates operations-loop slots from the projections loop so a stuck operation cannot starve catch-up", async () => {
    // #4611 AC3: the operations executor runs in its own runner group/loop with
    // independent slot accounting. A fully saturated operations loop (a hung
    // executor pinning its only slot) must not consume any of the projections
    // loop's concurrency — the two loops share a control plane but never a slot
    // budget, so projection-group catch-up keeps its full parallelism.
    const controlPlane = createAlwaysLeasedControlPlane();

    let releaseHungOperation: (() => void) | null = null;
    const hungOperationRunner: WorkerRunner = {
      name: "projection-operations",
      kind: "job",
      runOnce: async () =>
        new Promise<never>((_, reject) => {
          releaseHungOperation = () => reject(new Error("released"));
        }),
    };
    const operationsLoop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [hungOperationRunner],
      maxConcurrentRunners: 1,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    let concurrentProjectionRuns = 0;
    let maxConcurrentProjectionRuns = 0;
    const releaseProjectionGates: Array<() => void> = [];
    let projectionGatesOpen = false;
    const projectionRunner = (name: string): WorkerRunner => ({
      name,
      kind: "projection-group",
      runOnce: async () => {
        concurrentProjectionRuns += 1;
        maxConcurrentProjectionRuns = Math.max(maxConcurrentProjectionRuns, concurrentProjectionRuns);
        if (!projectionGatesOpen) {
          await new Promise<void>((resolve) => {
            releaseProjectionGates.push(resolve);
          });
        }
        concurrentProjectionRuns -= 1;
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    });
    const projectionsLoop = createWorkerRunnerLoop({
      workerId: "worker-a",
      controlPlane,
      runners: [projectionRunner("inventory.a"), projectionRunner("inventory.b")],
      maxConcurrentRunners: 2,
      leaseTtlMs: 1_000,
      leaseRenewIntervalMs: 100,
      pollIntervalMs: 5,
    });

    operationsLoop.start();
    projectionsLoop.start();
    try {
      await vi.waitFor(() => {
        // Both projection runners are in-flight at once even though the
        // operations loop's only slot is pinned by the hung executor.
        expect(maxConcurrentProjectionRuns).toBe(2);
      });
    } finally {
      projectionGatesOpen = true;
      for (const release of releaseProjectionGates) {
        release();
      }
      (releaseHungOperation as (() => void) | null)?.();
      await Promise.all([operationsLoop.stop(), projectionsLoop.stop()]);
    }

    expect(maxConcurrentProjectionRuns).toBe(2);
  });

  it("requeues an operation as retryable when the projection-group lease stays unavailable", async () => {
    const failures: Array<Record<string, unknown>> = [];
    const subscriptionRunner = {
      targetContextName: "inventory",
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      reset: async () => undefined,
      runOnce: async () => ({ processed: 0, lastGlobalPosition: "0" as never }),
    };
    const group = createProjectionGroup({
      subscriptionRunners: [subscriptionRunner],
      refreshStatus: async () => ({ revisionStale: false }),
    });
    const controlPlane = createAlwaysLeasedControlPlane({
      // The projection-group lease is held elsewhere for the whole window.
      acquireLease: async () => null,
      claimProjectionOperation: async () => createClaimedOperationRecord({ attemptCount: 1 }),
      recordProjectionOperationProgress: async () => true,
      getProjectionOperation: async () => createClaimedOperationRecord({ attemptCount: 1 }),
      failProjectionOperation: async (input) => {
        failures.push(input as unknown as Record<string, unknown>);
        return true;
      },
    });
    const [operationRunner] = collectProjectionOperationRunners(
      {
        mountedContexts: [],
        services: {},
        projectors: [],
        projectionGroups: [group],
        subscriptionRunners: [subscriptionRunner],
      } as never,
      {
        controlPlane,
        leaseAcquireTimeoutMs: 0,
        maxAttempts: 5,
      },
    );

    await expect(operationRunner.runOnce({ ownerId: "worker-a" })).rejects.toThrow(/lease .* is already active/);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ retryable: true });
  });

  it("waits for a briefly-held projection-group lease instead of failing the operation", async () => {
    let acquireAttempts = 0;
    const completed: string[] = [];
    const subscriptionRunner = {
      targetContextName: "inventory",
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      reset: async () => undefined,
      runOnce: async () => ({ processed: 0, lastGlobalPosition: "0" as never }),
    };
    const group = createProjectionGroup({
      subscriptionRunners: [subscriptionRunner],
      refreshStatus: async () => ({ revisionStale: false }),
    });
    const controlPlane = createAlwaysLeasedControlPlane({
      // The scheduled group runner yields the lease after two poll ticks.
      acquireLease: async (input) => {
        acquireAttempts += 1;
        if (acquireAttempts <= 2) {
          return null;
        }
        return {
          leaseName: input.leaseName,
          ownerId: input.ownerId,
          fencingToken: "1",
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
        };
      },
      claimProjectionOperation: async () => createClaimedOperationRecord(),
      recordProjectionOperationProgress: async () => true,
      getProjectionOperation: async () => createClaimedOperationRecord(),
      completeProjectionOperation: async (input) => {
        completed.push(input.operationId);
        return true;
      },
    });
    const [operationRunner] = collectProjectionOperationRunners(
      {
        mountedContexts: [],
        services: {},
        projectors: [],
        projectionGroups: [group],
        subscriptionRunners: [subscriptionRunner],
      } as never,
      {
        controlPlane,
        leaseAcquireTimeoutMs: 5_000,
        leaseAcquireRetryIntervalMs: 1,
      },
    );

    await expect(operationRunner.runOnce({ ownerId: "worker-a" })).resolves.toMatchObject({ processed: 1 });
    expect(acquireAttempts).toBeGreaterThanOrEqual(3);
    expect(completed).toEqual(["projection-operation-1"]);
  });

  it("throws the original operation error when the failure write loses the claim", async () => {
    // Regression for #4496: the masked claim-loss failure ("claim was lost
    // before the status update completed") replaced the real error and left
    // the operation pinned in `running` with no recorded failure.
    const subscriptionRunner = {
      targetContextName: "inventory",
      checkpointKey: "inventory-catalog-item-projection:catalog:v1",
      reset: async () => undefined,
      runOnce: async () => {
        throw new Error("projection apply exploded");
      },
    };
    const group = createProjectionGroup({
      subscriptionRunners: [subscriptionRunner],
      refreshStatus: async () => ({ revisionStale: false }),
    });
    const controlPlane = createAlwaysLeasedControlPlane({
      claimProjectionOperation: async () => createClaimedOperationRecord(),
      recordProjectionOperationProgress: async () => true,
      getProjectionOperation: async () => createClaimedOperationRecord(),
      failProjectionOperation: async () => false,
    });
    const [operationRunner] = collectProjectionOperationRunners(
      {
        mountedContexts: [],
        services: {},
        projectors: [],
        projectionGroups: [group],
        subscriptionRunners: [subscriptionRunner],
      } as never,
      {
        controlPlane,
      },
    );

    await expect(operationRunner.runOnce({ ownerId: "worker-a" })).rejects.toThrow("projection apply exploded");
  });

  it("creates the configured number of projection operation runners with stable names", () => {
    const runners = collectProjectionOperationRunners(
      {
        mountedContexts: [],
        services: {},
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      } as never,
      {
        controlPlane: createAlwaysLeasedControlPlane(),
        runnerCount: 3,
      },
    );

    expect(runners.map((runner) => runner.name)).toEqual([
      "projection-operations",
      "projection-operations-2",
      "projection-operations-3",
    ]);
  });
});

function createClaimedOperationRecord(overrides: Partial<ProjectionOperationRecord> = {}): ProjectionOperationRecord {
  return {
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
    attemptCount: 1,
    nextEligibleAt: new Date(0).toISOString(),
    progress: {},
    result: null,
    error: null,
    requestedAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    completedAt: null,
    ...overrides,
  };
}

function createProjectionGroup(
  overrides: Readonly<{
    subscriptionRunners?: readonly unknown[];
    refreshStatus?: (
      ...args: Parameters<ContextProjectionGroup["refreshStatus"]>
    ) => Promise<
      Pick<Awaited<ReturnType<ContextProjectionGroup["refreshStatus"]>>, "revisionStale" | "revisionSyncToken">
    >;
    recoveryRequired?: () => boolean;
    markRevisionSynced?: ContextProjectionGroup["markRevisionSynced"];
    reset?: () => Promise<void>;
  }> = {},
) {
  return {
    projectionName: "inventory-catalog-item-projection",
    handlerKind: "projection",
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
      handlerKind: "projection",
      projectionRevision: 2,
      storedProjectionRevision: 1,
      revisionStale: true,
      recoveryRequired: overrides.recoveryRequired?.() ?? false,
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

function holderTestGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function holderTestAbort(context?: ProjectionRunContext): Promise<void> {
  return new Promise<void>((resolve) => {
    if (context?.signal?.aborted) resolve();
    else context?.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
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
    readWorkerHeartbeatHistory:
      overrides.readWorkerHeartbeatHistory ??
      (async () => ({
        snapshotAt: new Date().toISOString(),
        workers: [],
        summary: {
          activeOrStaleCount: 0,
          expiredTotalCount: 0,
          expiredWithinDiagnosticWindowCount: 0,
          expiredReturnedCount: 0,
          expiredTruncated: false,
          expiredDiagnosticLimit: 100,
          diagnosticWindowMs: 604_800_000,
        },
      })),
    listRunnerStatuses: overrides.listRunnerStatuses ?? (async () => []),
    listLeases: overrides.listLeases ?? (async () => []),
    enqueueProjectionOperation:
      overrides.enqueueProjectionOperation ??
      (async () => {
        throw new Error("not used");
      }),
    claimProjectionOperation: overrides.claimProjectionOperation ?? (async () => null),
    recordProjectionOperationProgress: overrides.recordProjectionOperationProgress ?? (async () => false),
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
    readWorkerHeartbeatHistory: async () => ({
      snapshotAt: new Date().toISOString(),
      workers: [],
      summary: {
        activeOrStaleCount: 0,
        expiredTotalCount: 0,
        expiredWithinDiagnosticWindowCount: 0,
        expiredReturnedCount: 0,
        expiredTruncated: false,
        expiredDiagnosticLimit: 100,
        diagnosticWindowMs: 604_800_000,
      },
    }),
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

function createInMemoryLeaseCoordinator() {
  const leases = new Map<string, PlatformLease>();
  let nextFencingToken = 0n;

  const isActive = (lease: PlatformLease) => new Date(lease.expiresAt).getTime() > Date.now();
  const createControlPlane = (): PlatformControlPlane =>
    createAlwaysLeasedControlPlane({
      acquireLease: async (input) => {
        const current = leases.get(input.leaseName);
        if (current && isActive(current) && current.ownerId !== input.ownerId) {
          return null;
        }

        nextFencingToken += 1n;
        const lease: PlatformLease = {
          leaseName: input.leaseName,
          ownerId: input.ownerId,
          fencingToken: nextFencingToken.toString(),
          expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
        };
        leases.set(input.leaseName, lease);
        return lease;
      },
      renewLease: async (lease, ttlMs) => {
        const current = leases.get(lease.leaseName);
        if (
          !current ||
          current.ownerId !== lease.ownerId ||
          current.fencingToken !== lease.fencingToken ||
          !isActive(current)
        ) {
          return false;
        }

        leases.set(lease.leaseName, {
          ...current,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        });
        return true;
      },
      releaseLease: async (lease) => {
        const current = leases.get(lease.leaseName);
        if (current?.ownerId === lease.ownerId && current.fencingToken === lease.fencingToken) {
          leases.delete(lease.leaseName);
        }
      },
    });

  return { createControlPlane };
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
