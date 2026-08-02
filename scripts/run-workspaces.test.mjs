import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listWorkspacePackages } from "./lib/repo.mjs";
import {
  DB_TEST_SCRIPT_SELECTOR,
  DEFAULT_TEST_COMMAND_TIMEOUT_MS,
  loadTestEnvironment,
  parseRunWorkspacesArgs,
  runWorkspaceScripts,
  validateDurationHintRegistry,
  validateRunWorkspacesSummary,
  validateWorkspaceDurationReplay,
} from "./run-workspaces.mjs";

function workspace(name, scripts, testProfile) {
  return {
    name,
    packageJson: {
      scripts,
      chaseSets: testProfile ? { testProfile } : undefined,
    },
  };
}

function buildInvocation(args) {
  return {
    command: "pnpm",
    args,
  };
}

function durationRegistry(entries) {
  return {
    schemaVersion: "workspace-test-duration-hints/v1",
    entries,
  };
}

function durationEntry(workspace, script, estimatedDurationSeconds) {
  return { workspace, script, estimatedDurationSeconds };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function captureConsole(action) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => stdout.push(values.map(String).join(" "));
  console.error = (...values) => stderr.push(values.map(String).join(" "));

  try {
    return { result: await action(), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("run-workspaces", () => {
  it("keeps local verify:test on the same non-DB workspace runner used by CI", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const verifyTest = packageJson.scripts["verify:test"];

    expect(verifyTest).toBe(
      "node ./scripts/run-workspaces.mjs test --exclude-test-profile=db --concurrency=4 && node ./scripts/run-workspaces.mjs test:unit --test-profile=db --concurrency=4",
    );
  });

  it("preserves serial behavior by default", async () => {
    let active = 0;
    let maxActive = 0;

    await runWorkspaceScripts({
      argv: ["build"],
      buildInvocation,
      listWorkspaces: () => [workspace("@test/a", { build: "build" }), workspace("@test/b", { build: "build" })],
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(5);
        active -= 1;
      },
    });

    expect(maxActive).toBe(1);
  });

  it("limits simultaneous workspace runs to the requested concurrency", async () => {
    let active = 0;
    let maxActive = 0;

    await runWorkspaceScripts({
      argv: ["build", "--concurrency=2"],
      buildInvocation,
      listWorkspaces: () => [
        workspace("@test/a", { build: "build" }),
        workspace("@test/b", { build: "build" }),
        workspace("@test/c", { build: "build" }),
        workspace("@test/d", { build: "build" }),
      ],
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(5);
        active -= 1;
      },
    });

    expect(maxActive).toBe(2);
  });

  it("runs DB partition siblings serially while preserving global workspace concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const activeByWorkspace = new Map();
    const maxActiveByWorkspace = new Map();
    const runs = [];

    await runWorkspaceScripts({
      argv: [DB_TEST_SCRIPT_SELECTOR, "--concurrency=2"],
      buildInvocation,
      listWorkspaces: () => [
        workspace(
          "@test/partitioned",
          {
            "test:db": "aggregate",
            "test:db:1": "partition one",
            "test:db:2": "partition two",
          },
          "db",
        ),
        workspace("@test/ordinary", { "test:db": "ordinary" }, "db"),
      ],
      loadEnvironment: () => {},
      run: async (_command, args) => {
        const workspaceName = args[1];
        const scriptName = args[3];
        runs.push({ workspaceName, scriptName });
        active += 1;
        maxActive = Math.max(maxActive, active);
        const workspaceActive = (activeByWorkspace.get(workspaceName) ?? 0) + 1;
        activeByWorkspace.set(workspaceName, workspaceActive);
        maxActiveByWorkspace.set(
          workspaceName,
          Math.max(maxActiveByWorkspace.get(workspaceName) ?? 0, workspaceActive),
        );
        await delay(10);
        activeByWorkspace.set(workspaceName, workspaceActive - 1);
        active -= 1;
      },
    });

    expect(maxActive).toBe(2);
    expect(maxActiveByWorkspace.get("@test/partitioned")).toBe(1);
    expect(runs.filter(({ workspaceName }) => workspaceName === "@test/partitioned")).toEqual([
      { workspaceName: "@test/partitioned", scriptName: "test:db:1" },
      { workspaceName: "@test/partitioned", scriptName: "test:db:2" },
    ]);
    expect(runs).toContainEqual({ workspaceName: "@test/ordinary", scriptName: "test:db" });
  });

  it("respects include and exclude test profiles", async () => {
    const runs = [];
    const workspaces = [
      workspace("@chase-sets/fast", { test: "test" }),
      workspace("@chase-sets/db", { test: "test" }, "db"),
      workspace("@chase-sets/none", { build: "build" }),
    ];

    await runWorkspaceScripts({
      argv: ["test", "--exclude-test-profile=db"],
      buildInvocation,
      durationHintRegistry: durationRegistry([durationEntry("@chase-sets/fast", "test", 1)]),
      listWorkspaces: () => workspaces,
      loadEnvironment: () => {},
      run: async (_command, args) => {
        runs.push(args[1]);
      },
    });
    expect(runs).toEqual(["@chase-sets/fast"]);

    runs.length = 0;
    await runWorkspaceScripts({
      argv: ["test", "--test-profile=db"],
      buildInvocation,
      listWorkspaces: () => workspaces,
      loadEnvironment: () => {},
      run: async (_command, args) => {
        runs.push(args[1]);
      },
    });
    expect(runs).toEqual(["@chase-sets/db"]);

    runs.length = 0;
    await runWorkspaceScripts({
      argv: ["test:fast", "--test-profile=db"],
      buildInvocation,
      listWorkspaces: () => [
        workspace("@test/db-fast", { test: "test", "test:fast": "test:fast" }, "db"),
        workspace("@test/db-full-only", { test: "test" }, "db"),
        workspace("@test/fast", { test: "test", "test:fast": "test:fast" }),
      ],
      loadEnvironment: () => {},
      run: async (_command, args) => {
        runs.push(args[1]);
      },
    });
    expect(runs).toEqual(["@test/db-fast"]);
  });

  it("issue-6418 three-branch guard selects Public Presence exactly once for unit and DB profiles", async () => {
    const candidate = workspace(
      "@chase-sets/public-presence",
      { test: "test", "test:unit": "test:unit", "test:db": "test:db" },
      "db",
    );
    const runs = [];
    const run = async (_command, args) => runs.push({ workspace: args[1], script: args[3] });

    await runWorkspaceScripts({
      argv: ["test", "--exclude-test-profile=db"],
      buildInvocation,
      durationHintRegistry: durationRegistry([durationEntry("@chase-sets/fast", "test", 1)]),
      listWorkspaces: () => [workspace("@chase-sets/fast", { test: "test" }), candidate],
      loadEnvironment: () => {},
      run,
    });
    expect(runs).not.toContainEqual({ workspace: "@chase-sets/public-presence", script: "test" });

    runs.length = 0;
    await runWorkspaceScripts({
      argv: ["test:unit", "--test-profile=db"],
      buildInvocation,
      durationHintRegistry: durationRegistry([durationEntry("@chase-sets/public-presence", "test:unit", 52)]),
      listWorkspaces: () => [candidate],
      loadEnvironment: () => {},
      run,
    });
    expect(runs).toEqual([{ workspace: "@chase-sets/public-presence", script: "test:unit" }]);

    runs.length = 0;
    await runWorkspaceScripts({
      argv: [DB_TEST_SCRIPT_SELECTOR],
      buildInvocation,
      listWorkspaces: () => [candidate],
      loadEnvironment: () => {},
      run,
    });
    expect(runs).toEqual([{ workspace: "@chase-sets/public-presence", script: "test:db" }]);
  });

  it("issue-6418 lifecycle-bypass guard keeps pretest aliases exact and isolates only reconciliation DB tests", () => {
    const packageJson = JSON.parse(readFileSync("bounded-contexts/public-presence/package.json", "utf8"));
    expect(packageJson.scripts["pretest:unit"]).toBe(packageJson.scripts.pretest);
    expect(packageJson.scripts["pretest:db"]).toBe(packageJson.scripts.pretest);
    expect(packageJson.scripts["test:unit"]).toBe(
      "vitest run --config ./tests/vitest.config.mjs --exclude features/waitlist/api/referral-code-reconciliation.db.test.ts",
    );
    expect(packageJson.scripts["test:watch"]).toBe(
      "vitest --config ./tests/vitest.config.mjs --exclude features/waitlist/api/referral-code-reconciliation.db.test.ts",
    );
    expect(packageJson.scripts["test:db"]).toBe(
      "vitest run --config ./tests/vitest.config.mjs features/waitlist/api/referral-code-reconciliation.db.test.ts",
    );
  });

  it("returns nonzero semantics with a failed-workspace summary", async () => {
    const failedMessages = [];
    const originalError = console.error;
    console.error = (message) => {
      failedMessages.push(String(message));
    };

    try {
      await expect(
        runWorkspaceScripts({
          argv: ["build", "--concurrency=2"],
          buildInvocation,
          listWorkspaces: () => [workspace("@test/a", { build: "build" }), workspace("@test/b", { build: "build" })],
          run: async (_command, args) => {
            if (args[1] === "@test/b") {
              throw new Error("boom");
            }
          },
        }),
      ).rejects.toThrow("1 workspace script run(s) failed.");
    } finally {
      console.error = originalError;
    }

    expect(failedMessages.join("\n")).toContain("Failed workspaces: @test/b");
    expect(failedMessages.join("\n")).toContain("[@test/b] boom");
  });

  it("keeps arguments after -- as passthrough arguments", () => {
    expect(parseRunWorkspacesArgs(["test", "--concurrency=4", "--", "--coverage"])).toEqual({
      scriptName: "test",
      passthroughArgs: ["--coverage"],
      includeTestProfile: undefined,
      excludeTestProfile: undefined,
      workspaceNames: new Set(),
      concurrency: 4,
      commandTimeoutMs: undefined,
    });
  });

  it("parses an explicit per-command timeout without passing it to workspace scripts", async () => {
    expect(parseRunWorkspacesArgs(["build", "--command-timeout-ms=2500"])).toEqual({
      scriptName: "build",
      passthroughArgs: [],
      includeTestProfile: undefined,
      excludeTestProfile: undefined,
      workspaceNames: new Set(),
      concurrency: 1,
      commandTimeoutMs: 2500,
    });

    const runCalls = [];
    await runWorkspaceScripts({
      argv: ["build", "--command-timeout-ms=2500", "--workspace=@test/a"],
      buildInvocation,
      listWorkspaces: () => [workspace("@test/a", { build: "build" })],
      run: async (_command, args, options) => {
        runCalls.push({ args, options });
      },
    });

    expect(runCalls).toEqual([
      {
        args: ["--filter", "@test/a", "run", "build"],
        options: { stdio: "inherit", timeoutMs: 2500 },
      },
    ]);
  });

  it("bounds test workspace commands by default", async () => {
    const runOptions = [];

    await runWorkspaceScripts({
      argv: ["test:db", "--workspace=@test/db"],
      buildInvocation,
      listWorkspaces: () => [workspace("@test/db", { "test:db": "test:db" }, "db")],
      loadEnvironment: () => {},
      run: async (_command, _args, options) => {
        runOptions.push(options);
      },
    });

    expect(runOptions).toEqual([{ stdio: "inherit", timeoutMs: DEFAULT_TEST_COMMAND_TIMEOUT_MS }]);
  });

  it("forwards passthrough arguments to the workspace script without a literal separator", async () => {
    const runs = [];

    await runWorkspaceScripts({
      argv: ["test", "--workspace=@test/a", "--", "--coverage", "--coverage.reporter=lcov"],
      buildInvocation,
      listWorkspaces: () => [workspace("@test/a", { test: "test" })],
      loadEnvironment: () => {},
      run: async (_command, args) => {
        runs.push(args);
      },
    });

    expect(runs).toEqual([["--filter", "@test/a", "run", "test", "--coverage", "--coverage.reporter=lcov"]]);
  });

  it("filters by explicit workspace names", async () => {
    const runs = [];

    await runWorkspaceScripts({
      argv: ["build", "--workspace-list=@test/b,@test/c"],
      buildInvocation,
      listWorkspaces: () => [
        workspace("@test/a", { build: "build" }),
        workspace("@test/b", { build: "build" }),
        workspace("@test/c", { test: "test" }),
      ],
      run: async (_command, args) => {
        runs.push(args[1]);
      },
    });

    expect(runs).toEqual(["@test/b"]);
  });

  it("lets sandbox test env override checked-in local test defaults without replacing inherited shell values", () => {
    const env = {};

    loadTestEnvironment({
      env,
      envRootDir: process.cwd(),
      inheritedKeys: new Set(),
      syncEnvFiles: () => [],
      ensureSandboxEnvironment: () => ({
        env: {
          TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:7120/postgres",
          CHASE_SETS_SANDBOX_ID: "unit",
        },
      }),
    });

    expect(env.TEST_DATABASE_URL).toBe("postgresql://postgres:postgres@localhost:7120/postgres");
    expect(env.CHASE_SETS_SANDBOX_ID).toBe("unit");

    const inheritedEnv = {
      TEST_DATABASE_URL: "postgresql://ci/postgres",
    };

    loadTestEnvironment({
      env: inheritedEnv,
      envRootDir: process.cwd(),
      inheritedKeys: new Set(["TEST_DATABASE_URL"]),
      syncEnvFiles: () => [],
      ensureSandboxEnvironment: () => ({
        env: {
          TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:7120/postgres",
          CHASE_SETS_SANDBOX_ID: "unit",
        },
      }),
    });

    expect(inheritedEnv.TEST_DATABASE_URL).toBe("postgresql://ci/postgres");
    expect(inheritedEnv.CHASE_SETS_SANDBOX_ID).toBe("unit");
  });

  it("omits generated TEST_DATABASE_URL for non-DB test runs unless it was inherited", async () => {
    const loadCalls = [];

    await runWorkspaceScripts({
      argv: ["test", "--exclude-test-profile=db"],
      buildInvocation,
      durationHintRegistry: durationRegistry([durationEntry("@chase-sets/fast", "test", 1)]),
      listWorkspaces: () => [workspace("@chase-sets/fast", { test: "test" })],
      loadEnvironment: (options) => {
        loadCalls.push(options);
      },
      run: async () => {},
    });

    expect(loadCalls).toEqual([{ includeTestDatabaseUrl: false }]);

    loadCalls.length = 0;
    await runWorkspaceScripts({
      argv: ["test:unit", "--test-profile=db"],
      buildInvocation,
      durationHintRegistry: durationRegistry([durationEntry("@chase-sets/db-unit", "test:unit", 1)]),
      listWorkspaces: () => [workspace("@chase-sets/db-unit", { "test:unit": "test:unit" }, "db")],
      loadEnvironment: (options) => {
        loadCalls.push(options);
      },
      run: async () => {},
    });

    expect(loadCalls).toEqual([{ includeTestDatabaseUrl: false }]);

    loadCalls.length = 0;
    await runWorkspaceScripts({
      argv: ["test:db", "--test-profile=db"],
      buildInvocation,
      listWorkspaces: () => [workspace("@test/db", { "test:db": "test:db" }, "db")],
      loadEnvironment: (options) => {
        loadCalls.push(options);
      },
      run: async () => {},
    });

    expect(loadCalls).toEqual([{ includeTestDatabaseUrl: true }]);

    const env = {};
    loadTestEnvironment({
      env,
      envRootDir: process.cwd(),
      includeTestDatabaseUrl: false,
      inheritedKeys: new Set(),
      syncEnvFiles: () => [],
      ensureSandboxEnvironment: () => ({
        env: {
          TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:7120/postgres",
          CHASE_SETS_SANDBOX_ID: "unit",
        },
      }),
    });

    expect(env.TEST_DATABASE_URL).toBeUndefined();
    expect(env.CHASE_SETS_SANDBOX_ID).toBe("unit");

    const inheritedEnv = {
      TEST_DATABASE_URL: "postgresql://ci/postgres",
    };

    loadTestEnvironment({
      env: inheritedEnv,
      envRootDir: process.cwd(),
      includeTestDatabaseUrl: false,
      inheritedKeys: new Set(["TEST_DATABASE_URL"]),
      syncEnvFiles: () => [],
      ensureSandboxEnvironment: () => ({
        env: {
          TEST_DATABASE_URL: "postgresql://postgres:postgres@localhost:7120/postgres",
          CHASE_SETS_SANDBOX_ID: "unit",
        },
      }),
    });

    expect(inheritedEnv.TEST_DATABASE_URL).toBe("postgresql://ci/postgres");
    expect(inheritedEnv.CHASE_SETS_SANDBOX_ID).toBe("unit");
  });
});

