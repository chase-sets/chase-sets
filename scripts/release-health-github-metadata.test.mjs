import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildMergeQualificationCandidate } from "./merge-qualification-advisory.mjs";
import {
  collectMergeGroupRuns,
  collectReleaseHealthGithubMetadata,
  formatGithubOutput,
  validateReleaseCandidateLinkage,
} from "./release-health-github-metadata.mjs";

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
    pull_requests: [{ number: 517, head: { sha: pullHead } }],
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
    pullRequests: run.pull_requests.map((pull) => ({ number: pull.number, headSha: pull.head.sha })),
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
      pull_requests: [{ number: 999, head: { sha: "9".repeat(40) } }],
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
    const unrelated = mergeGroupRun({
      pull_requests: [{ number: 999, head: { sha: pullHead } }],
    });
    const metadata = await collect(
      fixture({ pages: [[unrelated]], candidateRecords: new Map([["8000", candidateFor(unrelated)]]) }),
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
