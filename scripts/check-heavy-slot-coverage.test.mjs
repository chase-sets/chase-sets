import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { GIT_LISTING_MAX_BUFFER } from "./lib/git-listing.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test } from "vitest";
import { checkHeavySlotCoverage } from "./check-heavy-slot-coverage.mjs";
import {
  acquireHeavySlot,
  acquireVitestHeavySlot,
  heavySlotVitestGlobalSetupPath,
  isDatabaseVitestRun,
  isFocusedVitestFileRun,
} from "./lib/heavy-slot.mjs";
import setupScriptBatteryHeavySlot, { inheritedOwnerScriptTests } from "./lib/heavy-slot-script-battery.mjs";
import { defineWorkspaceTestConfig } from "../vitest.shared.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

function createScriptProjectFixture() {
  const fixture = createControllerFixture();
  const root = path.dirname(fixture.checkout);
  for (const relativePath of inheritedOwnerScriptTests) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "export {};");
  }
  return { ...fixture, root };
}

function scriptProject(root, filters, watch = false) {
  return { vitest: { filenamePattern: filters }, config: { root, watch } };
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
    "contracts/order-groups/vitest.config.ts",
    "contracts/inventory-draft-listing/vitest.config.ts",
    "contracts/tcgplayer-market-observations/vitest.config.ts",
    "deployables/platform-api/vitest.config.ts",
    "deployables/tcgplayer-operator-extension/vitest.config.ts",
    "infrastructure/stripe-appearance/vitest.config.ts",
    "playwright.config.ts",
    "scripts/browser-e2e-probe.mjs",
    // The handoff command performs two connector builds and therefore uses build admission.
    "scripts/build-connector-extension-handoff.mjs",
    "scripts/bundle-node-service.mjs",
    "scripts/check-structure/brand-foil-proof.mjs",
    "scripts/check-structure/browser-e2e-disclosure-guard.mjs",
    "scripts/check-structure/provider-scope-picker-shape-guard.mjs",
    "scripts/check-structure/regenerate-lockfile-bound-artifacts.mjs",
    "scripts/connector-pairing-drill-staging.mjs",
    "scripts/dev-system.mjs",
    "scripts/format-check.mjs",
    "scripts/typecheck-changed.mjs",
    "scripts/generate-brand-icons.mjs",
    "scripts/identity-creation-position-guard.mjs",
    "scripts/managed-postgres-authority-guard.mjs",
    "scripts/react-router-build.mjs",
    "scripts/run-e2e-suite.mjs",
    "scripts/run-workspaces.mjs",
    "vitest.scripts.config.mjs",
  ];
  assert.equal(result.entrypoints.length, 90);
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
        "check:identity-creation-positions": "node ./scripts/identity-creation-position-guard.mjs",
      },
    }),
    "scripts/format-check.mjs": 'console.log("unguarded");\n',
    "scripts/identity-creation-position-guard.mjs": 'console.log("unguarded");\n',
    "scripts/managed-postgres-authority-guard.mjs": 'console.log("unguarded");\n',
    "scripts/run-workspaces.mjs": 'console.log("unguarded");\n',
    "scripts/lib/heavy-slot.mjs": "export function acquireHeavySlot() {}\n",
  });

  const violations = checkHeavySlotCoverage(root).violations.join("\n");
  assert.match(violations, /format-check\.mjs does not activate/);
  assert.match(violations, /identity-creation-position-guard\.mjs does not activate/);
  assert.match(violations, /managed-postgres-authority-guard\.mjs does not activate/);
  assert.match(violations, /run-workspaces\.mjs does not activate/);

  const guarded = 'import { acquireHeavySlot } from "./lib/heavy-slot.mjs";\nacquireHeavySlot("script-battery");\n';
  writeFileSync(path.join(root, "scripts", "format-check.mjs"), guarded);
  writeFileSync(path.join(root, "scripts", "identity-creation-position-guard.mjs"), guarded);
  writeFileSync(path.join(root, "scripts", "managed-postgres-authority-guard.mjs"), guarded);
  writeFileSync(path.join(root, "scripts", "run-workspaces.mjs"), guarded);
  assert.deepEqual(checkHeavySlotCoverage(root).violations, []);
});

