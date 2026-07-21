import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MERGE_GATE_OVERHEAD_BUDGET_MS,
  MERGE_GATE_PROOF_REQUIRED_RUNS,
  aggregateMergeGateProof,
  buildMergeGateNamespaceManifest,
  buildMergeGateRunRecord,
  evaluateMergeGateCapacity,
  parseCpuMillicores,
  parseMemoryMib,
  validateMergeGateConfig,
  verifyMergeGateCleanupTarget,
} from "./merge-gate-verification.mjs";

const NOW = new Date("2026-07-21T12:00:00.000Z");

function checkedInConfig() {
  return JSON.parse(readFileSync(resolve("scripts/merge-gate-verification-config.json"), "utf8"));
}

function validConfig(overrides = {}) {
  return {
    ...checkedInConfig(),
    costWager: { ...checkedInConfig().costWager, expiresAt: "2026-08-15T00:00:00.000Z" },
    ...overrides,
  };
}

describe("resource quantity parsing", () => {
  it("parses Kubernetes CPU and memory quantities", () => {
    expect(parseCpuMillicores("3900m")).toBe(3900);
    expect(parseCpuMillicores("4")).toBe(4000);
    expect(parseCpuMillicores("")).toBeNull();
    expect(parseMemoryMib("6350Mi")).toBe(6350);
    expect(parseMemoryMib("8Gi")).toBe(8192);
    expect(parseMemoryMib("1048576Ki")).toBe(1024);
    expect(parseMemoryMib("bogus")).toBeNull();
  });
});

describe("merge-gate config and cost wager (unknown cost or missing expiry fails preflight)", () => {
  it("accepts the checked-in config while its wager is unexpired", () => {
    // Validate the real file against a fixed clock inside its wager window so
    // this test does not rot with wall time; the runtime preflight enforces
    // the live clock.
    const config = checkedInConfig();
    const withinWindow = new Date(Date.parse(config.costWager.expiresAt) - 24 * 60 * 60 * 1000);
    expect(validateMergeGateConfig(config, { now: withinWindow })).toEqual([]);
  });

  it("fails closed on a missing expiry", () => {
    const config = validConfig();
    delete config.costWager.expiresAt;
    expect(validateMergeGateConfig(config, { now: NOW })).toEqual([
      expect.stringContaining("costWager.expiresAt is missing or unparseable"),
    ]);
  });

  it("fails closed on an expired wager", () => {
    const config = validConfig();
    config.costWager.expiresAt = "2026-07-01T00:00:00.000Z";
    expect(validateMergeGateConfig(config, { now: NOW })).toEqual([expect.stringContaining("has passed")]);
  });

  it("fails closed on a wager horizon beyond 30 days", () => {
    const config = validConfig();
    config.costWager.expiresAt = "2026-12-01T00:00:00.000Z";
    expect(validateMergeGateConfig(config, { now: NOW })).toEqual([expect.stringContaining("more than 30 days away")]);
  });

  it("fails closed on unknown per-run cost or missing minute rate", () => {
    const missingRequests = validConfig();
    delete missingRequests.perRunRequests;
    expect(validateMergeGateConfig(missingRequests, { now: NOW })).toEqual([
      expect.stringContaining("perRunRequests must declare positive cpuMillicores and memoryMib"),
    ]);

    const missingRate = validConfig();
    delete missingRate.costWager.actionsMinuteRateUsd;
    expect(validateMergeGateConfig(missingRate, { now: NOW })).toEqual([
      expect.stringContaining("actionsMinuteRateUsd"),
    ]);
  });

  it("requires a capacity exception to be a complete checked-in wager", () => {
    const config = validConfig({ capacityException: { owner: "todd.skelton@chasesets.com" } });
    expect(validateMergeGateConfig(config, { now: NOW })).toEqual([
      expect.stringContaining("capacityException must declare owner, dollarCeilingUsd, and a parseable expiresAt"),
    ]);
  });

  it("rejects unknown schema versions outright", () => {
    expect(validateMergeGateConfig({ schemaVersion: "merge-gate-verification-config/v2" }, { now: NOW })).toEqual([
      expect.stringContaining("schemaVersion must be merge-gate-verification-config/v1"),
    ]);
  });
});

