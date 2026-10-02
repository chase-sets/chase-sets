import { defineConfig } from "@playwright/test";
import { acquireHeavySlot } from "../../scripts/lib/heavy-slot.mjs";
acquireHeavySlot("playwright");
export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../artifacts/operator-extension/test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["./e2e/artifact-reporter.ts"]],
  use: { headless: false, trace: "off", screenshot: "off", video: "off" },
});