test("derives only the proof entrypoint delta and rejects omission of its actual admission", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-proof-fixture-"));
  temporaryRoots.push(root);
  const proofPath = "scripts/check-structure/brand-foil-proof.mjs";
  const source = readFileSync(proofPath, "utf8");
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  initializeTrackedFixture(root, {
    "package.json": JSON.stringify({ scripts: { "check:structure": manifest.scripts["check:structure"] } }),
    "scripts/check-structure.mjs": "export {};\n",
    [proofPath]: source,
    "scripts/lib/heavy-slot.mjs": "export function acquireHeavySlot() {}\n",
  });
  assert.deepEqual(checkHeavySlotCoverage(root), { entrypoints: [proofPath], unresolved: [], violations: [] });
  const admission = '  acquireHeavySlot("repository-gate");\n';
  assert.equal(source.split(admission).length, 2);
  writeFileSync(path.join(root, proofPath), source.replace(admission, ""));
  assert.deepEqual(checkHeavySlotCoverage(root).violations, [
    `${proofPath} does not activate scripts/lib/heavy-slot.mjs`,
  ]);
  writeFileSync(path.join(root, proofPath), source);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { "check:structure": "node ./scripts/check-structure.mjs" } }),
  );
  assert.deepEqual(checkHeavySlotCoverage(root), { entrypoints: [], unresolved: [], violations: [] });
});

test("admits only a production start of the generated service bundle without a tracked hook", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-service-bundle-fixture-"));
  temporaryRoots.push(root);
  const bundler = "scripts/bundle-node-service.mjs";
  const bundlerSource = 'import { acquireHeavySlot } from "./lib/heavy-slot.mjs";\nacquireHeavySlot("build");\n';
  const manifest = (scripts) => JSON.stringify({ scripts });
  initializeTrackedFixture(root, {
    "deployables/service/package.json": manifest({
      build: `node ../../${bundler} service`,
      "start:production": "node --enable-source-maps dist/main.js",
    }),
    [bundler]: bundlerSource,
    "scripts/lib/heavy-slot.mjs": "export function acquireHeavySlot() {}\n",
  });
  assert.deepEqual(checkHeavySlotCoverage(root), { entrypoints: [bundler], unresolved: [], violations: [] });

  writeFileSync(
    path.join(root, "deployables/service/package.json"),
    manifest({ start: "node dist/main.js", "start:production": "node --enable-source-maps dist/other.js" }),
  );
  assert.deepEqual(checkHeavySlotCoverage(root).unresolved, [
    "deployables/service: node --enable-source-maps dist/other.js",
    "deployables/service: node dist/main.js",
  ]);

  writeFileSync(
    path.join(root, "deployables/service/package.json"),
    manifest({ build: `node ../../${bundler} service` }),
  );
  writeFileSync(path.join(root, bundler), "export {};\n");
  assert.deepEqual(checkHeavySlotCoverage(root).violations, [
    `${bundler} does not activate scripts/lib/heavy-slot.mjs`,
  ]);
});

test("names the lockfile-bound regenerator when its script-battery admission is removed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-regenerator-fixture-"));
  temporaryRoots.push(root);
  const regeneratorPath = "scripts/check-structure/regenerate-lockfile-bound-artifacts.mjs";
  const guardedRegenerator = [
    'import { acquireHeavySlot } from "../lib/heavy-slot.mjs";',
    'acquireHeavySlot("script-battery");',
    "",
  ].join("\n");
  initializeTrackedFixture(root, {
    "package.json": JSON.stringify({
      private: true,
      scripts: {
        "regenerate:lockfile-bound-artifacts": `node ./${regeneratorPath}`,
      },
    }),
    [regeneratorPath]: guardedRegenerator,
    "scripts/lib/heavy-slot.mjs": "export function acquireHeavySlot() {}\n",
  });

  assert.deepEqual(checkHeavySlotCoverage(root), {
    entrypoints: [regeneratorPath],
    unresolved: [],
    violations: [],
  });

  const admissionRemoved = guardedRegenerator.replace('acquireHeavySlot("script-battery");\n', "");
  assert.notEqual(admissionRemoved, guardedRegenerator);
  writeFileSync(path.join(root, regeneratorPath), admissionRemoved);
  const mutant = checkHeavySlotCoverage(root);
  assert.deepEqual(mutant.entrypoints, [regeneratorPath]);
  assert.deepEqual(mutant.unresolved, []);
  assert.match(
    mutant.violations.join("\n"),
    /scripts\/check-structure\/regenerate-lockfile-bound-artifacts\.mjs does not activate/,
  );
});