describe("capacity headroom preflight", () => {
  const previewNode = (name, cpu = "3900m", memory = "6350Mi") => ({
    metadata: { name, labels: { "chase-sets.com/pool": "preview" } },
    status: { allocatable: { cpu, memory } },
  });
  const pod = (nodeName, cpu, memory, phase = "Running") => ({
    spec: { nodeName, containers: [{ resources: { requests: { cpu, memory } } }] },
    status: { phase },
  });
  const pools = [{ name: "preview", max_nodes: 3 }];

  it("passes with an empty pool and counts live preview pod requests against capacity", () => {
    const config = validConfig();
    const empty = evaluateMergeGateCapacity({
      config,
      nodes: { items: [previewNode("preview-a")] },
      pods: { items: [] },
      nodePools: pools,
    });
    expect(empty.passed).toBe(true);
    expect(empty.measurement.allocatableSource).toBe("live-node");
    expect(empty.measurement.maxNodes).toBe(3);

    // A live chase-sets-pr-* preview consuming most of the pool flips the
    // same measurement to insufficient.
    const crowded = evaluateMergeGateCapacity({
      config,
      nodes: { items: [previewNode("preview-a")] },
      pods: { items: [pod("preview-a", "3500m", "6000Mi"), pod("preview-a", "3000m", "6000Mi")] },
      nodePools: pools,
    });
    expect(crowded.passed).toBe(false);
    expect(crowded.errors).toEqual([
      expect.stringContaining("insufficient preview-pool headroom"),
      expect.stringContaining("insufficient preview-pool headroom"),
    ]);
    expect(crowded.measurement.committed.pods).toBe(2);
  });

  it("supports autoscale-from-zero via the checked-in allocatable fallback", () => {
    const result = evaluateMergeGateCapacity({
      config: validConfig(),
      nodes: { items: [] },
      pods: { items: [] },
      nodePools: pools,
    });
    expect(result.passed).toBe(true);
    expect(result.measurement.allocatableSource).toBe("config-fallback");
    expect(result.measurement.livePreviewNodes).toBe(0);
  });

  it("fails closed on unknown headroom: missing listings or an unknown pool", () => {
    const config = validConfig();
    expect(evaluateMergeGateCapacity({ config, nodes: null, pods: { items: [] }, nodePools: pools }).passed).toBe(
      false,
    );
    expect(evaluateMergeGateCapacity({ config, nodes: { items: [] }, pods: null, nodePools: pools }).passed).toBe(
      false,
    );
    const unknownPool = evaluateMergeGateCapacity({
      config,
      nodes: { items: [] },
      pods: { items: [] },
      nodePools: [{ name: "renamed-pool", max_nodes: 3 }],
    });
    expect(unknownPool.passed).toBe(false);
    expect(unknownPool.errors).toEqual([expect.stringContaining("unknown headroom fails preflight")]);
  });

  it("ignores completed pods and pods on non-preview nodes", () => {
    const result = evaluateMergeGateCapacity({
      config: validConfig(),
      nodes: { items: [previewNode("preview-a")] },
      pods: {
        items: [
          pod("staging-node", "3900m", "6000Mi"),
          pod("preview-a", "3900m", "6000Mi", "Succeeded"),
          pod("preview-a", "100m", "128Mi"),
        ],
      },
      nodePools: pools,
    });
    expect(result.measurement.committed).toEqual({ cpuMillicores: 100, memoryMib: 128, pods: 1 });
    expect(result.passed).toBe(true);
  });
});

