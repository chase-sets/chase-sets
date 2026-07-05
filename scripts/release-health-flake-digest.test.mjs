import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildDigestWindows,
  buildFlakeDigest,
  collectReleaseHealthFlakeDigest,
  parseReleaseHealthFlakeDigestArgs,
  summarizeWorkflowRuns,
  writeReleaseHealthFlakeDigest,
} from "./release-health-flake-digest.mjs";

describe("release health flake digest", () => {
  it("summarizes retry telemetry by workflow name", () => {
    const summary = summarizeWorkflowRuns([
      { name: "Platform PR", run_attempt: 3, conclusion: "success" },
      { name: "Platform PR", run_attempt: 2, conclusion: "failure" },
      { name: "Platform Production", run_attempt: 1, conclusion: "success" },
    ]);

    expect(summary.retryCount).toBe(3);
    expect(summary.flakyFailureCount).toBe(2);
    expect([...summary.jobs.values()]).toEqual([{ name: "Platform PR", retryCount: 3, flakyFailureCount: 2 }]);
  });

  it("builds a weekly digest with previous-window trends and breaches", () => {
    const windows = buildDigestWindows("2026-07-08T00:00:00.000Z", 7);
    const digest = buildFlakeDigest({
      checkedAt: "2026-07-08T00:00:00.000Z",
      repository: "chase-sets/chase-sets",
      windows,
      thresholds: { retryCount: 3, flakyFailureCount: 1 },
      currentRuns: [
        { name: "Platform PR", run_attempt: 3, conclusion: "success" },
        { name: "Platform PR", run_attempt: 2, conclusion: "success" },
        { name: "Platform Production", run_attempt: 2, conclusion: "failure" },
      ],
      previousRuns: [{ name: "Platform PR", run_attempt: 2, conclusion: "success" }],
    });

    expect(digest).toMatchObject({
      schemaVersion: "release-health-flake-digest/v1",
      retryCount: 4,
      flakyFailureCount: 3,
      previousRetryCount: 1,
      previousFlakyFailureCount: 1,
      breachCount: 1,
      issueTitle: "CI flake digest breach: 2026-07-01 to 2026-07-08",
    });
    expect(digest.topFlakyJobs[0]).toMatchObject({
      name: "Platform PR",
      retryCount: 3,
      flakyFailureCount: 3,
      previousRetryCount: 1,
      retryTrend: 2,
      flakyFailureTrend: 2,
      breached: true,
    });
    expect(digest.markdown).toContain("| Platform PR | 3 | +2 | 3 | +2 | yes |");
    expect(digest.issueBody).toContain("Follow-up policy");
  });

  it("collects current and previous workflow windows from GitHub", async () => {
    const seen = [];
    const digest = await collectReleaseHealthFlakeDigest({
      repository: "chase-sets/chase-sets",
      token: "token",
      checkedAt: "2026-07-08T00:00:00.000Z",
      windowDays: 7,
      retryThreshold: 3,
      flakyFailureThreshold: 1,
      fetchImpl: async (url, options) => {
        seen.push({ url: new URL(url), options });
        return {
          ok: true,
          headers: { get: () => null },
          json: async () => ({
            workflow_runs: url.searchParams.get("created")?.startsWith("2026-07-01")
              ? [{ name: "Platform PR", run_attempt: 2, conclusion: "success" }]
              : [],
          }),
        };
      },
    });

    expect(seen).toHaveLength(2);
    expect(seen[0].options.headers.Authorization).toBe("Bearer token");
    expect(seen.map((call) => call.url.searchParams.get("created")).sort()).toEqual([
      "2026-06-24T00:00:00.000Z..2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z..2026-07-08T00:00:00.000Z",
    ]);
    expect(digest.retryCount).toBe(1);
  });

  it("writes json, markdown, and GitHub outputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flake-digest-"));
    try {
      const outPath = join(dir, "digest.json");
      const markdownOutPath = join(dir, "digest.md");
      const githubOutputPath = join(dir, "github-output.txt");
      await writeReleaseHealthFlakeDigest({
        repository: "chase-sets/chase-sets",
        checkedAt: "2026-07-08T00:00:00.000Z",
        windowDays: 7,
        retryThreshold: 1,
        flakyFailureThreshold: 1,
        outPath,
        markdownOutPath,
        githubOutputPath,
        fetchImpl: async (url) => ({
          ok: true,
          headers: { get: () => null },
          json: async () => ({
            workflow_runs: url.searchParams.get("created")?.startsWith("2026-07-01")
              ? [{ name: "Platform PR", run_attempt: 2, conclusion: "success" }]
              : [],
          }),
        }),
      });

      expect(JSON.parse(await readFile(outPath, "utf8"))).toMatchObject({ breachCount: 1 });
      expect(await readFile(markdownOutPath, "utf8")).toContain("CI flake digest");
      expect(await readFile(githubOutputPath, "utf8")).toContain("breach_count=1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses workflow defaults from the environment", () => {
    expect(
      parseReleaseHealthFlakeDigestArgs(["--window-days", "14"], {
        GITHUB_REPOSITORY: "chase-sets/chase-sets",
        GH_TOKEN: "token",
        GITHUB_OUTPUT: "github-output.txt",
      }),
    ).toMatchObject({
      repository: "chase-sets/chase-sets",
      token: "token",
      windowDays: 14,
      retryThreshold: 3,
      flakyFailureThreshold: 1,
      githubOutputPath: "github-output.txt",
    });
  });
});
