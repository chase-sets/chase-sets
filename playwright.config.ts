import { defineConfig, devices } from "@playwright/test";
import { resolveWorktreeSandbox } from "./scripts/lib/sandbox.mjs";

const sandbox = resolveWorktreeSandbox();
const adminWebBaseUrl = process.env.ADMIN_WEB_URL ?? sandbox.urls.adminWeb;
const marketplaceBaseUrl = process.env.MARKETPLACE_WEB_URL ?? sandbox.urls.marketplaceWeb;
const isCi = Boolean(process.env.CI);
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true";
const hasDeployedAdminCredentials =
  Boolean(process.env.CATALOG_ADMIN_E2E_EMAIL?.trim()) && Boolean(process.env.CATALOG_ADMIN_E2E_PASSWORD?.trim());
const includeAdminWebProject = !skipWebServer || (Boolean(process.env.ADMIN_WEB_URL) && hasDeployedAdminCredentials);
const projects = [
  {
    name: "marketplace-chromium",
    testMatch: "deployables/marketplace/e2e/**/*.spec.ts",
    use: { ...devices["Desktop Chrome"], baseURL: marketplaceBaseUrl },
  },
  ...(includeAdminWebProject
    ? [
        {
          name: "admin-web-chromium",
          testMatch: "deployables/admin-web/e2e/**/*.spec.ts",
          use: { ...devices["Desktop Chrome"], baseURL: adminWebBaseUrl },
        },
      ]
    : []),
];

export default defineConfig({
  testDir: ".",
  outputDir: "artifacts/playwright/test-results",
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  workers: isCi ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never", outputFolder: "artifacts/playwright/report" }]],
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: skipWebServer
    ? undefined
    : {
        command: "pnpm run dev:browser-e2e",
        url: `${marketplaceBaseUrl}/health/ready`,
        reuseExistingServer: !isCi,
        timeout: 300_000,
      },
  projects,
});
