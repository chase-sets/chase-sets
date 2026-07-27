import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { checkHeavySlotCoverage } from "./check-heavy-slot-coverage.mjs";
import {
  acquireHeavySlot,
  acquireVitestHeavySlot,
  heavySlotVitestGlobalSetupPath,
  isDatabaseVitestRun,
  isFocusedVitestFileRun,
} from "./lib/heavy-slot.mjs";
import setupScriptBatteryHeavySlot from "./lib/heavy-slot-script-battery.mjs";
import { defineWorkspaceTestConfig } from "../vitest.shared.mjs";

const temporaryRoots = [];
afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function createControllerFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-controller-fixture-"));
  temporaryRoots.push(root);
  const orchestrator = path.join(root, ".orchestrator");
  const checkout = path.join(root, "checkout", "scripts");
  const marker = path.join(root, "admissions.txt");
  mkdirSync(orchestrator, { recursive: true });
  mkdirSync(checkout, { recursive: true });
  writeFileSync(path.join(orchestrator, "invoke-heavy-verifier.ps1"), "# inert fixture\n");
  writeFileSync(
    path.join(orchestrator, "heavy-slot.cjs"),
    `const { appendFileSync } = require("node:fs");\nmodule.exports = (kind) => appendFileSync(${JSON.stringify(
      marker,
    )}, kind + "\\n");\n`,
  );
  return { checkout, marker };
}

function initializeTrackedFixture(root, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
  execFileSync("git", ["add", "--all"], { cwd: root });
}

test("derives every heavy artifact entry point and requires a reachable guard activation", () => {
  const result = checkHeavySlotCoverage();
  const expectedEntrypoints = [
    "contracts/market-estimate-display/vitest.config.ts",
    "deployables/platform-api/vitest.config.ts",
    "playwright.config.ts",
    "scripts/browser-e2e-probe.mjs",
    "scripts/check-structure/browser-e2e-disclosure-guard.mjs",
    "scripts/check-structure/provider-scope-picker-shape-guard.mjs",
    "scripts/dev-system.mjs",
    "scripts/format-check.mjs",
    "scripts/managed-postgres-authority-guard.mjs",
    "scripts/react-router-build.mjs",
    "scripts/run-e2e-suite.mjs",
    "scripts/run-workspaces.mjs",
    "vitest.scripts.config.mjs",
  ];
  assert.ok(result.entrypoints.length >= 10, `expected a derived inventory, received ${result.entrypoints.length}`);
  assert.deepEqual(
    expectedEntrypoints.filter((entrypoint) => !result.entrypoints.includes(entrypoint)),
    [],
  );
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.violations, []);
});

test("fails through real tracked-file discovery when a derived entry point loses its guard", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-coverage-fixture-"));
  temporaryRoots.push(root);
  initializeTrackedFixture(root, {
    "package.json": JSON.stringify({
      private: true,
      scripts: {
        build: "node ./scripts/run-workspaces.mjs build",
        "format:check": "node ./scripts/format-check.mjs",
      },
    }),
    "scripts/format-check.mjs": 'console.log("unguarded");\n',
    "scripts/managed-postgres-authority-guard.mjs": 'console.log("unguarded");\n',
    "scripts/run-workspaces.mjs": 'console.log("unguarded");\n',
    "scripts/lib/heavy-slot.mjs": "export function acquireHeavySlot() {}\n",
  });

  const violations = checkHeavySlotCoverage(root).violations.join("\n");
  assert.match(violations, /format-check\.mjs does not activate/);
  assert.match(violations, /managed-postgres-authority-guard\.mjs does not activate/);
  assert.match(violations, /run-workspaces\.mjs does not activate/);

  const guarded = 'import { acquireHeavySlot } from "./lib/heavy-slot.mjs";\nacquireHeavySlot("script-battery");\n';
  writeFileSync(path.join(root, "scripts", "format-check.mjs"), guarded);
  writeFileSync(path.join(root, "scripts", "managed-postgres-authority-guard.mjs"), guarded);
  writeFileSync(path.join(root, "scripts", "run-workspaces.mjs"), guarded);
  assert.deepEqual(checkHeavySlotCoverage(root).violations, []);
});

