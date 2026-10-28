import { describe, expect, it } from "vitest";
import {
  buildMarketplaceEvictionCleanupCommand,
  classifyMarketplaceMemoryEvidence,
  selectEvictedMarketplacePods,
} from "./staging-marketplace-memory.mjs";

const pod = (name, overrides = {}) => ({
  metadata: {
    name,
    namespace: "chase-sets-platform",
    creationTimestamp: "2026-10-27T16:00:00Z",
    labels: { "app.kubernetes.io/name": "chase-sets-platform", "app.kubernetes.io/component": "marketplace" },
    ownerReferences: [{ kind: "ReplicaSet", name: "marketplace-rs" }],
    ...overrides.metadata,
  },
  spec: {
    containers: [
      {
        name: "marketplace",
        image: "registry.example/marketplace@sha256:" + "a".repeat(64),
        resources: { requests: { memory: "1280Mi" }, limits: { memory: "1536Mi" } },
      },
    ],
  },
  status: {
    phase: "Failed",
    reason: "Evicted",
    startTime: "2026-10-27T16:00:00Z",
    conditions: [],
    ...overrides.status,
  },
});

const readyPod = (name) =>
  pod(name, {
    status: {
      phase: "Running",
      reason: undefined,
      conditions: [{ type: "Ready", status: "True" }],
    },
  });

const validPackage = (overrides = {}) => ({
  marketplaceDeployment: {
    spec: { replicas: 1 },
    status: { readyReplicas: 1, conditions: [{ type: "Progressing", lastUpdateTime: "2026-10-27T16:00:00Z" }] },
  },
  marketplacePods: { items: [pod("marketplace-evicted"), readyPod("marketplace-ready")] },
  nodeMetrics: { items: [{ metadata: { name: "runtime-xl-3wv41z" }, usage: { memory: "2Gi" } }] },
  nodeEvents: [{ reason: "MemoryPressure" }],
  nodeDescribe: { metadata: { name: "runtime-xl-3wv41z" }, status: { conditions: [] } },
  eventWindow: { start: "2026-10-27T15:45:00Z", end: "2026-10-27T16:15:00Z" },
  ...overrides,
});

describe("staging marketplace memory evidence", () => {
  it("classifies a complete recurrence package and identifies deploy overlap", () => {
    expect(classifyMarketplaceMemoryEvidence(validPackage())).toMatchObject({
      verdict: "PASS",
      recurrence: "deploy-time-overlap",
      metrics: "available",
    });
  });

  it("marks unavailable metrics unknown instead of healthy", () => {
    expect(classifyMarketplaceMemoryEvidence(validPackage({ nodeMetrics: null }))).toMatchObject({
      verdict: "UNKNOWN",
      metrics: "unknown",
    });
  });

  it.each([
    ["truncated", { truncated: true }],
    ["node metrics continuation", { nodeMetrics: { metadata: { continue: "next" }, items: [{ name: "node" }] } }],
    ["missing node describe", { nodeDescribe: undefined }],
    ["empty node events", { nodeEvents: [] }],
    ["missing event window", { eventWindow: undefined }],
    [
      "missing Progressing time",
      { marketplaceDeployment: { spec: { replicas: 1 }, status: { readyReplicas: 1, conditions: [] } } },
    ],
    [
      "contradictory",
      { marketplacePods: { items: [pod("bad", { status: { phase: "Running", reason: "Evicted" } })] } },
    ],
  ])("classifies %s evidence as INCONCLUSIVE", (_name, change) => {
    expect(classifyMarketplaceMemoryEvidence(validPackage(change)).verdict).toBe("INCONCLUSIVE");
  });

  it("reports pod list continuation as truncated before pod-state checks", () => {
    const result = classifyMarketplaceMemoryEvidence(
      validPackage({
        marketplacePods: { metadata: { continue: "next" }, items: [readyPod("marketplace-ready")] },
      }),
    );
    expect(result).toEqual({
      verdict: "INCONCLUSIVE",
      recurrence: "unknown",
      metrics: "unknown",
      reasons: ["capture is truncated"],
    });
  });

  it("reports pod list remaining count as truncated before pod-state checks", () => {
    const result = classifyMarketplaceMemoryEvidence(
      validPackage({
        marketplacePods: { metadata: { remainingItemCount: 1 }, items: [readyPod("marketplace-ready")] },
      }),
    );
    expect(result).toEqual({
      verdict: "INCONCLUSIVE",
      recurrence: "unknown",
      metrics: "unknown",
      reasons: ["capture is truncated"],
    });
  });

  it("returns every pod evidence issue instead of only the first", () => {
    const result = classifyMarketplaceMemoryEvidence(
      validPackage({
        marketplacePods: {
          items: [
            pod("incomplete", {
              metadata: { namespace: undefined, ownerReferences: [] },
              spec: { containers: [] },
            }),
            readyPod("marketplace-ready"),
          ],
        },
      }),
    );
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["missing namespace", "missing ownerReferences", "namespace mismatch"]),
    );
  });

  it("rejects a Failed pod that claims Ready", () => {
    const result = classifyMarketplaceMemoryEvidence(
      validPackage({
        marketplacePods: {
          items: [
            pod("failed-ready", {
              status: {
                conditions: [{ type: "Ready", status: "True" }],
              },
            }),
            readyPod("marketplace-ready"),
          ],
        },
      }),
    );
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.reasons).toEqual(["deployment or pod evidence is contradictory"]);
  });

  it("selects only Failed/Evicted marketplace pods in the required namespace", () => {
    const inventory = {
      items: [
        pod("evicted"),
        pod("failed-error", { status: { phase: "Failed", reason: "Error" } }),
        pod("pending-evicted", { status: { phase: "Pending", reason: "Evicted" } }),
        pod("succeeded", { status: { phase: "Succeeded", reason: undefined } }),
        pod("running", { status: { phase: "Running", reason: undefined } }),
        pod("other-component", {
          metadata: {
            labels: { "app.kubernetes.io/name": "chase-sets-platform", "app.kubernetes.io/component": "platform-api" },
          },
        }),
        pod("other", { metadata: { namespace: "other" } }),
        pod("wrong-app", {
          metadata: { labels: { "app.kubernetes.io/name": "other", "app.kubernetes.io/component": "marketplace" } },
        }),
      ],
    };
    expect(selectEvictedMarketplacePods(inventory)).toEqual(["evicted"]);
  });

  it("pins cleanup command selectors and refuses a count mismatch", () => {
    const command = buildMarketplaceEvictionCleanupCommand({ context: "staging", expectedCount: 96 });
    expect(command).toContain("-n $ns get pods -l $label --field-selector=status.phase=Failed");
    expect(command).toContain("$_.status.reason -eq 'Evicted'");
    expect(command).toContain("$names.Count -ne 96");
    expect(command).toContain("-n $ns delete pod $_ --wait=false");
    expect(command).not.toContain("delete pods --all");
    expect(() => buildMarketplaceEvictionCleanupCommand({ context: "staging" })).toThrow("expectedCount");
    expect(() => buildMarketplaceEvictionCleanupCommand({ expectedCount: 96 })).toThrow("context");
    expect(() => buildMarketplaceEvictionCleanupCommand({ context: "staging", expectedCount: -1 })).toThrow(
      "non-negative integer",
    );
  });
});
