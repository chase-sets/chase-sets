import { describe, expect, it } from "vitest";
import {
  buildReleaseHealthGithubMetadata,
  collectReleaseHealthGithubMetadata,
  formatGithubOutput,
} from "./release-health-github-metadata.mjs";

const releaseCommit = "225e00cb6e3772770b3ae764c30b5d9e6d03aa42";

describe("release health GitHub metadata", () => {
  it("derives PR and merge queue timestamps from GitHub API records", () => {
    const metadata = buildReleaseHealthGithubMetadata({
      releaseCommit,
      pull: {
        number: 517,
        created_at: "2026-06-01T03:16:21Z",
        draft: false,
        merged_at: "2026-06-01T03:18:45Z",
        merge_commit_sha: releaseCommit,
      },
      reviews: [
        { state: "COMMENTED", submitted_at: "2026-06-01T03:17:10Z" },
        { state: "APPROVED", submitted_at: "2026-06-01T03:17:20Z" },
        { state: "APPROVED", submitted_at: "2026-06-01T03:17:30Z" },
      ],
      timeline: [
        { event: "added_to_merge_queue", created_at: "2026-06-01T03:17:55Z" },
        { event: "merged", created_at: "2026-06-01T03:18:45Z", commit_id: releaseCommit },
        { event: "removed_from_merge_queue", created_at: "2026-06-01T03:18:45Z" },
      ],
      mergeGroupRuns: [{ created_at: "2026-06-01T03:18:13Z" }],
    });

    expect(metadata).toEqual({
      pullRequestNumber: 517,
      prOpenedAt: "2026-06-01T03:16:21Z",
      prReadyForReviewAt: "2026-06-01T03:16:21Z",
      prApprovedAt: "2026-06-01T03:17:30Z",
      queueQueuedAt: "2026-06-01T03:17:55Z",
      queueMergeGroupStartedAt: "2026-06-01T03:18:13Z",
      queueMergedAt: "2026-06-01T03:18:45Z",
      queueDequeuedAt: null,
      queueFailureReason: null,
      mergeSha: releaseCommit,
    });
  });

  it("uses ready-for-review timeline evidence for draft PRs", () => {
    const metadata = buildReleaseHealthGithubMetadata({
      releaseCommit,
      pull: {
        number: 12,
        created_at: "2026-06-01T02:00:00Z",
        draft: false,
        merged_at: null,
        merge_commit_sha: null,
      },
      reviews: [],
      timeline: [
        { event: "ready_for_review", created_at: "2026-06-01T02:30:00Z" },
        { event: "added_to_merge_queue", created_at: "2026-06-01T03:00:00Z" },
        { event: "removed_from_merge_queue", created_at: "2026-06-01T03:05:00Z", reason: "required-check-failed" },
      ],
      mergeGroupRuns: [],
    });

    expect(metadata).toMatchObject({
      prReadyForReviewAt: "2026-06-01T02:30:00Z",
      queueQueuedAt: "2026-06-01T03:00:00Z",
      queueDequeuedAt: "2026-06-01T03:05:00Z",
      queueFailureReason: "required-check-failed",
      mergeSha: releaseCommit,
    });
  });

  it("collects metadata through the GitHub REST API", async () => {
    const calls = [];
    const responses = new Map([
      [`/repos/chase-sets/chase-sets/commits/${releaseCommit}/pulls`, [{ number: 517 }]],
      [
        "/repos/chase-sets/chase-sets/pulls/517",
        {
          number: 517,
          created_at: "2026-06-01T03:16:21Z",
          draft: false,
          merged_at: "2026-06-01T03:18:45Z",
          merge_commit_sha: releaseCommit,
        },
      ],
      ["/repos/chase-sets/chase-sets/pulls/517/reviews?per_page=100", []],
      [
        "/repos/chase-sets/chase-sets/issues/517/timeline?per_page=100",
        [{ event: "added_to_merge_queue", created_at: "2026-06-01T03:17:55Z" }],
      ],
      [
        `/repos/chase-sets/chase-sets/actions/runs?head_sha=${releaseCommit}&event=merge_group&per_page=10`,
        { workflow_runs: [{ created_at: "2026-06-01T03:18:13Z" }] },
      ],
    ]);

    const metadata = await collectReleaseHealthGithubMetadata(
      { repository: "chase-sets/chase-sets", releaseCommit, token: "token" },
      {
        fetchImpl: async (url) => {
          const path = new URL(url).pathname + new URL(url).search;
          calls.push(path);
          return { ok: true, json: async () => responses.get(path) };
        },
      },
    );

    expect(calls).toContain(
      `/repos/chase-sets/chase-sets/actions/runs?head_sha=${releaseCommit}&event=merge_group&per_page=10`,
    );
    expect(metadata.queueMergeGroupStartedAt).toBe("2026-06-01T03:18:13Z");
  });

  it("formats stable GitHub Actions outputs", () => {
    expect(
      formatGithubOutput({
        pullRequestNumber: 517,
        prOpenedAt: "2026-06-01T03:16:21Z",
        prReadyForReviewAt: "2026-06-01T03:16:21Z",
        prApprovedAt: null,
        queueQueuedAt: "2026-06-01T03:17:55Z",
        queueMergeGroupStartedAt: "2026-06-01T03:18:13Z",
        queueMergedAt: "2026-06-01T03:18:45Z",
        queueDequeuedAt: null,
        queueFailureReason: null,
        mergeSha: releaseCommit,
      }),
    ).toContain("queue_merge_group_started_at=2026-06-01T03:18:13Z\n");
  });
});
