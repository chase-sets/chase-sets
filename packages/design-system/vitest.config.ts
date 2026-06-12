import { defineWorkspaceTestConfig } from "../../vitest.shared.mjs";

export default defineWorkspaceTestConfig({
  test: { environment: "jsdom", globals: true },
});
