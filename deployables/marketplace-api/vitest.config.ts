import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const currentDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@chase-sets/discovery",
        replacement: resolve(currentDir, "../../bounded-contexts/discovery/index.ts"),
      },
      {
        find: /^@chase-sets\/identity\/server$/,
        replacement: resolve(currentDir, "../../bounded-contexts/identity/server.ts"),
      },
      {
        find: /^@chase-sets\/fulfillment$/,
        replacement: resolve(currentDir, "../../bounded-contexts/fulfillment/index.ts"),
      },
      {
        find: /^@chase-sets\/reputation$/,
        replacement: resolve(currentDir, "../../bounded-contexts/reputation/index.ts"),
      },
      {
        find: "@chase-sets/identity",
        replacement: resolve(currentDir, "../../bounded-contexts/identity/index.ts"),
      },
      {
        find: /^@chase-sets\/marketplace-context\/web$/,
        replacement: resolve(currentDir, "../../bounded-contexts/marketplace/web.ts"),
      },
      {
        find: "@chase-sets/marketplace-context",
        replacement: resolve(currentDir, "../../bounded-contexts/marketplace/index.ts"),
      },
      {
        find: "@chase-sets/catalog-authoring",
        replacement: resolve(currentDir, "../../bounded-contexts/catalog/authoring/index.ts"),
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
    include: ["__tests__/**/*.test.ts", "../../bounded-contexts/discovery/tests/acceptance/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
