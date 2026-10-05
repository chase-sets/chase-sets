import { setTimeout as delay } from "node:timers/promises";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";
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

async function captureDbRun({ workspaces, registry, run = async () => {}, now = () => 0, argv = [], readDbBaseline }) {
  const invocations = [];
  const appended = [];
  const output = await captureConsole(() =>
    runWorkspaceScripts({
      argv: [DB_TEST_SCRIPT_SELECTOR, ...argv],
      buildInvocation,
      durationHintRegistry: registry,
      listWorkspaces: () => workspaces,
      loadEnvironment: () => {},
      env: { GITHUB_STEP_SUMMARY: "summary.md" },
      appendSummary: (...args) => appended.push(args),
      now,
      readDbBaseline,
      run: async (_command, args, options) => {
        invocations.push(args);
        await run(args, options);
      },
    }).catch((error) => error),
  );
  const lines = output.stdout.filter((line) => line.startsWith("RUN_WORKSPACES_SUMMARY "));
  expect(lines).toHaveLength(1);
  const summary = JSON.parse(lines[0].slice("RUN_WORKSPACES_SUMMARY ".length));
  expect(validateRunWorkspacesSummary(summary)).toBe(summary);
  expect(appended).toHaveLength(1);
  return { ...output, summary, appended, invocations };
}

