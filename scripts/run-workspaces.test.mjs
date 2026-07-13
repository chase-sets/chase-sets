import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEST_COMMAND_TIMEOUT_MS,
  loadTestEnvironment,
  parseRunWorkspacesArgs,
  runWorkspaceScripts,
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

  it("respects include and exclude test profiles", async () => {
    const runs = [];
    const workspaces = [
      workspace("@test/fast", { test: "test" }),
      workspace("@test/db", { test: "test" }, "db"),
      workspace("@test/none", { build: "build" }),
    ];

    await runWorkspaceScripts({
      argv: ["test", "--exclude-test-profile=db"],
      buildInvocation,
      listWorkspaces: () => workspaces,
      loadEnvironment: () => {},
      run: async (_command, args) => {
        runs.push(args[1]);
      },
    });
    expect(runs).toEqual(["@test/fast"]);

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
    expect(runs).toEqual(["@test/db"]);

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
      listWorkspaces: () => [workspace("@test/fast", { test: "test" })],
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
      listWorkspaces: () => [workspace("@test/db-unit", { "test:unit": "test:unit" }, "db")],
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
