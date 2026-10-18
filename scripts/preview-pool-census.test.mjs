import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  PREVIEW_COMPONENTS,
  PREVIEW_POOL_CENSUS_SCHEMA_VERSION,
  allowlistedKubectlArgs,
  computeSizing,
  collectSnapshot,
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
  components: {
    ...Object.fromEntries(
      ["public-web", "marketplace", "admin-web", "platform-api", "platform-worker"].map((name) => [
        name,
        { resources: { requests: { memory: ["platform-api", "platform-worker"].includes(name) ? "512Mi" : "256Mi" } } },
      ]),
    ),
    "platform-bootstrap": { resources: { requests: { memory: "512Mi" } } },
  },
};

describe("preview-pool-census reducers and controls", () => {
  it("keeps only preview namespaces and classifies their pool kind", () => {
    expect(
      filterPreviewNamespaces([
        { metadata: { name: "default" } },
        { metadata: { name: "chase-sets-pr-42", creationTimestamp: "2026-10-18T00:00:00Z" } },
        { metadata: { name: "chase-sets-gate-55-2" } },
        { metadata: { name: "chase-sets-verify-123456-1" } },
      ]),
    ).toEqual([
      { kind: "gate", name: "chase-sets-gate-55-2", creationTimestamp: null },
      { kind: "pr", name: "chase-sets-pr-42", creationTimestamp: "2026-10-18T00:00:00Z" },
      { kind: "verify", name: "chase-sets-verify-123456-1", creationTimestamp: null },
    ]);
  });

  it("deduplicates allowed events by uid while retaining counts and timestamps", () => {
    expect(
      dedupeEvents([
        {
          metadata: { uid: "e1", namespace: "chase-sets-pr-42" },
          reason: "Evicted",
          count: 2,
          firstTimestamp: "2026-10-18T00:00:00Z",
          lastTimestamp: "2026-10-18T00:00:00Z",
        },
        {
          metadata: { uid: "e1", namespace: "chase-sets-pr-42" },
          reason: "Evicted",
          firstTimestamp: "2026-10-18T00:00:00Z",
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

  it("collects real preview shapes, every node, requests, restart reasons and filtered events", async () => {
    const previewNamespace = "chase-sets-verify-123456-1";
    const calls = [];
    const pod = {
      metadata: {
        namespace: previewNamespace,
        name: "api-1",
        labels: { "app.kubernetes.io/name": "chase-sets-platform", "app.kubernetes.io/component": "platform-api" },
        annotations: { marker: "synthetic" },
      },
      spec: {
        nodeName: "preview-node",
        containers: [
          {
            name: "postgres",
            env: [{ name: "TOKEN", value: "sk_test_SYNTHETIC_LEAK_MARKER" }],
            envFrom: [{ secretRef: { name: "synthetic" } }],
            resources: { requests: { memory: "512Mi" }, limits: { memory: "1Gi" } },
          },
        ],
      },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "postgres",
            restartCount: 1,
            state: { running: {} },
            lastState: { terminated: { reason: "OOMKilled" } },
          },
        ],
      },
    };
    const kubectl = async (args) => {
      calls.push(args);
      if (args.includes("nodes"))
        return JSON.stringify({
          items: [
            {
              metadata: {
                name: "preview-node",
                labels: { "chase-sets.com/pool": "preview", "node.kubernetes.io/instance-type": "s-2vcpu-4gb" },
              },
              status: { allocatable: { cpu: "2", memory: "4Gi" }, conditions: [{ type: "Ready", status: "True" }] },
            },
            {
              metadata: { name: "runtime-node", labels: { "chase-sets.com/pool": "runtime" } },
              status: { allocatable: { cpu: "2", memory: "4Gi" }, conditions: [] },
            },
          ],
        });
      if (args.includes("pods")) return JSON.stringify({ items: [pod] });
      if (args.includes("namespaces")) return JSON.stringify({ items: [{ metadata: { name: previewNamespace } }] });
      if (args.includes("events"))
        return JSON.stringify({
          items: [
            {
              metadata: { uid: "e1", namespace: previewNamespace },
              reason: "Evicted",
              count: 3,
              firstTimestamp: "2026-10-18T00:00:00Z",
              lastTimestamp: "2026-10-18T00:05:00Z",
            },
            { metadata: { uid: "e2", namespace: "kube-system" }, reason: "FailedScheduling", count: 9 },
          ],
        });
      if (args.includes("configmap")) return JSON.stringify({ data: { status: "ok" } });
      if (args.includes("--raw"))
        return JSON.stringify({
          pods: [
            {
              podRef: { namespace: previewNamespace, name: "api-1" },
              containers: [{ name: "postgres", memory: { workingSetBytes: 42 } }],
            },
          ],
        });
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const result = await collectSnapshot({ dependencies: { kubectl }, sizing: null });
    expect(result.errors).toEqual([]);
    expect(result.nodeRecords.map((node) => node.name)).toEqual(["preview-node", "runtime-node"]);
    expect([...result.peaks.values()][0]).toMatchObject({
      component: "platform-api",
      memoryRequestMi: 512,
      memoryLimitMi: 1024,
      terminatedReason: "OOMKilled",
    });
    expect(result.events).toEqual([
      expect.objectContaining({
        uid: "e1",
        count: 3,
        firstTimestamp: "2026-10-18T00:00:00Z",
        lastTimestamp: "2026-10-18T00:05:00Z",
      }),
    ]);
    const text = JSON.stringify({
      nodeRecords: result.nodeRecords,
      peaks: [...result.peaks.values()],
      events: result.events,
    });
    expect(text).not.toContain("SYNTHETIC_LEAK_MARKER");
    expect(text).not.toMatch(/"env(?:From)?"/);
    expect(calls.some((args) => args.includes("runtime-node"))).toBe(false);
  });

  it("retains all allowed events across run-level reads", async () => {
    const preview = "chase-sets-pr-900001";
    const verify = "chase-sets-verify-900002-1";
    const event = (uid, namespace, reason, count = 1) => ({
      metadata: { uid, namespace, name: `${uid}.synthetic` },
      reason,
      count,
      firstTimestamp: "2026-10-18T00:00:00Z",
      lastTimestamp: "2026-10-18T00:00:30Z",
    });
    const firstRead = [
      event("syn-evicted-a", preview, "Evicted", 2),
      event("syn-sched-verify", verify, "FailedScheduling"),
      event("syn-scaleup-pr", preview, "TriggeredScaleUp"),
    ];
    const finalRead = [
      event("syn-evicted-b", "kube-system", "Evicted"),
      event("syn-notscale-verify", verify, "NotTriggerScaleUp"),
    ];
    const kubectl = (eventReads) => {
      let eventRead = 0;
      return async (args) => {
        if (args.includes("events"))
          return JSON.stringify({ items: eventReads[Math.min(eventRead++, eventReads.length - 1)] });
        if (args.includes("nodes") || args.includes("pods")) return JSON.stringify({ items: [] });
        if (args.includes("namespaces"))
          return JSON.stringify({ items: [{ metadata: { name: preview } }, { metadata: { name: verify } }] });
        return JSON.stringify({ data: { status: "synthetic" } });
      };
    };
    const pick = (entry) => `${entry.uid}|${entry.namespace}|${entry.name}|${entry.reason}|${entry.count}`;
    const snapshot = await runCensus({ mode: "snapshot", dependencies: { kubectl: kubectl([firstRead]) } });
    expect(snapshot.events.map(pick)).toEqual(
      [
        "syn-scaleup-pr|chase-sets-pr-900001|syn-scaleup-pr.synthetic|TriggeredScaleUp|1",
        "syn-sched-verify|chase-sets-verify-900002-1|syn-sched-verify.synthetic|FailedScheduling|1",
        "syn-evicted-a|chase-sets-pr-900001|syn-evicted-a.synthetic|Evicted|2",
      ].sort(),
    );
    const sample = await runCensus({
      mode: "sample",
      durationMinutes: 0.0005,
      intervalSeconds: 5,
      dependencies: { kubectl: kubectl([firstRead, finalRead]) },
      sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    expect(sample.events.map(pick)).toEqual(
      [
        "syn-evicted-a|chase-sets-pr-900001|syn-evicted-a.synthetic|Evicted|2",
        "syn-evicted-b|kube-system|syn-evicted-b.synthetic|Evicted|1",
        "syn-notscale-verify|chase-sets-verify-900002-1|syn-notscale-verify.synthetic|NotTriggerScaleUp|1",
        "syn-scaleup-pr|chase-sets-pr-900001|syn-scaleup-pr.synthetic|TriggeredScaleUp|1",
        "syn-sched-verify|chase-sets-verify-900002-1|syn-sched-verify.synthetic|FailedScheduling|1",
      ].sort(),
    );
  });

  it("retains sizing from the last complete read when a later read fails", async () => {
    const values = {
      previewPostgres: { resources: { requests: { memory: "512Mi" } } },
      components: Object.fromEntries(
        ["public-web", "marketplace", "admin-web", "platform-api", "platform-worker", "platform-bootstrap"].map(
          (name) => [
            name,
            {
              resources: {
                requests: {
                  memory: ["platform-api", "platform-worker", "platform-bootstrap"].includes(name) ? "512Mi" : "256Mi",
                },
              },
            },
          ],
        ),
      ),
    };
    const node = {
      metadata: { name: "synthetic-preview-node", labels: { "chase-sets.com/pool": "preview" } },
      status: { allocatable: { memory: "6414Mi" } },
    };
    const systemPod = {
      metadata: { namespace: "kube-system", name: "synthetic-coredns" },
      spec: {
        nodeName: "synthetic-preview-node",
        containers: [{ name: "coredns", resources: { requests: { memory: "2048Mi" } } }],
      },
      status: { phase: "Running" },
    };
    const kubectl = (failOn) => {
      let nodeReads = 0;
      return async (args) => {
        if (args.includes("nodes") && !args.includes("--raw")) nodeReads += 1;
        if (args.includes("--raw")) return JSON.stringify({ pods: [] });
        if (args.includes(failOn) && nodeReads > 1) throw new Error(`synthetic ${failOn} failure`);
        if (args.includes("nodes")) return JSON.stringify({ items: [node] });
        if (args.includes("pods")) return JSON.stringify({ items: [systemPod] });
        if (args.includes("namespaces") || args.includes("events")) return JSON.stringify({ items: [] });
        return JSON.stringify({ data: { status: "synthetic" } });
      };
    };
    for (const failingRead of ["pods", "nodes"]) {
      const record = await runCensus({
        mode: "sample",
        durationMinutes: 0.0005,
        intervalSeconds: 5,
        values,
        maxNodes: 3,
        dependencies: { kubectl: kubectl(failingRead) },
        sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      expect(record.result).toBe("partial");
      expect(record.sizing).toEqual({ namespaceRequestMi: 2816, perNode: [1], N: { live: 1, maxNodes: 3 } });
    }
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
            if (args.includes("nodes"))
              return JSON.stringify({
                items: [
                  {
                    metadata: { name: "n1", labels: { "chase-sets.com/pool": "preview" } },
                    status: { allocatable: {} },
                  },
                ],
              });
            if (args.includes("pods"))
              return JSON.stringify({
                items: [
                  {
                    metadata: {
                      namespace: "chase-sets-pr-1",
                      name: "p1",
                      labels: { "app.kubernetes.io/component": "platform-api" },
                    },
                    spec: {
                      nodeName: "n1",
                      containers: [
                        {
                          name: "api",
                          env: [{ name: "TOKEN", value: "sk_test_SYNTHETIC_LEAK_MARKER" }],
                          envFrom: [{ secretRef: { name: "s" } }],
                          resources: {},
                        },
                      ],
                    },
                    status: { phase: "Running" },
                  },
                ],
              });
            if (args.includes("namespaces"))
              return JSON.stringify({ items: [{ metadata: { name: "chase-sets-pr-1" } }] });
            if (args.includes("events")) return JSON.stringify({ items: [] });
            if (args.includes("--raw")) return JSON.stringify({ pods: [] });
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
