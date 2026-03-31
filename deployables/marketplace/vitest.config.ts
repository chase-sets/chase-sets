import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const currentDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
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
        find: /^@chase-sets\/inventory\/web$/,
        replacement: resolve(
          currentDir,
          "../../bounded-contexts/inventory/web.ts"
        )
      },
      {
        find: /^@chase-sets\/inventory$/,
        replacement: resolve(
          currentDir,
          "../../bounded-contexts/inventory/index.ts"
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
  test: {
    environment: "jsdom",
    globals: true,
    include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
    css: true
  }
});


