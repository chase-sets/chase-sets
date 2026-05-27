import { defineConfig, devices } from "@playwright/test";
import { resolveWorktreeSandbox } from "./scripts/lib/sandbox.mjs";

const sandbox = resolveWorktreeSandbox();
const marketplaceBaseUrl = process.env.MARKETPLACE_WEB_URL ?? sandbox.urls.marketplaceWeb;
const isCi = Boolean(process.env.CI);
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true";

export default defineConfig({
  testDir: "./deployables/marketplace/e2e",
  outputDir: "artifacts/playwright/test-results",
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  workers: isCi ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never", outputFolder: "artifacts/playwright/report" }]],
  use: {
    baseURL: marketplaceBaseUrl,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: skipWebServer
    ? undefined
    : {
        command: "pnpm run dev:marketplace-full",
        url: `${marketplaceBaseUrl}/health/ready`,
        reuseExistingServer: !isCi,
        timeout: 180_000,
      },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
