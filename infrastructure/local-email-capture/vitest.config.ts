import { defineConfig } from "vitest/config";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";

export default defineConfig({
  test: { environment: "node" },
  resolve: {
    alias: createWorkspaceSourceAliases(),
  },
});
