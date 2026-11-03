import { describe, expect, it } from "vitest";
import {
  buildReleaseHealthGithubMetadata,
  collectReleaseHealthGithubMetadata,
  formatGithubOutput,
} from "./release-health-github-metadata.mjs";

const releaseCommit = "225e00cb6e3772770b3ae764c30b5d9e6d03aa42";

describe("release health GitHub metadata", () => {
  it("paged collection rejects truncation and exact-payload violations", async () => {
    const execute = async (defect) => {
      const calls = [];
      const result = collectReleaseHealthGithubMetadata(
        { repository: "chase-sets/chase-sets", releaseCommit },
        {
          fetchImpl: async (url) => {
            calls.push(url);
            const parsed = new URL(url);
            if (!parsed.pathname.endsWith("/actions/runs")) return new Response("[]");
            const page = Number(parsed.searchParams.get("page"));
            const runs = page === 1 ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) : [{ id: 101 }];
            const body = { total_count: 101, workflow_runs: runs };
            const headers = {};
            if (!defect && page === 1) {
              const next = new URL(parsed);
              next.searchParams.set("page", "2");
              next.searchParams.sort();
              headers.link = `<${next.href}>; rel="next"`;
            }
            if (defect === "short" && page === 1) body.workflow_runs = runs.slice(1);
            if (defect === "duplicate" && page === 2) body.workflow_runs = [{ id: 1 }];
            if (defect === "changed-total" && page === 2) body.total_count = 102;
            if (defect === "provider-cap") body.total_count = 1000;
            if (defect === "missing-total") delete body.total_count;
            if (defect === "malformed-link" && page === 1) headers.link = "not-a-link";
            if (["later", "shifted", "loop", "unsafe-link"].includes(defect) && page === 1) {
              const next = new URL(parsed);
              next.searchParams.set("page", defect === "loop" ? "1" : defect === "later" ? "3" : "2");
              if (defect === "shifted") next.searchParams.set("per_page", "10");
              if (defect === "unsafe-link") next.hostname = "example.invalid";
              headers.link = `<${next.href}>; rel="next"`;
            }
            return new Response(JSON.stringify(body), { headers });
          },
        },
      );
      return { result, calls };
    };
    const control = await execute(null);
    await expect(control.result).resolves.toMatchObject({ pullRequestNumber: null });
    expect(control.calls.filter((url) => new URL(url).pathname.endsWith("/actions/runs"))).toHaveLength(2);
    for (const defect of [
      "short",
      "duplicate",
      "changed-total",
      "provider-cap",
      "missing-total",
      "later",
      "shifted",
      "loop",
      "unsafe-link",
      "malformed-link",
    ]) {
      const negative = await execute(defect);
      await expect(negative.result, defect).rejects.toThrow("collection_incomplete");
      expect(negative.calls.every((url) => new URL(url).hostname === "api.github.com")).toBe(true);
    }
  });

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
      mergeGroupRuns: [{ created_at: "2026-06-01T03:18:13Z" }],
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
      mergeSha: releaseCommit,
    });
  });

  it("refuses a repository-id Link that changes identity between pages", async () => {
    const responses = new Map([
      [`/repos/chase-sets/chase-sets/commits/${releaseCommit}/pulls`, [{ id: 1, number: 1 }]],
      ["/repos/chase-sets/chase-sets/pulls/1", { number: 1, created_at: "2026-06-01T03:16:21Z" }],
      ["/repos/chase-sets/chase-sets/pulls/1/reviews?per_page=100", []],
      ["/repos/chase-sets/chase-sets/issues/1/timeline?per_page=100", []],
      [
        `/repos/chase-sets/chase-sets/actions/runs?head_sha=${releaseCommit}&event=merge_group&per_page=100`,
        { workflow_runs: [] },
      ],
      ["/repos/chase-sets/chase-sets/rules/branches/main?per_page=100", []],
    ]);
    await expect(
      collectReleaseHealthGithubMetadata(
        { repository: "chase-sets/chase-sets", releaseCommit },
        {
          fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith("/commits/" + releaseCommit + "/pulls")) {
              const page = Number(parsed.searchParams.get("page"));
              const headers = {};
              if (page === 1) {
                const next = new URL(parsed);
                next.pathname = "/repositories/2/commits/" + releaseCommit + "/pulls";
                next.searchParams.set("page", "2");
                headers.link = `<${next.href}>; rel="next"`;
              }
              return new Response(
                JSON.stringify({
                  total_count: 200,
                  items: Array.from({ length: 100 }, (_, id) => ({
                    id: (page - 1) * 100 + id,
                    number: (page - 1) * 100 + id + 1,
                  })),
                }),
                { headers },
              );
            }
            return metadataFixtureResponse(url, responses);
          },
        },
      ),
    ).rejects.toThrow("collection_incomplete");
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

  it("accepts identity-less provider timeline events with a deterministic composite identity", async () => {
    const responses = new Map([
      [`/repos/chase-sets/chase-sets/commits/${releaseCommit}/pulls`, [{ id: 517, number: 517 }]],
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
        [{ event: "cross-referenced", created_at: "2026-06-01T03:17:55Z", source: { issue: { number: 517 } } }],
      ],
      [
        `/repos/chase-sets/chase-sets/actions/runs?head_sha=${releaseCommit}&event=merge_group&per_page=100`,
        { workflow_runs: [] },
      ],
      ["/repos/chase-sets/chase-sets/rules/branches/main?per_page=100", []],
    ]);
    const metadata = await collectReleaseHealthGithubMetadata(
      { repository: "chase-sets/chase-sets", releaseCommit },
      { fetchImpl: async (url) => metadataFixtureResponse(url, responses) },
    );
    expect(metadata.pullRequestNumber).toBe(517);
  });

  it("collects metadata through the GitHub REST API", async () => {
    const calls = [];
    const responses = new Map([
      [`/repos/chase-sets/chase-sets/commits/${releaseCommit}/pulls`, [{ id: 517, number: 517 }]],
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
        `/repos/chase-sets/chase-sets/actions/runs?head_sha=${releaseCommit}&event=merge_group&per_page=100`,
        { workflow_runs: [{ id: 518, created_at: "2026-06-01T03:18:13Z" }] },
      ],
      [
        "/repos/chase-sets/chase-sets/rules/branches/main?per_page=100",
        [{ type: "merge_queue", parameters: { max_entries_to_merge: 2 } }],
      ],
    ]);

    const metadata = await collectReleaseHealthGithubMetadata(
      { repository: "chase-sets/chase-sets", releaseCommit, token: "token" },
      {
        fetchImpl: async (url) => {
          calls.push(new URL(url).pathname + new URL(url).search);
          return metadataFixtureResponse(url, responses);
        },
      },
    );

    expect(calls).toContain(
      `/repos/chase-sets/chase-sets/actions/runs?head_sha=${releaseCommit}&event=merge_group&per_page=100&page=1`,
    );
    expect(metadata.queueMergeGroupStartedAt).toBe("2026-06-01T03:18:13Z");
    expect(metadata.queueBatchSize).toBe(2);
  });

  it("keeps release timing metadata when branch rules are unavailable", async () => {
    const responses = new Map([
      [`/repos/chase-sets/chase-sets/commits/${releaseCommit}/pulls`, [{ id: 517, number: 517 }]],
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
        `/repos/chase-sets/chase-sets/actions/runs?head_sha=${releaseCommit}&event=merge_group&per_page=100`,
        { workflow_runs: [{ id: 518, created_at: "2026-06-01T03:18:13Z" }] },
      ],
    ]);

    const metadata = await collectReleaseHealthGithubMetadata(
      { repository: "chase-sets/chase-sets", releaseCommit, token: "token" },
      {
        fetchImpl: async (url) => {
          const path = new URL(url).pathname;
          if (path.endsWith("/rules/branches/main")) {
            return { ok: false, status: 404, json: async () => ({}) };
          }
          return metadataFixtureResponse(url, responses);
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

function metadataFixtureResponse(url, responses) {
  const parsed = new URL(url);
  parsed.searchParams.delete("page");
  if (/\/commits\/[^/]+\/pulls$/.test(parsed.pathname)) parsed.searchParams.delete("per_page");
  let value = responses.get(parsed.pathname + parsed.search);
  if (value?.workflow_runs) value = { total_count: value.workflow_runs.length, workflow_runs: value.workflow_runs };
  return new Response(JSON.stringify(value), { status: value === undefined ? 404 : 200 });
}
