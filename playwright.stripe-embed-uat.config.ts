import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./deployables/corten-pilot/e2e",
  testMatch: "**/account-payment-stripe-embed.uat.spec.ts",
  globalSetup: "./scripts/stripe-embed-uat-gates.mjs",
  outputDir: "artifacts/stripe-embed-uat/test-results",
  reporter: "list",
  retries: 0,
  workers: 1,
  use: { trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "stripe-embed-uat", use: devices["Desktop Chrome"] }],
});
