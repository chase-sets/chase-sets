import { defineBoundedContextTestConfig } from "../../../vitest.shared.mjs";

// routes/marketplace/home.test.tsx predates this include list and has never
// run; revive it before widening the include to the standard set.
export default defineBoundedContextTestConfig({
  test: {
    environment: "jsdom",
    include: ["features/**/*.test.ts", "features/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
