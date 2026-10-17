import { defineConfig } from "@playwright/test";
import { acquireHeavySlot } from "../../scripts/lib/heavy-slot.mjs";

acquireHeavySlot("playwright");

export default defineConfig({
  testDir: ".",
  testMatch: ["e2e/**/*.spec.ts", "__tests__/extension-restart-probe-chromium.spec.ts"],
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
