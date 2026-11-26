import { defineConfig, devices } from "@playwright/test";
import { createBrowserE2eRunEvidenceEnvironment } from "./scripts/browser-e2e-evidence.mjs";
import { browserE2eCortenMarketplaceTarget, resolveBrowserE2eSystemTarget } from "./scripts/dev-system-config.mjs";
import { acquireHeavySlot } from "./scripts/lib/heavy-slot.mjs";
import { resolveWorktreeSandbox } from "./scripts/lib/sandbox.mjs";

acquireHeavySlot("playwright");
const retryTelemetryReporterPath = "./deployables/admin-web/e2e/support/retry-telemetry-reporter.ts";

const sandbox = resolveWorktreeSandbox();
const adminWebBaseUrl = process.env.ADMIN_WEB_URL ?? sandbox.urls.adminWeb;
const marketplaceBaseUrl = process.env.MARKETPLACE_WEB_URL ?? sandbox.urls.marketplaceWeb;
const publicWebBaseUrl = process.env.PUBLIC_WEB_URL ?? sandbox.urls.publicWeb;
const isCi = Boolean(process.env.CI);
const renderedCopySweep = process.argv.some(
  (argument, index) => argument === "--grep" && process.argv[index + 1] === "@rendered-copy",
);
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true";
const deployedProfile = {
  grepInvert: skipWebServer ? /@browser-e2e-(?:seed|dev-source)/ : undefined,
};
const mobile = /(?:^|\s)@mobile(?:\s|$)/;
const tablet = /(?:^|\s)@tablet(?:\s|$)/;
const includeAdminWebProject = !skipWebServer || Boolean(process.env.ADMIN_WEB_URL);
// The browser-e2e dev-system targets boot platform-api, platform-worker and
// either admin-web or the Corten marketplace — not public-web. So the public-web project exists
// exactly when a caller names a running public-web host, and public-web specs
// never fall through to another deployable's host.
const includePublicWebProject = Boolean(process.env.PUBLIC_WEB_URL);
const browserE2eSystemTarget = resolveBrowserE2eSystemTarget();
// The web host the dev system boots last and Playwright waits for: the Corten marketplace target boots
// the marketplace and no admin; every other target boots admin and no marketplace.
const browserE2eSystemReadyUrl =
  browserE2eSystemTarget === browserE2eCortenMarketplaceTarget
    ? `${marketplaceBaseUrl}/health/ready`
    : `${adminWebBaseUrl}/health/ready`;
const browserE2eEvidenceEnvironment = createBrowserE2eRunEvidenceEnvironment(sandbox);
const marketplaceDesktop = {
  name: "marketplace-chromium",
  // The kept specs that run against the Corten marketplace on the marketplace host. The kept admin specs
  // sit beneath them in admin/.
  testMatch: "deployables/corten-pilot/e2e/*.spec.ts",
  use: { ...devices["Desktop Chrome"], baseURL: marketplaceBaseUrl },
};
const adminWebDesktop = {
  name: "admin-web-chromium",
  // The kept admin specs, which run against the Corten admin, and the admin-web specs not yet retired.
  testMatch: ["deployables/corten-pilot/e2e/admin/**/*.spec.ts", "deployables/admin-web/e2e/**/*.spec.ts"],
  use: { ...devices["Desktop Chrome"], baseURL: adminWebBaseUrl },
};
const projects = [
  {
    ...marketplaceDesktop,
    grepInvert: deployedProfile.grepInvert ? [mobile, deployedProfile.grepInvert] : mobile,
  },
  ...(includeAdminWebProject
    ? [
        {
          ...adminWebDesktop,
          grepInvert: deployedProfile.grepInvert ? [tablet, deployedProfile.grepInvert] : tablet,
        },
      ]
    : []),
  ...(includePublicWebProject
    ? [
        {
          name: "public-web-chromium",
          testMatch: "deployables/public-web/e2e/**/*.spec.ts",
          use: { ...devices["Desktop Chrome"], baseURL: publicWebBaseUrl },
        },
      ]
    : []),
  // Responsive journeys belong to the seeded browser stack used by local runs and PR CI.
  ...(skipWebServer
    ? []
    : [
        {
          ...marketplaceDesktop,
          name: "marketplace-mobile",
          grep: mobile,
          use: {
            ...devices["iPhone 13"],
            defaultBrowserType: "chromium",
            viewport: { width: 390, height: 844 },
            baseURL: marketplaceDesktop.use.baseURL,
          },
        },
        {
          ...adminWebDesktop,
          name: "admin-web-tablet",
          grep: tablet,
          use: {
            ...adminWebDesktop.use,
            viewport: { width: 768, height: 1024 },
            hasTouch: true,
          },
        },
      ]),
];

export default defineConfig({
  testDir: ".",
  metadata: {
    platformApiUrl: sandbox.urls.platformApi,
    catalogDatabaseUrl: sandbox.contextDatabaseUrls.catalog,
    identityDatabaseUrl: sandbox.contextDatabaseUrls.identity,
    channelsDatabaseUrl: sandbox.contextDatabaseUrls.channels,
  },
  ...deployedProfile,
  outputDir: "artifacts/playwright/test-results",
  fullyParallel: !renderedCopySweep,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  workers: isCi ? 1 : undefined,
  reporter: [
    ["list"],
    [retryTelemetryReporterPath],
    ["./scripts/lib/journey-package-reporter.mjs"],
    ["html", { open: "never", outputFolder: "artifacts/playwright/report" }],
    ...(renderedCopySweep
      ? [["json", { outputFile: "artifacts/playwright/rendered-copy-results.json" }] as const]
      : []),
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
          url: browserE2eSystemReadyUrl,
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
