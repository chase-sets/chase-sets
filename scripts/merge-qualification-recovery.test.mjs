import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { repoRoot } from "./lib/repo.mjs";
import {
  buildMergeQualificationCandidate,
  recoverMergeQualificationDecision,
  resolveMergeQualificationQueueDisposition,
  observeMergeQualificationQueueDisposition,
  resolveRunTerminalization,
  buildCancelledMergeQualificationRecord,
  buildMergeQualificationEvent,
  resolveMergeQualificationTerminalReplay,
  readMergeQualificationTerminalRecords,
  inventoryMergeQualificationAttempts,
  validateMergeQualificationEvent,
  readMergeQualificationRunCollection,
} from "./merge-qualification.mjs";
import { buildMergeGateProvisioningObservation } from "./merge-gate-verification.mjs";

// Synthetic control identities, not captured GitHub authority.
const sha = "a".repeat(40);
const revision = "b".repeat(40);
const candidate = buildMergeQualificationCandidate({
  repository: "synthetic/repository",
  workflowId: "11",
  workflowPath: ".github/workflows/platform-pr.yml",
  runId: "20",
  runAttempt: "1",
  queueBaseSha: "c".repeat(40),
  pullRequests: [{ number: 1, headSha: "d".repeat(40) }],
  candidateSha: sha,
  candidateTreeSha: "e".repeat(40),
  builtImageDigest: `sha256:${"f".repeat(64)}`,
  capturedAt: "2026-07-21T10:00:00Z",
}).record;
const run = {
  repository: { full_name: candidate.repository },
  id: 30,
  run_attempt: 1,
  workflow_id: 12,
  path: ".github/workflows/platform-merge-qualification.yml",
  event: "workflow_dispatch",
  display_title: "Merge Qualification producer 20-1",
  head_sha: revision,
  run_started_at: "2026-07-21T10:00:00.000Z",
};
const parentRun = {
  repository: run.repository,
  id: 20,
  run_attempt: 1,
  workflow_id: 11,
  path: ".github/workflows/platform-pr.yml",
  event: "merge_group",
  head_sha: sha,
};
const policy = JSON.stringify({
  schemaVersion: "merge-qualification-policy/v1",
  enabled: true,
  owner: "synthetic-owner",
  ceiling: { dollarCeilingUsd: 25, maxQualificationsPerDay: 20 },
  enabledAt: "2026-07-20T00:00:00Z",
  expiresAt: "2026-07-22T00:00:00Z",
});
const classifierRecord = {
  schemaVersion: "release-qualification-scope/v1",
  class: "isolated",
  reasonCodes: ["application_runtime"],
  candidate: { sha, treeSha: candidate.candidateTreeSha },
};

