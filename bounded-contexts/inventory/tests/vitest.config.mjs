import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["features/**/*.test.ts", "tests/**/*.test.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
