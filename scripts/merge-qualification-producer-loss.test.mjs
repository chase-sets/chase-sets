import { describe, expect, it } from "vitest";
import {
  buildMergeQualificationCandidate,
  inventoryMergeQualificationProducerAttempts,
  reconcileMergeQualificationProducerAttempt,
  validateMergeQualificationCandidate,
  validateMergeQualificationProducerTerminal,
} from "./merge-qualification.mjs";

const sha = "a".repeat(40);
const tree = "b".repeat(40);
const policyRevision = "c".repeat(40);
const now = new Date("2026-07-21T12:00:00.000Z");

const producer = (overrides = {}) => ({
  id: 4000,
  run_attempt: 1,
  workflow_id: 11,
  path: ".github/workflows/platform-pr.yml",
  event: "merge_group",
  status: "completed",
  conclusion: "success",
  created_at: "2026-07-21T10:00:00Z",
  run_started_at: "2026-07-21T10:00:00Z",
  updated_at: "2026-07-21T10:01:00Z",
  head_sha: sha,
  repository: { full_name: "chase-sets/chase-sets" },
  ...overrides,
});

const candidate = buildMergeQualificationCandidate({
  repository: "chase-sets/chase-sets",
  workflowId: "11",
  workflowPath: ".github/workflows/platform-pr.yml",
  runId: "4000",
  runAttempt: "1",
  queueBaseSha: "d".repeat(40),
  pullRequests: [{ number: 1, headSha: "e".repeat(40) }],
  candidateSha: sha,
  candidateTreeSha: tree,
  builtImageDigest: `sha256:${"f".repeat(64)}`,
  policyRevision,
  capturedAt: "2026-07-21T10:00:00Z",
}).record;