describe("scheduled advisory attempt inventory", () => {
  const completed = { ...run, status: "completed", conclusion: "success" };
  const inventory = (runs, options = {}) =>
    inventoryMergeQualificationAttempts({
      repository: candidate.repository,
      requestJson: async () => ({ total_count: runs.length, workflow_runs: runs }),
      readPolicyContent: async () => policy,
      ...options,
    });
  it.each([
    "success",
    "failure",
    "neutral",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "stale",
    "startup_failure",
    "future_unknown",
  ])("AC5 inventories completed %s without requiring workflow_run delivery", async (conclusion) => {
    expect(await inventory([{ ...completed, conclusion }])).toEqual({
      attempts: [{ run_id: "30", run_attempt: "1", workflow_id: "12", conclusion }],
      errors: [],
    });
  });
  it("AC1 selects the latest exact attempt before filtering completed state", async () => {
    expect(await inventory([completed, { ...completed, run_attempt: 2, status: "in_progress" }])).toEqual({
      attempts: [],
      errors: [],
    });
    expect((await inventory([completed, { ...completed, run_attempt: 2 }])).attempts[0].run_attempt).toBe("2");
  });
  it("AC2 evaluates historical policy at the original attempt instant", async () => {
    const revisions = [];
    const result = await inventory([completed], {
      readPolicyContent: async (head) => {
        revisions.push(head);
        return policy;
      },
    });
    expect(revisions).toEqual([revision]);
    expect(result.attempts).toHaveLength(1);
    expect(await inventory([completed], { readPolicyContent: async () => null })).toEqual({ attempts: [], errors: [] });
    expect(
      (
        await inventory([completed], {
          readPolicyContent: async () => {
            throw new Error("secret-marker");
          },
        })
      ).errors,
    ).toEqual(["attempt_authority_unavailable"]);
  });
  it.each([
    { id: "3e1" },
    { id: "9007199254740992" },
    { run_attempt: 0 },
    { head_sha: "main" },
    { run_started_at: null },
    { repository: { full_name: "untrusted/fork" } },
  ])("AC5 refuses malformed exact identity %j", async (change) => {
    expect((await inventory([{ ...completed, ...change }])).errors.length).toBeGreaterThan(0);
  });
  it("AC5 refuses incomplete, repeated and over-cap pages before filtering", async () => {
    for (const response of [
      { total_count: 2, workflow_runs: [completed] },
      { total_count: 10_001, workflow_runs: [] },
      { total_count: 2, workflow_runs: [completed, { ...completed, conclusion: "failure" }] },
    ])
      expect((await inventory([], { requestJson: async () => response })).errors.length).toBeGreaterThan(0);
  });
  it("AC5 reads later pages and does not stop at old or disabled runs", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ ...completed, id: 1000 + i, head_sha: sha }));
    const pages = [];
    const result = await inventory([], {
      requestJson: async (endpoint) => {
        pages.push(endpoint);
        return { total_count: 101, workflow_runs: pages.length === 1 ? first : [completed] };
      },
      readPolicyContent: async (head) => (head === revision ? policy : null),
    });
    expect(pages).toHaveLength(2);
    expect(result.attempts).toHaveLength(1);
  });
});

describe("bounded exact attempt collections", () => {
  const read = (requestJson, collection = "jobs") =>
    readMergeQualificationRunCollection({
      repository: candidate.repository,
      runId: "30",
      runAttempt: "2",
      collection,
      requestJson,
    });
  it("reads complete later pages from the attempt-specific jobs endpoint", async () => {
    const calls = [];
    const result = await read(async (endpoint) => {
      calls.push(endpoint);
      return {
        total_count: 101,
        jobs: calls.length === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) : [{ id: 101 }],
      };
    });
    expect(calls).toEqual([
      "repos/synthetic/repository/actions/runs/30/attempts/2/jobs?per_page=100&page=1",
      "repos/synthetic/repository/actions/runs/30/attempts/2/jobs?per_page=100&page=2",
    ]);
    expect(result.jobs).toHaveLength(101);
  });
  it.each([
    { total_count: 2, jobs: [{ id: 1 }] },
    { total_count: 2, jobs: [{ id: 1 }, { id: 1 }] },
    { total_count: 10001, jobs: [] },
    { total_count: 1, jobs: [{ id: "1e2" }] },
  ])("refuses incomplete or duplicate authority %j", async (payload) => {
    await expect(read(async () => payload)).rejects.toThrow();
  });
  it("keeps artifacts run-scoped with complete totals", async () => {
    await expect(
      read(async (endpoint) => {
        expect(endpoint).toBe("repos/synthetic/repository/actions/runs/30/artifacts?per_page=100&page=1");
        return { total_count: 0, artifacts: [] };
      }, "artifacts"),
    ).resolves.toEqual({ total_count: 0, artifacts: [] });
  });
});

