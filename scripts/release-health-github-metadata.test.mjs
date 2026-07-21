import { describe, expect, it } from "vitest";
import {
  buildReleaseHealthGithubMetadata,
  collectReleaseHealthGithubMetadata,
  formatGithubOutput,
} from "./release-health-github-metadata.mjs";

const releaseCommit = "225e00cb6e3772770b3ae764c30b5d9e6d03aa42";
const candidateCommit = "335e00cb6e3772770b3ae764c30b5d9e6d03aa43";
const sharedTree = "445e00cb6e3772770b3ae764c30b5d9e6d03aa44";
const productionMergeGroupRun = {
  id: 8000,
  run_attempt: 2,
  event: "merge_group",
  path: ".github/workflows/platform-pr.yml",
  status: "completed",
  conclusion: "success",
  head_branch: "gh-readonly-queue/main/pr-517-acde1234",
  head_sha: candidateCommit,
  candidateTreeSha: sharedTree,
  created_at: "2026-06-01T03:18:13Z",
  updated_at: "2026-06-01T03:18:40Z",
};

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
        { event: "removed_from_merge_queue", created_at: "2026-06-01T03:18:44Z" },
        { event: "merged", created_at: "2026-06-01T03:18:45Z", commit_id: releaseCommit },
      ],
      mergeGroupRuns: [productionMergeGroupRun],
      releaseTreeSha: sharedTree,
      branchRules: [{ type: "merge_queue", parameters: { max_entries_to_merge: 2 } }],
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
      queueBatchSize: 2,
      candidateSha: candidateCommit,
      candidateTreeSha: sharedTree,
      mergeGroupRunId: "8000",
      mergeGroupRunAttempt: "2",
      mergeSha: releaseCommit,
      mergeTreeSha: sharedTree,
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

  it.each([
    ["wrong tree", { candidateTreeSha: "f".repeat(40) }],
    ["wrong candidate workflow", { path: ".github/workflows/unrelated.yml" }],
    ["unrelated pull request", { head_branch: "gh-readonly-queue/main/pr-999-acde1234" }],
    ["before queue entry", { created_at: "2026-06-01T03:17:54Z" }],
    ["after merge", { created_at: "2026-06-01T03:18:46Z" }],
  ])("does not manufacture a causal bridge for %s", (_name, override) => {
    const metadata = buildReleaseHealthGithubMetadata({
      releaseCommit,
      pull: {
        number: 517,
        created_at: "2026-06-01T03:16:21Z",
        draft: false,
        merged_at: "2026-06-01T03:18:45Z",
        merge_commit_sha: releaseCommit,
      },
      timeline: [{ event: "added_to_merge_queue", created_at: "2026-06-01T03:17:55Z" }],
      mergeGroupRuns: [{ ...productionMergeGroupRun, ...override }],
      releaseTreeSha: sharedTree,
    });
    expect(metadata).toMatchObject({
      candidateSha: null,
      candidateTreeSha: null,
      mergeGroupRunId: null,
      mergeGroupRunAttempt: null,
      mergeSha: releaseCommit,
      mergeTreeSha: sharedTree,
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
        `/repos/chase-sets/chase-sets/actions/workflows/platform-pr.yml/runs?event=merge_group&per_page=100&page=1`,
        {
          total_count: 2,
          workflow_runs: [
            {
              ...productionMergeGroupRun,
              id: 7999,
              head_branch: "gh-readonly-queue/main/pr-999-unrelated",
              head_sha: "5".repeat(40),
            },
          ],
        },
      ],
      [
        `/repos/chase-sets/chase-sets/actions/workflows/platform-pr.yml/runs?event=merge_group&per_page=100&page=2`,
        { total_count: 2, workflow_runs: [productionMergeGroupRun] },
      ],
      [`/repos/chase-sets/chase-sets/git/commits/${releaseCommit}`, { tree: { sha: sharedTree } }],
      [`/repos/chase-sets/chase-sets/git/commits/${candidateCommit}`, { tree: { sha: sharedTree } }],
      [
        "/repos/chase-sets/chase-sets/rules/branches/main?per_page=100",
        [{ type: "merge_queue", parameters: { max_entries_to_merge: 2 } }],
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
      `/repos/chase-sets/chase-sets/actions/workflows/platform-pr.yml/runs?event=merge_group&per_page=100&page=2`,
    );
    expect(metadata.queueMergeGroupStartedAt).toBe("2026-06-01T03:18:13Z");
    expect(metadata.queueBatchSize).toBe(2);
  });

  it("keeps release timing metadata when branch rules are unavailable", async () => {
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
        `/repos/chase-sets/chase-sets/actions/workflows/platform-pr.yml/runs?event=merge_group&per_page=100&page=1`,
        { total_count: 1, workflow_runs: [productionMergeGroupRun] },
      ],
      [`/repos/chase-sets/chase-sets/git/commits/${releaseCommit}`, { tree: { sha: sharedTree } }],
      [`/repos/chase-sets/chase-sets/git/commits/${candidateCommit}`, { tree: { sha: sharedTree } }],
    ]);

    const metadata = await collectReleaseHealthGithubMetadata(
      { repository: "chase-sets/chase-sets", releaseCommit, token: "token" },
      {
        fetchImpl: async (url) => {
          const path = new URL(url).pathname + new URL(url).search;
          if (path.endsWith("/rules/branches/main?per_page=100")) {
            return { ok: false, status: 404, json: async () => ({}) };
          }
          return { ok: true, json: async () => responses.get(path) };
        },
      },
    );

    expect(metadata.queueMergeGroupStartedAt).toBe("2026-06-01T03:18:13Z");
    expect(metadata.queueBatchSize).toBeNull();
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
        queueBatchSize: 2,
        mergeSha: releaseCommit,
      }),
    ).toContain("queue_merge_group_started_at=2026-06-01T03:18:13Z\n");
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
        queueBatchSize: 2,
        mergeSha: releaseCommit,
      }),
    ).toContain("queue_batch_size=2\n");
  });
});
