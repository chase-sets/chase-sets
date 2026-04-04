import { defineConfig } from "vitest/config";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";

export default defineConfig({
  resolve: {
    alias: createWorkspaceSourceAliases(),
  },
  test: {
    include: ["__tests__/**/*.test.ts", "../../bounded-contexts/discovery/tests/acceptance/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
  },
});

