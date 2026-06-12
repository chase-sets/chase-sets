import { configDefaults, defineConfig } from "vitest/config";

// Canonical vitest shape for every workspace (issue #1420). Workspace configs
// import one of these factories with a small override object instead of
// cloning a config body, so the standard shape has exactly one definition.
//
// Override semantics are deliberately simple: keys under `test` replace the
// base values (no array concatenation surprises), except `exclude`, which
// always appends to the safe defaults. Top-level vite options (plugins,
// resolve) pass straight through.

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

export function defineWorkspaceTestConfig(overrides = {}) {
  const { test: testOverrides = {}, ...viteOverrides } = overrides;

  return defineConfig({
    ...viteOverrides,
    test: {
      environment: "node",
      include: ["**/*.test.ts", "**/*.test.tsx"],
      hookTimeout: 120_000,
      testTimeout: 120_000,
      ...testOverrides,
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
