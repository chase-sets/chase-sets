import { strict as assert } from "node:assert";
import { afterEach, test } from "vitest";
import { configDefaults } from "vitest/config";
import {
  boundedContextTestInclude,
  defineBoundedContextTestConfig,
  defineWorkspaceTestConfig,
  resolveVitestLaneProfile,
} from "../vitest.shared.mjs";
import { defineScriptsTestConfig } from "../vitest.scripts.config.mjs";
import { heavySlotVitestGlobalSetupPath } from "./lib/heavy-slot.mjs";
import { heavySlotScriptBatteryGlobalSetupPath } from "./lib/heavy-slot-script-battery.mjs";

const originalLaneMode = process.env.CHASE_SETS_LANE_MODE;

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
      globalSetup: [heavySlotScriptBatteryGlobalSetupPath],
      include: ["scripts/**/*.test.mjs"],
    });
  }
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
    globalSetup: [heavySlotScriptBatteryGlobalSetupPath],
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
