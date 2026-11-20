import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it, vi } from "vitest";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import {
  createProjectionGroupRunnerName,
  createWorkerRunnerLoop,
  type WorkerRunnerLoop,
} from "@chase-sets/platform-runtime/worker";
import type {
  ProjectionWakeIntentCompletedEvent,
  ProjectionWakeSchedulerObserver,
} from "@chase-sets/platform-runtime/projection-wake-scheduler";
import type { ProjectionWakeIntentEnqueuedEvent } from "@chase-sets/platform-runtime/work-signal-store";

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

function createWiring(text: string, loop?: WorkerRunnerLoop, disabled = false) {
  const source = ts.createSourceFile("main.ts", text, ts.ScriptTarget.ES2022, true);
  const declarations = new Map<string, ts.VariableDeclaration>();
  let observerFactory: ts.FunctionDeclaration | undefined;
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "createProjectionWakeSchedulerLogObserver") {
      observerFactory = statement;
    }
  }
  const property = (root: ts.Node, name: string): ts.Expression => {
    const matches: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        matches.push(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    expect(matches).toHaveLength(1);
    return matches[0]!;
  };
  expect(observerFactory).toBeDefined();
  const compiled = ts.transpileModule(
    [
      ...[
        "projectionWakeKey",
        "requestProjectionWakeLeaseHandoff",
        "completeProjectionWakeLeaseHandoff",
        "projectionWakeDisabledProjectionKeys",
        "projectionWakeSchedulerProjectionGroups",
        "enabledProjectionWakeRunnerNames",
      ].map((name) => {
        expect(declarations.has(name)).toBe(true);
        return `const ${declarations.get(name)!.getText(source)};`;
      }),
      observerFactory!.getText(source),
      `const enqueue = ${property(declarations.get("workSignalStore")!, "projectionWakeIntentEnqueued").getText(source)};`,
      `const observer = ${property(declarations.get("projectionWakeRunners")!, "observer").getText(source)};`,
      `const receive = ${property(declarations.get("projectionWakePushDispatcher")!, "notificationReceived").getText(source)};`,
    ].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const runner = { requestProjectionWakeLeaseHandoff: vi.fn(), completeProjectionWakeLeaseHandoff: vi.fn() };
  const recordOutcome = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const wiring: {
    enqueue: (event: ProjectionWakeIntentEnqueuedEvent) => void;
    observer: ProjectionWakeSchedulerObserver;
    receive: (event: { notification: { envelope: { kind: string; payload: object } } }) => void;
  } = runInNewContext(`${compiled}\n({ enqueue, observer, receive })`, {
    Date,
    createProjectionGroupRunnerName,
    projectionRunnerLoop: loop ?? runner,
    projectionWakeRunnerLoop: null,
    config: {
      projectionWakeDisabledProjections: disabled ? [`auth:${completed.projectionName}`] : [],
      projectionWakeScheduler: { enabled: true, hotLaneRunnerCount: 1, maxAttempts: 3, pushDispatchEnabled: false },
    },
    runtime: {
      projectionGroups: [completed, { targetContextName: "auth", projectionName: enabledSibling }],
    },
    recordProjectionWakeIntentEnqueueOutcome: vi.fn(),
    recordProjectionWakeIntentOutcome: recordOutcome,
    logger,
  });
  return { ...wiring, runner, recordOutcome, logger };
}

const completed: ProjectionWakeIntentCompletedEvent = {
  workerId: "auth-worker",
  laneRunnerName: "projection-wake.hot.0",
  wakeIntentId: "old-hot-wake",
  priorityLane: "hot",
  origin: "api-wait",
  sourceContextName: "identity",
  targetContextName: "auth",
  projectionName: "auth-identity-user-projection",
  checkpointKey: "auth-identity-user-projection",
  requiredPosition: "3",
  attemptCount: 1,
  queueAgeMs: 10,
  outcome: "ran",
  checkpointPosition: "3",
  requeued: false,
  processingDurationMs: 5,
};

const generation = { wakeIntentId: completed.wakeIntentId, requiredPosition: BigInt(completed.requiredPosition) };

function enqueue(wiring: ReturnType<typeof createWiring>, priorityLane = completed.priorityLane) {
  sendWake(wiring, "local", { priorityLane });
  return createProjectionGroupRunnerName(completed);
}

const enabledSibling = "auth-identity-session-projection";

async function duringProductivePass(
  probe: (wiring: ReturnType<typeof createWiring>) => void,
  {
    yields,
    finish,
    disabled,
  }: { yields: boolean; finish?: (wiring: ReturnType<typeof createWiring>) => void; disabled?: boolean },
) {
  vi.useFakeTimers();
  let runs = 0;
  let finishPass!: () => void;
  const firstPass = new Promise<void>((resolve) => {
    finishPass = resolve;
  });
  const releaseLease = vi.fn(async () => {});
  const granted: Partial<PlatformControlPlane> = {
    acquireLease: async ({ leaseName, ownerId, ttlMs }) => ({
      leaseName,
      ownerId,
      fencingToken: "1",
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    }),
    renewLease: async () => true,
    releaseLease,
    recordRunnerStatus: async () => {},
  };
  const controlPlane = new Proxy(granted, {
    get: (target, key) =>
      Reflect.get(target, key) ??
      (async () => {
        throw new Error(`Unexpected synthetic control-plane call ${String(key)}.`);
      }),
  }) as PlatformControlPlane;
  const loop = createWorkerRunnerLoop({
    workerId: "synthetic-poller",
    controlPlane,
    runners: [
      {
        name: createProjectionGroupRunnerName(completed),
        kind: "projection-group",
        runOnce: async (context) => {
          if (++runs === 1) await firstPass;
          else
            await new Promise<void>((resolve) =>
              context?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
          return { processed: 1, lastGlobalPosition: "1" as never, state: "running" };
        },
      },
    ],
    maxConcurrentRunners: 1,
    leaseTtlMs: 30_000,
    leaseRenewIntervalMs: 10_000,
    pollIntervalMs: 1_000,
  });
  try {
    const wiring = createWiring(mainSource, loop, disabled);
    loop.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    probe(wiring);
    finishPass();
    await vi.advanceTimersByTimeAsync(1_001);
    expect({ runs, releases: releaseLease.mock.calls.length }).toEqual(
      yields ? { runs: 1, releases: 1 } : { runs: 2, releases: 0 },
    );
    if (finish) {
      finish(wiring);
      await vi.advanceTimersByTimeAsync(1);
      expect(runs).toBe(2);
    }
  } finally {
    finishPass();
    await loop.stop();
    vi.useRealTimers();
  }
}

function sendWake(
  wiring: ReturnType<typeof createWiring>,
  ingress: "local" | "listen",
  overrides: Partial<ProjectionWakeIntentEnqueuedEvent> = {},
) {
  const payload = {
    ...completed,
    state: "queued" as const,
    claimedUntil: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
    outcome: "coalesced" as const,
    routingMode: "unspecified" as const,
  };
  if (ingress === "local") wiring.enqueue(payload);
  else wiring.receive({ notification: { envelope: { kind: "projection.wake-intent", payload } } });
}

function assertRequeuedHandoff(text: string, outcome: ProjectionWakeIntentCompletedEvent["outcome"]) {
  const wiring = createWiring(text);
  const key = enqueue(wiring);
  expect(wiring.runner.requestProjectionWakeLeaseHandoff).toHaveBeenCalledExactlyOnceWith(
    key,
    generation,
    expect.any(Number),
  );
  // Newer hot work is queued while the older wake is running.
  enqueue(wiring);
  wiring.observer.wakeIntentCompleted!({ ...completed, outcome, requeued: true });
  expect(wiring.runner.completeProjectionWakeLeaseHandoff).not.toHaveBeenCalled();
  wiring.observer.wakeIntentCompleted!({ ...completed, outcome });
  expect(wiring.runner.completeProjectionWakeLeaseHandoff).toHaveBeenCalledExactlyOnceWith(key, generation);
  expect(wiring.recordOutcome.mock.calls.map(([event]) => event.requeued)).toEqual([true, false]);
  expect(wiring.recordOutcome.mock.calls.map(([event]) => event.outcome)).toEqual([
    outcome === "ran" ? "completed" : outcome,
    outcome === "ran" ? "completed" : outcome,
  ]);
  expect(wiring.logger.info.mock.calls.map(([, event]) => event.requeued)).toEqual([true, false]);
}

describe("projection wake handoff production wiring", () => {
  it.each([
    ["distinct intent", { wakeIntentId: "other-hot-wake" }],
    ["higher position on the same row", { requiredPosition: "4" }],
  ] as const)("keeps a %s pending after the old wake completes", async (_scenario, newerWake) => {
    await duringProductivePass(
      (wiring) => {
        sendWake(wiring, "listen");
        sendWake(wiring, "listen", newerWake);
        wiring.observer.wakeIntentCompleted!(completed);
      },
      {
        yields: true,
        finish: (wiring) => wiring.observer.wakeIntentCompleted!({ ...completed, ...newerWake }),
      },
    );
  });

  describe.each(["local", "listen"] as const)("%s ingress", (ingress) => {
    it("keeps polling a disabled group beside an enabled sibling", async () => {
      await duringProductivePass((wiring) => sendWake(wiring, ingress), { yields: false, disabled: true });
    });

    it("does not yield for an exhausted same-position coalesce", async () => {
      await duringProductivePass((wiring) => sendWake(wiring, ingress, { state: "failed", attemptCount: 3 }), {
        yields: false,
      });
    });

    it.each(["queued", "claimed"] as const)("yields for a %s higher-position reopen", async (state) => {
      await duringProductivePass(
        (wiring) =>
          sendWake(wiring, ingress, {
            state,
            requiredPosition: "4",
            attemptCount: state === "queued" ? 0 : 3,
            claimedUntil: state === "claimed" ? new Date(Date.now() + 10_000).toISOString() : null,
          }),
        { yields: true },
      );
    });

    it.each([
      ["expired at cap", -10_000, 3, false],
      ["live at cap", 10_000, 3, true],
      ["expired below cap", -10_000, 2, true],
    ] as const)(
      "hands off a same-position claim only when runnable: %s",
      async (_label, claimOffset, attemptCount, yields) => {
        await duringProductivePass(
          (wiring) =>
            sendWake(wiring, ingress, {
              state: "claimed",
              attemptCount,
              claimedUntil: new Date(Date.now() + claimOffset).toISOString(),
            }),
          { yields },
        );
      },
    );
  });
  it.each(["ran", "already-satisfied"] as const)("preserves newer hot work on requeued %s completion", (outcome) => {
    assertRequeuedHandoff(mainSource, outcome);
  });

  it.each(["ran", "already-satisfied"] as const)("rejects the removed requeue guard for %s", (outcome) => {
    const guard = "if (!event.requeued) {\n        options.onTerminal?.(event);\n      }";
    const normalized = mainSource.replaceAll("\r\n", "\n");
    expect(normalized).toContain(guard);
    const mutant = normalized.replace(guard, "options.onTerminal?.(event);");
    expect(() => assertRequeuedHandoff(mutant, outcome)).toThrow("to not be called at all");
  });

  it.each(["wakeIntentNotReady", "wakeIntentDeferred", "wakeIntentRunFailed", "wakeIntentClaimLost"] as const)(
    "%s is not terminal for the hot handoff",
    (method) => {
      const wiring = createWiring(mainSource);
      enqueue(wiring);
      wiring.observer[method]!({ ...completed, retryAfterMs: 10, error: new Error("synthetic failure") });
      expect(wiring.runner.completeProjectionWakeLeaseHandoff).not.toHaveBeenCalled();
    },
  );

  it.each(["wakeIntentUnknownTarget", "wakeIntentAttemptsExhausted"] as const)(
    "%s clears the terminal hot handoff",
    (method) => {
      const wiring = createWiring(mainSource);
      const key = enqueue(wiring);
      wiring.observer[method]!({ ...completed, retryAfterMs: 10 });
      expect(wiring.runner.completeProjectionWakeLeaseHandoff).toHaveBeenCalledExactlyOnceWith(key, generation);
    },
  );

  it("does not clear a hot handoff for standard-lane completion", () => {
    const wiring = createWiring(mainSource);
    enqueue(wiring);
    wiring.observer.wakeIntentCompleted!({ ...completed, priorityLane: "standard" });
    expect(wiring.runner.completeProjectionWakeLeaseHandoff).not.toHaveBeenCalled();
  });
});