describe("durable observer terminal replay", () => {
  const decision = recoverMergeQualificationDecision({
    run,
    parentRun,
    candidate,
    policyRevision: revision,
    policyContent: policy,
    classifierRecord,
  }).decision;
  const event = buildMergeQualificationEvent({
    ...decision,
    terminalState: "cancelled_evicted",
    builtImageDigest: null,
    reasonCodes: ["run_force_cancelled"],
    provisioned: false,
    startedAt: run.run_started_at,
    completedAt: "2026-07-21T10:05:00.000Z",
    evidenceLinks: ["https://github.com/synthetic/repository/actions/runs/30/attempts/1"],
  }).event;
  const bytes = `${JSON.stringify(event, null, 2)}\n`;
  const artifact = {
    id: 100,
    name: "merge-qualification-terminal-30-1",
    expired: false,
    workflow_run: { id: 40 },
  };
  const owner = {
    id: 40,
    repository: run.repository,
    head_repository: run.repository,
    path: ".github/workflows/platform-merge-qualification-observer.yml",
    event: "schedule",
    head_branch: "main",
  };
  it("AC1 accepts exact durable bytes on next-day replay without rebuilding a terminal", () => {
    expect(resolveMergeQualificationTerminalReplay({ decision, records: [bytes, bytes] })).toEqual({
      action: "replay",
      event,
      errors: [],
    });
    expect(resolveMergeQualificationTerminalReplay({ decision, records: [] })).toEqual({
      action: "missing",
      event: null,
      errors: [],
    });
  });
  it.each([
    ["conflicting result", [bytes, JSON.stringify({ ...event, reasonCodes: ["gate_cancelled"] })]],
    ["non-identical bytes", [bytes, JSON.stringify(event)]],
    ["wrong attempt", [JSON.stringify({ ...event, runAttempt: "2" })]],
    ["wrong candidate", [JSON.stringify({ ...event, candidateSha: "1".repeat(40) })]],
    ["malformed", ["{secret-marker-not-json"]],
    ["missing inventory", null],
    ["oversized payload", [" ".repeat(65_537)]],
  ])("AC1 refuses %s without disclosing payload data", (_label, records) => {
    const result = resolveMergeQualificationTerminalReplay({ decision, records });
    expect(result.action).toBe("unknown");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("secret-marker");
  });
  it("AC2 disabled replay never calls the authority transport", async () => {
    const disabled = {
      ...decision,
      policyEnabled: false,
      policyReasonCode: "policy_disabled",
      classifierClass: null,
      classifierReasonCodes: [],
    };
    const result = await readMergeQualificationTerminalRecords({
      decision: disabled,
      defaultBranch: "main",
      requestJson: () => {
        throw new Error("transport must not run");
      },
      downloadArtifact: () => {
        throw new Error("download must not run");
      },
    });
    expect(result).toEqual({ records: [], errors: [] });
  });
  it("AC1 reads the exact artifact payload only after validating the observer owner", async () => {
    const calls = [];
    const result = await readMergeQualificationTerminalRecords({
      decision,
      defaultBranch: "main",
      requestJson: async (endpoint) => {
        calls.push(endpoint);
        return endpoint.includes("/artifacts?") ? { total_count: 1, artifacts: [artifact] } : owner;
      },
      downloadArtifact: async (input) => {
        calls.push(input);
        return bytes;
      },
    });
    expect(result).toEqual({ records: [bytes], errors: [] });
    expect(calls).toEqual([
      "repos/synthetic/repository/actions/artifacts?name=merge-qualification-terminal-30-1&per_page=100&page=1",
      "repos/synthetic/repository/actions/runs/40",
      { runId: "40", name: artifact.name },
    ]);
  });
  it.each([
    ["expired", { artifact: { ...artifact, expired: true } }],
    ["wrong name", { artifact: { ...artifact, name: "diagnostics" } }],
    ["wrong owner workflow", { owner: { ...owner, path: ".github/workflows/platform-pr.yml" } }],
    ["wrong owner branch", { owner: { ...owner, head_branch: "untrusted" } }],
    ["wrong owner repository", { owner: { ...owner, repository: { full_name: "untrusted/fork" } } }],
    ["wrong owner identity", { owner: { ...owner, id: 41 } }],
    ["truncated page", { total: 2 }],
    ["over cap", { total: 10001 }],
    ["transport error", { transportError: true }],
  ])("AC1 refuses %s without downloading or publishing", async (_label, mutation) => {
    let downloaded = false;
    const result = await readMergeQualificationTerminalRecords({
      decision,
      defaultBranch: "main",
      requestJson: async (endpoint) => {
        if (mutation.transportError) throw new Error("secret-marker-transport");
        return endpoint.includes("/artifacts?")
          ? { total_count: mutation.total ?? 1, artifacts: [mutation.artifact ?? artifact] }
          : (mutation.owner ?? owner);
      },
      downloadArtifact: async () => {
        downloaded = true;
        return bytes;
      },
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(downloaded).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-marker");
  });
});

describe("recovered cancelled-record production writer", () => {
  const decision = recoverMergeQualificationDecision({
    run,
    parentRun,
    candidate,
    policyRevision: revision,
    policyContent: policy,
    classifierRecord,
  }).decision;
  const cancelled = {
    ...run,
    conclusion: "cancelled",
    updated_at: "2026-07-21T10:05:00.000Z",
    html_url: "https://github.com/synthetic/repository/actions/runs/30",
  };
  const ownership = buildMergeGateProvisioningObservation({
    repository: candidate.repository,
    workflowId: "12",
    workflowPath: run.path,
    runId: "30",
    runAttempt: "1",
    namespace: "chase-sets-gate-30-1",
    candidateSha: sha,
    candidateTreeSha: candidate.candidateTreeSha,
    imageDigest: candidate.builtImageDigest,
    observedAt: "2026-07-21T10:01:00.000Z",
  });
  it("AC4 accepts recovered original decision after the child's decision upload is lost", () => {
    const result = buildCancelledMergeQualificationRecord({ decision, ownership, run: cancelled });
    expect(result.errors).toEqual([]);
    expect(result.record).toMatchObject({
      result: "fail",
      startedAt: run.run_started_at,
      runId: "30",
      runAttempt: "1",
      candidateSha: sha,
      imageDigest: candidate.builtImageDigest,
    });
  });
  it("AC4 refuses absent or unrelated decision, ambiguous ownership and a non-cancelled run", () => {
    for (const change of [
      { decision: null },
      { decision: { ...decision, runAttempt: "2" } },
      { decision: { ...decision, candidateSha: "9".repeat(40) } },
      { ownership: { ...ownership, runId: "31" } },
      { ownership: null },
      { run: { ...cancelled, conclusion: "success" } },
    ]) {
      expect(
        buildCancelledMergeQualificationRecord({ decision, ownership, run: cancelled, ...change }).errors.length,
      ).toBeGreaterThan(0);
    }
  });
  it("AC4 executes the CLI with recovered evidence and never needs the child artifact", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qualification-cancelled-record-"));
    try {
      for (const [name, value] of Object.entries({ decision, ownership, run: cancelled }))
        writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));
      const result = spawnSync(
        process.execPath,
        [
          "scripts/merge-qualification.mjs",
          "cancelled-record",
          "--decision",
          path.join(dir, "decision.json"),
          "--ownership",
          path.join(dir, "ownership.json"),
          "--run",
          path.join(dir, "run.json"),
          "--out",
          path.join(dir, "record.json"),
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(path.join(dir, "record.json"), "utf8"))).toMatchObject({
        result: "fail",
        runId: "30",
        runAttempt: "1",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("original revision recovery", () => {
  it("reconstructs at the original attempt instant, not today's expired policy window", () => {
    const result = recoverMergeQualificationDecision({
      run,
      parentRun,
      candidate,
      policyRevision: revision,
      policyContent: policy,
      classifierRecord,
    });
    expect(result.errors).toEqual([]);
    expect(result.decision).toMatchObject({
      policyEnabled: true,
      policyRevision: revision,
      observedAt: run.run_started_at,
      candidateSha: sha,
    });
  });
  it("refuses another revision, missing original time, or another producer attempt", () => {
    for (const override of [
      { policyRevision: sha },
      { run: { ...run, run_started_at: null } },
      { parentRun: { ...parentRun, run_attempt: 2 } },
    ]) {
      expect(
        recoverMergeQualificationDecision({
          run,
          parentRun,
          candidate,
          policyContent: policy,
          policyRevision: revision,
          ...override,
        }).errors.length,
      ).toBeGreaterThan(0);
    }
  });
  it("recovers original disabled policy without discovering a candidate", () => {
    const result = recoverMergeQualificationDecision({
      run,
      parentRun,
      policyRevision: revision,
      policyContent: JSON.stringify({ schemaVersion: "merge-qualification-policy/v1", enabled: false }),
    });
    expect(result.errors).toEqual([]);
    expect(result.decision).toMatchObject({ policyEnabled: false, candidateSha: null });
  });
  it("recovers enabled eligibility after early cancellation without inventing candidate or classifier proof", () => {
    const result = recoverMergeQualificationDecision({
      run,
      parentRun,
      policyRevision: revision,
      policyContent: policy,
    });
    expect(result.errors).toEqual([]);
    expect(result.decision).toMatchObject({
      policyEnabled: true,
      candidateSha: null,
      classifierClass: null,
      classifierReasonCodes: [],
      builtImageDigest: null,
    });
    expect(
      resolveRunTerminalization({
        runEvent: run.event,
        runDisplayTitle: run.display_title,
        runConclusion: "cancelled",
        decision: result.decision,
      }),
    ).toMatchObject({ terminalState: "cancelled_evicted", provisioned: false });
  });
  it("rejects a classifier observation from another candidate", () => {
    expect(
      recoverMergeQualificationDecision({
        run,
        parentRun,
        candidate,
        policyRevision: revision,
        policyContent: policy,
        classifierRecord: { ...classifierRecord, candidate: { sha: revision, treeSha: candidate.candidateTreeSha } },
      }).errors,
    ).toContain("original classifier observation does not bind the candidate SHA/tree.");
  });
});

describe("exact-head current queue disposition", () => {
  const entry = {
    headCommit: { oid: sha },
    baseCommit: { oid: candidate.queueBaseSha },
    position: 0,
    state: "QUEUED",
    solo: true,
    enqueuedAt: "2026-07-21T09:00:00Z",
    pullRequest: { number: 1, headRefOid: candidate.pullRequests[0].headSha },
  };
  const snapshot = (nodes = [entry], totalCount = nodes.length, pull = {}) => ({
    data: {
      repository: {
        nameWithOwner: candidate.repository,
        mergeQueue: { entries: { totalCount, nodes } },
        pr1: {
          number: 1,
          headRefOid: candidate.pullRequests[0].headSha,
          state: "OPEN",
          merged: false,
          mergeCommit: null,
          ...pull,
        },
      },
    },
  });
  it("permits only the exact queued head/base/PR set", () => {
    expect(resolveMergeQualificationQueueDisposition({ candidate, snapshot: snapshot() })).toBe("queued");
    expect(resolveMergeQualificationQueueDisposition({ candidate, snapshot: snapshot([entry, entry]) })).toBe(
      "unknown",
    );
    expect(
      resolveMergeQualificationQueueDisposition({
        candidate,
        snapshot: snapshot([{ ...entry, baseCommit: { oid: revision } }]),
      }),
    ).toBe("unknown");
  });
  it("distinguishes merged lineage, explicit eviction and ambiguous removal", () => {
    expect(resolveMergeQualificationQueueDisposition({ candidate, snapshot: snapshot([]) })).toBe("unknown");
    expect(
      resolveMergeQualificationQueueDisposition({
        candidate,
        snapshot: snapshot([], 0, { state: "MERGED", merged: true, mergeCommit: { oid: sha } }),
      }),
    ).toBe("merged");
    expect(
      resolveMergeQualificationQueueDisposition({ candidate, snapshot: snapshot([], 0, { state: "CLOSED" }) }),
    ).toBe("evicted");
    expect(
      resolveMergeQualificationQueueDisposition({ candidate, snapshot: snapshot([], 0, { headRefOid: revision }) }),
    ).toBe("evicted");
  });
  it("refuses partial, null, oversized and error-bearing observations", () => {
    for (const value of [
      null,
      snapshot([], 1),
      snapshot([], 101),
      { ...snapshot(), errors: [{}] },
      { data: { repository: { ...snapshot().data.repository, pr1: null } } },
    ]) {
      expect(resolveMergeQualificationQueueDisposition({ candidate, snapshot: value })).toBe("unknown");
    }
  });

  it("executes the production GraphQL reader with bounded exact candidate identities", async () => {
    const requests = [];
    const disposition = await observeMergeQualificationQueueDisposition(candidate, {
      token: "synthetic-token",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => snapshot() };
      },
    });
    expect(disposition).toBe("queued");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.github.com/graphql");
    expect(JSON.parse(requests[0].options.body)).toMatchObject({
      variables: { owner: "synthetic", name: "repository", branch: "main" },
    });
    expect(JSON.parse(requests[0].options.body).query).toContain("entries(first:100)");
    expect(requests[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(
      await observeMergeQualificationQueueDisposition(candidate, {
        token: "synthetic-token",
        fetchImpl: async () => {
          throw new Error("secret-marker-must-not-escape");
        },
      }),
    ).toBe("unknown");
  });

  it("executes queue CLI refusal and permits no unknown or evicted provisioning", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qualification-queue-control-"));
    try {
      const candidatePath = path.join(dir, "candidate.json");
      const queuePath = path.join(dir, "queue.json");
      writeFileSync(candidatePath, JSON.stringify(candidate));
      for (const [value, expected] of [
        [snapshot(), 0],
        [snapshot([]), 1],
        [snapshot([], 0, { state: "CLOSED" }), 1],
      ]) {
        writeFileSync(queuePath, JSON.stringify(value));
        const result = spawnSync(
          process.execPath,
          [
            "scripts/merge-qualification.mjs",
            "queue-disposition",
            "--candidate-record",
            candidatePath,
            "--queue-snapshot",
            queuePath,
          ],
          { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
        );
        expect(result.status, result.stderr).toBe(expected);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("eviction overrides a successful child and unknown disposition cannot pass", () => {
    const decision = recoverMergeQualificationDecision({
      run,
      parentRun,
      candidate,
      policyRevision: revision,
      policyContent: policy,
      classifierRecord,
    }).decision;
    const input = {
      runEvent: "workflow_dispatch",
      runDisplayTitle: run.display_title,
      runConclusion: "success",
      decision,
      provisioningObserved: true,
    };
    expect(resolveRunTerminalization({ ...input, queueDisposition: "evicted" })).toMatchObject({
      terminalState: "cancelled_evicted",
      reasonCodes: ["candidate_evicted"],
      provisioned: true,
    });
    expect(resolveRunTerminalization({ ...input, queueDisposition: "unknown" })).toMatchObject({
      terminalState: "infrastructure_error",
      reasonCodes: ["queue_disposition_unknown"],
    });
  });
});

describe("original revision production command", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qualification-recovery-control-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("recovers the checked-in original disabled revision and refuses an unavailable revision", () => {
    const original = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    writeFileSync(path.join(dir, "parent.json"), JSON.stringify(parentRun));
    for (const [head, expected] of [
      [original, 0],
      ["0".repeat(40), 1],
    ]) {
      const out = path.join(dir, `${head}.json`);
      writeFileSync(path.join(dir, "run.json"), JSON.stringify({ ...run, head_sha: head }));
      const result = spawnSync(
        process.execPath,
        [
          "scripts/merge-qualification.mjs",
          "recover-decision",
          "--run",
          path.join(dir, "run.json"),
          "--parent-run",
          path.join(dir, "parent.json"),
          "--out",
          out,
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
      );
      expect(result.status, result.stderr).toBe(expected);
      if (expected === 0)
        expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ policyEnabled: false, policyRevision: original });
      else expect(existsSync(out)).toBe(false);
    }
  });
});

describe("scheduled terminal production commands without workflow_run delivery", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "qualification-scheduled-terminal-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const scenarios = [
    ["passed", "isolated", ["application_runtime"], ["gate_passed"]],
    ["failed", "isolated", ["application_runtime"], ["gate_failed"]],
    ["not_applicable", "not_applicable", ["docs_or_test_only"], ["docs_or_test_only"]],
    ["persistent_required", "persistent_required", ["migration_schema"], ["migration_schema"]],
    ["cancelled_evicted", "isolated", ["application_runtime"], ["run_force_cancelled"]],
    ["infrastructure_error", "isolated", ["application_runtime"], ["advisory_result_missing"]],
  ];
  it.each(scenarios)(
    "AC1 emits one %s and next-day replay emits none after cleanup",
    (terminalState, classifierClass, classifierReasons, reasonCodes) => {
      const dir = path.join(directory, terminalState);
      const decision = recoverMergeQualificationDecision({
        run,
        parentRun,
        candidate,
        policyRevision: revision,
        policyContent: policy,
        classifierRecord: { ...classifierRecord, class: classifierClass, reasonCodes: classifierReasons },
      }).decision;
      const concludedRun = {
        ...run,
        status: "completed",
        conclusion: terminalState === "cancelled_evicted" ? "cancelled" : "success",
        updated_at: "2026-07-21T10:05:00.000Z",
      };
      const proof = ["passed", "failed"].includes(terminalState);
      const event = buildMergeQualificationEvent({
        ...decision,
        builtImageDigest: proof ? candidate.builtImageDigest : null,
        imageDigest: proof ? candidate.builtImageDigest : null,
        gateCandidateSha: proof ? sha : null,
        gateCandidateTreeSha: proof ? candidate.candidateTreeSha : null,
        terminalState,
        reasonCodes,
        provisioned: false,
        startedAt: run.run_started_at,
        completedAt: concludedRun.updated_at,
        evidenceLinks: ["https://github.com/synthetic/repository/actions/runs/30/attempts/1"],
      }).event;
      expect(validateMergeQualificationEvent(event)).toEqual([]);
      const values = {
        decision,
        run: concludedRun,
        "parent-run": parentRun,
        "candidate-record": candidate,
        jobs: { total_count: 0, jobs: [] },
        "run-artifacts": { total_count: 0, artifacts: [] },
        "terminal-records": { records: [] },
        "queue-snapshot": {
          data: {
            repository: {
              nameWithOwner: candidate.repository,
              mergeQueue: { entries: { totalCount: 0, nodes: [] } },
              pr1: {
                number: 1,
                headRefOid: candidate.pullRequests[0].headSha,
                state: "MERGED",
                merged: true,
                mergeCommit: { oid: sha },
              },
            },
          },
        },
        ...(proof ? { observation: { ...event, schemaVersion: "merge-qualification-observation/v1" } } : {}),
      };
      // Use unique flat file names: no fixture authority is borrowed from a real run.
      const args = [];
      for (const [name, value] of Object.entries(values)) {
        const file = `${dir}-${name}.json`;
        writeFileSync(file, JSON.stringify(value));
        args.push(`--${name}`, file);
      }
      const invoke = (command, out, extra = []) =>
        spawnSync(
          process.execPath,
          [
            "scripts/merge-qualification.mjs",
            command,
            ...args,
            "--repository",
            candidate.repository,
            "--out",
            out,
            ...extra,
          ],
          { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
        );
      const cleanupOutput = `${dir}-cleanup-output.txt`;
      expect(invoke("prepare-cleanup", `${dir}-unused.json`, ["--github-output", cleanupOutput]).status).toBe(0);
      expect(readFileSync(cleanupOutput, "utf8")).toContain("provisioned=false");
      const first = `${dir}-first.json`;
      const result = invoke("terminalize", first);
      expect(result.status, result.stderr).toBe(0);
      const bytes = readFileSync(first, "utf8");
      expect(JSON.parse(bytes).terminalState).toBe(terminalState);
      writeFileSync(`${dir}-terminal-records.json`, JSON.stringify({ records: [bytes] }));
      // A disappeared queue on the next day cannot rewrite already committed authority.
      writeFileSync(`${dir}-queue-snapshot.json`, "null");
      expect(invoke("prepare-cleanup", `${dir}-unused2.json`).status).toBe(0);
      const replayOutput = `${dir}-replay-output.txt`;
      const replay = invoke("terminalize", `${dir}-second.json`, [
        "--now",
        "2026-07-22T12:00:00.000Z",
        "--github-output",
        replayOutput,
      ]);
      expect(replay.status, replay.stderr).toBe(0);
      expect(existsSync(`${dir}-second.json`)).toBe(false);
      expect(readFileSync(replayOutput, "utf8")).toContain("event_written=false");
      const conflict = { ...JSON.parse(bytes), completedAt: "2026-07-21T10:06:00.000Z", durationSeconds: 360 };
      writeFileSync(`${dir}-terminal-records.json`, JSON.stringify({ records: [bytes, JSON.stringify(conflict)] }));
      expect(invoke("terminalize", `${dir}-conflict.json`).status).toBe(1);
      expect(existsSync(`${dir}-conflict.json`)).toBe(false);
    },
  );
});

describe("candidate publication byte contract", () => {
  it("AC2 allows identical recorder replay and refuses conflicting digest bytes without replacing the payload", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qualification-recorder-replay-"));
    try {
      writeFileSync(
        path.join(dir, "run.json"),
        JSON.stringify({
          ...parentRun,
          status: "in_progress",
          head_commit: { id: sha, tree_id: candidate.candidateTreeSha },
        }),
      );
      writeFileSync(
        path.join(dir, "queue.json"),
        JSON.stringify({
          data: {
            repository: {
              mergeQueue: {
                entries: {
                  totalCount: 1,
                  nodes: [
                    {
                      headCommit: { oid: sha },
                      baseCommit: { oid: candidate.queueBaseSha },
                      position: 0,
                      state: "QUEUED",
                      solo: true,
                      enqueuedAt: "2026-07-21T09:00:00Z",
                      pullRequest: { number: 1, headRefOid: candidate.pullRequests[0].headSha },
                    },
                  ],
                },
              },
            },
          },
        }),
      );
      const out = path.join(dir, "candidate.json");
      const invoke = (digest) =>
        spawnSync(
          process.execPath,
          [
            "scripts/merge-qualification.mjs",
            "candidate-evidence",
            "--repository",
            candidate.repository,
            "--run-metadata",
            path.join(dir, "run.json"),
            "--merge-queue-snapshot",
            path.join(dir, "queue.json"),
            "--queue-base-sha",
            candidate.queueBaseSha,
            "--built-image-digest",
            digest,
            "--captured-at",
            candidate.capturedAt,
            "--out",
            out,
          ],
          { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
        );
      const first = invoke(candidate.builtImageDigest);
      expect(first.status, first.stderr).toBe(0);
      const bytes = readFileSync(out, "utf8");
      expect(invoke(candidate.builtImageDigest).status).toBe(0);
      expect(invoke(`sha256:${"9".repeat(64)}`).status).toBe(1);
      expect(readFileSync(out, "utf8")).toBe(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
