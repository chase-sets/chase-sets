import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPrReleaseStatus, parsePrReleaseStatusArgs, writePrReleaseStatus, summarizePrReleaseStatus, commentPrReleaseStatus } from "./pr-release-status.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PR release status", () => {
  it.each(["", "11\n22\n"])("publishes the last matching bot comment or creates one: %s", async (comments) => {
    const directory = await mkdtemp(join(tmpdir(), "pr-status-publish-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "status.md");
    const summary = join(directory, "summary.md");
    const body = "<!-- chase-sets-pr-release-status -->\nstatus with spaces  \n\n";
    await writeFile(source, body);
    await writeFile(summary, "preceding summary\n");
    await summarizePrReleaseStatus({ GITHUB_STEP_SUMMARY: summary }, source);
    expect(await readFile(summary, "utf8")).toBe("preceding summary\n" + body);
    const execute = vi.fn().mockReturnValueOnce(comments).mockReturnValueOnce("");
    await commentPrReleaseStatus({ GITHUB_REPOSITORY: "synthetic/repository", PR_NUMBER: "123" }, execute, source);
    expect(execute.mock.calls[0]).toEqual(["gh", ["api", "repos/synthetic/repository/issues/123/comments", "--jq", '.[] | select(.user.login == "github-actions[bot]" and (.body | contains("<!-- chase-sets-pr-release-status -->"))) | .id'], { encoding: "utf8" }]);
    expect(execute.mock.calls[1]).toEqual(["gh", ["api", "--method", comments ? "PATCH" : "POST", comments ? "repos/synthetic/repository/issues/comments/22" : "repos/synthetic/repository/issues/123/comments", "-f", `body=${body.replace(/\n+$/, "")}`], { stdio: ["ignore", "ignore", "inherit"] }]);
  });

  it("does not hide missing artifacts or withheld-credential publication failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-status-failure-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "status.md");
    const execute = vi.fn(() => { throw new Error("credentials withheld"); });
    await expect(commentPrReleaseStatus({}, execute, source)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    await writeFile(source, "status\n");
    await expect(commentPrReleaseStatus({}, execute, source)).rejects.toThrow("credentials withheld");
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(summarizePrReleaseStatus({ GITHUB_STEP_SUMMARY: join(directory, "absent", "summary") }, source)).rejects.toThrow();
  });
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
    temporaryDirectories.push(directory);
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
