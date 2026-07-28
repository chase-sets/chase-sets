import { defineConfig } from "vitest/config";
import { heavySlotVitestGlobalSetupPath } from "../../scripts/lib/heavy-slot.mjs";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: [heavySlotVitestGlobalSetupPath],
    include: ["**/*.test.ts"],
  },
});
