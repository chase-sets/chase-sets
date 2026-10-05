import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";
import { defineDbTestConfig, defineUnitTestConfig, defineWorkspaceTestConfig } from "../../vitest.shared.mjs";
import { listWorkspacePackages, repoRoot } from "../lib/repo.mjs";
import { runWorkspaceScripts, validateDurationHintRegistry } from "../run-workspaces.mjs";
import {
  canonicalDbProfileCommand,
  discoverConfigTests,
  discoverDbProfile,
  validateDbProfileScripts,
  validateDbProfiles,
} from "./db-profile-script-canonical-form.mjs";

const roots = [];
const dbWorkspaces = listWorkspacePackages().filter(
  (workspace) => workspace.packageJson.chaseSets?.testProfile === "db",
);
const inventoryCases = dbWorkspaces.flatMap((workspace) => {
  const units = Object.keys(workspace.packageJson.scripts).filter((name) => /^test:db:[1-9]\d*$/.test(name));
  const inventory = discoverDbProfile(workspace.dir, units);
  return [
    inventory.aggregate.config.baseConfigPath,
    "vitest.db.config.mjs",
    "vitest.unit.config.mjs",
    ...units.map((name) => `vitest.db.${name.split(":").at(-1)}.config.mjs`),
  ].map((config) => ({ name: workspace.name, dir: workspace.dir, config }));
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ exceptional = false, units = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "db-profile-construction-"));
  roots.push(dir);
  const shared = path.relative(dir, path.join(repoRoot, "vitest.shared.mjs")).replaceAll("\\", "/");
  const write = (name, source) => {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  };
  write(
    "vitest.config.mjs",
    `import { defineWorkspaceTestConfig } from ${JSON.stringify(shared)}; export default defineWorkspaceTestConfig({test:{include:["**/*.test.ts"]}});`,
  );
  const db = (include, options = "") =>
    `import base from "./vitest.config.mjs"; import { defineDbTestConfig } from ${JSON.stringify(shared)}; export default defineDbTestConfig(base,${JSON.stringify(include)}${options});`;
  write("vitest.db.config.mjs", db(exceptional ? ["**/*.test.ts"] : ["**/*.db.test.ts"]));
  write(
    "vitest.unit.config.mjs",
    `import base from "./vitest.config.mjs"; import db from "./vitest.db.config.mjs"; import { defineUnitTestConfig } from ${JSON.stringify(shared)}; export default defineUnitTestConfig(base,db);`,
  );
  const scripts = {
    "test:db": canonicalDbProfileCommand("test:db"),
    "test:unit": "vitest run --config ./vitest.unit.config.mjs",
  };
  for (const unit of units) {
    scripts[unit] = canonicalDbProfileCommand(unit);
    write(
      `vitest.db.${unit.split(":").at(-1)}.config.mjs`,
      db([`tests/unit-${unit.split(":").at(-1)}/**/*.db.test.ts`]),
    );
  }
  return {
    dir,
    name: "@chase-sets/non-context-fixture",
    packageJson: { scripts, chaseSets: { testProfile: "db" } },
    write,
    db,
  };
}

