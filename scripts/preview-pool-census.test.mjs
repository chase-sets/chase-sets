import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  PREVIEW_COMPONENTS,
  PREVIEW_POOL_CENSUS_SCHEMA_VERSION,
  allowlistedKubectlArgs,
  computeSizing,
  dedupeEvents,
  filterPreviewNamespaces,
  reduceContainerPeaks,
  runCensus,
} from "./preview-pool-census.mjs";

const workflowPath = ".github/workflows/platform-preview-pool-census.yml";
const workflowText = readFileSync(resolve(workflowPath), "utf8");
const runbookText = readFileSync(resolve("docs/runbooks/doks-platform-operations.md"), "utf8");

const fixtureValues = {
  previewPostgres: { resources: { requests: { memory: "512Mi" } } },
  platformBootstrap: { resources: { requests: { memory: "512Mi" } } },
  components: Object.fromEntries(
    ["public-web", "marketplace", "admin-web", "platform-api", "platform-worker"].map((name) => [
      name,
      { resources: { requests: { memory: ["platform-api", "platform-worker"].includes(name) ? "512Mi" : "256Mi" } } },
    ]),
  ),
};

describe("preview-pool-census reducers and controls", () => {
  it("keeps only preview namespaces and classifies their pool kind", () => {
    expect(
      filterPreviewNamespaces([
        { metadata: { name: "default" } },
        { metadata: { name: "chase-sets-pr-42", creationTimestamp: "2026-10-18T00:00:00Z" } },
        { metadata: { name: "chase-sets-gate-7" } },
        { metadata: { name: "chase-sets-verify-9" } },
      ]),
    ).toEqual([
      { kind: "gate", name: "chase-sets-gate-7", creationTimestamp: null },
      { kind: "pr", name: "chase-sets-pr-42", creationTimestamp: "2026-10-18T00:00:00Z" },
      { kind: "verify", name: "chase-sets-verify-9", creationTimestamp: null },
    ]);
  });

  it("deduplicates allowed events by uid while retaining counts and timestamps", () => {
    expect(
      dedupeEvents([
        {
          metadata: { uid: "e1", namespace: "chase-sets-pr-42" },
          reason: "Evicted",
          lastTimestamp: "2026-10-18T00:00:00Z",
        },
        {
          metadata: { uid: "e1", namespace: "chase-sets-pr-42" },
          reason: "Evicted",
          lastTimestamp: "2026-10-18T00:01:00Z",
        },
        { metadata: { uid: "e2" }, reason: "Normal" },
      ]),
    ).toEqual([
      expect.objectContaining({
        uid: "e1",
        reason: "Evicted",
        count: 2,
        firstTimestamp: "2026-10-18T00:00:00Z",
        lastTimestamp: "2026-10-18T00:01:00Z",
      }),
    ]);
  });

  it("reduces the maximum working set across samples per container", () => {
    const peaks = reduceContainerPeaks(new Map(), [
      {
        key: "ns/pod/api",
        component: "platform-api",
        maxWorkingSetBytes: 4,
        sampleCount: 0,
        seenAt: "2026-10-18T00:00:00Z",
      },
      { key: "ns/pod/api", component: "platform-api", maxWorkingSetBytes: 9, seenAt: "2026-10-18T00:00:10Z" },
    ]);
    expect(peaks.get("ns/pod/api")).toMatchObject({ maxWorkingSetBytes: 9, sampleCount: 2, component: "platform-api" });
  });

  it("computes the seven-workload namespace request and live/max-node N", () => {
    expect(
      computeSizing(
        fixtureValues,
        [{ pool: "preview", allocatable: { memoryMi: 6414 }, nonPreviewRequests: { memoryMi: 412 } }],
        3,
      ),
    ).toEqual({
      namespaceRequestMi: 2816,
      perNode: [2],
      N: { live: 2, maxNodes: 6 },
    });
  });

  it("fails closed on mutating kubectl verbs and permits only get/raw stats", () => {
    expect(allowlistedKubectlArgs(["get", "pods", "-o", "json"])).toBe(true);
    expect(allowlistedKubectlArgs(["get", "--raw", "/api/v1/nodes/n1/proxy/stats/summary"])).toBe(true);
    expect(allowlistedKubectlArgs(["delete", "pod", "x"])).toBe(false);
    expect(allowlistedKubectlArgs(["get", "pods", "-o", "json", "--as", "admin"])).toBe(true);
  });

  it("records a failed read as partial instead of silently passing", async () => {
    const record = await runCensus({
      mode: "snapshot",
      dependencies: {
        kubectl: async () => {
          throw new Error("read failed");
        },
      },
      sleep: async () => {},
    });
    expect(record).toMatchObject({ schemaVersion: PREVIEW_POOL_CENSUS_SCHEMA_VERSION, result: "partial" });
    expect(record.errors.join(" ")).toContain("read failed");
  });

  it("keeps the field allowlist free of env, secrets and logs", async () => {
    const text = JSON.stringify(
      await runCensus({
        mode: "snapshot",
        dependencies: {
          kubectl: async (args) => {
            if (args.includes("nodes")) return JSON.stringify({ items: [] });
            if (args.includes("pods")) return JSON.stringify({ items: [] });
            if (args.includes("namespaces")) return JSON.stringify({ items: [] });
            if (args.includes("events")) return JSON.stringify({ items: [] });
            return JSON.stringify({ data: { status: "ok" } });
          },
        },
      }),
    );
    expect(text).not.toMatch(/\b(env|secret|logs)\b/i);
  });
});

describe("preview-pool-census workflow and runbook", () => {
  it("is a preview-environment dispatch with bounded inputs and pinned actions", () => {
    const workflow = parseYaml(workflowText);
    expect(workflow.jobs.census.environment).toBe("preview");
    expect(workflow.on.workflow_dispatch.inputs.mode.options).toEqual(["snapshot", "sample"]);
    expect(workflow.on.workflow_dispatch.inputs.duration_minutes.default).toBe(45);
    expect(workflow.on.workflow_dispatch.inputs.interval_seconds.default).toBe(10);
    expect(workflowText).toContain("kubectl get");
    expect(workflowText).toContain("actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10");
    expect(workflowText).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(workflowText).not.toMatch(/uses:\s+[^@]+@v\d/);
  });

  it("documents both modes, schema fields, and the read-only guarantee", () => {
    expect(runbookText).toContain("preview-pool-census");
    expect(runbookText).toContain("snapshot");
    expect(runbookText).toContain("sample");
    expect(runbookText).toContain("read-only");
    for (const component of PREVIEW_COMPONENTS) expect(runbookText).toContain(component);
  });
});
