import { defineWorkspaceTestConfig } from "../../vitest.shared.mjs";

export default defineWorkspaceTestConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
