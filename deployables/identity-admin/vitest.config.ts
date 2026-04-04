import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: createWorkspaceSourceAliases(),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
    css: true,
  },
});
