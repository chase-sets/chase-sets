import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "__tests__/**/*.test.ts",
      "../../bounded-contexts/catalog/authoring/**/*.test.ts",
    ],
    exclude: ["dist/**", "node_modules/**"],
  },
});