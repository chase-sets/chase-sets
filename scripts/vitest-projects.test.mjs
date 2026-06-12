import path from "node:path";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import { buildVitestProjects, parseVitestRunScript, selectFastTestTargets } from "./lib/vitest-projects.mjs";
import { runVitestProjects } from "./run-vitest-projects.mjs";
import { listWorkspacePackages } from "./lib/repo.mjs";

const rootDir = "D:/repo";

function workspace(name, scripts, testProfile) {
  return {
    name,
    dir: path.join(rootDir, name.replace("@chase-sets/", "workspaces/")),
    packageJson: {
      scripts,
      chaseSets: testProfile ? { testProfile } : undefined,
    },
  };
}

describe("selectFastTestTargets", () => {
  it("mirrors the former two-pass verify:test selection", () => {
    const workspaces = [
      workspace("@chase-sets/fast", { test: "vitest run --config ./vitest.config.ts" }),
      workspace(
        "@chase-sets/db",
        {
          test: "vitest run --config ./vitest.config.ts",
          "test:unit": "vitest run --config ./vitest.config.ts --exclude seed.test.ts",
          "test:db": "vitest run --config ./vitest.config.ts seed.test.ts",
        },
        "db",
      ),
      workspace("@chase-sets/db-only", { "test:db": "vitest run --config ./vitest.config.ts" }, "db"),
      workspace("@chase-sets/no-tests", { build: "tsc" }),
    ];

    const targets = selectFastTestTargets(workspaces);

    expect(targets.map(({ workspace: target, scriptName }) => [target.name, scriptName])).toEqual([
      ["@chase-sets/fast", "test"],
      ["@chase-sets/db", "test:unit"],
    ]);
  });
});

describe("parseVitestRunScript", () => {
  it("extracts the config path", () => {
    expect(parseVitestRunScript("vitest run --config ./tests/vitest.config.mjs")).toEqual({
      configPath: "./tests/vitest.config.mjs",
      excludePatterns: [],
    });
  });

  it("extracts repeated exclude patterns", () => {
    expect(
      parseVitestRunScript(
        "vitest run --config ./tests/vitest.config.mjs --exclude features/a/seed.test.ts --exclude tests/b.test.ts",
      ),
    ).toEqual({
      configPath: "./tests/vitest.config.mjs",
      excludePatterns: ["features/a/seed.test.ts", "tests/b.test.ts"],
    });
  });

  it("rejects scripts without an explicit config", () => {
    expect(() => parseVitestRunScript("vitest run --pool vmThreads")).toThrow(/Unsupported vitest argument/);
    expect(() => parseVitestRunScript("vitest run")).toThrow(/--config/);
  });

  it("rejects scripts that are not plain vitest run invocations", () => {
    expect(() => parseVitestRunScript("vitest --config ./vitest.config.ts")).toThrow(/vitest run/);
  });
});

describe("buildVitestProjects", () => {
  it("builds project entries rooted at each workspace", () => {
    const projects = buildVitestProjects({
      workspaces: [
        workspace("@chase-sets/fast", { test: "vitest run --config ./tests/vitest.config.mjs" }),
        workspace(
          "@chase-sets/db",
          { "test:unit": "vitest run --config ./vitest.config.ts --exclude seed.test.ts" },
          "db",
        ),
      ],
      rootDir,
    });

    expect(projects).toEqual([
      {
        extends: "./workspaces/fast/tests/vitest.config.mjs",
        root: "D:/repo/workspaces/fast",
        test: { name: "fast" },
      },
      {
        extends: "./workspaces/db/vitest.config.ts",
        root: "D:/repo/workspaces/db",
        test: {
          name: "db",
          exclude: [...configDefaults.exclude, "seed.test.ts"],
        },
      },
    ]);
  });

  it("covers every workspace of the real repo that the two-pass selection covered", () => {
    const workspaces = listWorkspacePackages();
    const projects = buildVitestProjects({ workspaces });
    const expectedNames = workspaces
      .filter((entry) => {
        const scripts = entry.packageJson.scripts ?? {};
        const profile = entry.packageJson.chaseSets?.testProfile;
        return profile === "db" ? typeof scripts["test:unit"] === "string" : typeof scripts.test === "string";
      })
      .map((entry) => entry.name.replace(/^@chase-sets\//, ""));

    expect(projects.map((project) => project.test.name)).toEqual(expectedNames);
  });
});

describe("runVitestProjects", () => {
  it("loads the non-DB test environment and runs the projects config", async () => {
    const calls = [];

    await runVitestProjects({
      argv: ["--reporter=dot"],
      buildInvocation: (args) => ({ command: "pnpm", args }),
      loadEnvironment: (options) => calls.push(["env", options]),
      run: async (command, args) => calls.push(["run", command, args]),
    });

    expect(calls).toEqual([
      ["env", { includeTestDatabaseUrl: false }],
      ["run", "pnpm", ["exec", "vitest", "run", "--config", "./vitest.projects.config.mjs", "--reporter=dot"]],
    ]);
  });
});