test("fails closed for an unreviewed tracked Node package-script entry point", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-unreviewed-node-fixture-"));
  temporaryRoots.push(root);
  initializeTrackedFixture(root, {
    "package.json": JSON.stringify({
      private: true,
      scripts: {
        "test:soak": "node ./scripts/mega-soak-runner.mjs",
      },
    }),
    "scripts/mega-soak-runner.mjs": 'console.log("unguarded");\n',
  });

  const result = checkHeavySlotCoverage(root);
  assert.deepEqual(result.entrypoints, ["scripts/mega-soak-runner.mjs"]);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.violations.join("\n"), /mega-soak-runner\.mjs does not activate/);
});

test("keeps an explicitly reviewed cheap Node package-script entry point out of the heavy inventory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-cheap-node-fixture-"));
  temporaryRoots.push(root);
  initializeTrackedFixture(root, {
    "package.json": JSON.stringify({
      private: true,
      scripts: {
        "check:docs-index": "node ./scripts/check-docs-index.mjs",
      },
    }),
    "scripts/check-docs-index.mjs": 'console.log("cheap");\n',
  });

  assert.deepEqual(checkHeavySlotCoverage(root), {
    entrypoints: [],
    unresolved: [],
    violations: [],
  });
});

test("structurally rejects a dev-system guard whose browser target condition can never acquire", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-dev-system-structure-fixture-"));
  temporaryRoots.push(root);
  const canonicalHelper = [
    "export function isBrowserE2eTarget(targetName) {",
    '  return targetName === "browser-e2e" || targetName === "browser-e2e-production";',
    "}",
    "export function acquireDevSystemHeavySlot(mode, targetName, acquireSlot) {",
    '  if (mode !== "dev" || !isBrowserE2eTarget(targetName)) return false;',
    '  return acquireSlot("script-battery");',
    "}",
    "",
  ].join("\n");
  initializeTrackedFixture(root, {
    "package.json": JSON.stringify({
      private: true,
      scripts: {
        "dev:browser-e2e": "node ./scripts/dev-system.mjs dev browser-e2e",
      },
    }),
    "scripts/dev-system.mjs": [
      'import { acquireDevSystemHeavySlot } from "./dev-system-config.mjs";',
      'import { acquireHeavySlot } from "./lib/heavy-slot.mjs";',
      'const mode = process.argv[2] ?? "dev";',
      'const target = process.argv[3] ?? "all";',
      "acquireDevSystemHeavySlot(mode, target, acquireHeavySlot);",
      "",
    ].join("\n"),
    "scripts/dev-system-config.mjs": canonicalHelper,
    "scripts/lib/heavy-slot.mjs": "export function acquireHeavySlot() {}\n",
  });

  assert.deepEqual(checkHeavySlotCoverage(root).violations, []);

  writeFileSync(
    path.join(root, "scripts", "dev-system-config.mjs"),
    canonicalHelper.replace("!isBrowserE2eTarget(targetName)", 'targetName !== "never-a-browser-target"'),
  );
  assert.match(checkHeavySlotCoverage(root).violations.join("\n"), /dev-system\.mjs does not activate/);
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

test("focused script tests stay concurrent while the scripts battery stays exclusive", () => {
  const { checkout, marker, root } = createScriptProjectFixture();
  const ordinary = path.join(root, "scripts", "ordinary.test.mjs");
  writeFileSync(ordinary, "export {};");

  setupScriptBatteryHeavySlot(scriptProject(root, ["scripts/ordinary.test.mjs"]), { startDirectory: checkout });
  assert.equal(existsSync(marker), false);
});

test("the scripts battery global setup acquires script-battery for a run with no filters", () => {
  const { checkout, marker, root } = createScriptProjectFixture();
  setupScriptBatteryHeavySlot(scriptProject(root, undefined), { startDirectory: checkout });
  assert.equal(readFileSync(marker, "utf8"), "script-battery\n");
});

test.each([
  ["directory filter", ["scripts"], {}],
  ["glob filter", ["scripts/**/*.test.mjs"], {}],
  ["missing file", ["scripts/missing.test.mjs"], {}],
  ["non-test file", ["scripts/ordinary.mjs"], {}],
  ["watch mode", ["scripts/ordinary.test.mjs"], { watch: true }],
  ["database lifecycle", ["scripts/ordinary.test.mjs"], { env: { npm_lifecycle_event: "test:db" } }],
  ["database URL", ["scripts/ordinary.test.mjs"], { env: { TEST_DATABASE_URL: "postgres://fixture" } }],
])("scripts battery global setup acquires script-battery for a %s", (_name, filters, options) => {
  const { checkout, marker, root } = createScriptProjectFixture();
  writeFileSync(path.join(root, "scripts", "ordinary.test.mjs"), "export {};");
  writeFileSync(path.join(root, "scripts", "ordinary.mjs"), "export {};");
  setupScriptBatteryHeavySlot(scriptProject(root, filters, options.watch ?? false), {
    startDirectory: checkout,
    env: options.env,
  });
  assert.equal(readFileSync(marker, "utf8"), "script-battery\n");
});

test.each([
  ["repo-relative", (relative) => relative],
  ["absolute", (relative, root) => path.join(root, relative)],
  ["forward-slash absolute", (relative, root) => path.join(root, relative).replaceAll("\\", "/")],
  [
    "vitest-normalized",
    (relative, root) => path.join(root, relative).replaceAll("\\", "/"),
    (root) => root.replaceAll("\\", "/"),
  ],
  ["dot-relative", (relative) => `./${relative}`],
  ["line suffix", (relative) => `${relative}:42`],
  ["backslash", (relative) => relative.replaceAll("/", "\\")],
])("a listed inherited-owner test keeps the setup admission with %s spelling", (_name, format, formatRoot) => {
  for (const relative of inheritedOwnerScriptTests) {
    const { checkout, marker, root } = createScriptProjectFixture();
    const projectRoot = formatRoot ? formatRoot(root) : root;
    setupScriptBatteryHeavySlot(scriptProject(projectRoot, [format(relative, root)]), { startDirectory: checkout });
    assert.equal(readFileSync(marker, "utf8"), "script-battery\n");
  }
});

test("a listed inherited-owner test keeps setup admission alongside unlisted files", () => {
  const { checkout, marker, root } = createScriptProjectFixture();
  const ordinary = path.join(root, "scripts", "ordinary.test.mjs");
  writeFileSync(ordinary, "export {};");
  setupScriptBatteryHeavySlot(scriptProject(root, ["scripts/ordinary.test.mjs", "scripts/verify-ci-local.test.mjs"]), {
    startDirectory: checkout,
  });
  assert.equal(readFileSync(marker, "utf8"), "script-battery\n");
});

const inheritedOwnerWaivers = Object.freeze({
  "scripts/browser-e2e-probe.test.mjs": "browser probe is not an inherited-owner dependent",
  "scripts/bundle-node-service.test.mjs": "bundle tests invoke the exported builder, not the guarded CLI",
  "scripts/change-scope.test.mjs": "change-scope fixtures do not spawn a guarded child",
  "scripts/check-structure/authoritative-stream-read-classification.test.mjs":
    "static classification does not spawn the guard",
  "scripts/check-structure/brand-foil-sites.test.mjs": "brand-foil checks do not spawn the guard",
  "scripts/check-structure/brand-mark-representations.test.mjs": "icon checks do not spawn the guard",
  "scripts/check-structure/browser-e2e-disclosure-guard.test.mjs": "disclosure fixture does not spawn the guard",
  "scripts/check-structure/provider-scope-picker-shape-guard.test.mjs":
    "provider shape fixture does not spawn the guard",
  "scripts/check-structure/regenerate-lockfile-bound-artifacts.test.mjs":
    "regenerator fixture does not spawn the guard",
  "scripts/digitalocean-platform-config.test.mjs": "workspace fixture does not spawn the guard",
  "scripts/identity-creation-position-guard.test.mjs": "position fixture does not spawn the guard",
  "scripts/ordering-test-profile.test.mjs": "workspace fixture does not spawn the guard",
  "scripts/process.test.mjs": "process helper does not spawn a guarded child",
  "scripts/provider-browser-install-timeout.test.mjs":
    "installer fixtures inject spawn and signals; hosted-controls is inspected, never executed",
  "scripts/provider-object-disposition/browser-boundary/install-ci.test.mjs":
    "browser fixture does not spawn the guard",
  "scripts/provider-object-disposition/browser-boundary/installation-cycle.test.mjs":
    "browser fixture does not spawn the guard",
  "scripts/provider-object-disposition/browser-boundary/ownership-controls.test.mjs":
    "browser fixture does not spawn the guard",
  "scripts/provider-object-disposition/test-window-browser-admission.test.mjs":
    "browser fixture does not spawn the guard",
  "scripts/provider-object-disposition/test-window-main.test.mjs": "browser fixture does not spawn the guard",
  "scripts/route-census/admission.test.mjs": "route census does not spawn the guard",
  "scripts/route-census/partition-scope.test.mjs": "route census does not spawn the guard",
  "scripts/route-census/publication.test.mjs": "route census does not spawn the guard",
  "scripts/run-e2e-suite.test.mjs": "suite test does not spawn a guarded child",
  "scripts/run-workspaces.test.mjs": "workspace test owns its child admission",
  "scripts/check-heavy-slot-coverage.test.mjs": "inventory owner; inert fixture controllers only",
});

function deriveInheritedOwnerCandidates(root = repositoryRoot) {
  const tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: GIT_LISTING_MAX_BUFFER,
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"));
  const guardedEntrypoints = tracked.filter((file) => {
    if (!file.startsWith("scripts/") || file.startsWith("scripts/lib/heavy-slot")) return false;
    if (file.endsWith(".test.mjs") || file.endsWith(".md")) return false;
    if (!/\.[cm]?[jt]sx?$/.test(file)) return false;
    const source = readFileSync(path.join(root, file), "utf8");
    return source.includes("acquireHeavySlot(");
  });
  const inheritedOwnerTokenPattern =
    /CHASE_SETS_HEAVY_SLOT_ID|CHASE_SETS_HEAVY_SLOT_TRANSPORT|findHeavySlotClient\(|acquireHeavySlot\(/;
  return tracked
    .filter((file) => file.startsWith("scripts/") && file.endsWith(".test.mjs"))
    .filter((file) => {
      const source = readFileSync(path.join(root, file), "utf8");
      return (
        guardedEntrypoints.some((entrypoint) => source.includes(path.posix.basename(entrypoint))) ||
        inheritedOwnerTokenPattern.test(source)
      );
    })
    .sort();
}

function classifyInheritedOwnerCandidates(
  candidates,
  listed = inheritedOwnerScriptTests,
  waivers = inheritedOwnerWaivers,
) {
  const listedSet = new Set(listed);
  const waivedSet = new Set(Object.keys(waivers));
  return {
    unclassified: candidates.filter((candidate) => !listedSet.has(candidate) && !waivedSet.has(candidate)),
    overlapping: candidates.filter((candidate) => listedSet.has(candidate) && waivedSet.has(candidate)),
    staleListed: listed.filter((candidate) => !candidates.includes(candidate)),
    staleWaived: [...waivedSet].filter((candidate) => !candidates.includes(candidate)),
  };
}

test("every script test that reaches a real heavy-slot acquisition is a declared inherited-owner test", () => {
  const candidates = deriveInheritedOwnerCandidates();
  const classification = classifyInheritedOwnerCandidates(candidates);
  assert.equal(candidates.length, 29);
  assert.equal(inheritedOwnerScriptTests.length, 5);
  assert.deepEqual(classification, {
    unclassified: [],
    overlapping: [],
    staleListed: [],
    staleWaived: [],
  });
  assert.equal(
    Object.values(inheritedOwnerWaivers).every(
      (reason) => typeof reason === "string" && reason.length > 0 && !reason.includes("\n"),
    ),
    true,
  );
});

test("candidate derivation fails closed for an unclassified guarded dependent", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "heavy-slot-inherited-owner-fixture-"));
  temporaryRoots.push(root);
  initializeTrackedFixture(root, {
    "scripts/guarded-entrypoint.mjs":
      'import { acquireHeavySlot } from "./lib/heavy-slot.mjs";\nacquireHeavySlot("script-battery");\n',
    "scripts/lib/heavy-slot.mjs": "export function acquireHeavySlot() {}\n",
    "scripts/unclassified.test.mjs": 'import "./guarded-entrypoint.mjs";\n',
    "scripts/token-only.test.mjs": 'const ownerToken = "CHASE_SETS_HEAVY_SLOT_ID";\nvoid ownerToken;\n',
  });
  const candidates = deriveInheritedOwnerCandidates(root);
  const classification = classifyInheritedOwnerCandidates(candidates);
  assert.deepEqual(classification.unclassified, ["scripts/token-only.test.mjs", "scripts/unclassified.test.mjs"]);
});

test("the canonical Vitest guard runs before consumer global setup", () => {
  const consumerSetup = path.join(os.tmpdir(), "consumer-global-setup.mjs");
  const config = defineWorkspaceTestConfig({ test: { globalSetup: consumerSetup } });
  assert.deepEqual(config.test.globalSetup, [heavySlotVitestGlobalSetupPath, consumerSetup]);
});
