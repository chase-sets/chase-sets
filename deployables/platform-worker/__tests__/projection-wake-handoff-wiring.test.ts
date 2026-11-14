import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it, vi } from "vitest";
import { createProjectionGroupRunnerName } from "@chase-sets/platform-runtime/worker";
import type {
  ProjectionWakeIntentCompletedEvent,
  ProjectionWakeSchedulerObserver,
} from "@chase-sets/platform-runtime/projection-wake-scheduler";
import type { ProjectionWakeIntentEnqueuedEvent } from "@chase-sets/platform-runtime/work-signal-store";

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

function createWiring(text: string) {
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
        "pendingHotProjectionWakeKeys",
        "projectionWakeKey",
        "requestProjectionWakeLeaseHandoff",
        "completeProjectionWakeLeaseHandoff",
      ].map((name) => {
        expect(declarations.has(name)).toBe(true);
        return `const ${declarations.get(name)!.getText(source)};`;
      }),
      observerFactory!.getText(source),
      `const enqueue = ${property(declarations.get("workSignalStore")!, "projectionWakeIntentEnqueued").getText(source)};`,
      `const observer = ${property(declarations.get("projectionWakeRunners")!, "observer").getText(source)};`,
    ].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const runner = { nudge: vi.fn(), completeProjectionWakeLeaseHandoff: vi.fn() };
  const recordOutcome = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const wiring: {
    enqueue: (event: ProjectionWakeIntentEnqueuedEvent) => void;
    observer: ProjectionWakeSchedulerObserver;
    pending: Set<string>;
  } = runInNewContext(`${compiled}\n({ enqueue, observer, pending: pendingHotProjectionWakeKeys })`, {
    createProjectionGroupRunnerName,
    projectionRunnerLoop: runner,
    projectionWakeRunnerLoop: null,
    config: { projectionWakeScheduler: { pushDispatchEnabled: false } },
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

function enqueue(wiring: ReturnType<typeof createWiring>, priorityLane = completed.priorityLane) {
  wiring.enqueue({
    ...completed,
    priorityLane,
    outcome: "coalesced",
    routingMode: "unspecified",
  });
  return createProjectionGroupRunnerName(completed);
}

function assertRequeuedHandoff(text: string, outcome: ProjectionWakeIntentCompletedEvent["outcome"]) {
  const wiring = createWiring(text);
  const key = enqueue(wiring);
  expect(wiring.pending.has(key)).toBe(true);
  expect(wiring.runner.nudge).toHaveBeenCalledWith([key]);
  // Newer hot work is queued while the older wake is running.
  enqueue(wiring);
  wiring.observer.wakeIntentCompleted!({ ...completed, outcome, requeued: true });
  expect(wiring.pending.has(key)).toBe(true);
  expect(wiring.runner.completeProjectionWakeLeaseHandoff).not.toHaveBeenCalled();
  wiring.observer.wakeIntentCompleted!({ ...completed, outcome });
  expect(wiring.pending.has(key)).toBe(false);
  expect(wiring.runner.completeProjectionWakeLeaseHandoff).toHaveBeenCalledExactlyOnceWith(key);
  expect(wiring.recordOutcome.mock.calls.map(([event]) => event.requeued)).toEqual([true, false]);
  expect(wiring.recordOutcome.mock.calls.map(([event]) => event.outcome)).toEqual([
    outcome === "ran" ? "completed" : outcome,
    outcome === "ran" ? "completed" : outcome,
  ]);
  expect(wiring.logger.info.mock.calls.map(([, event]) => event.requeued)).toEqual([true, false]);
}

describe("projection wake handoff production wiring", () => {
  it.each(["ran", "already-satisfied"] as const)("preserves newer hot work on requeued %s completion", (outcome) => {
    assertRequeuedHandoff(mainSource, outcome);
  });

  it.each(["ran", "already-satisfied"] as const)("rejects the removed requeue guard for %s", (outcome) => {
    const guard = "if (!event.requeued) {\n        options.onTerminal?.(event);\n      }";
    const normalized = mainSource.replaceAll("\r\n", "\n");
    expect(normalized).toContain(guard);
    const mutant = normalized.replace(guard, "options.onTerminal?.(event);");
    expect(() => assertRequeuedHandoff(mutant, outcome)).toThrow("expected false to be true");
  });

  it.each(["wakeIntentNotReady", "wakeIntentDeferred", "wakeIntentRunFailed", "wakeIntentClaimLost"] as const)(
    "%s is not terminal for the hot handoff",
    (method) => {
      const wiring = createWiring(mainSource);
      const key = enqueue(wiring);
      wiring.observer[method]!({ ...completed, retryAfterMs: 10, error: new Error("synthetic failure") });
      expect(wiring.pending.has(key)).toBe(true);
      expect(wiring.runner.completeProjectionWakeLeaseHandoff).not.toHaveBeenCalled();
    },
  );

  it.each(["wakeIntentUnknownTarget", "wakeIntentAttemptsExhausted"] as const)(
    "%s clears the terminal hot handoff",
    (method) => {
      const wiring = createWiring(mainSource);
      const key = enqueue(wiring);
      wiring.observer[method]!({ ...completed, retryAfterMs: 10 });
      expect(wiring.pending.has(key)).toBe(false);
      expect(wiring.runner.completeProjectionWakeLeaseHandoff).toHaveBeenCalledExactlyOnceWith(key);
    },
  );

  it("does not clear a hot handoff for standard-lane completion", () => {
    const wiring = createWiring(mainSource);
    const key = enqueue(wiring);
    wiring.observer.wakeIntentCompleted!({ ...completed, priorityLane: "standard" });
    expect(wiring.pending.has(key)).toBe(true);
    expect(wiring.runner.completeProjectionWakeLeaseHandoff).not.toHaveBeenCalled();
  });
});
