import { defineConfig } from "@playwright/test";
import { acquireHeavySlot } from "../../scripts/lib/heavy-slot.mjs";

acquireHeavySlot("playwright");
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.chromium.spec.ts",
  workers: 1,
  use: { browserName: "chromium" },
});