describe("closed duration scheduling contracts", () => {
  const registryPath = "scripts/workspace-test-duration-hints-v1.json";
  const replayPath = "scripts/fixtures/workspace-unit-duration-replay-v1.json";

  it("validates the checked-in registry and replay fixture against the current workspace universe", () => {
    const registry = readJson(registryPath);
    const replay = readJson(replayPath);
    const workspaces = listWorkspacePackages();
    const eligibleKeys = workspaces.flatMap((candidate) => {
      const keys = [];
      if (
        typeof candidate.packageJson.scripts?.test === "string" &&
        candidate.packageJson.chaseSets?.testProfile !== "db"
      ) {
        keys.push(`${candidate.name}\0test`);
      }
      if (
        typeof candidate.packageJson.scripts?.["test:unit"] === "string" &&
        candidate.packageJson.chaseSets?.testProfile === "db"
      ) {
        keys.push(`${candidate.name}\0test:unit`);
      }
      return keys;
    });
    const registryKeys = registry.entries.map((entry) => `${entry.workspace}\0${entry.script}`);

    expect(validateDurationHintRegistry(registry, workspaces)).toBe(registry);
    expect(validateWorkspaceDurationReplay(replay, registry)).toBe(replay);
    expect(new Set(registryKeys)).toEqual(new Set(eligibleKeys));
    expect(registry.entries).toHaveLength(58);
    expect(replay.observations).toHaveLength(83);
  });

  it("derives every checked-in duration hint from the authoritative observations", () => {
    const registry = readJson(registryPath);
    const replay = readJson(replayPath);
    const observationsByTask = new Map();

    for (const observation of replay.observations) {
      const key = `${observation.workspace}\0${observation.script}`;
      const durations = observationsByTask.get(key) ?? [];
      durations.push(observation.observedDurationMs);
      observationsByTask.set(key, durations);
    }

    const derivedEntries = [...observationsByTask.entries()]
      .map(([key, durations]) => {
        const [workspaceName, script] = key.split("\0");
        const sorted = durations.toSorted((left, right) => left - right);
        const middle = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
        return durationEntry(workspaceName, script, Math.ceil(median / 1000));
      })
      .sort((left, right) => {
        const leftKey = `${left.script}\0${left.workspace}`;
        const rightKey = `${right.script}\0${right.workspace}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
    const registeredEntries = registry.entries.toSorted((left, right) => {
      const leftKey = `${left.script}\0${left.workspace}`;
      const rightKey = `${right.script}\0${right.workspace}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

    expect(registeredEntries).toEqual(derivedEntries);
  });

  it("closed-schema-shallow-validation rejects registry drift before command execution", async () => {
    const workspaces = [
      workspace("@chase-sets/fast", { test: "test" }),
      workspace("@chase-sets/db-unit", { "test:unit": "test:unit" }, "db"),
      workspace("@chase-sets/db-fast", { test: "test" }, "db"),
      workspace("@chase-sets/no-unit", { test: "test" }, "db"),
    ];
    const valid = durationRegistry([durationEntry("@chase-sets/fast", "test", 12)]);
    const invalidRegistries = [
      null,
      { ...valid, unknown: true },
      { ...valid, schemaVersion: 1 },
      { ...valid, entries: {} },
      { ...valid, entries: [] },
      { ...valid, entries: Array.from({ length: 257 }, () => valid.entries[0]) },
      durationRegistry([null]),
      durationRegistry([{ ...valid.entries[0], unknown: true }]),
      durationRegistry([{ ...valid.entries[0], workspace: 1 }]),
      durationRegistry([durationEntry("", "test", 12)]),
      durationRegistry([durationEntry(`@chase-sets/${"a".repeat(128)}`, "test", 12)]),
      durationRegistry([durationEntry("fast", "test", 12)]),
      durationRegistry([durationEntry("@chase-sets/fast", 1, 12)]),
      durationRegistry([durationEntry("@chase-sets/fast", "build", 12)]),
      durationRegistry([durationEntry("@chase-sets/fast", "test", "12")]),
      durationRegistry([durationEntry("@chase-sets/fast", "test", 1.5)]),
      durationRegistry([durationEntry("@chase-sets/fast", "test", Number.POSITIVE_INFINITY)]),
      durationRegistry([durationEntry("@chase-sets/fast", "test", 0)]),
      durationRegistry([durationEntry("@chase-sets/fast", "test", 3601)]),
      durationRegistry([valid.entries[0], valid.entries[0]]),
      durationRegistry([durationEntry("@chase-sets/missing", "test", 12)]),
      durationRegistry([durationEntry("@chase-sets/no-unit", "test:unit", 12)]),
      durationRegistry([durationEntry("@chase-sets/db-fast", "test", 12)]),
    ];

    for (const durationHintRegistry of invalidRegistries) {
      let commandCount = 0;
      const { stdout } = await captureConsole(async () => {
        await expect(
          runWorkspaceScripts({
            argv: ["test", "--exclude-test-profile=db"],
            buildInvocation,
            durationHintRegistry,
            listWorkspaces: () => workspaces,
            loadEnvironment: () => {},
            run: async () => {
              commandCount += 1;
            },
          }),
        ).rejects.toThrow();
      });

      expect(commandCount).toBe(0);
      expect(stdout.some((line) => line.startsWith("RUN_WORKSPACES_SUMMARY "))).toBe(false);
    }
  });

  it("closed-schema-shallow-validation rejects replay unknowns, wrong types, bounds, duplicates, and absent tasks", () => {
    const registry = durationRegistry([durationEntry("@chase-sets/fast", "test", 12)]);
    const validObservation = {
      runId: 1,
      runAttempt: 1,
      jobId: 2,
      invocation: "test--exclude-test-profile=db",
      workspace: "@chase-sets/fast",
      script: "test",
      observedDurationMs: 1000,
    };
    const fixture = (observations) => ({
      schemaVersion: "workspace-unit-duration-replay/v1",
      observations,
    });
    const invalidFixtures = [
      null,
      { ...fixture([validObservation]), unknown: true },
      { ...fixture([validObservation]), schemaVersion: 1 },
      { ...fixture([validObservation]), observations: {} },
      fixture([]),
      fixture(Array.from({ length: 129 }, (_, index) => ({ ...validObservation, runId: index + 1 }))),
      fixture([null]),
      fixture([{ ...validObservation, unknown: true }]),
      fixture([{ ...validObservation, runId: 0 }]),
      fixture([{ ...validObservation, runId: 1.5 }]),
      fixture([{ ...validObservation, runId: Number.MAX_SAFE_INTEGER + 1 }]),
      fixture([{ ...validObservation, runAttempt: 101 }]),
      fixture([{ ...validObservation, jobId: "2" }]),
      fixture([{ ...validObservation, invocation: 1 }]),
      fixture([{ ...validObservation, invocation: "test" }]),
      fixture([{ ...validObservation, workspace: 1 }]),
      fixture([{ ...validObservation, workspace: "fast" }]),
      fixture([{ ...validObservation, script: 1 }]),
      fixture([{ ...validObservation, script: "test:unit" }]),
      fixture([{ ...validObservation, observedDurationMs: "1000" }]),
      fixture([{ ...validObservation, observedDurationMs: -1 }]),
      fixture([{ ...validObservation, observedDurationMs: 600_001 }]),
      fixture([validObservation, validObservation]),
      fixture([{ ...validObservation, workspace: "@chase-sets/absent" }]),
    ];

    for (const invalidFixture of invalidFixtures) {
      expect(() => validateWorkspaceDurationReplay(invalidFixture, registry)).toThrow();
    }
  });

  it("orders real-shaped skew by unhinted, duration descending, and workspace ascending without changing identity or concurrency", async () => {
    const workspaces = [
      workspace("@chase-sets/delta", { test: "test" }),
      workspace("@chase-sets/alpha", { test: "test" }),
      workspace("@chase-sets/echo", { test: "test" }),
      workspace("@chase-sets/bravo", { test: "test" }),
      workspace("@chase-sets/charlie", { test: "test" }),
    ];
    const registry = durationRegistry([
      durationEntry("@chase-sets/delta", "test", 10),
      durationEntry("@chase-sets/alpha", "test", 20),
      durationEntry("@chase-sets/bravo", "test", 20),
    ]);
    const dispatchOrder = [];
    let active = 0;
    let peakActive = 0;

    const { stdout, stderr } = await captureConsole(() =>
      runWorkspaceScripts({
        argv: ["test", "--exclude-test-profile=db", "--concurrency=2", "--", "--coverage"],
        buildInvocation,
        durationHintRegistry: registry,
        listWorkspaces: () => workspaces,
        loadEnvironment: () => {},
        run: async (_command, args) => {
          dispatchOrder.push(args[1]);
          expect(args.at(-1)).toBe("--coverage");
          active += 1;
          peakActive = Math.max(peakActive, active);
          await delay(2);
          active -= 1;
        },
      }),
    );

    expect(dispatchOrder).toEqual([
      "@chase-sets/charlie",
      "@chase-sets/echo",
      "@chase-sets/alpha",
      "@chase-sets/bravo",
      "@chase-sets/delta",
    ]);
    expect(peakActive).toBeLessThanOrEqual(2);
    expect(new Set(dispatchOrder)).toEqual(new Set(workspaces.map(({ name }) => name)));
    expect(stderr).toEqual([
      "Warning: missing duration hints for @chase-sets/charlie, @chase-sets/echo; using the largest registered duration as fallback.",
    ]);

    const summaryLines = stdout.filter((line) => line.startsWith("RUN_WORKSPACES_SUMMARY "));
    expect(summaryLines).toHaveLength(1);
    const summary = JSON.parse(summaryLines[0].slice("RUN_WORKSPACES_SUMMARY ".length));
    expect(Object.keys(summary)).toEqual([
      "schemaVersion",
      "scriptName",
      "concurrency",
      "eligibleCount",
      "completedCount",
      "passedCount",
      "failedCount",
      "elapsedMs",
      "unhintedTasks",
      "tasks",
    ]);
    expect(validateRunWorkspacesSummary(summary)).toBe(summary);
    expect(summary.tasks.map((task) => [task.workspace, task.estimatedDurationSeconds, task.usedFallback])).toEqual([
      ["@chase-sets/charlie", 20, true],
      ["@chase-sets/echo", 20, true],
      ["@chase-sets/alpha", 20, false],
      ["@chase-sets/bravo", 20, false],
      ["@chase-sets/delta", 10, false],
    ]);
    expect(stdout.at(-1)).toBe(summaryLines[0]);
  });

  it("keeps every noneligible invocation FIFO and emits no duration summary", async () => {
    const cases = [
      ["build", "--concurrency=2"],
      ["test:db", "--concurrency=2"],
      ["test", "--test-profile=db", "--concurrency=2"],
      ["test", "--exclude-test-profile=other", "--concurrency=2"],
      ["test:unit", "--concurrency=2"],
      ["test:unit", "--test-profile=other", "--concurrency=2"],
    ];

    for (const argv of cases) {
      const scriptName = argv[0];
      const profileArgument = argv.find((argument) => argument.startsWith("--test-profile="));
      const testProfile = profileArgument?.slice("--test-profile=".length);
      const workspaces = [
        workspace("@test/z", { [scriptName]: scriptName }, testProfile),
        workspace("@test/a", { [scriptName]: scriptName }, testProfile),
        workspace("@test/m", { [scriptName]: scriptName }, testProfile),
      ];
      const starts = [];
      const { stdout } = await captureConsole(() =>
        runWorkspaceScripts({
          argv,
          buildInvocation,
          durationHintRegistry: { invalid: true },
          listWorkspaces: () => workspaces,
          loadEnvironment: () => {},
          run: async (_command, args) => {
            starts.push(args[1]);
            await delay(1);
          },
        }),
      );

      expect(starts).toEqual(workspaces.map(({ name }) => name));
      expect(stdout.some((line) => line.startsWith("RUN_WORKSPACES_SUMMARY "))).toBe(false);
    }
  });

  it("emits the closed terminal summary on aggregate failure without changing failure semantics", async () => {
    const workspaces = [
      workspace("@chase-sets/alpha", { "test:unit": "test:unit" }, "db"),
      workspace("@chase-sets/bravo", { "test:unit": "test:unit" }, "db"),
    ];
    const registry = durationRegistry([
      durationEntry("@chase-sets/alpha", "test:unit", 2),
      durationEntry("@chase-sets/bravo", "test:unit", 1),
    ]);

    const { stdout, stderr } = await captureConsole(async () => {
      await expect(
        runWorkspaceScripts({
          argv: ["test:unit", "--test-profile=db", "--concurrency=2"],
          buildInvocation,
          durationHintRegistry: registry,
          listWorkspaces: () => workspaces,
          loadEnvironment: () => {},
          run: async (_command, args) => {
            if (args[1] === "@chase-sets/bravo") {
              throw new Error("boom");
            }
          },
        }),
      ).rejects.toThrow("1 workspace script run(s) failed.");
    });

    const summaryLine = stdout.at(-1);
    expect(summaryLine.startsWith("RUN_WORKSPACES_SUMMARY ")).toBe(true);
    const summary = JSON.parse(summaryLine.slice("RUN_WORKSPACES_SUMMARY ".length));
    expect(summary).toMatchObject({
      eligibleCount: 2,
      completedCount: 2,
      passedCount: 1,
      failedCount: 1,
    });
    expect(summary.tasks.map((task) => task.outcome)).toEqual(["passed", "failed"]);
    expect(stderr.join("\n")).toContain("Failed workspaces: @chase-sets/bravo");
    expect(validateRunWorkspacesSummary(summary)).toBe(summary);
  });

  it("emits a valid zero-eligible summary and one compact GitHub table without leaking args or environment", async () => {
    const registry = durationRegistry([durationEntry("@chase-sets/alpha", "test", 2)]);
    const appended = [];
    const secret = "must-not-appear";

    const { stdout } = await captureConsole(() =>
      runWorkspaceScripts({
        argv: ["test", "--exclude-test-profile=db", "--workspace-list=@chase-sets/missing", "--", `--token=${secret}`],
        appendSummary: (...args) => appended.push(args),
        buildInvocation,
        durationHintRegistry: registry,
        env: { GITHUB_STEP_SUMMARY: "summary.md", SECRET_VALUE: secret },
        listWorkspaces: () => [workspace("@chase-sets/alpha", { test: "test" })],
        loadEnvironment: () => {},
        run: async () => {
          throw new Error("must not run");
        },
      }),
    );

    const summaryLine = stdout.at(-1);
    const summary = JSON.parse(summaryLine.slice("RUN_WORKSPACES_SUMMARY ".length));
    expect(summary).toMatchObject({
      eligibleCount: 0,
      completedCount: 0,
      passedCount: 0,
      failedCount: 0,
      unhintedTasks: [],
      tasks: [],
    });
    expect(validateRunWorkspacesSummary(summary)).toBe(summary);
    expect(appended).toHaveLength(1);
    expect(appended[0][0]).toBe("summary.md");
    expect(appended[0][1]).toContain("| Workspace | Script | Estimated seconds | Fallback | Actual ms | Outcome |");
    expect(appended[0][1]).not.toContain(secret);
    expect(summaryLine).not.toContain(secret);
  });

  it("rejects closed summary unknowns, wrong types, bounds, and broken equations", () => {
    const validSummary = {
      schemaVersion: "run-workspaces-summary/v1",
      scriptName: "test",
      concurrency: 1,
      eligibleCount: 1,
      completedCount: 1,
      passedCount: 1,
      failedCount: 0,
      elapsedMs: 1,
      unhintedTasks: [],
      tasks: [
        {
          workspace: "@chase-sets/alpha",
          script: "test",
          estimatedDurationSeconds: 1,
          usedFallback: false,
          actualDurationMs: 1,
          outcome: "passed",
        },
      ],
    };
    const invalidSummaries = [
      { ...validSummary, unknown: true },
      {
        scriptName: validSummary.scriptName,
        schemaVersion: validSummary.schemaVersion,
        concurrency: validSummary.concurrency,
        eligibleCount: validSummary.eligibleCount,
        completedCount: validSummary.completedCount,
        passedCount: validSummary.passedCount,
        failedCount: validSummary.failedCount,
        elapsedMs: validSummary.elapsedMs,
        unhintedTasks: validSummary.unhintedTasks,
        tasks: validSummary.tasks,
      },
      { ...validSummary, concurrency: 65 },
      { ...validSummary, eligibleCount: 257 },
      { ...validSummary, eligibleCount: "1" },
      { ...validSummary, completedCount: 0 },
      { ...validSummary, elapsedMs: 86_400_001 },
      { ...validSummary, unhintedTasks: [{ workspace: "@chase-sets/alpha", script: "test", unknown: true }] },
      { ...validSummary, tasks: [{ ...validSummary.tasks[0], unknown: true }] },
      { ...validSummary, tasks: [{ ...validSummary.tasks[0], usedFallback: "false" }] },
      { ...validSummary, tasks: [{ ...validSummary.tasks[0], actualDurationMs: 600_001 }] },
      { ...validSummary, tasks: [{ ...validSummary.tasks[0], outcome: "skipped" }] },
    ];

    expect(validateRunWorkspacesSummary(validSummary)).toBe(validSummary);
    for (const summary of invalidSummaries) {
      expect(() => validateRunWorkspacesSummary(summary)).toThrow();
    }
  });

  it("replays the two authoritative attempt-one jobs at exact FIFO and LPT phase makespans", () => {
    const replay = readJson(replayPath);
    const observedPhaseBoundaries = new Map([
      [
        "30054895589\u000089364607063\u0000test--exclude-test-profile=db",
        ["2026-07-24T00:01:50.5694948Z", "2026-07-24T00:04:03.6692643Z"],
      ],
      [
        "30054895589\u000089364607063\u0000test:unit--test-profile=db",
        ["2026-07-24T00:04:03.7974100Z", "2026-07-24T00:09:38.6839751Z"],
      ],
      [
        "30060154233\u000089380059115\u0000test--exclude-test-profile=db",
        ["2026-07-24T01:54:01.9353929Z", "2026-07-24T01:55:22.4205650Z"],
      ],
      [
        "30060154233\u000089380059115\u0000test:unit--test-profile=db",
        ["2026-07-24T01:55:22.5641532Z", "2026-07-24T02:00:56.8796117Z"],
      ],
    ]);
    const phases = new Map();
    for (const observation of replay.observations) {
      expect(observation.runAttempt).toBe(1);
      const key = `${observation.runId}\0${observation.jobId}\0${observation.invocation}`;
      const phase = phases.get(key) ?? [];
      phase.push(observation.observedDurationMs);
      phases.set(key, phase);
    }

    const makespan = (durations) => {
      const lanes = [0, 0, 0, 0];
      for (const duration of durations) {
        let earliestLane = 0;
        for (let index = 1; index < lanes.length; index += 1) {
          if (lanes[index] < lanes[earliestLane]) {
            earliestLane = index;
          }
        }
        lanes[earliestLane] += duration;
      }
      return Math.max(...lanes);
    };
    const roundToNearestHundredMs = (durationMs) => Math.round(durationMs / 100) * 100;
    const fifoMs = [...observedPhaseBoundaries.values()].reduce(
      (total, [startedAt, completedAt]) =>
        total + roundToNearestHundredMs(Date.parse(completedAt) - Date.parse(startedAt)),
      0,
    );
    const lptMs = roundToNearestHundredMs(
      [...phases.values()].reduce(
        (total, durations) => total + makespan(durations.toSorted((left, right) => right - left)),
        0,
      ),
    );
    const reduction = (((fifoMs - lptMs) / fifoMs) * 100).toFixed(1);

    expect([...phases.keys()]).toEqual([
      "30054895589\u000089364607063\u0000test--exclude-test-profile=db",
      "30054895589\u000089364607063\u0000test:unit--test-profile=db",
      "30060154233\u000089380059115\u0000test--exclude-test-profile=db",
      "30060154233\u000089380059115\u0000test:unit--test-profile=db",
    ]);
    expect([...phases.keys()]).toEqual([...observedPhaseBoundaries.keys()]);
    expect(fifoMs).toBe(882_800);
    expect(lptMs).toBe(793_000);
    expect(reduction).toBe("10.2");
  });
});
