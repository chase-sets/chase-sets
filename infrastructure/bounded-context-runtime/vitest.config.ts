import { defineWorkspaceTestConfig } from "../../vitest.shared.mjs";

export default defineWorkspaceTestConfig({
  test: { pool: "vmThreads" },
});
