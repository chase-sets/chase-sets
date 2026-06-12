import { defineWorkspaceTestConfig } from "../../../vitest.shared.mjs";

export default defineWorkspaceTestConfig({
  test: {
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 300_000,
  },
});
