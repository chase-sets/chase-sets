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
    include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
    exclude: ["build/**", "dist/**", "node_modules/**"],
    css: true
  }
});
