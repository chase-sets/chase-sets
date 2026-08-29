import { defineConfig } from "vitest/config";
import { heavySlotScriptBatteryGlobalSetupPath } from "./scripts/lib/heavy-slot-script-battery.mjs";
import { resolveVitestLaneProfile } from "./vitest.shared.mjs";

// Single vitest configuration for every script-level test under scripts/.
// verify:static invokes this once instead of spawning one vitest process per
// file (issue #1327). Rule: a new check may be added to verify:static only by
// replacing or merging into an existing step — new script tests are picked up
// here automatically and must not become their own chain entries.
export function defineScriptsTestConfig(env = process.env) {
  return defineConfig({
    test: {
      ...resolveVitestLaneProfile(env),
      globalSetup: [heavySlotScriptBatteryGlobalSetupPath],
      include: ["scripts/**/*.test.mjs"],
    },
  });
}

export default defineScriptsTestConfig();
