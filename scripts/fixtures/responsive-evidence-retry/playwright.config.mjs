import process from "node:process";
import { defineConfig } from "@playwright/test";

// Isolated, browserless config for the retried-capture probe in
// scripts/validate-responsive-evidence-artifacts.test.mjs. The probe passes
// --retries on the command line and points outputDir at a temporary repository
// root, so nothing lands in the checkout. The named project and
// `trace: "on-first-retry"` mirror playwright.config.ts: a first retry keeps
// its own output directory even when it captures nothing. Git info stays off:
// under GitHub Actions it defaults on and fetches the pull request base with
// --depth=1 inside the checkout holding this config, adding a shallow boundary.
const outputDir = process.env.RESPONSIVE_EVIDENCE_RETRY_PROBE_OUTPUT_DIR;
if (!outputDir) throw new Error("RESPONSIVE_EVIDENCE_RETRY_PROBE_OUTPUT_DIR is required.");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "retried-capture.spec.mjs",
  outputDir,
  captureGitInfo: { commit: false, diff: false },
  reporter: [["list"]],
  workers: 1,
  use: { trace: "on-first-retry" },
  projects: [{ name: "retry-probe" }],
});
