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
    [
      "contradictory",
      { marketplacePods: { items: [pod("bad", { status: { phase: "Running", reason: "Evicted" } })] } },
    ],
  ])("classifies %s evidence as INCONCLUSIVE", (_name, change) => {
    expect(classifyMarketplaceMemoryEvidence(validPackage(change)).verdict).toBe("INCONCLUSIVE");
  });

  it("selects only Failed/Evicted marketplace pods in the required namespace", () => {
    const inventory = {
      items: [
        pod("evicted"),
        pod("running", { status: { phase: "Running", reason: undefined } }),
        pod("other", { metadata: { namespace: "other" } }),
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
  });
});
