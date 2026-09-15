import { defineConfig } from "@playwright/test";
import { acquireHeavySlot } from "../../scripts/lib/heavy-slot.mjs";

acquireHeavySlot("playwright");

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../artifacts/chromium-authority/test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    headless: false,
    trace: "on",
    screenshot: "only-on-failure",
    video: "off",
  },
});
