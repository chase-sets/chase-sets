import { describe, expect, it } from "vitest";
import {
  collectReleaseHealthCiMetadata,
  parseReleaseHealthCiMetadataArgs,
  summarizeWorkflowRuns,
} from "./release-health-ci-metadata.mjs";

const releaseCommit = "0123456789abcdef0123456789abcdef01234567";

describe("release health CI metadata", () => {
  it("summarizes retried successful workflow runs as flaky posture", () => {
    expect(
      summarizeWorkflowRuns({
        workflow_runs: [
          { name: "Platform PR", run_attempt: 3, conclusion: "success" },
          { name: "Platform PR", run_attempt: 1, conclusion: "success" },
          { name: "Platform Production", run_attempt: 2, conclusion: "failure" },
        ],
      }),
    ).toEqual({
      retryCount: 3,
      flakyFailureCount: 2,
      topFlakyJobs: [
        { name: "Platform PR", retryCount: 2, flakyFailureCount: 2 },
        { name: "Platform Production", retryCount: 1, flakyFailureCount: 0 },
      ],
    });
  });

  it("collects workflow run attempts for a release commit", async () => {
    const seen = [];
    const metadata = await collectReleaseHealthCiMetadata({
      repository: "chase-sets/chase-sets",
      releaseCommit,
      token: "token",
      fetchImpl: async (url, options) => {
        seen.push({ url, options });
        return {
          ok: true,
          json: async () => ({ workflow_runs: [{ name: "Platform PR", run_attempt: 2, conclusion: "success" }] }),
        };
      },
    });

    expect(seen[0].url.searchParams.get("head_sha")).toBe(releaseCommit);
    expect(seen[0].options.headers.Authorization).toBe("Bearer token");
    expect(metadata.retryCount).toBe(1);
    expect(metadata.flakyFailureCount).toBe(1);
  });

  it("parses GitHub workflow environment values", () => {
    expect(
      parseReleaseHealthCiMetadataArgs(["--format", "github-output"], {
        GITHUB_REPOSITORY: "chase-sets/chase-sets",
        RELEASE_COMMIT: releaseCommit,
        GH_TOKEN: "token",
      }),
    ).toMatchObject({
      repository: "chase-sets/chase-sets",
      releaseCommit,
      token: "token",
      format: "github-output",
    });
  });
});
