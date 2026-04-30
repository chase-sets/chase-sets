import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "features/**/*.test.ts",
      "features/**/*.test.tsx",
      "routes/**/*.test.ts",
      "routes/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