describe("producer dispatch-loss reconciliation", () => {
  it("inventories complete producer and advisory windows before filtering", async () => {
    const calls = [];
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) => {
        calls.push(endpoint);
        if (endpoint.includes("platform-pr.yml")) {
          return { total_count: 1, workflow_runs: [producer()] };
        }
        return { total_count: 0, workflow_runs: [] };
      },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: JSON.stringify({ enabled: true }),
        decision: { enabled: true, reasonCode: "policy_enabled" },
      }),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("platform-pr.yml/runs");
    expect(calls[1]).toContain("platform-merge-qualification.yml/runs");
    expect(result.errors).toEqual([]);
    expect(result.attempts).toMatchObject([{ run_id: "4000", run_attempt: "1", advisoryRunPresent: false }]);
  });

  it("does not read candidate or policy before a missing-advisory join", async () => {
    const reads = [];
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => new Date("2026-07-21T10:05:00Z"),
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 1, workflow_runs: [{ display_title: "Merge Qualification producer 4000-1" }] },
      readPolicyContent: async () => reads.push("policy"),
      readCandidate: async () => reads.push("candidate"),
    });
    expect(result.attempts).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("does not admit a producer to per-item inspection before the fifteen-minute tick", async () => {
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => new Date("2026-07-21T10:05:00Z"),
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: JSON.stringify({ enabled: true }),
        decision: { enabled: true, reasonCode: "policy_enabled" },
      }),
    });
    expect(result).toEqual({ attempts: [], errors: [] });
  });

  it("returns zero attempts for 31 completed producers when default-branch policy was disabled", async () => {
    const producers = Array.from({ length: 31 }, (_, index) => producer({ id: 5000 + index }));
    let reconcileCalls = 0;
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: producers.length, workflow_runs: producers }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: JSON.stringify({ schemaVersion: "merge-qualification-policy/v1", enabled: false }),
        decision: { enabled: false, reasonCode: "policy_disabled" },
      }),
    });
    if (result.attempts.length) reconcileCalls += result.attempts.length;
    expect(result).toEqual({ attempts: [], errors: [] });
    expect(reconcileCalls).toBe(0);
  });

  it("refuses a duplicate advisory identity and a non-completed producer", async () => {
    const duplicate = { display_title: "Merge Qualification producer 4000-1", id: 9001, run_attempt: 1 };
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 2, workflow_runs: [duplicate, { ...duplicate, id: 9002 }] },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: "{}",
        decision: { enabled: true },
      }),
    });
    expect(result).toEqual({ attempts: [], errors: ["advisory_identity_invalid"] });
    const pending = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer({ status: "in_progress" })] }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: "{}",
        decision: { enabled: true },
      }),
    });
    expect(pending).toEqual({ attempts: [], errors: [] });
  });

  it("settles one producer-keyed terminal after one tick and is byte-idempotent", () => {
    const first = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    });
    expect(first.state).toBe("dispatch_loss");
    expect(first.event).toMatchObject({
      producerRunId: "4000",
      producerRunAttempt: "1",
      terminalState: "infrastructure_error",
      reasonCodes: ["advisory_dispatch_missing"],
      cleanupLegs: 0,
      idempotencyKey: "merge-qualification-producer:chase-sets/chase-sets:4000:1",
    });
    const replay = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      existingTerminal: first.event,
      now,
    });
    expect(replay).toMatchObject({ state: "idempotent", event: null });
  });

  it("refuses producer page drift, the search ceiling, and matrix overflow", async () => {
    const drift = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) => {
        const page = Number(new URL(endpoint, "https://api.invalid").searchParams.get("page"));
        return endpoint.includes("platform-pr.yml")
          ? page === 1
            ? {
                total_count: 101,
                workflow_runs: Array.from({ length: 100 }, (_, index) => producer({ id: 6000 + index })),
              }
            : { total_count: 100, workflow_runs: [producer({ id: 7000 })] }
          : { total_count: 0, workflow_runs: [] };
      },
    });
    expect(drift.errors).toEqual(["producer_inventory_incomplete"]);
    const ceiling = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? {
              total_count: 1000,
              workflow_runs: Array.from({ length: 100 }, (_, index) => producer({ id: 8000 + index })),
            }
          : { total_count: 0, workflow_runs: [] },
    });
    expect(ceiling.errors).toEqual(["producer_inventory_incomplete"]);
    const overflowRuns = Array.from({ length: 257 }, (_, index) => producer({ id: 9000 + index }));
    const overflow = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) => {
        if (!endpoint.includes("platform-pr.yml")) return { total_count: 0, workflow_runs: [] };
        const page = Number(new URL(endpoint, "https://api.invalid").searchParams.get("page"));
        return { total_count: 257, workflow_runs: overflowRuns.slice((page - 1) * 100, page * 100) };
      },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: "{}",
        decision: { enabled: true },
      }),
    });
    expect(overflow.errors).toEqual(["producer_worker_capacity_exceeded"]);
    expect(validateMergeQualificationProducerTerminal({ cleanupLegs: 1 })).not.toEqual([]);
  });

  it("names awaiting, ineligible, advisory-present, and late-race conflict states", () => {
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate,
        policy: { enabled: true },
        now: new Date("2026-07-21T10:05:00Z"),
      }).state,
    ).toBe("awaiting_tick");
    expect(
      reconcileMergeQualificationProducerAttempt({ producer: producer(), candidate, policy: { enabled: false }, now })
        .state,
    ).toBe("ineligible");
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate,
        policy: { enabled: true },
        advisoryRun: { id: 5000 },
        now,
      }).state,
    ).toBe("advisory_present");
    const terminal = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate,
        policy: { enabled: true },
        advisoryRun: { id: 5000 },
        existingTerminal: terminal,
        now,
      }),
    ).toMatchObject({ state: "conflict", event: { terminalState: "conflict" } });
  });

  it("rejects a terminal from another producer identity", () => {
    const terminal = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer({ id: 4001 }),
        candidate: { ...candidate, runId: "4001" },
        policy: { enabled: true },
        existingTerminal: terminal,
        now,
      }),
    ).toMatchObject({ state: "unknown", reason: "terminal_identity_invalid", event: null });
  });

  it("rejects absent or substituted policy revision and malformed producer pages", () => {
    expect(validateMergeQualificationCandidate({ ...candidate, policyRevision: undefined })).not.toEqual([]);
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate: { ...candidate, policyRevision: sha },
        policy: { enabled: true },
        now,
      }),
    ).toMatchObject({ state: "unknown", reason: "candidate_invalid" });
  });
});
