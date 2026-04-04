import { defineConfig } from "vitest/config";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";

export default defineConfig({
  resolve: {
    alias: createWorkspaceSourceAliases(),
  },
  test: {
    include: [
      "__tests__/**/*.test.ts",
      "../../bounded-contexts/catalog/authoring/**/*.test.ts",
    ],
    exclude: ["dist/**", "node_modules/**"],
    fileParallelism: false,
  },
});

