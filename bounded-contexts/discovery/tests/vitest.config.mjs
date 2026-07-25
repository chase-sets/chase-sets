import { defineBoundedContextTestConfig } from "../../../vitest.shared.mjs";

export default defineBoundedContextTestConfig({
  test: { setupFiles: ["./tests/test-support/vitest-setup.ts"] },
});
