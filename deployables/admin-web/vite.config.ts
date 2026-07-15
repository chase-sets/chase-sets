import os from "node:os";
import { defaultAllowedOrigins, defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { createWorkspaceSourceAliases } from "../../scripts/workspace-source-aliases.mjs";

const localMachineHostnames = Array.from(
  new Set([os.hostname().toLowerCase(), `${os.hostname().toLowerCase()}.local`].filter(Boolean)),
);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const localDevCorsOrigins = [
  defaultAllowedOrigins,
  ...localMachineHostnames.map((hostname) => new RegExp(`^https?:\\/\\/${escapeRegExp(hostname)}(?::\\d+)?$`, "i")),
  /^https?:\/\/(?:[\w-]+\.)*[\w-]+\.local(?::\d+)?$/i,
  /^https?:\/\/(?:[\w-]+\.)*[\w-]+\.test(?::\d+)?$/i,
  /^https?:\/\/(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?::\d+)?$/,
];
const platformApiTarget = process.env.VITE_PLATFORM_API_URL ?? process.env.PLATFORM_API_URL ?? "http://localhost:6182";

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
    port: Number(process.env.PORT ?? process.env.ADMIN_WEB_PORT ?? 6172),
    strictPort: true,
    allowedHosts: [...localMachineHostnames, ".local", ".test"],
    cors: { origin: localDevCorsOrigins },
    proxy: {
      "/api/auth": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/catalog": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/commercial-terms": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/identity": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/experience": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/marketplace": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/platform": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/public-presence": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/settlement": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/realtime": {
        target: platformApiTarget,
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});
