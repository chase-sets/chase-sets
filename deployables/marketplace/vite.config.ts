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
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      checks: {
        pluginTimings: false,
      },
    },
  },
  plugins: [reactRouter(), tailwindcss()],
  optimizeDeps: {
    include: [
      "ulid",
      "pg",
      "@chase-sets/marketplace > hono/client",
      "@chase-sets/design-system > lucide-react",
      "@chase-sets/design-system > motion/react",
      "@chase-sets/design-system > @base-ui/react/accordion",
      "@chase-sets/design-system > @base-ui/react/alert-dialog",
      "@chase-sets/design-system > @base-ui/react/autocomplete",
      "@chase-sets/design-system > @base-ui/react/combobox",
      "@chase-sets/design-system > @base-ui/react/dialog",
      "@chase-sets/design-system > @base-ui/react/field",
      "@chase-sets/design-system > @base-ui/react/fieldset",
      "@chase-sets/design-system > @base-ui/react/menu",
      "@chase-sets/design-system > @base-ui/react/navigation-menu",
      "@chase-sets/design-system > @base-ui/react/number-field",
      "@chase-sets/design-system > @base-ui/react/popover",
      "@chase-sets/design-system > @base-ui/react/radio-group",
      "@chase-sets/design-system > @base-ui/react/radio",
      "@chase-sets/design-system > @base-ui/react/scroll-area",
      "@chase-sets/design-system > @base-ui/react/select",
      "@chase-sets/design-system > @base-ui/react/separator",
      "@chase-sets/design-system > @base-ui/react/slider",
      "@chase-sets/design-system > @base-ui/react/switch",
      "@chase-sets/design-system > @base-ui/react/tabs",
      "@chase-sets/design-system > @base-ui/react/toast",
      "@chase-sets/design-system > @base-ui/react/toggle-group",
      "@chase-sets/design-system > @base-ui/react/toggle",
      "@chase-sets/design-system > @base-ui/react/toolbar",
      "@chase-sets/design-system > @base-ui/react/tooltip",
    ],
  },
  resolve: {
    alias: createWorkspaceSourceAliases(),
  },
  server: {
    host: true,
    port: Number(process.env.PORT ?? process.env.MARKETPLACE_WEB_PORT ?? 6173),
    strictPort: true,
    allowedHosts: [...localMachineHostnames, ".local", ".test"],
    cors: { origin: localDevCorsOrigins },
    proxy: {
      "/api/auth": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/marketplace": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/public-presence": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/identity": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/inventory": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/notifications": {
        target: platformApiTarget,
        changeOrigin: true,
      },
      "/api/realtime": {
        target: platformApiTarget,
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
      "/api/settlement": {
        target: platformApiTarget,
        changeOrigin: true,
      },
    },
  },
});
