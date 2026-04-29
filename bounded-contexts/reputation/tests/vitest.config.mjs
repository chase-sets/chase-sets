import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const currentDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@chase-sets\/fulfillment$/,
        replacement: resolve(currentDir, "../../fulfillment/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["../**/*.test.ts", "../**/*.test.tsx"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
