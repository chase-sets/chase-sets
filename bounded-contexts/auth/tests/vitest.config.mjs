import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "features/**/*.test.ts",
      "features/**/*.test.tsx",
      "support/**/*.test.ts",
      "support/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],
  },
});
