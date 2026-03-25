import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../../bounded-contexts/discovery/__tests__/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});