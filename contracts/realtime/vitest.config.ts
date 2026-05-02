import { defineConfig } from "vitest/config";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";

export default defineConfig({
  resolve: {
    alias: createWorkspaceSourceAliases(),
  },
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.ts"],
  },
});
