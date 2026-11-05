import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "vitest";
import { configDefaults } from "vitest/config";
import { GIT_LISTING_MAX_BUFFER } from "./lib/git-listing.mjs";
import {
  boundedContextTestInclude,
  defineBoundedContextTestConfig,
  defineWorkspaceTestConfig,
  resolveVitestLaneProfile,
} from "../vitest.shared.mjs";
import { defineScriptsTestConfig } from "../vitest.scripts.config.mjs";
import { heavySlotVitestGlobalSetupPath } from "./lib/heavy-slot.mjs";
import { heavySlotScriptBatteryGlobalSetupPath } from "./lib/heavy-slot-script-battery.mjs";
import { scriptBatteryTempCensusGlobalSetupPath } from "./lib/script-battery-temp-census.mjs";
import { repoRoot } from "./lib/repo.mjs";

const originalLaneMode = process.env.CHASE_SETS_LANE_MODE;
const canonicalRecordTest = "scripts/canonical-record.test.mjs";

function trackedScriptsTestFiles() {
  return execFileSync("git", ["ls-files", "--", "scripts/*.test.mjs", "scripts/**/*.test.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: GIT_LISTING_MAX_BUFFER,
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
}

function assertExactScriptsPartition({ canonicalFiles, remainderFiles, completeFiles }) {
  const expected = new Set(completeFiles);
  const first = [...canonicalFiles];
  const remainder = [...remainderFiles];
  assert.deepEqual(first, [canonicalRecordTest], "canonical phase must contain only the canonical file");
  assert.equal(new Set(first).size, first.length, "canonical phase must not duplicate a file");
  assert.equal(new Set(remainder).size, remainder.length, "remainder phase must not duplicate a file");
  assert.equal(first.filter((file) => remainder.includes(file)).length, 0, "phases must be disjoint");
  assert.deepEqual(new Set([...first, ...remainder]), expected, "phases must cover complete enrollment");
  assert.equal(first.filter((file) => file === canonicalRecordTest).length, 1);
}

function scriptsCommandPartition(command) {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  command ??= packageJson.scripts["test:scripts"];
  const phases = command.split(" && ");
  assert.equal(phases.length, 2, "scripts command must contain exactly two complete phase invocations");
  const [canonicalPhase, remainderPhase] = phases;
  const canonicalCommand = packageJson.scripts["test:canonical-record"];
  const completeFiles = trackedScriptsTestFiles();
  const include = defineScriptsTestConfig().test.include;
  const includesScripts = completeFiles.filter((file) => /^scripts\/.*\.test\.mjs$/.test(file));
  const excludes = [...remainderPhase.matchAll(/--exclude\s+(\S+)/g)].map(([, file]) => file);

  assert.equal(canonicalPhase, `pnpm run test:canonical-record`);
  assert.equal(
    canonicalCommand,
    "vitest run --config ./vitest.scripts.config.mjs scripts/canonical-record.test.mjs --maxWorkers=1 --fileParallelism=false --silent=false",
  );
  assert.match(
    remainderPhase,
    /^vitest run --config \.\/vitest\.scripts\.config\.mjs --exclude scripts\/canonical-record\.test\.mjs$/,
  );
  assert.deepEqual(include, ["scripts/**/*.test.mjs"]);
  assert.deepEqual(excludes, [canonicalRecordTest]);

  return {
    canonicalFiles: [canonicalRecordTest],
    remainderFiles: includesScripts.filter((file) => !excludes.includes(file)),
    completeFiles: includesScripts,
  };
}

function runInertScriptsPhases(canonicalExit, remainderExit) {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const command = packageJson.scripts["test:scripts"];
  const canonicalPhase = "pnpm run test:canonical-record";
  const remainderPhase = command.match(
    /vitest run --config \.\/vitest\.scripts\.config\.mjs --exclude scripts\/canonical-record\.test\.mjs/,
  )?.[0];
  assert.ok(remainderPhase, "scripts command must contain the complement invocation");
  const syntheticPhase = (name, exit) =>
    `"${process.execPath}" -e "console.log('synthetic-${name}');process.exit(${exit})"`;
  const inertCommand = command
    .replace(canonicalPhase, syntheticPhase("canonical", canonicalExit))
    .replace(remainderPhase, syntheticPhase("complement", remainderExit));
  const result = spawnSync(inertCommand, { cwd: repoRoot, encoding: "utf8", shell: true });
  assert.ifError(result.error);
  assert.equal(result.stderr, "");
  return { status: result.status, trace: result.stdout.trim().split(/\r?\n/) };
}

afterEach(() => {
  if (originalLaneMode === undefined) delete process.env.CHASE_SETS_LANE_MODE;
  else process.env.CHASE_SETS_LANE_MODE = originalLaneMode;
});

function setLaneMode(value) {
  if (value === undefined) delete process.env.CHASE_SETS_LANE_MODE;
  else process.env.CHASE_SETS_LANE_MODE = value;
}

test("keeps the default and hosted workspace profile byte-semantically strict", () => {
  for (const laneMode of [undefined, "", "0", "true"]) {
    setLaneMode(laneMode);
    assert.deepEqual(resolveVitestLaneProfile({ CHASE_SETS_LANE_MODE: laneMode, CI: "true" }), {});
    assert.deepEqual(defineWorkspaceTestConfig().test, {
      environment: "node",
      include: ["**/*.test.ts", "**/*.test.tsx"],
      hookTimeout: 120_000,
      testTimeout: 120_000,
      globalSetup: [heavySlotVitestGlobalSetupPath],
      exclude: [...configDefaults.exclude, "**/dist/**"],
    });
  }
});

test("keeps the default and hosted scripts profile byte-semantically strict", () => {
  for (const env of [{}, { CI: "true" }, { CHASE_SETS_LANE_MODE: "0", CI: "true" }]) {
    assert.deepEqual(defineScriptsTestConfig(env).test, {
      globalSetup: [heavySlotScriptBatteryGlobalSetupPath, scriptBatteryTempCensusGlobalSetupPath],
      setupFiles: ["./scripts/lib/tracked-checkout-write-guard.mjs"],
      include: ["scripts/**/*.test.mjs"],
    });
  }
});

test("runs canonical scripts first and enrolls the exact remaining test complement", () => {
  assertExactScriptsPartition(scriptsCommandPartition());
});

test("rejects canonical omission, duplication, and a second-file exclusion", () => {
  const partition = scriptsCommandPartition();
  const secondFile = partition.remainderFiles[0];
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const command = packageJson.scripts["test:scripts"];

  for (const changedCommand of [
    command.replace("pnpm run test:canonical-record && ", ""),
    `${command} && pnpm run test:canonical-record`,
    `${command} --exclude ${secondFile}`,
  ]) {
    assert.throws(() => assertExactScriptsPartition(scriptsCommandPartition(changedCommand)));
  }

  assert.throws(() =>
    assertExactScriptsPartition({
      ...partition,
      canonicalFiles: [],
    }),
  );
  assert.throws(() =>
    assertExactScriptsPartition({
      ...partition,
      canonicalFiles: [canonicalRecordTest, canonicalRecordTest],
    }),
  );
  assert.throws(() =>
    assertExactScriptsPartition({
      ...partition,
      remainderFiles: partition.remainderFiles.filter((file) => file !== secondFile),
    }),
  );
});

test("runs both inert scripts phases in order and preserves success", () => {
  assert.deepEqual(runInertScriptsPhases(0, 0), {
    status: 0,
    trace: ["synthetic-canonical", "synthetic-complement"],
  });
});

test("preserves inert canonical failure without running the complement", () => {
  assert.deepEqual(runInertScriptsPhases(17, 0), {
    status: 17,
    trace: ["synthetic-canonical"],
  });
});

test("preserves inert complement failure after canonical success", () => {
  assert.deepEqual(runInertScriptsPhases(0, 19), {
    status: 19,
    trace: ["synthetic-canonical", "synthetic-complement"],
  });
});

test("applies the lane profile once to every shared-config consumer and the scripts battery", () => {
  setLaneMode("1");
  const laneProfile = {
    hookTimeout: 300_000,
    testTimeout: 300_000,
    maxWorkers: 2,
  };

  assert.deepEqual(resolveVitestLaneProfile({ CHASE_SETS_LANE_MODE: "1" }), laneProfile);
  assert.deepEqual(defineWorkspaceTestConfig().test, {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    ...laneProfile,
    globalSetup: [heavySlotVitestGlobalSetupPath],
    exclude: [...configDefaults.exclude, "**/dist/**"],
  });
  assert.deepEqual(defineBoundedContextTestConfig().test.include, boundedContextTestInclude);
  assert.deepEqual(defineScriptsTestConfig({ CHASE_SETS_LANE_MODE: "1" }).test, {
    ...laneProfile,
    globalSetup: [heavySlotScriptBatteryGlobalSetupPath, scriptBatteryTempCensusGlobalSetupPath],
    setupFiles: ["./scripts/lib/tracked-checkout-write-guard.mjs"],
    include: ["scripts/**/*.test.mjs"],
  });
});

test("preserves explicit workspace overrides in lane mode", () => {
  setLaneMode("1");
  const config = defineWorkspaceTestConfig({
    test: { hookTimeout: 10_000, maxWorkers: 1, testTimeout: 20_000 },
  });

  assert.equal(config.test.hookTimeout, 10_000);
  assert.equal(config.test.testTimeout, 20_000);
  assert.equal(config.test.maxWorkers, 1);
});

test("keeps the exact 70+1 tracked Vitest config topology on the shared lane resolver", () => {
  const trackedConfigs = execFileSync("git", ["ls-files", "--", "*vitest*.config.*"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: GIT_LISTING_MAX_BUFFER,
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const scriptsConfig = "vitest.scripts.config.mjs";
  const workspaceConfigs = trackedConfigs.filter((configPath) => configPath !== scriptsConfig);

  assert.equal(trackedConfigs.length, 71);
  assert.equal(workspaceConfigs.length, 70);
  assert.ok(workspaceConfigs.includes("contracts/order-groups/vitest.config.ts"));
  assert.ok(workspaceConfigs.includes("contracts/tcgplayer-market-observations/vitest.config.ts"));
  assert.deepEqual(
    trackedConfigs.filter((configPath) => configPath === scriptsConfig),
    [scriptsConfig],
  );

  for (const configPath of workspaceConfigs) {
    const source = readFileSync(path.join(repoRoot, configPath), "utf8");
    assert.match(source, /from ["'][^"']*vitest\.shared\.mjs["']/, configPath);
    assert.match(source, /export default define(?:BoundedContext|Workspace)TestConfig\(/, configPath);
    assert.doesNotMatch(source, /from ["']vitest\/config["']/, configPath);
  }

  const marketEstimateSource = readFileSync(
    path.join(repoRoot, "contracts/market-estimate-display/vitest.config.ts"),
    "utf8",
  );
  assert.match(marketEstimateSource, /defineWorkspaceTestConfig/);
  assert.match(marketEstimateSource, /environment: "node"/);
  assert.match(marketEstimateSource, /include: \["\*\*\/\*\.test\.ts"\]/);

  const scriptsSource = readFileSync(path.join(repoRoot, scriptsConfig), "utf8");
  assert.match(scriptsSource, /resolveVitestLaneProfile/);
  assert.match(scriptsSource, /export default defineScriptsTestConfig\(\)/);
  assert.match(scriptsSource, /heavySlotScriptBatteryGlobalSetupPath/);
  assert.match(scriptsSource, /include: \["scripts\/\*\*\/\*\.test\.mjs"\]/);
});