describe("atomic gate namespace manifest", () => {
  const input = {
    runId: "123456",
    runAttempt: "2",
    repository: "chase-sets/chase-sets",
    workflowId: "778899",
    workflowPath: ".github/workflows/platform-merge-qualification.yml",
    candidateSha: "0123456789abcdef0123456789abcdef01234567",
    candidateTreeSha: "89abcdef0123456789abcdef0123456789abcdef",
    imageDigest: `sha256:${"a".repeat(64)}`,
    cleanupDeadlineHours: 2,
    now: NOW,
  };

  it("binds identity, candidate, digest, creation time, and cleanup deadline in one create", () => {
    const manifest = buildMergeGateNamespaceManifest(input);
    expect(manifest).toEqual({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: "chase-sets-gate-123456-2",
        labels: {
          "chasesets.com/purpose": "merge-gate-verification",
          "chasesets.com/run-id": "123456",
          "chasesets.com/run-attempt": "2",
        },
        annotations: {
          "chasesets.com/repository": "chase-sets/chase-sets",
          "chasesets.com/workflow-id": "778899",
          "chasesets.com/workflow-path": ".github/workflows/platform-merge-qualification.yml",
          "chasesets.com/workflow-run": "123456",
          "chasesets.com/workflow-run-attempt": "2",
          "chasesets.com/candidate-sha": input.candidateSha,
          "chasesets.com/candidate-tree-sha": input.candidateTreeSha,
          "chasesets.com/image-digest": input.imageDigest,
          "chasesets.com/created-at": "2026-07-21T12:00:00.000Z",
          "chasesets.com/cleanup-deadline": "2026-07-21T14:00:00.000Z",
        },
      },
    });
  });

  it("fails closed on malformed identity, candidate, or digest inputs", () => {
    expect(() => buildMergeGateNamespaceManifest({ ...input, runId: "gate" })).toThrow("safe integers");
    expect(() => buildMergeGateNamespaceManifest({ ...input, runId: "9007199254740992" })).toThrow("safe integers");
    expect(() => buildMergeGateNamespaceManifest({ ...input, repository: "not a repo" })).toThrow("repository");
    expect(() => buildMergeGateNamespaceManifest({ ...input, workflowId: "9007199254740992" })).toThrow("safe integer");
    expect(() => buildMergeGateNamespaceManifest({ ...input, workflowPath: "other.yml" })).toThrow("workflowPath");
    expect(() => buildMergeGateNamespaceManifest({ ...input, candidateSha: "short" })).toThrow("40-character");
    expect(() => buildMergeGateNamespaceManifest({ ...input, imageDigest: "latest" })).toThrow("sha256");
    expect(() => buildMergeGateNamespaceManifest({ ...input, cleanupDeadlineHours: "soon" })).toThrow(
      "cleanupDeadlineHours",
    );
  });

  it("allows only the exact observed workflow-run target and is idempotent when absent", () => {
    const namespace = buildMergeGateNamespaceManifest(input);
    expect(verifyMergeGateCleanupTarget(namespace, input)).toMatchObject({
      allowed: true,
      status: "verified",
      identity: { name: "chase-sets-gate-123456-2", imageDigest: input.imageDigest },
    });
    expect(verifyMergeGateCleanupTarget(null, input)).toEqual({
      allowed: false,
      status: "absent",
      identity: null,
      errors: [],
    });
  });

  it.each([
    ["wrong run label", (value) => (value.metadata.labels["chasesets.com/run-id"] = "999")],
    ["wrong repository", (value) => (value.metadata.annotations["chasesets.com/repository"] = "other/repo")],
    ["wrong workflow", (value) => (value.metadata.annotations["chasesets.com/workflow-id"] = "42")],
    ["wrong digest", (value) => (value.metadata.annotations["chasesets.com/image-digest"] = "latest")],
  ])("refuses cleanup for %s", (_name, mutate) => {
    const namespace = structuredClone(buildMergeGateNamespaceManifest(input));
    mutate(namespace);
    expect(verifyMergeGateCleanupTarget(namespace, input)).toMatchObject({ allowed: false, status: "refused" });
  });

  it("refuses malformed or unsafe observer identity before examining a namespace", () => {
    const namespace = buildMergeGateNamespaceManifest(input);
    expect(verifyMergeGateCleanupTarget(namespace, { ...input, runId: "9007199254740992" })).toMatchObject({
      allowed: false,
      status: "refused",
    });
  });
});

