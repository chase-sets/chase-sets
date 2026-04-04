import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";

export default defineConfig({
  plugins: [reactRouter(), tailwindcss()],
  resolve: {
    alias: createWorkspaceSourceAliases(),
  },
  server: {
    port: 6174,
    strictPort: true,
    proxy: {
      "/api/identity": {
        target: "http://localhost:6181",
        changeOrigin: true,
      },
    },
  },
});
