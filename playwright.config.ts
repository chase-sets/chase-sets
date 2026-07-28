import { defineConfig, devices } from "@playwright/test";
import { createBrowserE2eRunEvidenceEnvironment } from "./scripts/browser-e2e-evidence.mjs";
import { resolveBrowserE2eSystemTarget } from "./scripts/dev-system-config.mjs";
import { acquireHeavySlot } from "./scripts/lib/heavy-slot.mjs";
import { resolveWorktreeSandbox } from "./scripts/lib/sandbox.mjs";

acquireHeavySlot("playwright");
const retryTelemetryReporterPath = "./deployables/admin-web/e2e/support/retry-telemetry-reporter.ts";

const sandbox = resolveWorktreeSandbox();
const adminWebBaseUrl = process.env.ADMIN_WEB_URL ?? sandbox.urls.adminWeb;
const marketplaceBaseUrl = process.env.MARKETPLACE_WEB_URL ?? sandbox.urls.marketplaceWeb;
const isCi = Boolean(process.env.CI);
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true";
const includeAdminWebProject = !skipWebServer || Boolean(process.env.ADMIN_WEB_URL);
const browserE2eSystemTarget = resolveBrowserE2eSystemTarget();
const browserE2eEvidenceEnvironment = createBrowserE2eRunEvidenceEnvironment(sandbox);
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
  grepInvert: skipWebServer ? /@browser-e2e-seed/ : undefined,
  outputDir: "artifacts/playwright/test-results",
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  workers: isCi ? 1 : undefined,
  reporter: [
    ["list"],
    [retryTelemetryReporterPath],
    ["html", { open: "never", outputFolder: "artifacts/playwright/report" }],
  ],
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: skipWebServer
    ? undefined
    : [
        {
          command: `node ./scripts/dev-system.mjs dev ${browserE2eSystemTarget}`,
          env: browserE2eEvidenceEnvironment,
          url: `${marketplaceBaseUrl}/health/ready`,
          reuseExistingServer: !isCi,
          timeout: 600_000,
          stdout: isCi ? "pipe" : "ignore",
        },
        {
          command: "node ./scripts/browser-e2e-readiness.mjs",
          env: browserE2eEvidenceEnvironment,
          url: `${sandbox.urls.portal}/health/ready`,
          reuseExistingServer: false,
          timeout: 600_000,
          stdout: isCi ? "pipe" : "ignore",
        },
      ],
  projects,
});
