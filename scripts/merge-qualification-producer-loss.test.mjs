import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildMergeQualificationCandidate,
  inventoryMergeQualificationProducerAttempts,
  readMergeQualificationProducerTerminalRecords,
  readMergeQualificationProducerImageEligibility,
  readMergeQualificationAdvisoryCleanupMarkers,
  readHistoricalProducerPolicy,
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
      readHistoricalPolicyContent: async () => reads.push("policy"),
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

  it("anchors the tick to producer completion and admits a late advisory", async () => {
    const completed = producer({
      run_started_at: "2026-07-21T09:30:00Z",
      created_at: "2026-07-21T09:30:00Z",
      updated_at: "2026-07-21T10:01:00Z",
    });
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => new Date("2026-07-21T10:20:00Z"),
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [completed] }
          : {
              total_count: 1,
              workflow_runs: [
                {
                  display_title: "Merge Qualification producer 4000-1",
                  created_at: "2026-07-21T10:17:00Z",
                },
              ],
            },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: JSON.stringify({ enabled: true }),
        decision: { enabled: true, reasonCode: "policy_enabled" },
      }),
      readProducerImageEligibility: async () => true,
    });
    expect(result.attempts).toHaveLength(1);
  });

  it("keeps policy authority failure as one producer unknown", async () => {
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => {
        throw new Error("producer_policy_landing_evidence_unavailable");
      },
      readProducerImageEligibility: async () => true,
    });
    expect(result.errors).toEqual([]);
    expect(result.attempts).toMatchObject([
      {
        historicalPolicyState: "unknown",
        historicalPolicyReason: "producer_policy_landing_evidence_unavailable",
      },
    ]);
  });

  it("does not read image eligibility for an advisory joined before the tick", async () => {
    let eligibilityReads = 0;
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : {
              total_count: 1,
              workflow_runs: [
                {
                  display_title: "Merge Qualification producer 4000-1",
                  created_at: "2026-07-21T10:02:00Z",
                },
              ],
            },
      readProducerImageEligibility: async () => {
        eligibilityReads += 1;
        return true;
      },
    });
    expect(result).toEqual({ attempts: [], errors: [] });
    expect(eligibilityReads).toBe(0);
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

  it.each([{ reasonCode: "policy_expired" }, { reasonCode: "policy_schema_invalid" }, {}])(
    "keeps canonically disabled history inert (%o)",
    async (decision) => {
      const result = await inventoryMergeQualificationProducerAttempts({
        repository: "chase-sets/chase-sets",
        now: () => now,
        requestJson: async (endpoint) =>
          endpoint.includes("platform-pr.yml")
            ? { total_count: 1, workflow_runs: [producer()] }
            : { total_count: 0, workflow_runs: [] },
        readHistoricalPolicyContent: async () => ({
          revision: policyRevision,
          content: "malformed",
          decision: { enabled: false, ...decision },
        }),
        readProducerImageEligibility: async () => true,
      });
      expect(result).toEqual({ attempts: [], errors: [] });
    },
  );

  it("skips a producer whose Docker Image Build job was skipped", async () => {
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 0, workflow_runs: [] },
      readHistoricalPolicyContent: async () => ({
        revision: policyRevision,
        content: JSON.stringify({ enabled: true }),
        decision: { enabled: true, reasonCode: "policy_enabled" },
      }),
      readProducerImageEligibility: async () => false,
    });
    expect(result).toEqual({ attempts: [], errors: [] });
  });

  it.each([
    ["success", true],
    ["skipped", false],
    ["cancelled", false],
    ["failure", false],
  ])("requires one successful image push step (%s)", async (conclusion, expected) => {
    const result = await readMergeQualificationProducerImageEligibility({
      repository: "chase-sets/chase-sets",
      run: producer(),
      requestJson: async () => ({
        total_count: 1,
        jobs: [
          {
            id: 77,
            name: "Docker Image Build",
            conclusion: "success",
            steps: [{ name: "Push boot-smoked merge-group image", conclusion }],
          },
        ],
      }),
    });
    expect(result).toBe(expected);
  });

  it("refuses missing or duplicate image push evidence", async () => {
    await expect(
      readMergeQualificationProducerImageEligibility({
        repository: "chase-sets/chase-sets",
        run: producer(),
        requestJson: async () => ({
          total_count: 1,
          jobs: [{ id: 77, name: "Docker Image Build", steps: [] }],
        }),
      }),
    ).rejects.toThrow("producer_image_eligibility_invalid");
    await expect(
      readMergeQualificationProducerImageEligibility({
        repository: "chase-sets/chase-sets",
        run: producer(),
        requestJson: async () => ({
          total_count: 1,
          jobs: [
            {
              id: 77,
              name: "Docker Image Build",
              steps: [
                { name: "Push boot-smoked merge-group image", conclusion: "success" },
                { name: "Push boot-smoked merge-group image", conclusion: "success" },
              ],
            },
          ],
        }),
      }),
    ).rejects.toThrow("producer_image_eligibility_invalid");
  });

  it("keeps malformed image evidence as one producer unknown", async () => {
    const result = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer()] }
          : { total_count: 0, workflow_runs: [] },
      readProducerImageEligibility: async () => {
        throw new Error("producer_image_eligibility_invalid");
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.attempts).toMatchObject([
      {
        historicalPolicyState: "unknown",
        historicalPolicyReason: "producer_image_eligibility_invalid",
        imageEligible: null,
      },
    ]);
  });

  it("refuses a producer head as historical policy authority even when it appears before run start", async () => {
    const producerHead = "d".repeat(40);
    await expect(
      readHistoricalProducerPolicy({
        run: producer({ head_sha: producerHead }),
        execFile: (command, args) => {
          if (args[0] === "log") return `${producerHead}\t2026-07-21T09:00:00Z\n`;
          return "";
        },
        readPolicy: () => JSON.stringify({ enabled: true }),
        readLandingEvidence: async () => [
          {
            base: { ref: "main" },
            merged_at: "2026-07-21T09:30:00Z",
            merge_commit_sha: producerHead,
          },
        ],
      }),
    ).rejects.toThrow("producer_policy_authority_unavailable");
  });

  it("uses real git history plus landing time, not committer time, for authority", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "qualification-policy-history-"));
    try {
      const git = (args, options = {}) => execFileSync("git", args, { ...options, cwd: repo, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["config", "user.name", "Test"]);
      mkdirSync(path.join(repo, "scripts"));
      writeFileSync(path.join(repo, "scripts/merge-qualification-policy.json"), '{"enabled":false}\n');
      git(["add", "."]);
      git(["commit", "-qm", "disabled"], {
        env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-21T08:00:00Z", GIT_COMMITTER_DATE: "2026-07-21T08:00:00Z" },
      });
      const disabled = git(["rev-parse", "HEAD"]).trim();
      writeFileSync(path.join(repo, "scripts/merge-qualification-policy.json"), '{"enabled":true}\n');
      git(["add", "."]);
      git(["commit", "-qm", "enable"], {
        env: { ...process.env, GIT_AUTHOR_DATE: "2026-07-21T09:30:00Z", GIT_COMMITTER_DATE: "2026-07-21T09:30:00Z" },
      });
      const enabled = git(["rev-parse", "HEAD"]).trim();
      git(["update-ref", "refs/remotes/origin/main", enabled]);
      const result = await readHistoricalProducerPolicy({
        repository: "chase-sets/chase-sets",
        run: producer({ run_started_at: "2026-07-21T10:00:00Z", head_sha: sha }),
        execFile: (command, args, options) => git(args, options),
        readLandingEvidence: async ({ revision }) => [
          {
            base: { ref: "main" },
            merged_at: revision === enabled ? "2026-07-21T10:30:00Z" : "2026-07-21T08:30:00Z",
            merge_commit_sha: revision,
          },
        ],
        readPolicy: async (revision) => (revision === disabled ? '{"enabled":false}' : '{"enabled":true}'),
      });
      expect(result).toMatchObject({ revision: disabled, decision: { enabled: false } });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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
    const foreign = await inventoryMergeQualificationProducerAttempts({
      repository: "chase-sets/chase-sets",
      now: () => now,
      requestJson: async (endpoint) =>
        endpoint.includes("platform-pr.yml")
          ? { total_count: 1, workflow_runs: [producer({ path: ".github/workflows/other.yml" })] }
          : { total_count: 0, workflow_runs: [] },
    });
    expect(foreign.errors).toEqual(["producer_identity_invalid"]);
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
        advisoryRun: { id: 5000, run_attempt: 1 },
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
        advisoryRun: { id: 5000, run_attempt: 1 },
        existingTerminal: terminal,
        advisoryCleanupComplete: true,
        now,
      }),
    ).toMatchObject({ state: "conflict", event: { terminalState: "conflict" } });
  });

  it("waits for cleanup before conflict and settles a two-record replay", () => {
    const loss = reconcileMergeQualificationProducerAttempt({
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
        existingTerminal: loss,
        now,
      }),
    ).toMatchObject({ state: "awaiting_advisory_cleanup", event: null });
    const conflict = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      advisoryRun: { id: 5000, run_attempt: 1 },
      existingTerminal: loss,
      advisoryCleanupComplete: true,
      now,
    }).event;
    expect(conflict).toMatchObject({ terminalState: "conflict" });
    expect(
      reconcileMergeQualificationProducerAttempt({
        producer: producer(),
        candidate,
        policy: { enabled: true },
        advisoryRun: { id: 5000, run_attempt: 1 },
        existingTerminals: [loss, conflict],
        advisoryCleanupComplete: true,
        now,
      }),
    ).toMatchObject({ state: "conflict_settled", event: null });
  });

  it("classifies byte-identical producer terminal replay and refuses foreign writers", async () => {
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    const bytes = JSON.stringify(loss);
    const requestJson = async (endpoint) => {
      if (endpoint.includes("/artifacts?"))
        return {
          total_count: 1,
          artifacts: [
            { id: 1, name: "merge-qualification-producer-terminal-4000-1", expired: false, workflow_run: { id: 9000 } },
          ],
        };
      return writer;
    };
    const result = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson,
      downloadArtifact: async () => bytes,
    });
    expect(result).toMatchObject({ state: "dispatch_loss", records: [bytes], errors: [] });
    const refused = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?")
          ? requestJson(endpoint)
          : { ...writer, head_repository: { full_name: "evil/repo" } },
      downloadArtifact: async () => bytes,
    });
    expect(refused.errors).toEqual(["terminal_writer_invalid"]);
  });

  it("refuses terminal page drift and foreign producer bindings", async () => {
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    const artifact = (id) => ({
      id,
      name: "merge-qualification-producer-terminal-4000-1",
      expired: false,
      workflow_run: { id: 9000 },
    });
    const base = {
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      downloadArtifact: async () => JSON.stringify(loss),
    };
    const drift = await readMergeQualificationProducerTerminalRecords({
      ...base,
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?")
          ? Number(new URL(endpoint, "https://api.invalid").searchParams.get("page")) === 1
            ? { total_count: 2, artifacts: [artifact(1)] }
            : { total_count: 1, artifacts: [artifact(2)] }
          : writer,
    });
    expect(drift.errors).toEqual(["terminal_inventory_incomplete"]);
    const foreign = await readMergeQualificationProducerTerminalRecords({
      ...base,
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?") ? { total_count: 1, artifacts: [artifact(1)] } : writer,
      downloadArtifact: async () =>
        JSON.stringify({
          ...loss,
          producerRunId: "4001",
          idempotencyKey: "merge-qualification-producer:chase-sets/chase-sets:4001:1",
        }),
    });
    expect(foreign.errors).toEqual(["terminal_payload_binding_invalid"]);
  });

  it("deduplicates byte-identical terminal replay and enforces closed fields", async () => {
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    const bytes = JSON.stringify(loss);
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    const requestJson = async (endpoint) =>
      endpoint.includes("/artifacts?")
        ? {
            total_count: 2,
            artifacts: [
              {
                id: 1,
                name: "merge-qualification-producer-terminal-4000-1",
                expired: false,
                workflow_run: { id: 9000 },
              },
              {
                id: 2,
                name: "merge-qualification-producer-terminal-4000-1",
                expired: false,
                workflow_run: { id: 9000 },
              },
            ],
          }
        : writer;
    const replay = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson,
      downloadArtifact: async () => bytes,
    });
    expect(replay).toMatchObject({ state: "dispatch_loss", errors: [] });
    const invalid = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?")
          ? {
              total_count: 1,
              artifacts: [
                {
                  id: 1,
                  name: "merge-qualification-producer-terminal-4000-1",
                  expired: false,
                  workflow_run: { id: 9000 },
                },
              ],
            }
          : writer,
      downloadArtifact: async () => JSON.stringify({ ...loss, cleanupLegs: 1 }),
    });
    expect(invalid.errors).toEqual(["terminal_payload_binding_invalid"]);
    const badKey = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?")
          ? {
              total_count: 1,
              artifacts: [
                {
                  id: 1,
                  name: "merge-qualification-producer-terminal-4000-1",
                  expired: false,
                  workflow_run: { id: 9000 },
                },
              ],
            }
          : writer,
      downloadArtifact: async () => JSON.stringify({ ...loss, idempotencyKey: "wrong" }),
    });
    expect(badKey.errors).toEqual(["terminal_payload_binding_invalid"]);
  });

  it("classifies late advisory cleanup ordering from the authenticated marker reader", async () => {
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    const bytes = JSON.stringify(loss);
    const requestJson = async (endpoint) =>
      endpoint.includes("/artifacts?")
        ? {
            total_count: 1,
            artifacts: [
              {
                id: 1,
                name: "merge-qualification-producer-terminal-4000-1",
                expired: false,
                workflow_run: { id: 9000 },
              },
            ],
          }
        : {
            id: 9000,
            repository: { full_name: "chase-sets/chase-sets" },
            head_repository: { full_name: "chase-sets/chase-sets" },
            head_branch: "main",
            path: ".github/workflows/platform-merge-qualification-observer.yml",
            event: "schedule",
          };
    const base = {
      repository: "chase-sets/chase-sets",
      producer: producer(),
      advisoryRun: {
        id: 5000,
        run_attempt: 1,
        repository: { full_name: "chase-sets/chase-sets" },
        path: ".github/workflows/platform-merge-qualification.yml",
        event: "workflow_dispatch",
      },
      defaultBranch: "main",
      requestJson,
      downloadArtifact: async () => bytes,
    };
    const awaiting = await readMergeQualificationProducerTerminalRecords({
      ...base,
      readAdvisoryCleanupMarkers: async () => ({ complete: false, errors: [] }),
    });
    expect(awaiting).toMatchObject({ state: "awaiting_advisory_cleanup", errors: [] });
    const complete = await readMergeQualificationProducerTerminalRecords({
      ...base,
      readAdvisoryCleanupMarkers: async () => ({ complete: true, errors: [] }),
    });
    expect(complete).toMatchObject({ state: "advisory_cleanup_complete", advisoryCleanupComplete: true, errors: [] });
  });

  it("reads the cleanup-complete filename and rejects a foreign marker writer", async () => {
    const advisoryRun = {
      id: 5000,
      run_attempt: 1,
      repository: { full_name: "chase-sets/chase-sets" },
      path: ".github/workflows/platform-merge-qualification.yml",
      event: "workflow_dispatch",
    };
    const markerName = "merge-qualification-cleanup-complete-5000-1";
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    const result = await readMergeQualificationAdvisoryCleanupMarkers({
      repository: "chase-sets/chase-sets",
      advisoryRun,
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("name=merge-qualification-cleanup-complete-")
          ? { total_count: 1, artifacts: [{ id: 2, name: markerName, expired: false, workflow_run: { id: 9000 } }] }
          : writer,
      downloadArtifact: async ({ fileName }) => {
        expect(fileName).toBe("cleanup-complete.json");
        return JSON.stringify({ runId: "5000", runAttempt: "1", cleanup: "complete" });
      },
    });
    expect(result).toEqual({ complete: true, errors: [] });
    const foreign = await readMergeQualificationAdvisoryCleanupMarkers({
      repository: "chase-sets/chase-sets",
      advisoryRun,
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("name=merge-qualification-cleanup-complete-")
          ? { total_count: 1, artifacts: [{ id: 2, name: markerName, expired: false, workflow_run: { id: 9000 } }] }
          : { ...writer, path: ".github/workflows/other.yml" },
      downloadArtifact: async () => JSON.stringify({ runId: "5000", runAttempt: "1", cleanup: "complete" }),
    });
    expect(foreign.errors).toEqual(["producer_marker_writer_invalid"]);
  });

  it("settles loss and conflict records at the terminal reader", async () => {
    const loss = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      now,
    }).event;
    const conflict = reconcileMergeQualificationProducerAttempt({
      producer: producer(),
      candidate,
      policy: { enabled: true },
      advisoryRun: { id: 5000, run_attempt: 1 },
      existingTerminal: loss,
      advisoryCleanupComplete: true,
      now,
    }).event;
    const writer = {
      id: 9000,
      repository: { full_name: "chase-sets/chase-sets" },
      head_repository: { full_name: "chase-sets/chase-sets" },
      head_branch: "main",
      path: ".github/workflows/platform-merge-qualification-observer.yml",
      event: "schedule",
    };
    let downloadCount = 0;
    const result = await readMergeQualificationProducerTerminalRecords({
      repository: "chase-sets/chase-sets",
      producer: producer(),
      defaultBranch: "main",
      requestJson: async (endpoint) =>
        endpoint.includes("/artifacts?")
          ? {
              total_count: 2,
              artifacts: [
                {
                  id: 1,
                  name: "merge-qualification-producer-terminal-4000-1",
                  expired: false,
                  workflow_run: { id: 9000 },
                },
                {
                  id: 2,
                  name: "merge-qualification-producer-terminal-4000-1",
                  expired: false,
                  workflow_run: { id: 9000 },
                },
              ],
            }
          : writer,
      downloadArtifact: async () => JSON.stringify(downloadCount++ === 0 ? loss : conflict),
    });
    expect(result).toMatchObject({ state: "conflict_settled", advisoryCleanupComplete: true, errors: [] });
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