describe("DB profile construction", () => {
  it("canonical scripts reject hidden membership", () => {
    const workspace = fixture();
    workspace.write("tests/a.db.test.ts", "");
    expect(validateDbProfileScripts(workspace).violations).toEqual([]);
    for (const command of [
      `${canonicalDbProfileCommand("test:db")} tests/a.db.test.ts`,
      `${canonicalDbProfileCommand("test:db")} --exclude tests/a.db.test.ts`,
      `node guard.mjs && ${canonicalDbProfileCommand("test:db")}`,
    ]) {
      workspace.packageJson.scripts["test:db"] = command;
      expect(validateDbProfileScripts(workspace).violations).toContain(
        `${workspace.name} test:db: expected canonical form '${canonicalDbProfileCommand("test:db")}'`,
      );
    }
    workspace.packageJson.scripts["test:db"] = canonicalDbProfileCommand("test:db");
    workspace.packageJson.scripts["test:watch"] = "vitest --config ./vitest.unit.config.mjs";
    expect(validateDbProfileScripts(workspace).violations).toEqual([]);
    workspace.packageJson.scripts["test:watch"] = "vitest --config ./vitest.config.mjs";
    expect(validateDbProfileScripts(workspace).violations.join("\n")).toContain(
      "test:watch: expected canonical form 'vitest --config ./vitest.unit.config.mjs'",
    );
    workspace.packageJson.scripts["test:watch"] = "vitest --config ./vitest.unit.config.mjs";
    workspace.packageJson.chaseSets.testProfile = "unsupported";
    expect(validateDbProfileScripts(workspace).violations.join("\n")).toContain("unsupported testProfile");
    workspace.packageJson.chaseSets.testProfile = "db";
    for (const source of [
      "export default {",
      workspace.db(["**/*.db.test.ts"], ', {exclude:["tests/a.db.test.ts"]}'),
      'export default {test:{include:["**/*.db.test.ts"]}};',
    ]) {
      workspace.write("vitest.db.config.mjs", source);
      expect(validateDbProfileScripts(workspace).violations.join("\n")).toContain(
        "expected canonical config 'vitest.db.config.mjs'",
      );
    }
    workspace.write("vitest.db.config.mjs", workspace.db(["**/*.db.test.ts"]));
    expect(validateDbProfileScripts(workspace).violations).toEqual([]);
  });

  it("config and disk define the executed DB set", () => {
    const workspace = fixture({ units: ["test:db:1", "test:db:2"] });
    workspace.write("tests/unit-1/a.db.test.ts", "");
    workspace.write("tests/unit-2/b.db.test.ts", "");
    expect(discoverDbProfile(workspace.dir, ["test:db:1", "test:db:2"]).violations).toEqual([]);
    workspace.write("build/unlisted.db.test.ts", "");
    expect(discoverDbProfile(workspace.dir, ["test:db:1", "test:db:2"]).violations.join("\n")).toContain(
      "build/unlisted.db.test.ts",
    );
    workspace.write("vitest.db.1.config.mjs", workspace.db(["tests/unit-1/**/*.db.test.ts", "build/**/*.db.test.ts"]));
    expect(discoverDbProfile(workspace.dir, ["test:db:1", "test:db:2"]).violations).toEqual([]);
    rmSync(path.join(workspace.dir, "build/unlisted.db.test.ts"));
    workspace.write("vitest.db.1.config.mjs", workspace.db(["tests/unit-1/**/*.db.test.ts"]));
    workspace.write("features/orders/api/purchase-limits.db.test.ts", "");
    expect(discoverDbProfile(workspace.dir, ["test:db:1", "test:db:2"]).violations.join("\n")).toContain(
      "purchase-limits.db.test.ts",
    );
    workspace.write(
      "vitest.db.1.config.mjs",
      workspace.db(["tests/unit-1/**/*.db.test.ts", "features/**/*.db.test.ts"]),
    );
    expect(discoverDbProfile(workspace.dir, ["test:db:1", "test:db:2"]).violations).toEqual([]);
    workspace.write("vitest.db.2.config.mjs", workspace.db(["tests/**/*.db.test.ts"]));
    expect(discoverDbProfile(workspace.dir, ["test:db:1", "test:db:2"]).violations.join("\n")).toContain(
      "exactly one runner-selected",
    );
    workspace.write("vitest.db.config.mjs", workspace.db(["tests/unit-1/**/*.db.test.ts"]));
    expect(discoverDbProfile(workspace.dir, ["test:db:1", "test:db:2"]).violations.join("\n")).toContain(
      "omitted or excluded",
    );
    workspace.write(
      "vitest.config.mjs",
      readFileSync(path.join(workspace.dir, "vitest.config.mjs"), "utf8").replace(
        'include:["**/*.test.ts"]',
        'include:["**/*.test.ts"],exclude:["features/**/*.db.test.ts"]',
      ),
    );
    expect(discoverDbProfile(workspace.dir, ["test:db:1", "test:db:2"]).violations.join("\n")).toContain(
      "purchase-limits.db.test.ts",
    );
    const seed = fixture({ exceptional: true });
    for (const name of [
      "marketplace-seed",
      "representative-catalog",
      "representative-commerce-state",
      "identity-anchor-representative-reconciliation",
    ])
      seed.write(`tests/${name}.test.ts`, "");
    expect(discoverDbProfile(seed.dir).aggregate.files).toHaveLength(4);
    seed.write("vitest.db.config.mjs", seed.db(["tests/representative-*.test.ts"]));
    expect(discoverDbProfile(seed.dir).violations.join("\n")).toContain("retain every base-config test suite");
    rmSync(path.join(seed.dir, "vitest.db.config.mjs"));
    expect(() => discoverDbProfile(seed.dir)).toThrow();
  });

  it("DB TSX suites cannot be omitted or leak into units", () => {
    const workspace = fixture({ units: ["test:db:1"] });
    workspace.write(
      "vitest.config.mjs",
      readFileSync(path.join(workspace.dir, "vitest.config.mjs"), "utf8").replace(
        'include:["**/*.test.ts"]',
        'include:["**/*.test.ts","**/*.test.tsx"]',
      ),
    );
    const dbFile = "tests/unit-1/rendering.db.test.tsx";
    workspace.write(dbFile, "");
    workspace.write("tests/unit-1/runtime.db.test.ts", "");
    workspace.write("tests/rendering.test.tsx", "");
    const omitted = discoverDbProfile(workspace.dir, ["test:db:1"]);
    expect(omitted.violations).toContain(`${dbFile}: DB glob file omitted or excluded by aggregate config`);
    expect(omitted.unit.files).toContain(dbFile);
    workspace.write("vitest.db.config.mjs", workspace.db(["**/*.db.test.ts", "**/*.db.test.tsx"]));
    expect(discoverDbProfile(workspace.dir, ["test:db:1"]).violations.join("\n")).toContain(
      `${dbFile}: must belong to aggregate and exactly one runner-selected DB unit; found none`,
    );
    workspace.write(
      "vitest.db.1.config.mjs",
      workspace.db(["tests/unit-1/**/*.db.test.ts", "tests/unit-1/**/*.db.test.tsx"]),
    );
    const enrolled = discoverDbProfile(workspace.dir, ["test:db:1"]);
    expect(enrolled.violations).toEqual([]);
    expect(enrolled.aggregate.files).toContain(dbFile);
    expect(enrolled.units[0].files).toContain(dbFile);
    expect(enrolled.unit.files).toEqual(["tests/rendering.test.tsx"]);
  });

  it("unit selection is the DB complement", async () => {
    const base = defineWorkspaceTestConfig({ test: { setupFiles: ["setup.ts"], exclude: ["safe/**"] } });
    const db = defineDbTestConfig(base, ["**/*.db.test.ts"]);
    const unit = defineUnitTestConfig(base, db);
    expect(db.test.globalSetup).toEqual(base.test.globalSetup);
    expect(db.test.setupFiles).toEqual(base.test.setupFiles);
    expect(unit.test.exclude).toEqual([...base.test.exclude, ...db.test.include]);
    const workspaces = listWorkspacePackages();
    const calls = [];
    const ordering = workspaces.find((workspace) => workspace.name === "@chase-sets/ordering");
    const environments = [];
    const result = await runWorkspaceScripts({
      argv: ["test:unit", "--test-profile=db"],
      listWorkspaces: () => [ordering],
      loadEnvironment: (options) => environments.push(options),
      durationHintRegistry: {
        schemaVersion: "workspace-test-duration-hints/v1",
        entries: [{ workspace: ordering.name, script: "test:unit", estimatedDurationSeconds: 60 }],
      },
      buildInvocation: (args) => ({ command: "pnpm", args }),
      run: async (_command, args) => {
        calls.push(args);
      },
    });
    expect(result).toBeUndefined();
    expect(environments).toEqual([{ includeTestDatabaseUrl: false }]);
    expect(calls.flat()).toContain("test:unit");
  });

  it("safe directory exclusions match actual Vitest", async () => {
    const workspace = fixture({ units: ["test:db:1"] });
    workspace.write("tests/unit-1/enrolled.db.test.ts", "");
    workspace.write("build/unlisted.db.test.ts", "");
    workspace.write("dist/derived.db.test.ts", "");
    const inventory = discoverDbProfile(workspace.dir, ["test:db:1"]);
    expect(inventory.violations.join("\n")).toContain("build/unlisted.db.test.ts");
    expect(inventory.aggregate.files).toEqual(["build/unlisted.db.test.ts", "tests/unit-1/enrolled.db.test.ts"]);
    const context = await createVitest("test", {
      root: workspace.dir,
      config: path.join(workspace.dir, "vitest.db.config.mjs"),
      watch: false,
    });
    try {
      const selected = (await context.globTestSpecifications())
        .map((spec) => path.relative(workspace.dir, spec.moduleId).replaceAll("\\", "/"))
        .sort();
      expect(selected).toEqual(inventory.aggregate.files);
    } finally {
      await context.close();
    }
    workspace.write("vitest.db.1.config.mjs", workspace.db(["tests/unit-1/**/*.db.test.ts", "build/**/*.db.test.ts"]));
    expect(discoverDbProfile(workspace.dir, ["test:db:1"]).violations).toEqual([]);
  });

  it.each(inventoryCases)("actual Vitest inventory: $name $config", async ({ name, dir, config }) => {
    const workspace = dbWorkspaces.find((candidate) => candidate.name === name);
    const inventory = discoverDbProfile(
      workspace.dir,
      name === "@chase-sets/app-platform-api" ? ["test:db:1", "test:db:2"] : [],
    );
    expect(inventory.violations).toEqual([]);
    const context = await createVitest("test", {
      root: dir,
      config: path.resolve(dir, config),
      watch: false,
    });
    try {
      const selected = (await context.globTestSpecifications())
        .map((spec) => path.relative(workspace.dir, spec.moduleId).replaceAll("\\", "/"))
        .sort();
      expect(selected).toEqual(discoverConfigTests(workspace.dir, config).files);
      console.log(
        `DB_PROFILE_INVENTORY ${JSON.stringify({ workspace: name, config: path.relative(dir, path.resolve(dir, config)).replaceAll("\\", "/"), files: selected })}`,
      );
    } finally {
      await context.close();
    }
    if (name === "@chase-sets/catalog")
      expect(inventory.unit.files).toEqual(
        expect.arrayContaining([
          "features/fields/api/seed.test.ts",
          "features/product-measures/api/seed.test.ts",
          "features/source-observations/api/providers/provider-send-admission.test.ts",
        ]),
      );
    if (name === "@chase-sets/ordering") expect(inventory.unit.files.length).toBeGreaterThan(0);
    if (name === "@chase-sets/marketplace-seed-testing") {
      expect(inventory.unit.files).toEqual([]);
      expect(inventory.aggregate.files).toHaveLength(4);
    }
  });

  it("duration ownership stays exact", () => {
    const workspaces = listWorkspacePackages();
    const registry = JSON.parse(
      readFileSync(path.join(repoRoot, "scripts/workspace-test-duration-hints-v1.json"), "utf8"),
    );
    expect(validateDbProfiles({ workspaces }).violations).toEqual([]);
    for (const name of ["@chase-sets/ordering", "@chase-sets/marketplace-seed-testing"])
      expect(registry.entries).toContainEqual(expect.objectContaining({ workspace: name, script: "test:unit" }));
    const obsolete = structuredClone(registry);
    obsolete.entries.find((entry) => entry.workspace === "@chase-sets/ordering").script = "test";
    expect(() => validateDurationHintRegistry(obsolete, workspaces)).toThrow("obsolete");
    const absent = structuredClone(workspaces);
    delete absent.find((workspace) => workspace.name === "@chase-sets/ordering").packageJson.scripts["test:unit"];
    expect(() => validateDurationHintRegistry(registry, absent)).toThrow("absent script");
    const missing = structuredClone(workspaces);
    missing.push({ name: "@chase-sets/unhinted", packageJson: { scripts: { test: "vitest run" } }, dir: repoRoot });
    expect(validateDbProfiles({ workspaces: missing }).violations.join("\n")).toContain("missing duration owner");
  });
});
