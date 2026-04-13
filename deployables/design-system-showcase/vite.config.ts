import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";

export default defineConfig({
  build: {
    rolldownOptions: {
      checks: {
        pluginTimings: false,
      },
    },
  },
  plugins: [reactRouter(), tailwindcss()],
  resolve: {
    alias: createWorkspaceSourceAliases(),
  },
  server: {
    port: 6171,
    strictPort: true,
  },
});
