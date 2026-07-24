import react from "@vitejs/plugin-react";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";
import { defineWorkspaceTestConfig } from "../../vitest.shared.mjs";

export default defineWorkspaceTestConfig({
  plugins: [react()],
  resolve: { alias: createWorkspaceSourceAliases() },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./app/test-support/setup.ts",
    include: ["app/**/*.test.ts", "app/**/*.test.tsx", "e2e/support/**/*.test.ts"],
    css: true,
  },
});
