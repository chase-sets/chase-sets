import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildMergeQualificationCandidate } from "./merge-qualification-advisory.mjs";
import {
  collectMergeGroupRuns,
  collectReleaseHealthGithubMetadata,
  formatGithubOutput,
  validateReleaseCandidateLinkage,
} from "./release-health-github-metadata.mjs";
import { repoRoot } from "./lib/repo.mjs";

const repository = "chase-sets/chase-sets";
const releaseCommit = "225e00cb6e3772770b3ae764c30b5d9e6d03aa42";
const candidateCommit = "335e00cb6e3772770b3ae764c30b5d9e6d03aa43";
const sharedTree = "445e00cb6e3772770b3ae764c30b5d9e6d03aa44";
const queueBase = "555e00cb6e3772770b3ae764c30b5d9e6d03aa45";
const pullHead = "665e00cb6e3772770b3ae764c30b5d9e6d03aa46";
const imageDigest = `sha256:${"7".repeat(64)}`;
const workflowPath = ".github/workflows/platform-pr.yml";

function mergeGroupRun(overrides = {}) {
  return {
    id: 8000,
    run_attempt: 2,
    workflow_id: 11,
    event: "merge_group",
    path: workflowPath,
    status: "completed",
    conclusion: "success",
    head_sha: candidateCommit,
    pull_requests: [],
    head_commit: { id: candidateCommit, tree_id: sharedTree },
    repository: { full_name: repository },
    created_at: "2026-06-01T03:18:13Z",
    updated_at: "2026-06-01T03:18:40Z",
    ...overrides,
  };
}

function candidateFor(run, overrides = {}) {
  const { record, errors } = buildMergeQualificationCandidate({
    repository,
    workflowId: String(run.workflow_id),
    workflowPath: run.path,
    runId: String(run.id),
    runAttempt: String(run.run_attempt),
    queueBaseSha: queueBase,
    pullRequests: [{ number: 517, headSha: pullHead }],
    candidateSha: run.head_sha,
    candidateTreeSha: sharedTree,
    builtImageDigest: imageDigest,
    capturedAt: "2026-06-01T03:18:30Z",
    ...overrides,
  });
  expect(errors).toEqual([]);
  return record;
}

