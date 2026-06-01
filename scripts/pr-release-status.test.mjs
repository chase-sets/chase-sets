import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildPrReleaseStatus, parsePrReleaseStatusArgs, writePrReleaseStatus } from "./pr-release-status.mjs";

describe("PR release status", () => {
  it("describes deployable PR release posture without replacing merge queue", () => {
    const markdown = buildPrReleaseStatus({
      prNumber: "123",
      prRequiredResult: "success",
      deploymentRequired: true,
      previewResult: "success",
      exposurePostureChanged: true,
      exposurePostureCategories: "live-money-provider,tax-posture",
      checkedAt: "2026-06-01T12:00:00.000Z",
    });

    expect(markdown).toContain("<!-- chase-sets-pr-release-status -->");
    expect(markdown).toContain("GitHub merge queue remains the admission gate");
    expect(markdown).toContain("Deployable change: staging and production promotion will be required");
    expect(markdown).toContain("Exposure posture changed: live-money-provider, tax-posture.");
  });

  it("describes non-deployable PRs as no production promotion expected", () => {
    const markdown = buildPrReleaseStatus({
      prRequiredResult: "failure",
      deploymentRequired: false,
      previewResult: "skipped",
      exposurePostureChanged: false,
      exposurePostureCategories: "",
      checkedAt: "2026-06-01T12:00:00.000Z",
    });

    expect(markdown).toContain("PR Required is failure");
    expect(markdown).toContain("Non-deployable change: production promotion is not expected");
    expect(markdown).toContain("Preview: not required.");
  });

  it("writes markdown for comments and job summaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-pr-release-status-"));
    const outFile = join(directory, "status.md");
    const markdown = await writePrReleaseStatus({
      outPath: outFile,
      prRequiredResult: "success",
      deploymentRequired: true,
      previewResult: "skipped",
      exposurePostureChanged: false,
      exposurePostureCategories: "",
      checkedAt: "2026-06-01T12:00:00.000Z",
    });

    expect(await readFile(outFile, "utf8")).toBe(markdown);
  });

  it("parses GitHub workflow environment values", () => {
    expect(
      parsePrReleaseStatusArgs([], {
        PR_RELEASE_STATUS_OUT: "artifacts/pr-release-status.md",
        PR_NUMBER: "123",
        PR_REQUIRED_RESULT: "success",
        DEPLOYMENT_REQUIRED: "true",
        PREVIEW_RESULT: "skipped",
        EXPOSURE_POSTURE_CHANGED: "true",
        EXPOSURE_POSTURE_CATEGORIES: "public-marketplace-launch",
      }),
    ).toMatchObject({
      outPath: "artifacts/pr-release-status.md",
      prNumber: "123",
      prRequiredResult: "success",
      deploymentRequired: true,
      exposurePostureChanged: true,
      exposurePostureCategories: "public-marketplace-launch",
    });
  });
});
