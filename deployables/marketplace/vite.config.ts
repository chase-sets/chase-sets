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
      },
      {
        find: /^@chase-sets\/discovery\/web$/,
        replacement: resolve(
          currentDir,
          "../../bounded-contexts/discovery/web.ts"
        )
      },
      {
        find: /^@chase-sets\/discovery$/,
        replacement: resolve(
          currentDir,
          "../../bounded-contexts/discovery/index.ts"
        )
      },
      {
        find: /^@chase-sets\/identity\/server$/,
        replacement: resolve(
          currentDir,
          "../../bounded-contexts/identity/server.ts"
        )
      },
      {
        find: /^@chase-sets\/identity\/web$/,
        replacement: resolve(
          currentDir,
          "../../bounded-contexts/identity/web.ts"
        )
      },
      {
        find: /^@chase-sets\/identity$/,
        replacement: resolve(
          currentDir,
          "../../bounded-contexts/identity/index.ts"
        )
      },
      {
        find: "@chase-sets/event-core-postgres",
        replacement: resolve(
          currentDir,
          "../../infrastructure/event-core-postgres/index.ts"
        )
      },
      {
        find: /^@chase-sets\/event-core$/,
        replacement: resolve(currentDir, "../../contracts/event-core/index.ts")
      },
      {
        find: /^@chase-sets\/event-core\/(.*)$/,
        replacement: `${resolve(currentDir, "../../contracts/event-core")}/$1`
      },
      {
        find: /^@chase-sets\/http\/(.*)$/,
        replacement: `${resolve(currentDir, "../../contracts/http")}/$1`
      },
      {
        find: /^@chase-sets\/primitives\/(.*)$/,
        replacement: `${resolve(currentDir, "../../contracts/primitives")}/$1`
      }
    ]
  },
  server: {
    port: 6173,
    strictPort: true,
    proxy: {
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
    },
  }
});

