import { defineBoundedContextTestConfig } from "../../../vitest.shared.mjs";

export default defineBoundedContextTestConfig({
  test: {
    environment: "jsdom",
    include: [
      "features/**/*.test.ts",
      "features/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "routes/marketplace/home.test.tsx",
    ],
  },
});