function fixture({
  pages,
  candidateRecords,
  pulls = [{ number: 517 }],
  pull = {},
  associatedPullsByRun = new Map(),
  branchRules = [{ type: "merge_queue", parameters: { max_entries_to_merge: 2 } }],
} = {}) {
  const defaultRun = mergeGroupRun();
  const runPages = pages ?? [[defaultRun]];
  const records = candidateRecords ?? new Map([[String(defaultRun.id), candidateFor(defaultRun)]]);
  const calls = [];
  const json = new Map([
    [`/repos/${repository}/commits/${releaseCommit}/pulls`, pulls],
    [
      `/repos/${repository}/pulls/517`,
      {
        number: 517,
        created_at: "2026-06-01T03:16:21Z",
        draft: false,
        merged_at: "2026-06-01T03:18:45Z",
        merge_commit_sha: releaseCommit,
        base: { sha: queueBase },
        head: { sha: pullHead },
        ...pull,
      },
    ],
    [
      `/repos/${repository}/pulls/517/reviews?per_page=100`,
      [{ state: "APPROVED", submitted_at: "2026-06-01T03:17:30Z" }],
    ],
    [
      `/repos/${repository}/issues/517/timeline?per_page=100`,
      [{ event: "added_to_merge_queue", created_at: "2026-06-01T03:17:55Z" }],
    ],
    [`/repos/${repository}/rules/branches/main?per_page=100`, branchRules],
    [`/repos/${repository}/git/commits/${releaseCommit}`, { tree: { sha: sharedTree } }],
  ]);
  runPages.forEach((runs, index) => {
    json.set(
      `/repos/${repository}/actions/workflows/platform-pr.yml/runs?event=merge_group&per_page=100&page=${index + 1}`,
      { total_count: runPages.reduce((total, page) => total + page.length, 0), workflow_runs: runs },
    );
  });
  for (const runs of runPages) {
    for (const run of runs) {
      const record = records.get(String(run.id));
      if (!record) continue;
      json.set(`/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100&page=1`, {
        total_count: 1,
        artifacts: [
          {
            id: Number(run.id) + 10000,
            name: `merge-qualification-candidate-${run.id}-${run.run_attempt}`,
            expired: false,
            archive_download_url: `https://artifacts.test/${run.id}`,
          },
        ],
      });
      json.set(
        `/repos/${repository}/commits/${run.head_sha}/pulls?per_page=100`,
        associatedPullsByRun.get(String(run.id)) ?? [
          {
            number: 517,
            merge_commit_sha: run.head_sha,
            head: { sha: pullHead },
            base: { sha: queueBase },
          },
        ],
      );
    }
  }
  return {
    calls,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const key = parsed.hostname === "api.github.com" ? `${parsed.pathname}${parsed.search}` : parsed.href;
      calls.push(key);
      if (parsed.hostname === "artifacts.test") {
        const runId = parsed.pathname.slice(1);
        const record = records.get(runId);
        if (!record) return new Response("missing", { status: 404 });
        return new Response(buildZip([["candidate.json", JSON.stringify(record), 8]]), { status: 200 });
      }
      if (!json.has(key)) throw new Error(`Unexpected GitHub fixture request: ${key}`);
      return new Response(JSON.stringify(json.get(key)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

async function collect(setup = fixture()) {
  return collectReleaseHealthGithubMetadata(
    { repository, releaseCommit, sourceWorkflowCreatedAt: "2026-06-01T03:16:00Z", token: "token" },
    { fetchImpl: setup.fetchImpl },
  );
}

describe("production release candidate linkage", () => {
  it("drives the real empty-pull merge_group run through the queue-snapshot CLI and post-merge release discovery", async () => {
    const realFixture = JSON.parse(
      readFileSync(
        path.join(
          repoRoot,
          "scripts/fixtures/merge-qualification/real-successful-merge-group-empty-actions-pulls.json",
        ),
        "utf8",
      ),
    );
    // Structural negative control: this assertion must fail if a future test
    // silently restores the fixture-only Actions pull list that caused the
    // production outage.
    expect(realFixture.run.pull_requests).toEqual([]);

    const workDir = mkdtempSync(path.join(tmpdir(), "merge-group-candidate-evidence-"));
    try {
      const associated = realFixture.associatedPullRequestPages[0][0];
      // Producer-time observation of run 29882700998: while the candidate was
      // queued the run was still in flight and the only pull-request
      // association GitHub exposed was its merge-queue entry. The entry shape
      // follows the introspected GraphQL contract; the recorded post-merge
      // association below proves the identities agree.
      const preMergeRun = { ...realFixture.run, status: "in_progress", conclusion: null };
      const preMergeQueueSnapshot = {
        data: {
          repository: {
            mergeQueue: {
              entries: {
                totalCount: 1,
                nodes: [
                  {
                    position: 0,
                    state: "AWAITING_CHECKS",
                    solo: false,
                    enqueuedAt: "2026-07-22T01:17:20Z",
                    headCommit: { oid: realFixture.run.head_sha },
                    baseCommit: { oid: associated.base.sha },
                    pullRequest: { number: associated.number, headRefOid: associated.head.sha },
                  },
                ],
              },
            },
          },
        },
      };
      const runPath = path.join(workDir, "run.json");
      const snapshotPath = path.join(workDir, "merge-queue-snapshot.json");
      const candidatePath = path.join(workDir, "candidate.json");
      writeFileSync(runPath, JSON.stringify(preMergeRun));
      writeFileSync(snapshotPath, JSON.stringify(preMergeQueueSnapshot));
      execFileSync(
        process.execPath,
        [
          "scripts/merge-qualification-advisory.mjs",
          "candidate-evidence",
          "--repository",
          repository,
          "--run-metadata",
          runPath,
          "--merge-queue-snapshot",
          snapshotPath,
          "--queue-base-sha",
          associated.base.sha,
          "--built-image-digest",
          imageDigest,
          "--captured-at",
          "2026-07-22T01:20:00.000Z",
          "--out",
          candidatePath,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
      expect(candidate).toMatchObject({
        runId: "29882700998",
        candidateSha: realFixture.run.head_sha,
        candidateTreeSha: realFixture.run.head_commit.tree_id,
        pullRequests: [{ number: 5888, headSha: associated.head.sha }],
      });
      const routes = new Map([
        [`/repos/${repository}/commits/${realFixture.run.head_sha}/pulls`, [{ number: associated.number }]],
        [
          `/repos/${repository}/pulls/${associated.number}`,
          { ...associated, created_at: "2026-07-21T23:39:47Z", draft: false },
        ],
        [`/repos/${repository}/pulls/${associated.number}/reviews?per_page=100`, []],
        [
          `/repos/${repository}/issues/${associated.number}/timeline?per_page=100`,
          [{ event: "added_to_merge_queue", created_at: "2026-07-22T01:17:20Z" }],
        ],
        [`/repos/${repository}/rules/branches/main?per_page=100`, []],
        [
          `/repos/${repository}/git/commits/${realFixture.run.head_sha}`,
          { tree: { sha: realFixture.run.head_commit.tree_id } },
        ],
        [
          `/repos/${repository}/actions/workflows/platform-pr.yml/runs?event=merge_group&per_page=100&page=1`,
          { total_count: 1, workflow_runs: [realFixture.run] },
        ],
        [
          `/repos/${repository}/actions/runs/${realFixture.run.id}/artifacts?per_page=100&page=1`,
          {
            total_count: 1,
            artifacts: [
              {
                id: 40000000001,
                name: `merge-qualification-candidate-${realFixture.run.id}-${realFixture.run.run_attempt}`,
                expired: false,
                archive_download_url: "https://artifacts.test/real-candidate",
              },
            ],
          },
        ],
        [
          `/repos/${repository}/commits/${realFixture.run.head_sha}/pulls?per_page=100`,
          realFixture.associatedPullRequestPages[0],
        ],
      ]);
      const metadata = await collectReleaseHealthGithubMetadata(
        {
          repository,
          releaseCommit: realFixture.run.head_sha,
          sourceWorkflowCreatedAt: "2026-07-22T01:17:00Z",
          token: "fixture",
        },
        {
          fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.href === "https://artifacts.test/real-candidate") {
              return new Response(buildZip([["candidate.json", JSON.stringify(candidate), 8]]), { status: 200 });
            }
            const key = `${parsed.pathname}${parsed.search}`;
            if (!routes.has(key)) throw new Error(`Unexpected real-shape request: ${key}`);
            return new Response(JSON.stringify(routes.get(key)), { status: 200 });
          },
        },
      );
      expect(metadata).toMatchObject({
        pullRequestNumber: 5888,
        candidateSha: realFixture.run.head_sha,
        candidateTreeSha: realFixture.run.head_commit.tree_id,
        mergeGroupRunId: String(realFixture.run.id),
        mergeGroupRunAttempt: String(realFixture.run.run_attempt),
        lineageComplete: true,
        lineageReasons: [],
      });

      // Temporal negative controls: replaying the producer after merge — the
      // completed run plus the recorded post-merge queue state (entry gone) —
      // must refuse to fabricate candidate evidence.
      const postMergeQueueSnapshot = {
        data: { repository: { mergeQueue: { entries: { totalCount: 0, nodes: [] } } } },
      };
      for (const [replayRun, replaySnapshot] of [
        [realFixture.run, preMergeQueueSnapshot],
        [preMergeRun, postMergeQueueSnapshot],
        [realFixture.run, postMergeQueueSnapshot],
      ]) {
        writeFileSync(runPath, JSON.stringify(replayRun));
        writeFileSync(snapshotPath, JSON.stringify(replaySnapshot));
        expect(() =>
          execFileSync(
            process.execPath,
            [
              "scripts/merge-qualification-advisory.mjs",
              "candidate-evidence",
              "--repository",
              repository,
              "--run-metadata",
              runPath,
              "--merge-queue-snapshot",
              snapshotPath,
              "--queue-base-sha",
              associated.base.sha,
              "--built-image-digest",
              imageDigest,
              "--captured-at",
              "2026-07-22T01:20:00.000Z",
            ],
            { cwd: repoRoot, stdio: "pipe" },
          ),
        ).toThrow();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("proves producer-time identity from the real pre-merge queue window (PR #5886, run 29890726423)", async () => {
    const fixture = JSON.parse(
      readFileSync(
        path.join(repoRoot, "scripts/fixtures/merge-qualification/real-premerge-merge-queue-snapshot.json"),
        "utf8",
      ),
    );
    // All three observations were captured in the same still-queued window:
    // the run was in flight, BOTH legacy association sources were empty at
    // the producer execution point, and the merge-queue entry alone named the
    // candidate's pull request.
    expect(fixture.run.status).toBe("in_progress");
    expect(fixture.run.pull_requests).toEqual([]);
    expect(fixture.commitPullsWhileQueued).toEqual([]);
    const entry = fixture.mergeQueueSnapshot.data.repository.mergeQueue.entries.nodes[0];
    expect(entry.headCommit.oid).toBe(fixture.run.head_sha);
    expect(entry.baseCommit.oid).toBe(fixture.queueBaseSha);

    const workDir = mkdtempSync(path.join(tmpdir(), "premerge-queue-candidate-"));
    try {
      const runPath = path.join(workDir, "run.json");
      const snapshotPath = path.join(workDir, "merge-queue-snapshot.json");
      const candidatePath = path.join(workDir, "candidate.json");
      writeFileSync(runPath, JSON.stringify(fixture.run));
      writeFileSync(snapshotPath, JSON.stringify(fixture.mergeQueueSnapshot));
      execFileSync(
        process.execPath,
        [
          "scripts/merge-qualification-advisory.mjs",
          "candidate-evidence",
          "--repository",
          repository,
          "--run-metadata",
          runPath,
          "--merge-queue-snapshot",
          snapshotPath,
          "--queue-base-sha",
          fixture.queueBaseSha,
          "--built-image-digest",
          imageDigest,
          "--captured-at",
          "2026-07-22T04:24:47.446Z",
          "--out",
          candidatePath,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
      expect(candidate).toEqual({
        schemaVersion: "merge-qualification-candidate/v2",
        repository,
        workflowId: String(fixture.run.workflow_id),
        workflowPath: fixture.run.path,
        runId: String(fixture.run.id),
        runAttempt: String(fixture.run.run_attempt),
        queueBaseSha: fixture.queueBaseSha,
        pullRequests: [{ number: entry.pullRequest.number, headSha: entry.pullRequest.headRefOid }],
        candidateSha: fixture.run.head_sha,
        candidateTreeSha: fixture.run.head_commit.tree_id,
        builtImageDigest: imageDigest,
        capturedAt: "2026-07-22T04:24:47.446Z",
      });

      // Post-merge, release discovery independently re-derives the same
      // identity from the (now populated) commit association and accepts the
      // producer's queue-snapshot record byte-for-byte.
      const merged = fixture.afterMerge;
      const associated = merged.associatedPullRequestPages[0][0];
      expect(associated.number).toBe(entry.pullRequest.number);
      expect(associated.head.sha).toBe(entry.pullRequest.headRefOid);
      expect(associated.merge_commit_sha).toBe(fixture.run.head_sha);
      const routes = new Map([
        [`/repos/${repository}/commits/${fixture.run.head_sha}/pulls`, [{ number: associated.number }]],
        [
          `/repos/${repository}/pulls/${associated.number}`,
          { ...associated, created_at: merged.pullCreatedAt, draft: false },
        ],
        [`/repos/${repository}/pulls/${associated.number}/reviews?per_page=100`, []],
        [
          `/repos/${repository}/issues/${associated.number}/timeline?per_page=100`,
          [{ event: "added_to_merge_queue", created_at: merged.addedToMergeQueueAt }],
        ],
        [`/repos/${repository}/rules/branches/main?per_page=100`, []],
        [
          `/repos/${repository}/git/commits/${fixture.run.head_sha}`,
          { tree: { sha: fixture.run.head_commit.tree_id } },
        ],
        [
          `/repos/${repository}/actions/workflows/platform-pr.yml/runs?event=merge_group&per_page=100&page=1`,
          { total_count: 1, workflow_runs: [merged.run] },
        ],
        [
          `/repos/${repository}/actions/runs/${merged.run.id}/artifacts?per_page=100&page=1`,
          {
            total_count: 1,
            artifacts: [
              {
                id: 40000000002,
                name: `merge-qualification-candidate-${merged.run.id}-${merged.run.run_attempt}`,
                expired: false,
                archive_download_url: "https://artifacts.test/premerge-candidate",
              },
            ],
          },
        ],
        [
          `/repos/${repository}/commits/${fixture.run.head_sha}/pulls?per_page=100`,
          merged.associatedPullRequestPages[0],
        ],
      ]);
      const metadata = await collectReleaseHealthGithubMetadata(
        {
          repository,
          releaseCommit: fixture.run.head_sha,
          sourceWorkflowCreatedAt: merged.run.created_at,
          token: "fixture",
        },
        {
          fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.href === "https://artifacts.test/premerge-candidate") {
              return new Response(buildZip([["candidate.json", JSON.stringify(candidate), 8]]), { status: 200 });
            }
            const key = `${parsed.pathname}${parsed.search}`;
            if (!routes.has(key)) throw new Error(`Unexpected pre-merge fixture request: ${key}`);
            return new Response(JSON.stringify(routes.get(key)), { status: 200 });
          },
        },
      );
      expect(metadata).toMatchObject({
        pullRequestNumber: 5886,
        candidateSha: fixture.run.head_sha,
        candidateTreeSha: fixture.run.head_commit.tree_id,
        mergeGroupRunId: String(fixture.run.id),
        mergeGroupRunAttempt: String(fixture.run.run_attempt),
        lineageComplete: true,
        lineageReasons: [],
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("collects the exact candidate artifact, workflow attempt, tree, digest, and final merge identity", async () => {
    const metadata = await collect();
    expect(validateReleaseCandidateLinkage(metadata, { releaseCommit })).toEqual([]);
    expect(metadata).toMatchObject({
      repository,
      releaseCommit,
      pullRequestNumber: 517,
      queueMergeGroupStartedAt: "2026-06-01T03:18:13Z",
      candidateArtifactId: "18000",
      candidateArtifactName: "merge-qualification-candidate-8000-2",
      mergeGroupWorkflowId: "11",
      mergeGroupWorkflowPath: workflowPath,
      mergeGroupRunId: "8000",
      mergeGroupRunAttempt: "2",
      candidateSha: candidateCommit,
      candidateTreeSha: sharedTree,
      candidateImageDigest: imageDigest,
      mergeSha: releaseCommit,
      mergeTreeSha: sharedTree,
      lineageComplete: true,
      lineageReasons: [],
    });
  });

  it("fetches page 2 after an old unrelated page-1 item and returns the in-window candidate", async () => {
    const old = mergeGroupRun({
      id: 7999,
      run_attempt: 1,
      head_sha: "8".repeat(40),
      created_at: "2026-05-01T03:18:13Z",
      updated_at: "2026-05-01T03:18:40Z",
    });
    const valid = mergeGroupRun();
    const setup = fixture({ pages: [[old], [valid]], candidateRecords: new Map([["8000", candidateFor(valid)]]) });
    const metadata = await collect(setup);
    expect(setup.calls).toContain(
      `/repos/${repository}/actions/workflows/platform-pr.yml/runs?event=merge_group&per_page=100&page=2`,
    );
    expect(metadata).toMatchObject({
      candidateArtifactId: "18000",
      mergeGroupRunId: "8000",
      candidateSha: candidateCommit,
      lineageComplete: false,
    });
    expect(metadata.lineageReasons).toContain("merge-group-runs:page-1:short-page:1/2");
  });

  it.each([
    ["wrong artifact workflow", { workflowId: "12" }],
    ["wrong artifact run", { runId: "8001" }],
    ["wrong artifact attempt", { runAttempt: "1" }],
    ["wrong candidate SHA", { candidateSha: "a".repeat(40) }],
    ["wrong candidate tree", { candidateTreeSha: "b".repeat(40) }],
    ["wrong pull/head linkage", { pullRequests: [{ number: 517, headSha: "d".repeat(40) }] }],
    ["temporal mismatch", { capturedAt: "2026-06-01T03:19:30Z" }],
  ])("fails lineage visibly for %s", async (_name, override) => {
    const run = mergeGroupRun();
    const setup = fixture({ pages: [[run]], candidateRecords: new Map([["8000", candidateFor(run, override)]]) });
    const metadata = await collect(setup);
    expect(metadata.candidateArtifactId).toBeNull();
    expect(metadata.lineageComplete).toBe(false);
    expect(metadata.lineageReasons.some((reason) => reason.includes("candidate-artifact-invalid"))).toBe(true);
  });

  it("does not cross-bind an unrelated same-tree run", async () => {
    const unrelated = mergeGroupRun();
    const metadata = await collect(
      fixture({
        pages: [[unrelated]],
        candidateRecords: new Map([
          ["8000", candidateFor(unrelated, { pullRequests: [{ number: 999, headSha: pullHead }] })],
        ]),
        associatedPullsByRun: new Map([
          [
            "8000",
            [
              {
                number: 999,
                merge_commit_sha: unrelated.head_sha,
                head: { sha: pullHead },
                base: { sha: queueBase },
              },
            ],
          ],
        ]),
      }),
    );
    expect(metadata).toMatchObject({ candidateArtifactId: null, candidateTreeSha: null, lineageComplete: false });
  });

  it("does not choose between exact same-tree reruns or requeues", async () => {
    const first = mergeGroupRun();
    const second = mergeGroupRun({ id: 8001, run_attempt: 1, created_at: "2026-06-01T03:18:20Z" });
    const metadata = await collect(
      fixture({
        pages: [[first, second]],
        candidateRecords: new Map([
          ["8000", candidateFor(first)],
          ["8001", candidateFor(second, { capturedAt: "2026-06-01T03:18:30Z" })],
        ]),
      }),
    );
    expect(metadata.candidateArtifactId).toBeNull();
    expect(metadata.lineageReasons).toContain("ambiguous-exact-candidates:2");
  });

  it("fails closed on revert/reland ambiguity instead of selecting by tree", async () => {
    const setup = fixture({ pulls: [{ number: 517 }, { number: 518 }], candidateRecords: new Map() });
    const metadata = await collect(setup);
    expect(metadata).toMatchObject({ pullRequestNumber: null, candidateArtifactId: null, lineageComplete: false });
    expect(metadata.lineageReasons).toContain("final-commit-pull-count:2");
  });

  it("rejects recursively contradictory loaded linkage and formats the complete bridge", async () => {
    const metadata = await collect();
    for (const invalid of [
      { ...metadata, candidateArtifactName: "merge-qualification-candidate-8000-1" },
      { ...metadata, mergeGroupWorkflowPath: ".github/workflows/unrelated.yml" },
      { ...metadata, mergeTreeSha: "f".repeat(40) },
      { ...metadata, lineageComplete: false },
      { ...metadata, lineageReasons: ["incomplete"], lineageComplete: true },
      { ...metadata, extra: true },
    ]) {
      expect(validateReleaseCandidateLinkage(invalid, { releaseCommit })).not.toEqual([]);
    }
    const output = formatGithubOutput(metadata);
    expect(output).toContain("candidate_artifact_name=merge-qualification-candidate-8000-2\n");
    expect(output).toContain("merge_qualification_lineage_version=release-candidate-linkage/v1\n");
    expect(output).toContain("lineage_complete=true\n");
    expect(output).toContain("lineage_reasons_json=[]\n");
  });
});

describe("bounded total-aware merge-group pagination", () => {
  const run = (id, createdAt) => ({ id, run_attempt: 1, created_at: createdAt });

  it("marks changed totals, duplicates, out-of-order pages, loops, and missing continuation incomplete", async () => {
    const pages = [
      { total_count: 4, workflow_runs: [run(1, "2026-07-21T10:00:00Z")] },
      { total_count: 5, workflow_runs: [run(1, "2026-07-21T11:00:00Z")] },
      { total_count: 5, workflow_runs: [] },
    ];
    const result = await collectMergeGroupRuns(
      { json: async (path) => pages[Number(new URL(`https://fixture${path}`).searchParams.get("page")) - 1] },
      { maxPages: 3 },
    );
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("declared-total-changed"),
        expect.stringContaining("page-loop"),
        expect.stringContaining("duplicate:1:1"),
        expect.stringContaining("conflicting-duplicate:1:1"),
        expect.stringContaining("out-of-order"),
        expect.stringContaining("missing-page"),
        expect.stringContaining("incomplete-total"),
      ]),
    );
    expect(result.runs).toEqual([]);
  });

  it("reports the refusal ceiling without raising it or pretending the declared total was exhausted", async () => {
    const page = Array.from({ length: 100 }, (_, index) => run(index + 1, "2026-07-21T10:00:00Z"));
    const result = await collectMergeGroupRuns(
      { json: async () => ({ total_count: 201, workflow_runs: page }) },
      { maxPages: 2 },
    );
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "merge-group-runs:refusal-ceiling:201",
        "merge-group-runs:page-2:page-loop",
        "merge-group-runs:incomplete-total:200/201",
        "merge-group-runs:refusal-ceiling-reached:2",
      ]),
    );
  });
});

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, text, method] of entries) {
    const nameBytes = Buffer.from(name);
    const contents = Buffer.from(text);
    const compressed = method === 8 ? deflateRawSync(contents) : contents;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}
