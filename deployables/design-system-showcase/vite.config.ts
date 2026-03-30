import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";

const currentDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [reactRouter(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: "@chase-sets/design-system/styles.css",
        replacement: resolve(
          currentDir,
          "../../packages/design-system/src/styles/tailwind.css"
        )
      },
      {
        find: "@chase-sets/design-system",
        replacement: resolve(
          currentDir,
          "../../packages/design-system/src/index.ts"
        )
      }
    ]
  },
  server: {
    port: 6171,
    strictPort: true,
  },
});
