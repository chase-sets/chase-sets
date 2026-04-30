import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "features/**/*.test.ts",
      "features/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],
  },
});
