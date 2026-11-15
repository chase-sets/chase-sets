import path from "node:path";
import process from "node:process";
import { defineConfig } from "@playwright/test";

// Browserless config for the journey package tests. Each run points testDir at
// a temporary root that mirrors the repository layout, so the real reporter
// matches the real contract target without a test-only override, and every
// output lands in that root. Git info stays off so no run touches this checkout.
// A failed dependency leaves the target never dispatched (not executed).
const root = process.env.JOURNEY_PACKAGE_FIXTURE_ROOT;
if (!root) throw new Error("JOURNEY_PACKAGE_FIXTURE_ROOT is required.");
const dependsOnOther = process.env.JOURNEY_PACKAGE_FIXTURE_DEPENDS_ON_OTHER === "true";

export default defineConfig({
  testDir: root,
  outputDir: path.join(root, "artifacts/playwright/test-results"),
  captureGitInfo: { commit: false, diff: false },
  reporter: [["list"], [path.join(import.meta.dirname, "../../lib/journey-package-reporter.mjs")]],
  workers: Number(process.env.JOURNEY_PACKAGE_FIXTURE_WORKERS ?? "1"),
  maxFailures: Number(process.env.JOURNEY_PACKAGE_FIXTURE_MAX_FAILURES ?? "0"),
  projects: [
    { name: "other-project", testMatch: "other/**/*.spec.ts" },
    {
      name: "marketplace-chromium",
      testMatch: "deployables/marketplace/e2e/**/*.spec.ts",
      dependencies: dependsOnOther ? ["other-project"] : [],
    },
  ],
});
