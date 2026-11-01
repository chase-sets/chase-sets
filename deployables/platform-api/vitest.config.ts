import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";
import { defineWorkspaceTestConfig } from "../../vitest.shared.mjs";
import { createPlatformApiVitestOverrides } from "./scripts/lane-source-aliases.ts";

export default defineWorkspaceTestConfig({
  ...createPlatformApiVitestOverrides(process.env, createWorkspaceSourceAliases),
  test: {
    globals: true,
    include: ["__tests__/**/*.test.ts"],
  },
});
