import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";
import { defineWorkspaceTestConfig } from "../../vitest.shared.mjs";

export default defineWorkspaceTestConfig({
  resolve: { alias: createWorkspaceSourceAliases() },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
