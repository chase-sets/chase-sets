import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const currentDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@chase-sets/identity/server",
        replacement: resolve(currentDir, "../../bounded-contexts/identity/server.ts"),
      },
      {
        find: "@chase-sets/identity",
        replacement: resolve(currentDir, "../../bounded-contexts/identity/index.ts"),
      },
      {
        find: "@chase-sets/inventory",
        replacement: resolve(currentDir, "../../bounded-contexts/inventory/index.ts"),
      },
      {
        find: /^@chase-sets\/inventory\/web$/,
        replacement: resolve(currentDir, "../../bounded-contexts/inventory/web.ts"),
      },
      {
        find: "@chase-sets/event-core-postgres",
        replacement: resolve(
          currentDir,
          "../../infrastructure/event-core-postgres/index.ts"
        ),
      },
      {
        find: /^@chase-sets\/event-core$/,
        replacement: resolve(currentDir, "../../contracts/event-core/index.ts"),
      },
      {
        find: /^@chase-sets\/event-core\/(.*)$/,
        replacement: `${resolve(currentDir, "../../contracts/event-core")}/$1`,
      },
      {
        find: /^@chase-sets\/http\/(.*)$/,
        replacement: `${resolve(currentDir, "../../contracts/http")}/$1`,
      },
      {
        find: /^@chase-sets\/primitives\/(.*)$/,
        replacement: `${resolve(currentDir, "../../contracts/primitives")}/$1`,
      },
    ],
  },
  test: {
    include: [
      "__tests__/**/*.test.ts",
      "../../bounded-contexts/inventory/**/*.test.ts",
    ],
    exclude: ["dist/**", "node_modules/**"],
  },
});