describe("DB duration drift annotation", () => {
  it("DB drift annotation never changes exit status", async () => {
    const name = "@chase-sets/synthetic-db";
    const other = "@chase-sets/new-db";
    const empty = { schemaVersion: "db-duration-baseline/v1", recomputes: [] };
    const baseline = {
      ...empty,
      recomputes: [
        {
          recomputedAt: "2026-10-05T00:00:00Z",
          sampleJobIds: Array.from({ length: 20 }, (_, i) => i + 1),
          workspaces: { [name]: 240000 },
          jobWallMs: 240000,
          cause: "initial (#6660 split)",
        },
      ],
    };
    for (const failure of [false, true]) {
      for (const mode of ["empty", "valid", "unreadable", "malformed"]) {
        for (const elapsed of [299999, 300000, 300001]) {
          let clock = 0;
          const result = await captureDbRun({
            workspaces: [
              workspace(name, { "test:db": "vitest" }, "db"),
              workspace(other, { "test:db": "vitest" }, "db"),
            ],
            registry: durationRegistry([durationEntry(name, "test:db", 240)]),
            now: () => clock,
            readDbBaseline: () => {
              if (mode === "unreadable") throw new Error("EACCES");
              return mode === "valid" ? baseline : mode === "empty" ? empty : {};
            },
            run: async () => {
              clock += elapsed;
              if (failure) throw new Error("original failure");
            },
          });
          expect(result.result instanceof Error).toBe(failure);
          if (failure) expect(result.result.message).toContain("workspace script run(s) failed");
          const warnings = result.stdout.filter((line) => line.startsWith("::warning title=DB duration drift::"));
          expect(warnings).toEqual(
            mode === "valid" && elapsed > 300000
              ? [
                  `::warning title=DB duration drift::${name} test:db 300001 ms > drift bound 300000 ms (ratified 240000 ms)`,
                ]
              : [],
          );
          const unbaselined = result.stdout.filter((line) => line.includes("unbaselined:"));
          expect(unbaselined).toEqual(
            mode === "empty"
              ? [`DB duration drift: unbaselined: ${other}, ${name}`]
              : mode === "valid"
                ? [`DB duration drift: unbaselined: ${other}`]
                : [],
          );
          if (["unreadable", "malformed"].includes(mode))
            expect(result.stderr.some((line) => line.includes("unknown baseline"))).toBe(true);
        }
      }
    }
  });

  it("does not read the DB baseline for non-DB invocations", async () => {
    await captureConsole(() =>
      runWorkspaceScripts({
        argv: ["lint"],
        listWorkspaces: () => [],
        run: async () => {},
        readDbBaseline: () => {
          throw new Error("must not read");
        },
      }),
    );
  });
});

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
      durationHintRegistry: durationRegistry([
        durationEntry("@chase-sets/partitioned", "test:db", 10),
        durationEntry("@chase-sets/ordinary", "test:db", 1),
      ]),
      listWorkspaces: () => [
        workspace(
          "@chase-sets/partitioned",
          {
            "test:db": "aggregate",
            "test:db:1": "partition one",
            "test:db:2": "partition two",
          },
          "db",
        ),
        workspace("@chase-sets/ordinary", { "test:db": "ordinary" }, "db"),
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
    expect(maxActiveByWorkspace.get("@chase-sets/partitioned")).toBe(1);
    expect(runs.filter(({ workspaceName }) => workspaceName === "@chase-sets/partitioned")).toEqual([
      { workspaceName: "@chase-sets/partitioned", scriptName: "test:db:1" },
      { workspaceName: "@chase-sets/partitioned", scriptName: "test:db:2" },
    ]);
    expect(runs).toContainEqual({ workspaceName: "@chase-sets/ordinary", scriptName: "test:db" });
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

describe("DB duration scheduling", () => {
  it.each(
    [
      [],
      ["--workspace=@chase-sets/app-platform-api"],
      ["--workspace=@chase-sets/marketplace-seed-testing"],
      ["--workspace=@chase-sets/not-present"],
    ].map((scope) => [scope]),
  )("partitions the actual eligible census without overlap or empty-to-all fallback: %j", async (scope) => {
    const workspaces = listWorkspacePackages();
    const registry = readJson("scripts/workspace-test-duration-hints-v1.json");
    const run = (group) =>
      captureDbRun({
        workspaces,
        registry,
        argv: ["--concurrency=2", ...scope, ...(group ? [`--db-workspace-group=${group}`] : [])],
      });
    const whole = await run();
    const api = await run("api");
    const other = await run("other");
    const calls = (output) => output.invocations.map((args) => `${args[1]} ${args[3]}`).sort();
    expect([...calls(api), ...calls(other)].sort()).toEqual(calls(whole));
    expect(api.invocations.every((args) => args[1] === "@chase-sets/app-platform-api")).toBe(true);
    expect(other.invocations.every((args) => args[1] !== "@chase-sets/app-platform-api")).toBe(true);
    expect(api.summary.eligibleCount + other.summary.eligibleCount).toBe(whole.summary.eligibleCount);
    expect(api.result).toBeUndefined();
    expect(other.result).toBeUndefined();
  });

  it("intersects grouping after profile eligibility", async () => {
    const calls = [];
    await runWorkspaceScripts({
      argv: ["test:db*", "--db-workspace-group=api", "--exclude-test-profile=db"],
      listWorkspaces: () => [workspace("@chase-sets/app-platform-api", { "test:db": "db" }, "db")],
      loadEnvironment: () => {},
      run: async (...args) => calls.push(args),
    });
    expect(calls).toEqual([]);
  });

  it.each(["api", "other"])(
    "preserves serial partitions, deadlines, failures and future enrollment in %s",
    async (group) => {
      const api = workspace("@chase-sets/app-platform-api", { "test:db:1": "one", "test:db:2": "two" }, "db");
      const future = workspace("@chase-sets/future-db", { "test:db:1": "one", "test:db:2": "two" }, "db");
      const registered = workspace("@chase-sets/registered-db", { "test:db": "db" }, "db");
      let active = 0;
      let peak = 0;
      const output = await captureDbRun({
        workspaces: [api, future, registered],
        registry: durationRegistry([durationEntry(registered.name, "test:db", 1)]),
        argv: ["--concurrency=2", `--db-workspace-group=${group}`],
        run: async (args, options) => {
          expect(options.timeoutMs).toBe(600_000);
          peak = Math.max(peak, ++active);
          await delay(0);
          active--;
          if (args[3] === "test:db:2") throw new Error("synthetic second-unit failure");
        },
      });
      expect(peak).toBe(group === "api" ? 1 : 2);
      expect(output.result).toBeInstanceOf(Error);
      expect(output.summary.failedCount).toBe(1);
      expect(
        output.invocations
          .filter((args) => args[1] === (group === "api" ? api.name : future.name))
          .map((args) => args[3]),
      ).toEqual(["test:db:1", "test:db:2"]);
    },
  );

  it.each([
    ["test", "--db-workspace-group=api"],
    ["test:db", "--db-workspace-group=api"],
    ["test:db:1", "--db-workspace-group=other"],
    ["test:db*", "--db-workspace-group=unknown"],
    ["test:db*", "--db-workspace-group"],
    ["test:db*", "--db-workspace-group="],
    ["test:db*", "--db-workspace-group=api", "--db-workspace-group=api"],
    ["test:db*", "--db-workspace-group=api", "--db-workspace-group=other"],
  ])("rejects noncanonical group arguments before loading or execution: %j", async (...argv) => {
    const unexpected = () => {
      throw new Error("must not execute");
    };
    await expect(
      runWorkspaceScripts({ argv, loadEnvironment: unexpected, listWorkspaces: unexpected, run: unexpected }),
    ).rejects.toThrow("--db-workspace-group");
  });

  const db = workspace("@chase-sets/db", { "test:db": "aggregate", "test:db:2": "two", "test:db:1": "one" }, "db");
  const registry = durationRegistry([durationEntry(db.name, "test:db", 2)]);

  it.each([
    ["API first", 927, 346, undefined, "api"],
    ["seed first", 346, 927, undefined, "seed"],
    ["unhinted API", undefined, 346, undefined, "api"],
    ["unhinted seed", 927, undefined, undefined, "seed"],
    ["both unhinted", undefined, undefined, undefined, "api"],
    ["failed API first partition", 927, 346, "test:db:1", "api"],
    ["failed API second partition", 927, 346, "test:db:2", "api"],
    ["failed seed", 346, 927, "test:db", "seed"],
  ])(
    "excludes seed/API DB overlap with %s while filling unrelated slots",
    async (_label, apiHint, seedHint, failure, firstName) => {
      const api = workspace(
        "@chase-sets/app-platform-api",
        { "test:db": "aggregate", "test:db:1": "one", "test:db:2": "two" },
        "db",
      );
      const seed = workspace("@chase-sets/marketplace-seed-testing", { "test:db": "seed" }, "db");
      const peers = ["other-one", "other-two"].map((name) =>
        workspace(`@chase-sets/${name}`, { "test:db": "db" }, "db"),
      );
      const first = firstName === "api" ? api : seed;
      const held = Promise.withResolvers();
      const peersFinished = Promise.withResolvers();
      const active = new Set();
      const overlaps = [];
      const starts = [];
      let maxActive = 0;
      let completedPeers = 0;
      const outputPromise = captureDbRun({
        workspaces: [seed, ...peers, api],
        registry: durationRegistry([
          ...[durationEntry(api.name, "test:db", apiHint), durationEntry(seed.name, "test:db", seedHint)].filter(
            (entry) => entry.estimatedDurationSeconds !== undefined,
          ),
          ...peers.map((peer) => durationEntry(peer.name, "test:db", 1)),
        ]),
        argv: ["--concurrency=2"],
        run: async (args, options) => {
          const [, name, , script] = args;
          starts.push([name, script]);
          active.add(name);
          maxActive = Math.max(maxActive, active.size);
          if (active.has(api.name) && active.has(seed.name)) overlaps.push([name, script]);
          try {
            expect(options.timeoutMs).toBe(600_000);
            if (name === first.name) await held.promise;
            if (name === first.name && script === failure) throw new Error("synthetic DB failure");
          } finally {
            active.delete(name);
            if (peers.some((peer) => peer.name === name) && ++completedPeers === peers.length) peersFinished.resolve();
          }
        },
      });
      // Keep the first DB owner active after every unrelated task has drained.
      // The idle worker must wait, then wake on either success or failure.
      await peersFinished.promise;
      await delay(0);
      const startsWhileHeld = starts.slice();
      held.resolve();
      const output = await outputPromise;

      expect(overlaps).toEqual([]);
      expect(maxActive).toBe(2);
      expect(startsWhileHeld.map(([name]) => name)).toEqual([first.name, ...peers.map((peer) => peer.name)]);
      expect(output.result instanceof Error).toBe(failure !== undefined);
      expect(output.summary).toMatchObject({ eligibleCount: 4, completedCount: 4, failedCount: failure ? 1 : 0 });
      expect(output.summary.tasks.map((task) => task.workspace).sort()).toEqual(
        [api, seed, ...peers].map((task) => task.name).sort(),
      );
      expect(starts.filter(([name]) => name === api.name).map(([, script]) => script)).toEqual(
        failure === "test:db:1" ? ["test:db:1"] : ["test:db:1", "test:db:2"],
      );
      expect(starts.filter(([name]) => name === seed.name)).toEqual([[seed.name, "test:db"]]);
      if (failure) {
        expect(output.result.message).toBe("1 workspace script run(s) failed.");
        expect(output.stderr.join("\n")).toContain("synthetic DB failure");
        expect(output.summary.tasks.find((task) => task.workspace === first.name).outcome).toBe("failed");
      }
    },
  );

  it.each(["test:db", "test:db:1", "test:unit", "test", "build"])(
    "limits exclusion to DB commands for exact selector %s",
    async (script) => {
      const active = new Set();
      let maxActive = 0;
      const names = ["@chase-sets/marketplace-seed-testing", "@chase-sets/app-platform-api"];
      const invocations = [];
      await runWorkspaceScripts({
        argv: [script, "--concurrency=4"],
        buildInvocation,
        listWorkspaces: () => names.map((name) => workspace(name, { [script]: "command" }, "db")),
        loadEnvironment: () => {},
        run: async (_command, args) => {
          invocations.push(args[1]);
          active.add(args[1]);
          maxActive = Math.max(maxActive, active.size);
          await delay(0);
          active.delete(args[1]);
        },
      });
      expect(invocations).toEqual(names);
      expect(maxActive).toBe(script.startsWith("test:db") ? 1 : 2);
    },
  );

  it("retains the real DB sweep membership and invokes seed and API partitions only", async () => {
    const workspaces = listWorkspacePackages();
    const output = await captureDbRun({
      workspaces,
      registry: readJson("scripts/workspace-test-duration-hints-v1.json"),
      argv: ["--concurrency=2"],
    });
    const eligible = workspaces.filter((entry) => typeof entry.packageJson.scripts?.["test:db"] === "string");
    expect(output.result).toBeUndefined();
    expect(output.summary.tasks.map((task) => task.workspace).sort()).toEqual(
      eligible.map((entry) => entry.name).sort(),
    );
    for (const [name, scripts] of [
      ["@chase-sets/marketplace-seed-testing", ["test:db:1", "test:db:2"]],
      ["@chase-sets/app-platform-api", ["test:db:1", "test:db:2"]],
    ]) {
      expect(output.invocations.filter((args) => args[1] === name).map((args) => args[3])).toEqual(scripts);
    }
  });

  it("discovers every seed DB file exactly once through the commands selected by the runner", async () => {
    const seed = listWorkspacePackages().find((entry) => entry.name === "@chase-sets/marketplace-seed-testing");
    const scripts = seed.packageJson.scripts;
    const output = await captureDbRun({
      workspaces: [seed],
      registry: durationRegistry([durationEntry(seed.name, "test:db", 346)]),
    });
    const vitest = await createVitest("test", { root: seed.dir, config: "./tests/vitest.config.mjs", watch: false });
    try {
      const discover = async (command) => {
        const args = command.split(/\s+/);
        expect(args.slice(0, 4)).toEqual(["vitest", "run", "--config", "./tests/vitest.config.mjs"]);
        return (await vitest.globTestSpecifications(args.slice(4))).map((spec) => spec.moduleId).sort();
      };
      const aggregate = await discover(scripts["test:db"]);
      const onDisk = globSync("tests/**/*.test.ts", { cwd: seed.dir })
        .map((file) => path.resolve(seed.dir, file).replaceAll("\\", "/"))
        .sort();
      expect(aggregate).toEqual(onDisk);
      const partitions = await Promise.all(output.invocations.map((args) => discover(scripts[args[3]])));
      const assertCompleteDisjoint = (groups) => expect(groups.flat().sort()).toEqual(aggregate);
      assertCompleteDisjoint(partitions);
      expect(partitions.map((files) => files.length)).toEqual([1, 3]);
      const omittedFile = await discover(scripts["test:db:2"].split(/\s+/).slice(0, -1).join(" "));
      expect(() => assertCompleteDisjoint([partitions[0], omittedFile])).toThrow();
      expect(() => assertCompleteDisjoint([...partitions, partitions[0]])).toThrow();
    } finally {
      await vitest.close();
    }
  });

  it("keeps all real API DB entries in the API cell and out of unit and fast discovery", async () => {
    const api = listWorkspacePackages().find((entry) => entry.name === "@chase-sets/app-platform-api");
    const scripts = api.packageJson.scripts;
    const output = await captureDbRun({
      workspaces: [api],
      registry: durationRegistry([durationEntry(api.name, "test:db", 1)]),
      argv: ["--db-workspace-group=api"],
    });
    const onDisk = globSync("__tests__/**/*.db.test.ts", { cwd: api.dir })
      .map((file) => path.resolve(api.dir, file).replaceAll("\\", "/"))
      .sort();
    const vitest = await createVitest("test", { root: api.dir, config: "./vitest.config.ts", watch: false });
    try {
      const groups = [];
      for (const args of output.invocations) {
        const parts = scripts[args[3]].split(" && ");
        expect(parts[0]).toBe("node ./scripts/check-bootstrap-db-enrollment.mjs");
        expect(parts[1]).toContain("--maxWorkers=3");
        const filters = parts[1].split(/\s+/).filter((arg) => arg.startsWith("__tests__/"));
        groups.push((await vitest.globTestSpecifications(filters)).map((spec) => spec.moduleId));
      }
      expect(groups.flat().sort()).toEqual(onDisk);
      expect(groups.map((files) => files.length)).toEqual([7, 9]);
      expect(groups[1].filter((file) => file.includes("/operator-session/"))).toHaveLength(5);
      for (const name of ["test:unit", "test:fast"]) {
        const exclude = [...scripts[name].matchAll(/--exclude\s+(\S+)/g)].map((match) => match[1]);
        const unit = await createVitest("test", { root: api.dir, config: "./vitest.config.ts", watch: false, exclude });
        try {
          const discovered = (await unit.globTestSpecifications()).map((spec) => spec.moduleId);
          expect(discovered.length).toBeGreaterThan(0);
          expect(discovered.filter((file) => onDisk.includes(file))).toEqual([]);
        } finally {
          await unit.close();
        }
      }
    } finally {
      await vitest.close();
    }
  });

  it("DB selector preserves LPT order and serialized partition invocations", async () => {
    const candidates = [
      workspace("@chase-sets/z-short", { "test:db": "db" }, "db"),
      db,
      workspace("@chase-sets/b-tie", { "test:db": "db" }, "db"),
      workspace("@chase-sets/a-tie", { "test:db": "db" }, "db"),
      workspace("@chase-sets/unhinted", { "test:db": "db" }),
    ];
    const entries = candidates
      .slice(0, 4)
      .map((candidate) => durationEntry(candidate.name, "test:db", candidate === db ? 3 : 1));
    const { invocations, summary } = await captureDbRun({
      workspaces: candidates,
      registry: durationRegistry(entries),
    });
    expect(invocations).toEqual([
      ["--filter", "@chase-sets/unhinted", "run", "test:db"],
      ["--filter", db.name, "run", "test:db:1"],
      ["--filter", db.name, "run", "test:db:2"],
      ["--filter", "@chase-sets/a-tie", "run", "test:db"],
      ["--filter", "@chase-sets/b-tie", "run", "test:db"],
      ["--filter", "@chase-sets/z-short", "run", "test:db"],
    ]);
    expect(summary.tasks.map((task) => [task.workspace, task.estimatedDurationSeconds, task.usedFallback])).toEqual([
      ["@chase-sets/unhinted", 3, true],
      [db.name, 3, false],
      ["@chase-sets/a-tie", 1, false],
      ["@chase-sets/b-tie", 1, false],
      ["@chase-sets/z-short", 1, false],
    ]);
  });

  it("DB summary normalizes script and excludes scriptless workspaces", async () => {
    for (const failed of [false, true]) {
      let clock = 0;
      const output = await captureDbRun({
        workspaces: [db, workspace("@chase-sets/scriptless", { "test:unit": "unit" }, "db")],
        registry,
        now: () => clock,
        run: async () => {
          clock += 100;
          if (failed) throw new Error("synthetic failure");
        },
      });
      expect(output.result instanceof Error).toBe(failed);
      if (failed) expect(output.result.message).toBe("1 workspace script run(s) failed.");
      expect(output.summary).toMatchObject({
        scriptName: "test:db",
        eligibleCount: 1,
        completedCount: 1,
        passedCount: failed ? 0 : 1,
        failedCount: failed ? 1 : 0,
        tasks: [{ workspace: db.name, script: "test:db", actualDurationMs: failed ? 100 : 200 }],
      });
      expect(output.appended[0][1]).toContain(
        `| ${db.name} | test:db | 2 | no | ${failed ? 100 : 200} | ${failed ? "failed" : "passed"} |`,
      );
      expect(output.appended[0][1]).not.toContain("scriptless");
      expect(output.invocations.map((args) => args[3])).toEqual(failed ? ["test:db:1"] : ["test:db:1", "test:db:2"]);
    }
    const empty = await captureDbRun({ workspaces: [db], registry, argv: ["--workspace=@chase-sets/absent"] });
    expect(empty.summary.tasks).toEqual([]);
  });

  it("DB summary records serialized duration beyond one command ceiling", async () => {
    for (const [duration, recorded] of [
      [600_001, 600_001],
      [3_600_000, 3_600_000],
      [3_600_001, 3_600_000],
    ]) {
      let clock = 0;
      const output = await captureDbRun({
        workspaces: [db],
        registry,
        now: () => clock,
        run: async (_args, options) => {
          expect(options.timeoutMs).toBe(600_000);
          clock += duration / 2;
        },
      });
      expect(output.summary.schemaVersion).toBe("run-workspaces-summary/v1");
      expect(output.summary.tasks[0].actualDurationMs).toBe(recorded);
      for (const invalid of [-1, 1.5, "600001", Infinity, 3_600_001]) {
        const mutant = structuredClone(output.summary);
        mutant.tasks[0].actualDurationMs = invalid;
        expect(() => validateRunWorkspacesSummary(mutant)).toThrow();
      }
    }
  });

  it("DB hint and summary admission stays closed", async () => {
    expect(validateDurationHintRegistry(registry, [db])).toBe(registry);
    const invalidRegistries = [
      { ...registry, unknown: true },
      durationRegistry([{ ...registry.entries[0], unknown: true }]),
      durationRegistry([registry.entries[0], registry.entries[0]]),
      ...[DB_TEST_SCRIPT_SELECTOR, "test:db:1", "build"].map((script) =>
        durationRegistry([durationEntry(db.name, script, 2)]),
      ),
      durationRegistry([durationEntry("@chase-sets/absent", "test:db", 2)]),
      ...[0, 3601, 1.5, Infinity, "2"].map((value) => durationRegistry([durationEntry(db.name, "test:db", value)])),
    ];
    for (const invalid of invalidRegistries) expect(() => validateDurationHintRegistry(invalid, [db])).toThrow();
    expect(() => validateDurationHintRegistry(registry, [workspace(db.name, {}, "db")])).toThrow("absent script");
    expect(() => validateDurationHintRegistry(registry, [workspace(db.name, { "test:db": "db" })])).toThrow("obsolete");
    const { summary } = await captureDbRun({ workspaces: [db], registry });
    const invalidSummaries = [
      { ...summary, unknown: true },
      { ...summary, scriptName: DB_TEST_SCRIPT_SELECTOR },
      { ...summary, tasks: [{ ...summary.tasks[0], script: "test" }] },
      { ...summary, tasks: [{ ...summary.tasks[0], script: DB_TEST_SCRIPT_SELECTOR }] },
      { ...summary, tasks: [{ ...summary.tasks[0], unknown: true }] },
      { ...summary, unhintedTasks: [{ workspace: db.name, script: "test:db", unknown: true }] },
      { ...summary, unhintedTasks: [{ workspace: db.name, script: DB_TEST_SCRIPT_SELECTOR }] },
      { ...summary, tasks: [{ ...summary.tasks[0], actualDurationMs: 3_600_001 }] },
      { ...summary, tasks: [{ ...summary.tasks[0], estimatedDurationSeconds: 3601 }] },
    ];
    for (const invalid of invalidSummaries) expect(() => validateRunWorkspacesSummary(invalid)).toThrow();
  });

  it("DB registry accepts what replay refuses", () => {
    expect(validateDurationHintRegistry(registry, [db])).toBe(registry);
    const observation = {
      runId: 1,
      runAttempt: 1,
      jobId: 2,
      invocation: "test--exclude-test-profile=db",
      workspace: db.name,
      script: "test",
      observedDurationMs: 1,
    };
    const fixture = { schemaVersion: "workspace-unit-duration-replay/v1", observations: [observation] };
    expect(validateWorkspaceDurationReplay(fixture)).toBe(fixture);
    expect(() =>
      validateWorkspaceDurationReplay({ ...fixture, observations: [{ ...observation, script: "test:db" }] }, registry),
    ).toThrow("must be test or test:unit");
    for (const invocation of ["test:db", DB_TEST_SCRIPT_SELECTOR, "test:db--test-profile=db"]) {
      expect(() =>
        validateWorkspaceDurationReplay(
          { ...fixture, observations: [{ ...observation, invocation, script: "test:db" }] },
          registry,
        ),
      ).toThrow("invocation is invalid");
    }
    expect(() =>
      validateWorkspaceDurationReplay({ ...fixture, observations: [{ ...observation, observedDurationMs: 600_001 }] }),
    ).toThrow();
    expect(() =>
      validateDurationHintRegistry(durationRegistry([durationEntry(db.name, "test:db", 3601)]), [db]),
    ).toThrow();
  });

  it("DB scheduling output is not hosted budget evidence", async () => {
    const unhinted = workspace("@chase-sets/unhinted", { "test:db": "db" });
    const unit = workspace("@chase-sets/unit", { test: "test" });
    const output = await captureDbRun({
      workspaces: [db, unhinted, unit],
      registry: durationRegistry([...registry.entries, durationEntry(unit.name, "test", 927)]),
    });
    const summary = {
      schemaVersion: "run-workspaces-summary/v1",
      scriptName: "test:db",
      concurrency: 1,
      eligibleCount: 2,
      completedCount: 2,
      passedCount: 2,
      failedCount: 0,
      elapsedMs: 0,
      unhintedTasks: [{ workspace: unhinted.name, script: "test:db" }],
      tasks: [
        {
          workspace: unhinted.name,
          script: "test:db",
          estimatedDurationSeconds: 927,
          usedFallback: true,
          actualDurationMs: 0,
          outcome: "passed",
        },
        {
          workspace: db.name,
          script: "test:db",
          estimatedDurationSeconds: 2,
          usedFallback: false,
          actualDurationMs: 0,
          outcome: "passed",
        },
      ],
    };
    expect(output.stdout).toEqual([
      `Running test:db in ${unhinted.name}...`,
      `Running test:db:1 in ${db.name}...`,
      `Running test:db:2 in ${db.name}...`,
      `DB duration drift: unbaselined: ${unhinted.name}, ${db.name}`,
      `RUN_WORKSPACES_SUMMARY ${JSON.stringify(summary)}`,
    ]);
    expect(output.stderr).toEqual([
      `Warning: missing duration hints for ${unhinted.name}; using the largest registered duration as fallback.`,
    ]);
    expect(output.appended).toEqual([
      [
        "summary.md",
        [
          "Run workspaces summary (run-workspaces-summary/v1): script `test:db`, concurrency 1, elapsed 0ms, 2 passed, 0 failed.",
          "",
          "| Workspace | Script | Estimated seconds | Fallback | Actual ms | Outcome |",
          "| --- | --- | ---: | :---: | ---: | --- |",
          `| ${unhinted.name} | test:db | 927 | yes | 0 | passed |`,
          `| ${db.name} | test:db | 2 | no | 0 | passed |`,
          "",
        ].join("\n"),
        "utf8",
      ],
    ]);
  });

  it("DB hints equal the named hosted sweep", () => {
    // Green merge-group run 36392844721, job 108832742783, attempt 1.
    // Each row records the immutable log line(s) and observed seconds, not lane timings.
    const source = [
      ["app-platform-api", [24616, 42321], [516.11, 410.29]],
      ["app-platform-worker", [999], [30.37]],
      ["auth", [1496], [11.08]],
      ["bounded-context-runtime", [3032], [19.66]],
      ["catalog", [10950], [123.79]],
      ["channels", [20802], [189.07]],
      ["checkout", [22038], [26.03]],
      ["collections", [22163], [4.55]],
      ["customer-feedback", [22385], [3.66]],
      ["discovery", [24665], [104.08]],
      ["event-core-postgres", [24688], [7.34]],
      ["fulfillment", [24832], [12.37]],
      ["identity", [25477], [19.22]],
      ["inventory", [40897], [299.77]],
      ["marketplace", [41754], [25.12]],
      ["marketplace-seed-testing", [45647], [345.7]],
      ["notifications", [42417], [4.73]],
      ["ordering", [42726], [46.94]],
      ["payments", [43140], [23.24]],
      ["platform-operations", [43292], [11.19]],
      ["platform-policy", [43437], [2.48]],
      ["platform-runtime", [43590], [8.56]],
      ["pricing", [45132], [149.6]],
      ["settlement", [45330], [23.14]],
    ];
    const expected = source.map(([name, lines, seconds]) => {
      expect(lines).toHaveLength(seconds.length);
      return durationEntry(`@chase-sets/${name}`, "test:db", Math.ceil(seconds.reduce((sum, value) => sum + value, 0)));
    });
    const candidates = listWorkspacePackages();
    const assertHints = (candidateRegistry) => {
      validateDurationHintRegistry(candidateRegistry, candidates);
      expect(candidateRegistry.entries.filter((entry) => entry.script === "test:db")).toEqual(expected);
      expect(new Set(expected.map((entry) => entry.workspace))).toEqual(
        new Set(
          candidates
            .filter(
              (candidate) =>
                candidate.packageJson.chaseSets?.testProfile === "db" &&
                typeof candidate.packageJson.scripts?.["test:db"] === "string",
            )
            .map((candidate) => candidate.name),
        ),
      );
    };
    const checkedIn = readJson("scripts/workspace-test-duration-hints-v1.json");
    assertHints(checkedIn);
    const mutants = [
      durationRegistry(
        checkedIn.entries.filter((entry) => entry.workspace !== expected[0].workspace || entry.script !== "test:db"),
      ),
      durationRegistry([...checkedIn.entries, durationEntry("@chase-sets/extra", "test:db", 1)]),
      durationRegistry([...checkedIn.entries, durationEntry("@chase-sets/app-admin-web", "test:db", 1)]),
      ...[926.4, 517].map((value) =>
        durationRegistry(
          checkedIn.entries.map((entry) =>
            entry.workspace === expected[0].workspace && entry.script === "test:db"
              ? { ...entry, estimatedDurationSeconds: value }
              : entry,
          ),
        ),
      ),
    ];
    for (const mutant of mutants) expect(() => assertHints(mutant)).toThrow();
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
    const unitEntries = registry.entries.filter((entry) => entry.script !== "test:db");
    const registryKeys = unitEntries.map((entry) => `${entry.workspace}\0${entry.script}`);

    expect(validateDurationHintRegistry(registry, workspaces)).toBe(registry);
    expect(validateWorkspaceDurationReplay(replay, registry)).toBe(replay);
    expect(new Set(registryKeys)).toEqual(new Set(eligibleKeys));
    expect(unitEntries).toHaveLength(65);
    expect(replay.observations).toHaveLength(90);
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
    const registeredEntries = registry.entries
      .filter((entry) => entry.script !== "test:db")
      .toSorted((left, right) => {
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

  it("DB admission preserves selection and summaries while adding DB-only telemetry", async () => {
    const cases = [
      ["build", "--concurrency=2"],
      ["test:db", "--concurrency=2"],
      ["test:db:1", "--concurrency=2"],
      [DB_TEST_SCRIPT_SELECTOR, "--test-profile=db", "--concurrency=2"],
      [DB_TEST_SCRIPT_SELECTOR, "--exclude-test-profile=db", "--concurrency=2"],
      ["test", "--exclude-test-profile=db", "--test-profile=db", "--concurrency=2"],
      ["test:unit", "--test-profile=db", "--exclude-test-profile=db", "--concurrency=2"],
      ["test", "--test-profile=db", "--concurrency=2"],
      ["test", "--exclude-test-profile=other", "--concurrency=2"],
      ["test:unit", "--concurrency=2"],
      ["test:unit", "--test-profile=other", "--concurrency=2"],
    ];

    for (const argv of cases) {
      const scriptName = argv[0];
      const profileArgument = argv.find((argument) => argument.startsWith("--test-profile="));
      const testProfile = profileArgument?.slice("--test-profile=".length);
      const invokedScript = scriptName === DB_TEST_SCRIPT_SELECTOR ? "test:db" : scriptName;
      const workspaces = [
        workspace("@test/z", { [invokedScript]: invokedScript }, testProfile),
        workspace("@test/a", { [invokedScript]: invokedScript }, testProfile),
        workspace("@test/m", { [invokedScript]: invokedScript }, testProfile),
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

      const excluded = argv.includes("--exclude-test-profile=db") && testProfile === "db";
      expect(starts).toEqual(excluded ? [] : workspaces.map(({ name }) => name));
      expect(stdout).toEqual(
        excluded
          ? [`No workspaces matched ${scriptName}.`]
          : [
              ...workspaces.map(({ name }) => `Running ${invokedScript} in ${name}...`),
              ...(scriptName.startsWith("test:db")
                ? ["DB duration drift: unbaselined: @test/z, @test/a, @test/m"]
                : []),
            ],
      );
      expect(stdout.some((line) => line.startsWith("RUN_WORKSPACES_SUMMARY "))).toBe(false);
    }

    for (const [script, filter] of [
      ["test", "--exclude-test-profile=db"],
      ["test:unit", "--test-profile=db"],
    ]) {
      const workspaces = [
        workspace("@chase-sets/short", { [script]: script }, script === "test:unit" ? "db" : undefined),
        workspace("@chase-sets/long", { [script]: script }, script === "test:unit" ? "db" : undefined),
      ];
      const entries = [durationEntry(workspaces[0].name, script, 1), durationEntry(workspaces[1].name, script, 2)];
      const execute = (registry) =>
        captureConsole(() =>
          runWorkspaceScripts({
            argv: [script, filter],
            buildInvocation,
            durationHintRegistry: registry,
            listWorkspaces: () => [...workspaces, workspace("@chase-sets/db", { "test:db": "db" }, "db")],
            loadEnvironment: () => {},
            now: () => 0,
            run: async () => {},
          }),
        );
      const before = await execute(durationRegistry(entries));
      const after = await execute(durationRegistry([...entries, durationEntry("@chase-sets/db", "test:db", 927)]));
      expect(after).toEqual(before);
      expect(after.stdout.slice(0, 2)).toEqual([
        `Running ${script} in @chase-sets/long...`,
        `Running ${script} in @chase-sets/short...`,
      ]);
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
      { ...validSummary, tasks: [{ ...validSummary.tasks[0], actualDurationMs: 3_600_001 }] },
      { ...validSummary, tasks: [{ ...validSummary.tasks[0], outcome: "skipped" }] },
    ];

    expect(validateRunWorkspacesSummary(validSummary)).toBe(validSummary);
    for (const summary of invalidSummaries) {
      expect(() => validateRunWorkspacesSummary(summary)).toThrow();
    }
  });

  it("replays the three authoritative attempt-one jobs at exact FIFO and LPT phase makespans", () => {
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
      [
        "33471778258\u000099742894811\u0000test--exclude-test-profile=db",
        ["2026-09-01T04:58:21.4760028Z", "2026-09-01T05:00:02.8423969Z"],
      ],
    ]);
    const phases = new Map();
    for (const observation of replay.observations) {
      expect(observation.runAttempt).toBe(1);
      const key = `${observation.runId}\0${observation.jobId}\0${observation.invocation}`;
      if (!observedPhaseBoundaries.has(key)) {
        continue;
      }
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
      "33471778258\u000099742894811\u0000test--exclude-test-profile=db",
    ]);
    expect([...phases.keys()]).toEqual([...observedPhaseBoundaries.keys()]);
    expect(fifoMs).toBe(984_200);
    expect(lptMs).toBe(794_800);
    expect(reduction).toBe("19.2");
  });
});
