import os from "node:os";
import { defaultAllowedOrigins, defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";

const localMachineHostnames = Array.from(
  new Set(
    [os.hostname().toLowerCase(), `${os.hostname().toLowerCase()}.local`].filter(
      Boolean,
    ),
  ),
);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const localDevCorsOrigins = [
  defaultAllowedOrigins,
  ...localMachineHostnames.map(
    (hostname) => new RegExp(`^https?:\\/\\/${escapeRegExp(hostname)}(?::\\d+)?$`, "i"),
  ),
  /^https?:\/\/(?:[\w-]+\.)*[\w-]+\.local(?::\d+)?$/i,
  /^https?:\/\/(?:[\w-]+\.)*[\w-]+\.test(?::\d+)?$/i,
  /^https?:\/\/(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?::\d+)?$/,
];

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
    host: true,
    port: 6172,
    strictPort: true,
    allowedHosts: [...localMachineHostnames, ".local", ".test"],
    cors: { origin: localDevCorsOrigins },
    proxy: {
      "/api/auth": {
        target: "http://localhost:6182",
        changeOrigin: true,
      },
      "/api/catalog": {
        target: "http://localhost:6182",
        changeOrigin: true,
      },
      "/api/identity": {
        target: "http://localhost:6182",
        changeOrigin: true,
      },
      "/api/public-presence": {
        target: "http://localhost:6182",
        changeOrigin: true,
      },
    },
  },
});