test("derives explicit-file DB lifecycle configs instead of treating them as cheap focused runs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-db-coverage-fixture-"));
  temporaryRoots.push(root);
  initializeTrackedFixture(root, {
    "package.json": JSON.stringify({
      private: true,
      scripts: {
        "test:db:1": "vitest run --config ./vitest.config.mjs focused.test.ts",
      },
    }),
    "focused.test.ts": "",
    "vitest.config.mjs": "export default { test: {} };\n",
    "scripts/lib/heavy-slot.mjs": "export const heavySlotVitestGlobalSetupPath = import.meta.filename;\n",
  });

  assert.match(checkHeavySlotCoverage(root).violations.join("\n"), /vitest\.config\.mjs does not activate/);
  writeFileSync(
    path.join(root, "vitest.config.mjs"),
    'import { heavySlotVitestGlobalSetupPath } from "./scripts/lib/heavy-slot.mjs";\n' +
      "export default { test: { globalSetup: [heavySlotVitestGlobalSetupPath] } };\n",
  );
  assert.deepEqual(checkHeavySlotCoverage(root).violations, []);
});

test("no-ops when no ancestor controller client exists", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-no-container-"));
  temporaryRoots.push(root);
  assert.equal(acquireHeavySlot("script-battery", { startDirectory: root }), false);
});

test("direct guard invocation delegates to the controller client discovered from the artifact tree", () => {
  const { checkout, marker } = createControllerFixture();
  assert.equal(acquireHeavySlot("build", { startDirectory: checkout }), true);
  assert.equal(readFileSync(marker, "utf8"), "build\n");
});

test("skips Vitest admission only for positive in-process evidence of explicit test files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-vitest-focus-"));
  temporaryRoots.push(root);
  const focusedFile = path.join(root, "focused.test.mjs");
  writeFileSync(focusedFile, "");

  assert.equal(
    isFocusedVitestFileRun({ vitest: { filenamePattern: [focusedFile] }, config: { root, watch: false } }),
    true,
  );
  assert.equal(isFocusedVitestFileRun({ vitest: { filenamePattern: [] }, config: { root, watch: false } }), false);
  assert.equal(
    isFocusedVitestFileRun({ vitest: { filenamePattern: ["focused"] }, config: { root, watch: false } }),
    false,
  );
  assert.equal(
    isFocusedVitestFileRun({ vitest: { filenamePattern: [focusedFile] }, config: { root, watch: true } }),
    false,
  );
  assert.equal(isFocusedVitestFileRun({ vitest: {}, config: { root, watch: false } }), false);
});

test("DB lifecycle and custom-runner database environments acquire even with explicit test files", () => {
  const { checkout, marker } = createControllerFixture();
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-db-focus-"));
  temporaryRoots.push(root);
  const focusedFile = path.join(root, "focused.test.mjs");
  writeFileSync(focusedFile, "");
  const project = { vitest: { filenamePattern: [focusedFile] }, config: { root, watch: false } };

  assert.equal(acquireVitestHeavySlot(project, "vitest-full", { startDirectory: checkout, env: {} }), false);
  assert.equal(existsSync(marker), false);

  assert.equal(isDatabaseVitestRun({ npm_lifecycle_event: "test:db:1" }), true);
  assert.equal(
    acquireVitestHeavySlot(project, "vitest-full", {
      startDirectory: checkout,
      env: { npm_lifecycle_event: "test:db:1" },
    }),
    true,
  );
  assert.equal(isDatabaseVitestRun({ TEST_DATABASE_URL: "postgres://fixture" }), true);
  assert.equal(
    acquireVitestHeavySlot(project, "vitest-full", {
      startDirectory: checkout,
      env: { TEST_DATABASE_URL: "postgres://fixture" },
    }),
    true,
  );
  assert.equal(readFileSync(marker, "utf8"), "vitest-full\nvitest-full\n");
});

test("custom Vitest runners with directory filters acquire instead of masquerading as focused files", () => {
  const { checkout, marker } = createControllerFixture();
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-directory-focus-"));
  temporaryRoots.push(root);
  const project = { vitest: { filenamePattern: [root] }, config: { root, watch: false } };

  assert.equal(isFocusedVitestFileRun(project), false);
  assert.equal(acquireVitestHeavySlot(project, "vitest-full", { startDirectory: checkout, env: {} }), true);
  assert.equal(readFileSync(marker, "utf8"), "vitest-full\n");
});

test("focused repository guard tests remain a script battery while ordinary focused Vitest stays concurrent", () => {
  const { checkout, marker } = createControllerFixture();
  setupScriptBatteryHeavySlot({}, { startDirectory: checkout });
  assert.equal(readFileSync(marker, "utf8"), "script-battery\n");
});

test("the canonical Vitest guard runs before consumer global setup", () => {
  const consumerSetup = path.join(os.tmpdir(), "consumer-global-setup.mjs");
  const config = defineWorkspaceTestConfig({ test: { globalSetup: consumerSetup } });
  assert.deepEqual(config.test.globalSetup, [heavySlotVitestGlobalSetupPath, consumerSetup]);
});
