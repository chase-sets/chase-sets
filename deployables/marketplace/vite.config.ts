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
    port: 6173,
    strictPort: true,
    proxy: {
      "/api/auth": {
        target: "http://localhost:6181",
        changeOrigin: true,
      },
      "/api/marketplace": {
        target: "http://localhost:6182",
        changeOrigin: true,
      },
      "/api/identity": {
        target: "http://localhost:6181",
        changeOrigin: true,
      },
      "/api/inventory": {
        target: "http://localhost:6183",
        changeOrigin: true,
      },
      "/api/settlement": {
        target: "http://localhost:6182",
        changeOrigin: true,
      },
    },
  }
});
