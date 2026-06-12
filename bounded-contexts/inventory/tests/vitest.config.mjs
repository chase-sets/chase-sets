import { defineBoundedContextTestConfig } from "../../../vitest.shared.mjs";

// The import-batches and inventory-items UI suites (features/**/*.test.tsx)
// predate this include list and have never run; revive them before widening
// the include to the standard bounded-context set.
export default defineBoundedContextTestConfig({
  test: {
    include: ["features/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
