import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const authorityRoot = path.resolve(import.meta.dirname, "../..", "artifacts/playwright-evidence-authority");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "corpus.capture.spec.ts",
  outputDir: path.join(authorityRoot, "test-results"),
  workers: 1,
  retries: 1,
  reporter: [
    ["html", { outputFolder: path.join(authorityRoot, "html-report"), open: "never" }],
    ["json", { outputFile: path.join(authorityRoot, "report.json") }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    trace: "on-first-retry",
    video: "on-first-retry",
    screenshot: "off",
  },
  projects: [{ name: "authority-corpus", use: { browserName: "chromium" } }],
});
