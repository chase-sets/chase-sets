import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  inventoryMergeQualificationProducerAttempts,
  listMergeQualificationAdvisoryRuns,
  readMergeQualificationProducerImageEligibility,
  deriveMergeQualificationSettledEntry,
  readMergeQualificationSettledIndex,
  writeMergeQualificationSettledIndex,
  validateMergeQualificationSettledEntry,
  validateMergeQualificationSettledIndex,
  validateMergeQualificationEvent,
  readMergeQualificationRunCollection,
  MERGE_QUALIFICATION_INVENTORY_HORIZON_HOURS,
  MERGE_QUALIFICATION_SETTLED_INDEX_ARTIFACT,
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
  policyRevision: revision,
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
  const completed = { ...run, status: "completed", conclusion: "success", created_at: run.run_started_at };
  const now = () => new Date("2026-07-21T12:00:00.000Z");
  const windowStart = "2026-07-19T12:00:00Z";
  const inventory = (runs, options = {}) =>
    inventoryMergeQualificationAttempts({
      repository: candidate.repository,
      requestJson: async () => ({ total_count: runs.length, workflow_runs: runs }),
      readPolicyContent: async () => policy,
      now,
      ...options,
    });
  // Synthetic GitHub runs endpoint: honors the created lower bound and pages by created order.
  const githubRuns = (runs, calls = []) => {
    return async (endpoint) => {
      calls.push(endpoint);
      const query = new URL(endpoint, "https://api.github.invalid/").searchParams;
      const since = Date.parse(query.get("created").replace(/^>=/u, ""));
      const page = Number(query.get("page"));
      const matching = runs.filter((candidateRun) => Date.parse(candidateRun.created_at) >= since);
      return { total_count: matching.length, workflow_runs: matching.slice((page - 1) * 100, page * 100) };
    };
  };
  const enabledRuns = (count, { created = completed.created_at, firstId = 5000 } = {}) =>
    Array.from({ length: count }, (_, index) => ({
      ...completed,
      id: firstId + index,
      created_at: created,
      run_started_at: created,
    }));

  it("AC1 requests only the bounded recent window, shorter than evidence retention", async () => {
    expect(MERGE_QUALIFICATION_INVENTORY_HORIZON_HOURS).toBe(48);
    expect(MERGE_QUALIFICATION_INVENTORY_HORIZON_HOURS).toBeLessThan(30 * 24);
    const calls = [];
    const result = await inventory([], { requestJson: githubRuns([completed], calls) });
    expect(calls).toEqual([
      `repos/synthetic/repository/actions/workflows/platform-merge-qualification.yml/runs?created=%3E%3D${windowStart}&per_page=100&page=1`,
    ]);
    expect(result).toEqual({
      attempts: [{ run_id: "30", run_attempt: "1", workflow_id: "12", conclusion: "success" }],
      settled: 0,
      errors: [],
    });
  });

  it("AC1 retires history: out-of-window volume never wedges the steady-state tick", async () => {
    const retired = "2026-07-19T11:59:59.000Z";
    const disabledHistory = Array.from({ length: 10_001 }, (_, index) => ({
      ...completed,
      id: 100_000 + index,
      created_at: retired,
    }));
    const calls = [];
    expect(await inventory([], { requestJson: githubRuns([...disabledHistory, completed], calls) })).toEqual({
      attempts: [{ run_id: "30", run_attempt: "1", workflow_id: "12", conclusion: "success" }],
      settled: 0,
      errors: [],
    });
    expect(calls).toHaveLength(1);
    expect(
      await inventory([], { requestJson: githubRuns(enabledRuns(257, { created: retired, firstId: 200_000 })) }),
    ).toEqual({ attempts: [], settled: 0, errors: [] });
  });

  it("AC5 refuses a page whose runs fall outside the requested window", async () => {
    for (const created_at of ["2026-07-19T11:59:59.000Z", null, "yesterday"]) {
      expect(await inventory([{ ...completed, created_at }])).toEqual({
        attempts: [],
        settled: 0,
        errors: ["attempt_window_invalid"],
      });
    }
  });

  it("AC5 treats a filtered total at the 1,000-result search ceiling as incomplete", async () => {
    const calls = [];
    const result = await inventory([], {
      requestJson: async (endpoint) => {
        calls.push(endpoint);
        return { total_count: 1_000, workflow_runs: enabledRuns(100) };
      },
    });
    expect(result).toEqual({ attempts: [], settled: 0, errors: ["attempt_inventory_incomplete"] });
    expect(calls).toHaveLength(1);
  });

  it("AC5 refuses a short non-final page even when later pages would reach the total", async () => {
    const pages = [enabledRuns(50), enabledRuns(1, { firstId: 9000 })];
    const result = await inventory([], {
      requestJson: async (endpoint) => {
        const page = Number(new URL(endpoint, "https://api.github.invalid/").searchParams.get("page"));
        return { total_count: 51, workflow_runs: pages[page - 1] ?? [] };
      },
    });
    expect(result).toEqual({ attempts: [], settled: 0, errors: ["attempt_inventory_incomplete"] });
  });

  it("AC5 refuses a total that drifts between pages", async () => {
    const pages = [
      { total_count: 150, workflow_runs: enabledRuns(100) },
      { total_count: 101, workflow_runs: enabledRuns(1, { firstId: 9000 }) },
    ];
    const result = await inventory([], {
      requestJson: async (endpoint) =>
        pages[Number(new URL(endpoint, "https://api.github.invalid/").searchParams.get("page")) - 1],
    });
    expect(result).toEqual({ attempts: [], settled: 0, errors: ["attempt_inventory_incomplete"] });
  });

  it("AC1 refuses an over-capacity window instead of dropping its tail", async () => {
    const control = await inventory([], { requestJson: githubRuns(enabledRuns(256)) });
    expect(control.errors).toEqual([]);
    expect(control.attempts).toHaveLength(256);
    expect(await inventory([], { requestJson: githubRuns(enabledRuns(257)) })).toEqual({
      attempts: [],
      settled: 0,
      errors: ["attempt_worker_capacity_exceeded"],
    });
  });

  it("AC1 inventories only producer-dispatched advisory attempts", async () => {
    for (const change of [
      { event: "workflow_run" },
      { display_title: "Merge Qualification merge_group 20-1" },
      { display_title: "Merge Qualification pull_request 20-1" },
    ]) {
      expect(await inventory([{ ...completed, ...change }])).toEqual({ attempts: [], settled: 0, errors: [] });
    }
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
      settled: 0,
      errors: [],
    });
  });
  it("AC1 selects the latest exact attempt before filtering completed state", async () => {
    expect(await inventory([completed, { ...completed, run_attempt: 2, status: "in_progress" }])).toEqual({
      attempts: [],
      settled: 0,
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
    expect(await inventory([completed], { readPolicyContent: async () => null })).toEqual({
      attempts: [],
      settled: 0,
      errors: [],
    });
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
  it("AC1 refuses an otherwise-identical terminal that does not start at the original attempt instant", () => {
    const shifted = buildMergeQualificationEvent({
      ...decision,
      terminalState: "cancelled_evicted",
      builtImageDigest: null,
      reasonCodes: ["run_force_cancelled"],
      provisioned: false,
      startedAt: "2026-07-21T10:01:00.000Z",
      completedAt: "2026-07-21T10:05:00.000Z",
      evidenceLinks: ["https://github.com/synthetic/repository/actions/runs/30/attempts/1"],
    }).event;
    expect(validateMergeQualificationEvent(shifted)).toEqual([]);
    expect(
      resolveMergeQualificationTerminalReplay({ decision, records: [`${JSON.stringify(shifted, null, 2)}\n`] }),
    ).toEqual({ action: "unknown", event: null, errors: ["terminal_payload_binding_invalid"] });
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
      { run: { ...run, event: "workflow_run" } },
      { run: { ...run, display_title: "Merge Qualification merge_group 20-1" } },
    ]) {
      const result = recoverMergeQualificationDecision({
        run,
        parentRun,
        candidate,
        policyContent: policy,
        policyRevision: revision,
        ...override,
      });
      expect(result.errors.length).toBeGreaterThan(0);
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

describe("terminal replay ownership binding", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "qualification-replay-ownership-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const decision = recoverMergeQualificationDecision({
    run,
    parentRun,
    candidate,
    policyRevision: revision,
    policyContent: policy,
    classifierRecord,
  }).decision;
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
  const terminalize = (label, { recordProvisioned, ownershipObserved }) => {
    const event = buildMergeQualificationEvent({
      ...decision,
      terminalState: "cancelled_evicted",
      builtImageDigest: null,
      reasonCodes: ["run_force_cancelled"],
      provisioned: recordProvisioned,
      startedAt: run.run_started_at,
      completedAt: "2026-07-21T10:05:00.000Z",
      evidenceLinks: ["https://github.com/synthetic/repository/actions/runs/30/attempts/1"],
    }).event;
    expect(validateMergeQualificationEvent(event)).toEqual([]);
    const values = {
      decision,
      run: { ...run, status: "completed", conclusion: "cancelled", updated_at: "2026-07-21T10:05:00.000Z" },
      "parent-run": parentRun,
      "candidate-record": candidate,
      jobs: { total_count: 0, jobs: [] },
      "run-artifacts": { total_count: 0, artifacts: [] },
      "terminal-records": { records: [`${JSON.stringify(event, null, 2)}\n`] },
      ...(ownershipObserved ? { "provisioning-observation": ownership } : {}),
    };
    const args = [];
    for (const [name, value] of Object.entries(values)) {
      const file = path.join(directory, `${label}-${name}.json`);
      writeFileSync(file, JSON.stringify(value));
      args.push(`--${name}`, file);
    }
    const out = path.join(directory, `${label}-event.json`);
    const githubOutput = path.join(directory, `${label}-output.txt`);
    writeFileSync(githubOutput, "");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/merge-qualification.mjs",
        "terminalize",
        ...args,
        "--repository",
        candidate.repository,
        "--out",
        out,
        "--github-output",
        githubOutput,
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
    );
    return { result, written: existsSync(out), output: readFileSync(githubOutput, "utf8") };
  };

  it.each([
    ["provisioned replay without recovered ownership", { recordProvisioned: true, ownershipObserved: false }],
    ["unprovisioned replay with recovered ownership", { recordProvisioned: false, ownershipObserved: true }],
  ])("AC4 refuses %s through the terminalize command", (label, input) => {
    const { result, written, output } = terminalize(label.replaceAll(" ", "-"), input);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("terminal_ownership_conflict");
    expect(written).toBe(false);
    expect(output).toBe("");
  });

  it.each([
    ["provisioned", { recordProvisioned: true, ownershipObserved: true }],
    ["unprovisioned", { recordProvisioned: false, ownershipObserved: false }],
  ])("AC4 replays a matching %s terminal without writing another", (label, input) => {
    const { result, written, output } = terminalize(`matching-${label}`, input);
    expect(result.status, result.stderr).toBe(0);
    expect(written).toBe(false);
    expect(output).toContain("action=replay");
    expect(output).toContain("event_written=false");
  });
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
            "--policy-revision",
            candidate.policyRevision,
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

describe("settled-attempt index", () => {
  // Synthetic control identities, not captured GitHub authority.
  const repository = candidate.repository;
  const now = () => new Date("2026-07-21T12:00:00.000Z");
  const decision = recoverMergeQualificationDecision({
    run,
    parentRun,
    candidate,
    policyRevision: revision,
    policyContent: policy,
    classifierRecord,
  }).decision;
  const advisoryTerminal = `${JSON.stringify(
    buildMergeQualificationEvent({
      ...decision,
      terminalState: "cancelled_evicted",
      builtImageDigest: null,
      reasonCodes: ["run_force_cancelled"],
      provisioned: false,
      startedAt: run.run_started_at,
      completedAt: "2026-07-21T10:05:00.000Z",
      evidenceLinks: ["https://github.com/synthetic/repository/actions/runs/30/attempts/1"],
    }).event,
    null,
    2,
  )}\n`;
  const marker = (runId = "30", runAttempt = "1") =>
    `${JSON.stringify({ runId, runAttempt, cleanup: "complete" }, null, 2)}\n`;
  const producerTerminal = (overrides = {}) =>
    `${JSON.stringify(
      {
        schemaVersion: "merge-qualification-terminal/v1",
        idempotencyKey: `merge-qualification-producer:${repository}:20:1`,
        repository,
        producerWorkflowId: "11",
        producerWorkflowPath: ".github/workflows/platform-pr.yml",
        producerRunId: "20",
        producerRunAttempt: "1",
        producerHeadSha: sha,
        policyRevision: revision,
        advisoryRunId: null,
        advisoryRunAttempt: null,
        terminalState: "infrastructure_error",
        reasonCodes: ["advisory_dispatch_missing"],
        startedAt: "2026-07-21T10:00:00Z",
        completedAt: "2026-07-21T10:20:00.000Z",
        cleanupLegs: 0,
        ...overrides,
      },
      null,
      2,
    )}\n`;
  const loss = producerTerminal();
  const conflict = producerTerminal({
    advisoryRunId: "30",
    advisoryRunAttempt: "1",
    terminalState: "conflict",
    reasonCodes: ["advisory_dispatch_race"],
    completedAt: "2026-07-21T11:00:00.000Z",
  });
  const lateJoin = { runId: "30", runAttempt: "1" };
  const digest = (bytes) => createHash("sha256").update(bytes, "utf8").digest("hex");
  const derive = (input) => deriveMergeQualificationSettledEntry({ repository, ...input });
  const advisoryEntry = derive({ variant: "advisory", terminals: [advisoryTerminal], cleanupMarker: marker() }).entry;
  const lossEntry = derive({ variant: "producer_loss", terminals: [loss] }).entry;
  const write = (entries, { prior = null, at = now, writerRunId = "900" } = {}) =>
    writeMergeQualificationSettledIndex({ repository, prior, entries, writerRunId, writerRunAttempt: "1", now: at });
  const advisoryRun = (id, producerId, overrides = {}) => ({
    ...run,
    id,
    display_title: `Merge Qualification producer ${producerId}-1`,
    status: "completed",
    conclusion: "cancelled",
    created_at: run.run_started_at,
    ...overrides,
  });
  const producerRun = (id, overrides = {}) => ({
    ...parentRun,
    id,
    status: "completed",
    conclusion: "success",
    created_at: "2026-07-21T10:00:00Z",
    run_started_at: "2026-07-21T10:00:00Z",
    updated_at: "2026-07-21T10:01:00Z",
    ...overrides,
  });
  const noTransport = async (endpoint) => {
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const advisoryInventory = (advisoryRuns, settledIndex, at = now) =>
    inventoryMergeQualificationAttempts({
      repository,
      requestJson: noTransport,
      readPolicyContent: async () => policy,
      advisoryRuns,
      settledIndex,
      now: at,
    });
  const producerInventory = async (producers, advisoryRuns, settledIndex) => {
    const reads = [];
    const result = await inventoryMergeQualificationProducerAttempts({
      repository,
      now,
      requestJson: async (endpoint) => {
        if (!endpoint.includes("/workflows/platform-pr.yml/runs?")) throw new Error(`unexpected ${endpoint}`);
        return { total_count: producers.length, workflow_runs: producers };
      },
      advisoryRuns,
      settledIndex,
      readHistoricalPolicyContent: async () => {
        reads.push("policy");
        return { revision, content: policy, decision: { enabled: true } };
      },
      readProducerImageEligibility: async () => {
        reads.push("image");
        return true;
      },
    });
    return { result, reads };
  };
  const observerRun = {
    id: 900,
    run_attempt: 1,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_branch: "main",
    path: ".github/workflows/platform-merge-qualification-observer.yml",
    event: "schedule",
    status: "completed",
    conclusion: "success",
  };
  const indexArtifact = {
    id: 7000,
    name: MERGE_QUALIFICATION_SETTLED_INDEX_ARTIFACT,
    expired: false,
    workflow_run: { id: 900 },
  };
  const readIndex = (index, mutation = {}, calls = []) =>
    readMergeQualificationSettledIndex({
      repository,
      defaultBranch: "main",
      requestJson: async (endpoint) => {
        calls.push(endpoint);
        if (mutation.transportError) throw new Error("secret-marker-transport");
        if (endpoint.includes("/workflows/platform-merge-qualification-observer.yml/runs?"))
          return mutation.runs ?? { total_count: 1, workflow_runs: [mutation.run ?? observerRun] };
        if (endpoint.includes("/artifacts?name="))
          return mutation.artifacts ?? { total_count: 1, artifacts: [indexArtifact] };
        throw new Error(`unexpected ${endpoint}`);
      },
      downloadArtifact: async (input) => {
        calls.push(input);
        return mutation.bytes ?? `${JSON.stringify(index)}\n`;
      },
    });

  it.each([
    [
      "advisory terminal plus exact cleanup marker",
      { variant: "advisory", terminals: [advisoryTerminal], cleanupMarker: marker() },
      true,
    ],
    [
      "advisory byte-identical terminal replay plus marker",
      { variant: "advisory", terminals: [advisoryTerminal, advisoryTerminal], cleanupMarker: marker() },
      true,
    ],
    ["advisory terminal without its marker", { variant: "advisory", terminals: [advisoryTerminal] }, false],
    ["advisory marker without its terminal", { variant: "advisory", terminals: [], cleanupMarker: marker() }, false],
    ["producer-loss terminal alone", { variant: "producer_loss", terminals: [loss] }, true],
    [
      "late-run conflict record without a marker",
      { variant: "producer_loss", terminals: [conflict], advisoryJoin: lateJoin },
      true,
    ],
    [
      "loss plus late-run conflict record",
      { variant: "producer_loss", terminals: [loss, conflict], advisoryJoin: lateJoin },
      true,
    ],
    [
      "loss awaiting a late advisory run's cleanup and conflict",
      { variant: "producer_loss", terminals: [loss], advisoryJoin: lateJoin },
      false,
    ],
    ["producer attempt without a terminal", { variant: "producer_loss", terminals: [] }, false],
  ])("AC1 settles %s only as defined", (_label, input, settled) => {
    const result = derive(input);
    expect(result.errors).toEqual([]);
    expect(result.settled).toBe(settled);
    expect(result.entry === null).toBe(!settled);
    if (settled) expect(validateMergeQualificationSettledEntry(result.entry)).toEqual([]);
  });

  it("AC1 derives entries from exact content keyed by variant/run/attempt with the producer join", () => {
    expect(advisoryEntry).toEqual({
      variant: "advisory",
      runId: "30",
      runAttempt: "1",
      join: { runId: "20", runAttempt: "1" },
      terminals: [{ terminalState: "cancelled_evicted", sha256: digest(advisoryTerminal) }],
      cleanupMarkerSha256: digest(marker()),
      startedAt: run.run_started_at,
    });
    expect(lossEntry).toEqual({
      variant: "producer_loss",
      runId: "20",
      runAttempt: "1",
      join: null,
      terminals: [{ terminalState: "infrastructure_error", sha256: digest(loss) }],
      cleanupMarkerSha256: null,
      startedAt: "2026-07-21T10:00:00Z",
    });
    expect(
      derive({ variant: "producer_loss", terminals: [conflict, loss], advisoryJoin: lateJoin }).entry,
    ).toMatchObject({
      join: lateJoin,
      terminals: [
        { terminalState: "conflict", sha256: digest(conflict) },
        { terminalState: "infrastructure_error", sha256: digest(loss) },
      ],
    });
  });

  it.each([
    [
      "a marker for another attempt",
      { variant: "advisory", terminals: [advisoryTerminal], cleanupMarker: marker("31") },
      "settlement_marker_invalid",
    ],
    [
      "a marker with extra fields",
      {
        variant: "advisory",
        terminals: [advisoryTerminal],
        cleanupMarker: JSON.stringify({ runId: "30", runAttempt: "1", cleanup: "complete", note: "x" }),
      },
      "settlement_marker_invalid",
    ],
    [
      "two different advisory terminals",
      { variant: "advisory", terminals: [advisoryTerminal, advisoryTerminal.trim()], cleanupMarker: marker() },
      "settlement_terminal_conflict",
    ],
    [
      "a terminal from another repository",
      {
        variant: "advisory",
        terminals: [advisoryTerminal.replaceAll("synthetic/repository", "untrusted/fork")],
        cleanupMarker: marker(),
      },
      "settlement_terminal_invalid",
    ],
    [
      "a conflict naming another advisory run",
      { variant: "producer_loss", terminals: [conflict], advisoryJoin: { runId: "31", runAttempt: "1" } },
      "settlement_join_conflict",
    ],
    [
      "two distinct loss terminals",
      { variant: "producer_loss", terminals: [loss, producerTerminal({ completedAt: "2026-07-21T10:21:00.000Z" })] },
      "settlement_terminal_conflict",
    ],
    [
      "a terminal from another producer",
      {
        variant: "producer_loss",
        terminals: [
          loss,
          producerTerminal({
            producerRunId: "21",
            idempotencyKey: `merge-qualification-producer:${repository}:21:1`,
            terminalState: "conflict",
            reasonCodes: ["advisory_dispatch_race"],
            advisoryRunId: "30",
            advisoryRunAttempt: "1",
          }),
        ],
        advisoryJoin: lateJoin,
      },
      "settlement_terminal_invalid",
    ],
    [
      "malformed terminal bytes",
      { variant: "producer_loss", terminals: ["{secret-marker"] },
      "settlement_terminal_invalid",
    ],
  ])("AC1 refuses %s instead of settling", (_label, input, code) => {
    const result = derive(input);
    expect(result).toEqual({ settled: false, entry: null, errors: [code] });
    expect(JSON.stringify(result)).not.toContain("secret-marker");
  });

  it("AC1 marker-required: an advisory entry or index without its exact marker digest settles nothing", async () => {
    expect(validateMergeQualificationSettledEntry({ ...advisoryEntry, cleanupMarkerSha256: null })).toContain(
      "advisory settlement requires its exact cleanup marker.",
    );
    expect(validateMergeQualificationSettledEntry({ ...lossEntry, cleanupMarkerSha256: digest(marker()) })).toContain(
      "producer-loss settlement never carries a cleanup marker.",
    );
    const index = write([advisoryEntry]).index;
    const markerless = { ...index, entries: [{ ...advisoryEntry, cleanupMarkerSha256: null }] };
    expect((await readIndex(markerless)).errors).toEqual(["settled_index_payload_invalid"]);
    const pending = await advisoryInventory([advisoryRun(30, 20)], markerless);
    expect(pending).toMatchObject({ settled: 0, errors: [] });
    expect(pending.attempts).toHaveLength(1);
  });

  it("AC1 schedules no advisory leg for a settled attempt and keeps every other attempt pending", async () => {
    const index = write([advisoryEntry]).index;
    const runs = [advisoryRun(30, 20), advisoryRun(31, 21)];
    expect(await advisoryInventory(runs, index)).toEqual({
      attempts: [{ run_id: "31", run_attempt: "1", workflow_id: "12", conclusion: "cancelled" }],
      settled: 1,
      errors: [],
    });
    expect((await advisoryInventory(runs, null)).attempts.map((attempt) => attempt.run_id)).toEqual(["30", "31"]);
    // Same advisory key with another producer join is not the settled attempt.
    expect((await advisoryInventory([advisoryRun(30, 99)], index)).attempts).toHaveLength(1);
    // A newer advisory attempt of a settled run is its own key.
    expect((await advisoryInventory([advisoryRun(30, 20, { run_attempt: 2 })], index)).attempts).toMatchObject([
      { run_id: "30", run_attempt: "2" },
    ]);
  });

  it("AC1 schedules no producer leg for a settled loss and reads nothing for it", async () => {
    const index = write([lossEntry]).index;
    const settled = await producerInventory([producerRun(20), producerRun(21)], [], index);
    expect(settled.result.attempts.map((attempt) => attempt.run_id)).toEqual(["21"]);
    expect(settled.result.settled).toBe(1);
    expect(settled.reads).toEqual(["policy", "image"]);
    const control = await producerInventory([producerRun(20), producerRun(21)], [], null);
    expect(control.result.attempts.map((attempt) => attempt.run_id)).toEqual(["20", "21"]);
    expect(control.reads).toHaveLength(4);
  });

  it("AC1 reopens a settled loss when a late advisory joins and settles its conflict without a marker", async () => {
    const lateAdvisory = advisoryRun(30, 20, { created_at: "2026-07-21T10:30:00Z" });
    const lossIndex = write([lossEntry]).index;
    const reopened = await producerInventory([producerRun(20)], [lateAdvisory], lossIndex);
    expect(reopened.result).toMatchObject({ settled: 0, errors: [] });
    expect(reopened.result.attempts).toMatchObject([{ run_id: "20", advisoryRunPresent: true }]);
    const conflictEntry = derive({
      variant: "producer_loss",
      terminals: [loss, conflict],
      advisoryJoin: lateJoin,
    }).entry;
    const refined = write([conflictEntry], { prior: lossIndex });
    expect(refined.errors).toEqual([]);
    expect(refined.index.entries).toEqual([conflictEntry]);
    const settledAgain = await producerInventory([producerRun(20)], [lateAdvisory], refined.index);
    expect(settledAgain.result).toEqual({ attempts: [], settled: 1, errors: [] });
    expect(settledAgain.reads).toEqual([]);
  });

  describe("AC2 enabled-volume REST budget", () => {
    // Captured current-main probe (issue evidence): at 2026-10-20T16:08:03Z the
    // 48-hour window held 110 completed merge-group Platform PR attempts out of
    // 452 Platform PR runs of every event; a refresh at 2026-10-20T16:39:05Z
    // returned 113 merge-group runs. The 256-attempt window is synthetic.
    const CAPTURED = { mergeGroupAttempts: 110, refreshedMergeGroupRuns: 113, platformPrRuns: 452, windowHours: 48 };
    const TOKEN_LIMIT_PER_HOUR = 1_000;
    const CEILING_PER_HOUR = 250;
    const SCHEDULED_DELIVERIES_PER_HOUR = 4;
    // Every Platform PR and advisory completion is a workflow_run delivery. At a
    // given attempt volume the merge-group share of Platform PR runs scales with
    // it, and each enabled attempt adds one advisory completion.
    const deliveriesPerHour = (attempts) =>
      Math.ceil(
        (CAPTURED.platformPrRuns - CAPTURED.mergeGroupAttempts + 2 * attempts) / CAPTURED.windowHours +
          SCHEDULED_DELIVERIES_PER_HOUR,
      );
    const synthetic = (kind, index) => (kind === "producer" ? 50_000 : 60_000) + index;
    const jobs = {
      total_count: 1,
      jobs: [
        {
          id: 1,
          name: "Docker Image Build",
          conclusion: "success",
          steps: [{ name: "Push boot-smoked merge-group image", conclusion: "success" }],
        },
      ],
    };
    // One delivery through the production readers with a counting transport.
    const deliveryLedger = async (attempts, { indexed = true, missingAdvisory = 0, lossSettled = false } = {}) => {
      const producers = Array.from({ length: attempts }, (_, i) => producerRun(synthetic("producer", i)));
      const advisories = Array.from({ length: attempts - missingAdvisory }, (_, i) =>
        advisoryRun(synthetic("advisory", i), synthetic("producer", i), { created_at: "2026-07-21T10:02:00Z" }),
      );
      const entries = [
        ...advisories.map((_, i) => ({
          variant: "advisory",
          runId: String(synthetic("advisory", i)),
          runAttempt: "1",
          join: { runId: String(synthetic("producer", i)), runAttempt: "1" },
          terminals: [{ terminalState: "passed", sha256: "1".repeat(64) }],
          cleanupMarkerSha256: "2".repeat(64),
          startedAt: run.run_started_at,
        })),
        ...(lossSettled
          ? producers
              .slice(attempts - missingAdvisory)
              .map((producer) => ({ ...lossEntry, runId: String(producer.id) }))
          : []),
      ];
      const index = write(entries).index;
      const calls = [];
      const page = (runs, endpoint) => {
        const number = Number(new URL(endpoint, "https://api.github.invalid/").searchParams.get("page"));
        return { total_count: runs.length, workflow_runs: runs.slice((number - 1) * 100, number * 100) };
      };
      const requestJson = async (endpoint) => {
        calls.push(endpoint);
        if (endpoint.includes("/workflows/platform-merge-qualification-observer.yml/runs?"))
          return indexed ? { total_count: 1, workflow_runs: [observerRun] } : { total_count: 0, workflow_runs: [] };
        if (endpoint.includes("/artifacts?name=")) return { total_count: 1, artifacts: [indexArtifact] };
        if (endpoint.includes("/workflows/platform-merge-qualification.yml/runs?")) return page(advisories, endpoint);
        if (endpoint.includes("/workflows/platform-pr.yml/runs?")) return page(producers, endpoint);
        if (endpoint.endsWith(`/commits/${revision}/pulls`))
          return [{ base: { ref: "main" }, merged_at: "2026-07-21T09:00:00Z", merge_commit_sha: revision }];
        if (endpoint.includes("/jobs?")) return jobs;
        throw new Error(`unexpected endpoint ${endpoint}`);
      };
      const settledIndex = await readMergeQualificationSettledIndex({
        repository,
        defaultBranch: "main",
        requestJson,
        downloadArtifact: async (input) => {
          calls.push(input);
          return `${JSON.stringify(index)}\n`;
        },
      });
      const listing = await listMergeQualificationAdvisoryRuns({ repository, requestJson, now });
      const advisory = await inventoryMergeQualificationAttempts({
        repository,
        requestJson,
        now,
        advisoryRuns: listing.runs,
        settledIndex: settledIndex.index,
        readPolicyContent: async () => policy,
      });
      const producer = await inventoryMergeQualificationProducerAttempts({
        repository,
        requestJson,
        now,
        advisoryRuns: listing.runs,
        settledIndex: settledIndex.index,
        execFile: () => `${revision}\t2026-07-21T09:00:00Z\n`,
        readPolicy: () => policy,
        readProducerImageEligibility: ({ run: producerAttempt }) =>
          readMergeQualificationProducerImageEligibility({ repository, run: producerAttempt, requestJson }),
      });
      expect(advisory.errors).toEqual([]);
      expect(producer.errors).toEqual([]);
      return { calls, settledIndex, advisory, producer, legs: advisory.attempts.length + producer.attempts.length };
    };

    it("AC2 holds steady-state calls under 25% of the token limit at captured volume and the 256-leg boundary", async () => {
      expect(CEILING_PER_HOUR).toBe(TOKEN_LIMIT_PER_HOUR / 4);
      const observed = {};
      for (const attempts of [CAPTURED.mergeGroupAttempts, CAPTURED.refreshedMergeGroupRuns, 256]) {
        const ledger = await deliveryLedger(attempts);
        const pages = Math.ceil(attempts / 100);
        expect(ledger.settledIndex.state).toBe("valid");
        expect(ledger.legs).toBe(0);
        expect(ledger.advisory.settled).toBe(attempts);
        // Three index calls, then complete advisory and producer pages; the shared
        // advisory listing is never fetched twice and no candidate read occurs.
        expect(ledger.calls.slice(0, 3)).toEqual([
          "repos/synthetic/repository/actions/workflows/platform-merge-qualification-observer.yml/runs?branch=main&status=success&per_page=1",
          `repos/synthetic/repository/actions/runs/900/artifacts?name=${MERGE_QUALIFICATION_SETTLED_INDEX_ARTIFACT}`,
          { artifactId: "7000" },
        ]);
        const rest = ledger.calls.slice(3);
        expect(rest.filter((call) => call.includes("platform-merge-qualification.yml/runs"))).toHaveLength(pages);
        expect(rest.filter((call) => call.includes("platform-pr.yml/runs"))).toHaveLength(pages);
        expect(ledger.calls).toHaveLength(3 + 2 * pages);
        observed[attempts] = ledger.calls.length * deliveriesPerHour(attempts);
        expect(observed[attempts]).toBeLessThanOrEqual(CEILING_PER_HOUR);
      }
      expect(observed).toEqual({ 110: 7 * 16, 113: 7 * 16, 256: 9 * 22 });
    });

    it("AC2 shows no per-attempt growth when every attempt has an advisory run", async () => {
      const calls = async (attempts) => (await deliveryLedger(attempts)).calls.length;
      expect(await calls(1)).toBe(await calls(100));
      expect(await calls(101)).toBe(await calls(200));
      expect(await calls(201)).toBe(await calls(256));
    });

    it("AC2 reads candidates only after a missing advisory join, and never for a settled loss", async () => {
      const unsettled = await deliveryLedger(256, { missingAdvisory: 3 });
      const extra = unsettled.calls.slice(3 + 6);
      // One shared landing read for the policy revision plus one jobs page per missing join.
      expect(extra.filter((call) => call.endsWith("/pulls"))).toHaveLength(1);
      expect(extra.filter((call) => call.includes("/jobs?"))).toHaveLength(3);
      expect(extra).toHaveLength(4);
      expect(unsettled.producer.attempts).toHaveLength(3);
      const settled = await deliveryLedger(256, { missingAdvisory: 3, lossSettled: true });
      expect(settled.calls).toHaveLength(3 + 6);
      expect(settled.legs).toBe(0);
      expect(settled.producer.settled).toBe(3);
    });

    it("AC2 rejects fewer deliveries alone: without the index the captured window exceeds the ceiling on cadence alone", async () => {
      const ledger = await deliveryLedger(CAPTURED.mergeGroupAttempts, { indexed: false });
      expect(ledger.settledIndex.errors).toEqual(["settled_index_missing"]);
      expect(ledger.legs).toBe(CAPTURED.mergeGroupAttempts);
      // Each advisory leg's inspect step makes at least these REST reads before any download.
      const observer = readFileSync(
        path.join(repoRoot, ".github/workflows/platform-merge-qualification-observer.yml"),
        "utf8",
      );
      const inspect = observer.slice(
        observer.indexOf("- name: Inspect complete advisory run evidence"),
        observer.indexOf("- name: Recover exact cleanup ownership before terminalization"),
      );
      const perLegReads =
        (inspect.match(/gh api "repos\//gu) ?? []).length +
        (inspect.match(/merge-qualification\.mjs run-collection/gu) ?? []).length;
      expect(perLegReads).toBe(4);
      expect(SCHEDULED_DELIVERIES_PER_HOUR * ledger.legs * perLegReads).toBeGreaterThan(CEILING_PER_HOUR);
    });
  });

  it.each([
    ["no successful observer run", { runs: { total_count: 0, workflow_runs: [] } }, "settled_index_missing", 1],
    [
      "a truncated latest-run page",
      { runs: { total_count: 2, workflow_runs: [] } },
      "settled_index_lookup_incomplete",
      1,
    ],
    [
      "a non-observer writer",
      { run: { ...observerRun, path: ".github/workflows/platform-pr.yml" } },
      "settled_index_writer_invalid",
      1,
    ],
    [
      "a foreign branch writer",
      { run: { ...observerRun, head_branch: "untrusted" } },
      "settled_index_writer_invalid",
      1,
    ],
    [
      "a fork head writer",
      { run: { ...observerRun, head_repository: { full_name: "untrusted/fork" } } },
      "settled_index_writer_invalid",
      1,
    ],
    [
      "a dispatch-event writer",
      { run: { ...observerRun, event: "workflow_dispatch" } },
      "settled_index_writer_invalid",
      1,
    ],
    ["an unsuccessful writer", { run: { ...observerRun, conclusion: "failure" } }, "settled_index_writer_invalid", 1],
    ["no index artifact", { artifacts: { total_count: 0, artifacts: [] } }, "settled_index_missing", 2],
    [
      "an incomplete artifact page",
      { artifacts: { total_count: 2, artifacts: [indexArtifact] } },
      "settled_index_lookup_incomplete",
      2,
    ],
    [
      "duplicate index artifacts",
      { artifacts: { total_count: 2, artifacts: [indexArtifact, { ...indexArtifact, id: 7001 }] } },
      "settled_index_artifact_invalid",
      2,
    ],
    [
      "an expired index artifact",
      { artifacts: { total_count: 1, artifacts: [{ ...indexArtifact, expired: true }] } },
      "settled_index_artifact_invalid",
      2,
    ],
    [
      "an artifact from another run",
      { artifacts: { total_count: 1, artifacts: [{ ...indexArtifact, workflow_run: { id: 901 } }] } },
      "settled_index_artifact_invalid",
      2,
    ],
    [
      "a wrongly named artifact",
      { artifacts: { total_count: 1, artifacts: [{ ...indexArtifact, name: "diagnostics" }] } },
      "settled_index_artifact_invalid",
      2,
    ],
    ["malformed index bytes", { bytes: "{secret-marker" }, "settled_index_payload_invalid", 3],
    ["an oversized index", { bytes: " ".repeat(2_000_001) }, "settled_index_payload_invalid", 3],
    ["a transport failure", { transportError: true }, "settled_index_authority_unavailable", 1],
  ])("AC3 fails closed to an explicit unknown index on %s", async (_label, mutation, code, callCount) => {
    const calls = [];
    const result = await readIndex(write([advisoryEntry]).index, mutation, calls);
    expect(result).toEqual({ state: "unknown", index: null, writer: null, errors: [code] });
    expect(calls).toHaveLength(callCount);
    expect(JSON.stringify(result)).not.toContain("secret-marker");
    // Unknown evidence settles nothing: every inventoried attempt stays bounded pending work.
    expect((await advisoryInventory([advisoryRun(30, 20)], result.index)).attempts).toHaveLength(1);
  });

  it.each([
    ["an open schema", (index) => ({ ...index, note: "x" })],
    ["another schema version", (index) => ({ ...index, schemaVersion: "observer-settled-index/v2" })],
    ["another repository", (index) => ({ ...index, repository: "untrusted/fork" })],
    ["another writer run", (index) => ({ ...index, writerRunId: "899" })],
    ["another writer attempt", (index) => ({ ...index, writerRunAttempt: "2" })],
    ["repeated keys", (index) => ({ ...index, entries: [advisoryEntry, advisoryEntry] })],
    ["non-canonical order", (index) => ({ ...index, entries: [lossEntry, advisoryEntry] })],
    ["an aged entry", (index) => ({ ...index, windowStart: "2026-07-21T10:00:01Z" })],
    ["an entry with an open schema", (index) => ({ ...index, entries: [{ ...advisoryEntry, extra: true }] })],
  ])("AC3 refuses an index with %s", async (_label, mutate) => {
    const index = mutate(write([advisoryEntry, lossEntry]).index);
    expect(await readIndex(index)).toMatchObject({ state: "unknown", index: null });
  });

  it("AC3 reads one validated index in exactly three calls and keeps a stale index safe", async () => {
    const calls = [];
    const stale = write([lossEntry]).index;
    const result = await readIndex(stale, {}, calls);
    expect(result).toEqual({ state: "valid", index: stale, writer: { runId: "900", runAttempt: "1" }, errors: [] });
    expect(calls).toHaveLength(3);
    // The stale index predates the advisory settlement: that attempt is pending, never dropped.
    expect((await advisoryInventory([advisoryRun(30, 20)], result.index)).attempts).toHaveLength(1);
  });

  it("AC3 writer carries prior entries, refuses non-monotonic or invalid input, and dedupes replays", () => {
    const prior = write([advisoryEntry, lossEntry]).index;
    const carried = write([], { prior, writerRunId: "901" });
    expect(carried).toMatchObject({ aged: 0, added: 0, errors: [] });
    expect(carried.index.entries).toEqual(prior.entries);
    expect(carried.index.writerRunId).toBe("901");
    expect(write([advisoryEntry, advisoryEntry], { prior }).added).toBe(0);
    const changed = { ...advisoryEntry, terminals: [{ terminalState: "failed", sha256: "3".repeat(64) }] };
    expect(write([changed], { prior })).toEqual({
      index: null,
      aged: 0,
      added: 0,
      errors: ["settled_index_not_monotonic"],
    });
    const conflictOnly = {
      ...lossEntry,
      join: lateJoin,
      terminals: [{ terminalState: "conflict", sha256: "4".repeat(64) }],
    };
    expect(write([conflictOnly], { prior }).errors).toEqual(["settled_index_not_monotonic"]);
    expect(write([{ ...advisoryEntry, cleanupMarkerSha256: null }]).errors).toEqual(["settled_index_entry_invalid"]);
    expect(write([], { prior: { ...prior, repository: "untrusted/fork" } }).errors).toEqual([
      "settled_index_prior_invalid",
    ]);
    expect(write(Array.from({ length: 513 }, () => advisoryEntry)).errors).toEqual(["settled_index_entries_invalid"]);
    expect(validateMergeQualificationSettledIndex(carried.index, { repository })).toEqual([]);
  });

  it("AC4 next-day replay schedules no settled work and re-derives byte-identical settlement", async () => {
    const day1 = await advisoryInventory([advisoryRun(30, 20)], null);
    expect(day1.attempts).toHaveLength(1);
    const published = write([advisoryEntry]);
    expect(published).toMatchObject({ added: 1, errors: [] });
    const nextDay = () => new Date("2026-07-22T08:00:00.000Z");
    const read = await readIndex(published.index);
    expect(await advisoryInventory([advisoryRun(30, 20)], read.index, nextDay)).toEqual({
      attempts: [],
      settled: 1,
      errors: [],
    });
    // A stale-index redelivery replays the same durable bytes into the same entry, never a second one.
    const rederived = derive({ variant: "advisory", terminals: [advisoryTerminal], cleanupMarker: marker() }).entry;
    const replayed = write([rederived], { prior: read.index, at: nextDay });
    expect(replayed).toMatchObject({ added: 0, aged: 0, errors: [] });
    expect(replayed.index.entries).toEqual(published.index.entries);
  });

  it("AC4 ages an attempt out of the index into explicit unknown under the 48-hour rule", async () => {
    const published = write([advisoryEntry, lossEntry]).index;
    const later = () => new Date("2026-07-23T10:00:01.000Z");
    const aged = write([], { prior: published, at: later });
    expect(aged).toMatchObject({ aged: 2, added: 0, errors: [] });
    expect(aged.index.entries).toEqual([]);
    // A late settlement for an aged attempt is never admitted.
    expect(write([advisoryEntry], { prior: aged.index, at: later }).index.entries).toEqual([]);
    expect(
      validateMergeQualificationSettledIndex({ ...aged.index, entries: [advisoryEntry] }, { repository }),
    ).toContain("settled index retains an aged entry.");
    // The aged run is outside the inventory window: neither settled nor pending.
    const listing = await listMergeQualificationAdvisoryRuns({
      repository,
      now: later,
      requestJson: async (endpoint) => {
        const since = Date.parse(new URL(endpoint, "https://api.github.invalid/").searchParams.get("created").slice(2));
        const runs = [advisoryRun(30, 20)].filter((candidateRun) => Date.parse(candidateRun.created_at) >= since);
        return { total_count: runs.length, workflow_runs: runs };
      },
    });
    expect(listing).toEqual({ runs: [], errors: [] });
    expect(await advisoryInventory(listing.runs, aged.index, later)).toEqual({ attempts: [], settled: 0, errors: [] });
  });

  describe("settled-index production commands", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "qualification-settled-index-"));
    afterAll(() => rmSync(directory, { recursive: true, force: true }));
    const cli = (args, env = {}) =>
      spawnSync(process.execPath, ["scripts/merge-qualification.mjs", ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, ...env },
      });
    const file = (name, value) => {
      const target = path.join(directory, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, value);
      return target;
    };
    const entryArgs = ({ variant, records, out, extra = [] }) => [
      "settled-entry",
      "--variant",
      variant,
      "--repository",
      repository,
      "--terminal-records",
      file(`${variant}-records.json`, JSON.stringify({ records })),
      ...extra,
      "--out",
      out,
    ];
    const writeArgs = ({ entriesDir, out, prior = null }) => [
      "settled-index-write",
      "--repository",
      repository,
      ...(prior ? ["--prior", prior] : []),
      "--entries-dir",
      entriesDir,
      "--writer-run-id",
      "900",
      "--writer-run-attempt",
      "1",
      "--now",
      "2026-07-21T12:00:00.000Z",
      "--out",
      out,
    ];

    it("AC1 derives advisory and producer-loss entries through the settled-entry command", () => {
      const output = file("entry-output.txt", "");
      const advisoryOut = path.join(directory, "advisory-entry.json");
      const advisory = cli(
        entryArgs({
          variant: "advisory",
          records: [],
          out: advisoryOut,
          extra: [
            "--event",
            file("event.json", advisoryTerminal),
            "--cleanup-marker",
            file("cleanup-complete.json", marker()),
            "--github-output",
            output,
          ],
        }),
      );
      expect(advisory.status, advisory.stderr).toBe(0);
      expect(JSON.parse(readFileSync(advisoryOut, "utf8"))).toEqual(advisoryEntry);
      const lossOut = path.join(directory, "loss-entry.json");
      const producer = cli(
        entryArgs({
          variant: "producer_loss",
          records: [loss, loss],
          out: lossOut,
          extra: ["--advisory-run", file("advisory.json", "null"), "--github-output", output],
        }),
      );
      expect(producer.status, producer.stderr).toBe(0);
      expect(JSON.parse(readFileSync(lossOut, "utf8"))).toEqual(lossEntry);
      const awaitingOut = path.join(directory, "awaiting-entry.json");
      const awaiting = cli(
        entryArgs({
          variant: "producer_loss",
          records: [loss],
          out: awaitingOut,
          extra: [
            "--advisory-run",
            file("late-advisory.json", JSON.stringify(advisoryRun(30, 20))),
            "--github-output",
            output,
          ],
        }),
      );
      expect(awaiting.status, awaiting.stderr).toBe(0);
      expect(existsSync(awaitingOut)).toBe(false);
      expect(readFileSync(output, "utf8")).toBe("settled=true\nsettled=true\nsettled=false\n");
      const refusedOut = path.join(directory, "refused-entry.json");
      const missingMarker = cli(
        entryArgs({
          variant: "advisory",
          records: [advisoryTerminal],
          out: refusedOut,
          extra: ["--cleanup-marker", path.join(directory, "absent-marker.json")],
        }),
      );
      expect(missingMarker.status).toBe(1);
      expect(missingMarker.stderr.trim()).toBe("settlement_evidence_unreadable");
      expect(existsSync(refusedOut)).toBe(false);
    });

    it("AC3 writes a monotonic index from name-bound entry artifacts and refuses mismatches", () => {
      // The merged download lays every entry artifact out as one key-named file.
      const entriesDir = path.join(directory, "entries");
      file("entries/merge-qualification-settled-entry-advisory-30-1.json", JSON.stringify(advisoryEntry));
      file("entries/merge-qualification-settled-entry-producer_loss-20-1.json", JSON.stringify(lossEntry));
      const out = path.join(directory, "settled-index.json");
      const first = cli(writeArgs({ entriesDir, out }));
      expect(first.status, first.stderr).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(`${JSON.stringify(write([advisoryEntry, lossEntry]).index)}\n`);
      // A delivery that settles exactly one attempt has the same layout.
      file("single/merge-qualification-settled-entry-advisory-30-1.json", JSON.stringify(advisoryEntry));
      const singleOut = path.join(directory, "single-index.json");
      const single = cli(writeArgs({ entriesDir: path.join(directory, "single"), out: singleOut }));
      expect(single.status, single.stderr).toBe(0);
      expect(JSON.parse(readFileSync(singleOut, "utf8")).entries).toEqual([advisoryEntry]);
      const prior = file("prior.json", readFileSync(out, "utf8"));
      const emptyEntries = path.join(directory, "empty-entries");
      mkdirSync(emptyEntries, { recursive: true });
      const carriedOut = path.join(directory, "carried-index.json");
      const carried = cli(writeArgs({ entriesDir: emptyEntries, out: carriedOut, prior }));
      expect(carried.status, carried.stderr).toBe(0);
      expect(JSON.parse(readFileSync(carriedOut, "utf8")).entries).toEqual([advisoryEntry, lossEntry]);
      file("bad-name/merge-qualification-settled-entry-advisory-31-1.json", JSON.stringify(advisoryEntry));
      file("bad-extra/merge-qualification-settled-entry-advisory-30-1.json", JSON.stringify(advisoryEntry));
      file("bad-extra/extra.json", "{}");
      file("bad-file/settled-entry.json", JSON.stringify(advisoryEntry));
      file(
        "bad-directory/merge-qualification-settled-entry-advisory-30-1/settled-entry.json",
        JSON.stringify(advisoryEntry),
      );
      for (const [dir, code] of [
        ["bad-name", "settled_entry_artifact_invalid"],
        ["bad-extra", "settled_entry_artifact_invalid"],
        ["bad-file", "settled_entry_artifact_invalid"],
        ["bad-directory", "settled_entry_artifact_invalid"],
        ["bad-missing", "settled_entries_unreadable"],
      ]) {
        const refusedOut = path.join(directory, `${dir}-index.json`);
        const refused = cli(writeArgs({ entriesDir: path.join(directory, dir), out: refusedOut }));
        expect(refused.status, dir).toBe(1);
        expect(refused.stderr.trim(), dir).toBe(code);
        expect(existsSync(refusedOut), dir).toBe(false);
      }
      const unreadablePrior = cli(
        writeArgs({
          entriesDir,
          out: path.join(directory, "no-prior.json"),
          prior: path.join(directory, "absent.json"),
        }),
      );
      expect(unreadablePrior.status).toBe(1);
      expect(unreadablePrior.stderr.trim()).toBe("settled_index_prior_invalid");
      const monotonic = file(
        "conflicting/merge-qualification-settled-entry-advisory-30-1.json",
        JSON.stringify({ ...advisoryEntry, terminals: [{ terminalState: "failed", sha256: "3".repeat(64) }] }),
      );
      expect(existsSync(monotonic)).toBe(true);
      const refusedChange = cli(
        writeArgs({
          entriesDir: path.join(directory, "conflicting"),
          out: path.join(directory, "changed.json"),
          prior,
        }),
      );
      expect(refusedChange.status).toBe(1);
      expect(refusedChange.stderr.trim()).toBe("settled_index_not_monotonic");
    });

    it("AC2 reads the latest index through exactly three gh calls and writes nothing when unknown", () => {
      const preload = file(
        "gh-preload.mjs",
        [
          'import { appendFileSync, readFileSync } from "node:fs";',
          'import childProcess from "node:child_process";',
          'import { syncBuiltinESMExports } from "node:module";',
          "const fixture = JSON.parse(readFileSync(process.env.SETTLED_INDEX_FIXTURE, 'utf8'));",
          "const log = (entry) => appendFileSync(process.env.SETTLED_INDEX_CALLS, JSON.stringify(entry) + '\\n');",
          "const original = childProcess.execFileSync;",
          "childProcess.execFileSync = (command, args, options) => {",
          "  if (command === 'gh') {",
          "    log({ command, args });",
          "    if (args[0] !== 'api') throw new Error('unexpected gh call');",
          "    if (args[1].includes('/workflows/platform-merge-qualification-observer.yml/runs?')) return JSON.stringify(fixture.runs);",
          "    if (args[1].includes('/artifacts?name=')) return JSON.stringify(fixture.artifacts);",
          "    if (args[1].endsWith('/zip')) return Buffer.from('synthetic-zip');",
          "    throw new Error('unexpected gh endpoint');",
          "  }",
          "  if (command === 'unzip') {",
          "    log({ command, args: [args[0]] });",
          "    return args[0] === '-Z1' ? 'settled-index.json\\n' : fixture.index;",
          "  }",
          "  return original(command, args, options);",
          "};",
          "syncBuiltinESMExports();",
        ].join("\n"),
      );
      const index = write([advisoryEntry]).index;
      for (const [label, artifacts] of [
        ["valid", { total_count: 1, artifacts: [indexArtifact] }],
        ["unknown", { total_count: 0, artifacts: [] }],
      ]) {
        const calls = file(`${label}-calls.jsonl`, "");
        const fixture = file(
          `${label}-fixture.json`,
          JSON.stringify({
            runs: { total_count: 1, workflow_runs: [observerRun] },
            artifacts,
            index: `${JSON.stringify(index)}\n`,
          }),
        );
        const out = path.join(directory, `${label}-prior`, "settled-index.json");
        const output = file(`${label}-output.txt`, "");
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            pathToFileURL(preload).href,
            "scripts/merge-qualification.mjs",
            "settled-index-read",
            "--repository",
            repository,
            "--default-branch",
            "main",
            "--out",
            out,
            "--github-output",
            output,
          ],
          {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 30_000,
            env: { ...process.env, SETTLED_INDEX_FIXTURE: fixture, SETTLED_INDEX_CALLS: calls },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const log = readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const ghCalls = log.filter((call) => call.command === "gh").map((call) => call.args[1]);
        if (label === "valid") {
          expect(ghCalls).toEqual([
            "repos/synthetic/repository/actions/workflows/platform-merge-qualification-observer.yml/runs?branch=main&status=success&per_page=1",
            `repos/synthetic/repository/actions/runs/900/artifacts?name=${MERGE_QUALIFICATION_SETTLED_INDEX_ARTIFACT}`,
            "repos/synthetic/repository/actions/artifacts/7000/zip",
          ]);
          expect(log.filter((call) => call.command === "unzip").map((call) => call.args[0])).toEqual(["-Z1", "-p"]);
          expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(index);
          expect(readFileSync(output, "utf8")).toBe("state=valid\nreason=\nentries=1\n");
        } else {
          expect(ghCalls).toHaveLength(2);
          expect(existsSync(out)).toBe(false);
          expect(readFileSync(output, "utf8")).toBe("state=unknown\nreason=settled_index_missing\nentries=0\n");
        }
      }
    });
  });
});
