import { configDefaults, defineConfig } from "vitest/config";
import { heavySlotVitestGlobalSetupPath } from "./scripts/lib/heavy-slot.mjs";

// Canonical vitest shape for every workspace (issue #1420). Workspace configs
// import one of these factories with a small override object instead of
// cloning a config body, so the standard shape has exactly one definition.
//
// Override semantics are deliberately simple: keys under `test` replace the
// base values (no array concatenation surprises), except `exclude` and
// `globalSetup`, which compose with the safe defaults. The canonical
// heavy-slot guard always runs before consumer setup. Top-level vite options
// (plugins, resolve) pass straight through.

export const boundedContextTestInclude = [
  "features/**/*.test.ts",
  "features/**/*.test.tsx",
  "routes/**/*.test.ts",
  "routes/**/*.test.tsx",
  "support/**/*.test.ts",
  "support/**/*.test.tsx",
  "tests/**/*.test.ts",
  "tests/**/*.test.tsx",
];

export function resolveVitestLaneProfile(env = process.env) {
  if (env.CHASE_SETS_LANE_MODE !== "1") return {};

  return {
    hookTimeout: 300_000,
    testTimeout: 300_000,
    maxWorkers: 2,
  };
}

export function defineWorkspaceTestConfig(overrides = {}) {
  const { test: testOverrides = {}, ...viteOverrides } = overrides;

  return defineConfig({
    ...viteOverrides,
    test: {
      environment: "node",
      include: ["**/*.test.ts", "**/*.test.tsx"],
      hookTimeout: 120_000,
      testTimeout: 120_000,
      ...resolveVitestLaneProfile(),
      ...testOverrides,
      globalSetup: [heavySlotVitestGlobalSetupPath, ...[testOverrides.globalSetup ?? []].flat()],
      exclude: [...configDefaults.exclude, "**/dist/**", ...(testOverrides.exclude ?? [])],
    },
  });
}

export function defineBoundedContextTestConfig(overrides = {}) {
  return defineWorkspaceTestConfig({
    ...overrides,
    test: {
      include: boundedContextTestInclude,
      ...(overrides.test ?? {}),
    },
  });
}
