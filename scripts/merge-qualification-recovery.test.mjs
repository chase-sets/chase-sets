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
} from "./merge-qualification.mjs";

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
  run_started_at: "2026-07-21T10:00:00Z",
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
    state: "QUEUED",
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