describe("per-run instrumentation record", () => {
  const marks = [
    { phase: "candidate-resolved", at: "2026-07-21T12:00:10.000Z" },
    { phase: "image-resolved", at: "2026-07-21T12:01:10.000Z" },
    { phase: "namespace-created", at: "2026-07-21T12:01:40.000Z" },
    { phase: "deployed", at: "2026-07-21T12:11:40.000Z" },
    { phase: "stripe-complete", at: "2026-07-21T12:20:40.000Z" },
    { phase: "webhooks-deleted", at: "2026-07-21T12:21:10.000Z" },
    { phase: "teardown-complete", at: "2026-07-21T12:22:10.000Z" },
  ];

  it("computes phase durations, overhead vs the 2-minute budget, and incremental cost", () => {
    const record = buildMergeGateRunRecord({
      config: validConfig(),
      marks,
      repository: "chase-sets/chase-sets",
      runId: "123456",
      runAttempt: "1",
      namespace: "chase-sets-gate-123456-1",
      release: "csg-123456-1",
      result: "pass",
      jobStartedAt: "2026-07-21T12:00:00.000Z",
      preflightStartedAt: "2026-07-21T11:59:00.000Z",
      preflightCompletedAt: "2026-07-21T11:59:45.000Z",
      pods: {
        items: [
          { spec: { containers: [{ resources: { requests: { cpu: "250m", memory: "512Mi" } } }] } },
          { spec: { containers: [{ resources: { requests: { cpu: "150m", memory: "256Mi" } } }] } },
        ],
      },
      topOutput: "pod-a 120m 300Mi\npod-b 80m 200Mi\n",
      providerCalls: ["doctl=4", "stripe-webhook-lifecycle=2"],
      now: NOW,
    });

    expect(record.schemaVersion).toBe("merge-gate-verification-run/v1");
    expect(record.phases.deployed).toBe(10 * 60 * 1000);
    expect(record.preflightMs).toBe(45_000);
    expect(record.cleanupMs).toBe(30_000 + 60_000);
    expect(record.overheadMs).toBe(45_000 + 90_000);
    expect(record.overheadBudgetMs).toBe(MERGE_GATE_OVERHEAD_BUDGET_MS);
    expect(record.totalMs).toBe(22 * 60 * 1000 + 10 * 1000);
    expect(record.compute).toEqual({ podCount: 2, requestedCpuMillicores: 400, requestedMemoryMib: 768 });
    expect(record.peakUtilization).toEqual({ observedCpuMillicores: 200, observedMemoryMib: 500, sampledPods: 2 });
    expect(record.providerCalls).toEqual({ doctl: 4, "stripe-webhook-lifecycle": 2 });
    // ceil(22m10s of verify + 45s of preflight, in minutes) = 23 billed minutes.
    expect(record.actionsMinutes).toBe(23);
    expect(record.estimatedIncrementalCostUsd).toBeCloseTo(23 * 0.008, 6);
  });

  it("tolerates a cancelled run with partial marks and missing snapshots", () => {
    const record = buildMergeGateRunRecord({
      config: validConfig(),
      marks: marks.slice(0, 3),
      result: "cancelled",
      jobStartedAt: "2026-07-21T12:00:00.000Z",
      now: NOW,
    });
    expect(record.result).toBe("cancelled");
    expect(record.cleanupMs).toBeNull();
    expect(record.overheadMs).toBeNull();
    expect(record.compute).toBeNull();
  });
});

describe("10-run proof aggregation", () => {
  const runRecord = (overrides = {}) => ({
    schemaVersion: "merge-gate-verification-run/v1",
    result: "pass",
    drill: null,
    totalMs: 20 * 60 * 1000,
    overheadMs: 90_000,
    estimatedIncrementalCostUsd: 0.2,
    ...overrides,
  });

  it("passes with ten successful instrumented runs inside the overhead budget", () => {
    const proof = aggregateMergeGateProof(Array.from({ length: 10 }, () => runRecord()));
    expect(proof.status).toBe("pass");
    expect(proof.successfulRunCount).toBe(MERGE_GATE_PROOF_REQUIRED_RUNS);
    expect(proof.overheadMs.p95).toBe(90_000);
    expect(proof.estimatedIncrementalCostUsd.perRunMean).toBeCloseTo(0.2, 6);
  });

  it("fails with fewer than ten successful runs and excludes drills and failures", () => {
    const proof = aggregateMergeGateProof([
      ...Array.from({ length: 9 }, () => runRecord()),
      runRecord({ result: "fail" }),
      runRecord({ drill: "induced-failure" }),
      { schemaVersion: "something-else/v1" },
    ]);
    expect(proof.status).toBe("fail");
    expect(proof.successfulRunCount).toBe(9);
    expect(proof.failures).toEqual([expect.stringContaining("only 9 successful non-drill runs")]);
  });

  it("fails when p95 preflight+cleanup overhead exceeds the 2-minute budget", () => {
    const proof = aggregateMergeGateProof(Array.from({ length: 10 }, () => runRecord({ overheadMs: 150_000 })));
    expect(proof.status).toBe("fail");
    expect(proof.failures).toEqual([expect.stringContaining("exceeds the 120000ms budget")]);
  });
});
