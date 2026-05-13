import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
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
  it("preserves serial behavior by default", async () => {
    let active = 0;
    let maxActive = 0;

    await runWorkspaceScripts({
      argv: ["build"],
      buildInvocation,
      listWorkspaces: () => [
        workspace("@test/a", { build: "build" }),
        workspace("@test/b", { build: "build" }),
      ],
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
          listWorkspaces: () => [
            workspace("@test/a", { build: "build" }),
            workspace("@test/b", { build: "build" }),
          ],
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
      concurrency: 4,
    });
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
