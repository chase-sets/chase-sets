import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitCommand,
  BOUNDS,
  CaptureRefusal,
  collect,
  commandFailure,
  commandReader,
  limitBytes,
  NAMESPACE,
  OUTPUT,
  readHistory,
  runCapture,
  validateArtifact,
} from "./production-memory-probe.mjs";

const END = "2026-10-23T09:00:00.000Z";
const TIME = "2026-10-23T08:59:30Z";
const START = "2026-10-23T08:00:00Z";
const CLUSTER = "00000000-0000-4000-8000-000000000001";
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const image = (n) => `sha256:${String(n).repeat(64)}`;
const SENTINEL = "SYNTHETIC-CREDENTIAL-SESSION-NEVER-RETAIN";
// Entirely synthetic explicit configuration: never spread process.env or invoke a provider CLI.
const environment = () => ({
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "104300001",
  GITHUB_RUN_ATTEMPT: "1",
  CAPTURE_CLUSTER_ID: CLUSTER,
  KUBECONFIG: "/synthetic/not-a-live-kubeconfig",
  PROMETHEUS_QUERY_TOKEN: SENTINEL,
});
const clone = (v) => structuredClone(v);
function pod(component, n) {
  return {
    metadata: {
      name: `synthetic-${component}-${n}`,
      uid: uid(n),
      namespace: NAMESPACE,
      labels: { "app.kubernetes.io/instance": NAMESPACE, "app.kubernetes.io/component": component },
      annotations: { private: SENTINEL },
    },
    spec: {
      nodeName: "synthetic-node",
      containers: [
        {
          name: "web",
          image: `private/${SENTINEL}`,
          env: [{ name: "PRIVATE", value: SENTINEL }],
          resources: { limits: { memory: "100Mi" } },
        },
      ],
    },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "web",
          imageID: `docker-pullable://synthetic/image@${image((n % 2) + 1)}`,
          restartCount: 0,
          state: { running: { startedAt: START } },
          lastState: {},
        },
      ],
    },
  };
}
const page = (items, metadata = {}) => ({ metadata: { resourceVersion: "synthetic-version", ...metadata }, items });
function fixture() {
  const pods = [pod("marketplace", 1), pod("marketplace", 2), pod("public-web", 3)];
  const summary = {
    node: { nodeName: "synthetic-node" },
    pods: pods.map((p, n) => ({
      podRef: { uid: p.metadata.uid, name: p.metadata.name, namespace: NAMESPACE },
      containers: [
        {
          name: "web",
          memory: { time: TIME, workingSetBytes: (n === 0 ? 95 : 20) * 1024 ** 2 },
          rootfs: { secret: SENTINEL },
        },
      ],
    })),
  };
  const histories = {
    status: "success",
    data: {
      resultType: "matrix",
      result: pods.map((p) => ({
        metric: {
          deployment_environment: "production",
          k8s_cluster_id: CLUSTER,
          k8s_namespace_name: NAMESPACE,
          k8s_pod_uid: p.metadata.uid,
          k8s_pod_name: p.metadata.name,
          k8s_container_name: "web",
          container_image_id: p.status.containerStatuses[0].imageID,
          private: SENTINEL,
        },
        values: [[Date.parse(TIME) / 1000, "10485760"]],
      })),
    },
  };
  let podReads = 0;
  const data = { pods, after: null, summary, histories, events: [], paths: [] };
  const read = vi.fn(async (path) => {
    admitCommand("kubectl", ["get", "--raw", path, "--request-timeout=15s"]);
    data.paths.push(path);
    if (path.includes("/pods?")) return page(clone(podReads++ ? (data.after ?? data.pods) : data.pods));
    if (path.includes("/events?")) return page(clone(data.events));
    return clone(data.summary);
  });
  return {
    data,
    read,
    env: environment(),
    now: () => new Date(END),
    history: vi.fn(async () => clone(data.histories)),
  };
}
async function output(f) {
  let text;
  const code = await runCapture({
    ...f,
    write: async (path, value) => {
      expect(path).toBe(OUTPUT);
      text = value;
    },
    makeDirectory: async () => {},
  });
  return { code, text, artifact: JSON.parse(text) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("actual collector to retained projection", () => {
  it("captures both components, replicas and mixed digests without raw metadata; near is triage only", async () => {
    const f = fixture();
    const { artifact: a, code, text } = await output(f);
    expect(code).toBe(0);
    expect(validateArtifact(a)).toBe(true);
    expect(a.containers).toHaveLength(3);
    expect(new Set(a.containers.map((r) => r.imageDigest)).size).toBe(2);
    expect(a.containers[0]).toMatchObject({
      startedAt: START,
      percent: 95,
      classification: "near",
      riskFlags: ["near-limit"],
      history: { status: "available", value: { maximumBytes: 10485760, count: 1 } },
    });
    expect(a.provenance).toEqual({
      toolingSha: "a".repeat(40),
      runId: "104300001",
      runAttempt: "1",
      job: "capture",
      step: "collect",
    });
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toMatch(/annotations|rootfs|docker-pullable|kubeconfig|private/);
    expect(f.data.paths.filter((p) => p.includes("stats/summary"))).toHaveLength(1);
  });

  it.each([
    "PROMETHEUS_QUERY_TOKEN",
    "CAPTURE_CLUSTER_ID",
    "KUBECONFIG",
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
  ])("withheld %s fails before any request", async (key) => {
    const f = fixture();
    delete f.env[key];
    const { artifact, code } = await output(f);
    expect(code).toBe(1);
    expect(artifact.completeness).toBe("incomplete");
    expect(f.read).not.toHaveBeenCalled();
    expect(f.history).not.toHaveBeenCalled();
  });

  it.each([null, NaN, -1, Infinity, "0"])("invalid current usage %s is unknown, never zero/safe", async (usage) => {
    const f = fixture();
    f.data.summary.pods[1].containers[0].memory.workingSetBytes = usage;
    const { artifact, code } = await output(f);
    expect(code).toBe(1);
    expect(artifact.containers[1]).toMatchObject({
      current: { status: "unknown", reason: "usage-unavailable" },
      percent: null,
      classification: "unknown",
    });
    expect(artifact.containers[0].riskFlags).toContain("near-limit");
  });

  it("zero usage is a measured below-threshold fact, not a healthy classification", async () => {
    const f = fixture();
    f.data.summary.pods[1].containers[0].memory.workingSetBytes = 0;
    const { artifact, code } = await output(f);
    expect(code).toBe(0);
    expect(artifact.containers[1]).toMatchObject({ percent: 0, classification: "below-near-threshold" });
  });

  it.each(["0", undefined, "NaN", "-1", "999999999999999999999Gi"])(
    "invalid/missing limit %s makes capture incomplete",
    async (limit) => {
      const f = fixture();
      f.data.pods[1].spec.containers[0].resources.limits.memory = limit;
      const { artifact, code } = await output(f);
      expect(code).toBe(1);
      expect(artifact.reasons).toContain("limit-unavailable");
      expect(artifact.containers[1].classification).toBe("unknown");
    },
  );

  it.each([
    [
      "restart-drift",
      (p) => {
        p.status.containerStatuses[0].restartCount++;
      },
    ],
    [
      "limit-drift",
      (p) => {
        p.spec.containers[0].resources.limits.memory = "200Mi";
      },
    ],
    [
      "identity-drift",
      (p) => {
        p.status.containerStatuses[0].imageID = image(9);
      },
    ],
    [
      "identity-drift",
      (p) => {
        p.metadata.uid = uid(100);
      },
    ],
    [
      "identity-drift",
      (p) => {
        p.status.containerStatuses[0].state.running.startedAt = TIME;
      },
    ],
  ])("%s across the two snapshots is incomplete and keeps other replica risk", async (reason, mutate) => {
    const f = fixture();
    f.data.after = clone(f.data.pods);
    mutate(f.data.after[1]);
    const { artifact, code } = await output(f);
    expect(code).toBe(1);
    expect(artifact.reasons).toContain(reason);
    expect(artifact.containers[0].riskFlags).toContain("near-limit");
  });

  it.each(["2026-10-23T08:57:59Z", "2026-10-23T09:00:01Z", "not-time"])(
    "stale/future/invalid sample %s is incomplete",
    async (time) => {
      const f = fixture();
      f.data.summary.pods[1].containers[0].memory.time = time;
      expect((await output(f)).code).toBe(1);
    },
  );

  it("missing sample, wrong pod UID or wrong node cannot join", async () => {
    for (const mutate of [
      (f) => {
        f.data.summary.pods.pop();
      },
      (f) => {
        f.data.summary.pods[1].podRef.uid = uid(100);
      },
      (f) => {
        f.data.summary.node.nodeName = "synthetic-other-node";
      },
    ]) {
      const f = fixture();
      mutate(f);
      expect((await output(f)).code).toBe(1);
    }
  });

  it("samples must still be fresh after the final pod snapshot, not only before history collection", async () => {
    const f = fixture();
    let delayed = false;
    f.now = () => new Date(Date.parse(END) + (delayed ? 120_000 : 0));
    f.history = async () => {
      delayed = true;
      return f.data.histories;
    };
    const { artifact, code } = await output(f);
    expect(code).toBe(1);
    expect(artifact.reasons).toContain("stale");
  });

  it.each(["imageID", "restartCount", "state"])("missing status identity %s cannot be complete", async (field) => {
    const f = fixture();
    delete f.data.pods[1].status.containerStatuses[0][field];
    expect((await output(f)).code).toBe(1);
  });

  it("inventories running native sidecars but ignores completed init containers", async () => {
    const f = fixture();
    f.data.pods[0].spec.initContainers = [
      { name: "sidecar", resources: { limits: { memory: "1Mi" } } },
      { name: "init" },
    ];
    f.data.pods[0].status.initContainerStatuses = [
      { name: "sidecar", imageID: image(1), restartCount: 0, state: { running: { startedAt: START } } },
      { name: "init", state: { terminated: {} } },
    ];
    f.data.summary.pods[0].containers.push({ name: "sidecar", memory: { time: TIME, workingSetBytes: 100 } });
    const { artifact, code } = await output(f);
    expect(code).toBe(0);
    expect(artifact.containers).toHaveLength(4);
  });

  it("projects only bounded OOM/eviction reason, timestamp and count for exact selected UIDs", async () => {
    const f = fixture();
    f.data.pods[0].status.containerStatuses[0].lastState = {
      terminated: { reason: "OOMKilled", finishedAt: START, exitCode: 137, message: SENTINEL },
    };
    f.data.events = [
      {
        involvedObject: { kind: "Pod", name: f.data.pods[0].metadata.name, namespace: NAMESPACE, uid: uid(1) },
        reason: "Evicted",
        lastTimestamp: TIME,
        count: 2,
        message: SENTINEL,
      },
      { involvedObject: { uid: uid(999) }, reason: "OOMKilled", message: SENTINEL },
    ];
    const { artifact, code, text } = await output(f);
    expect(code).toBe(0);
    expect(artifact.containers[0].riskFlags).toEqual(["near-limit", "oom-observed", "eviction-observed"]);
    expect(artifact.containers[0].events.value).toEqual([{ reason: "Evicted", time: TIME, count: 2 }]);
    expect(text).not.toContain(SENTINEL);
  });

  it.each(["unauthorized", "forbidden", "redirect", "timeout", "malformed", "output-limit"])(
    "history %s alone remains complete with explicit unknown",
    async (reason) => {
      const f = fixture();
      f.history = async () => {
        throw new CaptureRefusal(reason);
      };
      const { artifact, code } = await output(f);
      expect(code).toBe(0);
      expect(artifact.containers[0].history).toEqual({ status: "unknown", reason });
    },
  );

  it.each([
    "k8s_cluster_id",
    "k8s_pod_uid",
    "k8s_pod_name",
    "k8s_container_name",
    "container_image_id",
    "deployment_environment",
  ])("history without matching %s is unavailable, not query failure", async (label) => {
    const f = fixture();
    delete f.data.histories.data.result[0].metric[label];
    const { artifact, code } = await output(f);
    expect(code).toBe(0);
    expect(artifact.containers[0].history.reason).toBe("no-identity-matching-series");
  });

  it.each([null, "NaN", "-1", "Infinity", 1])("invalid history value %s remains unknown", async (value) => {
    const f = fixture();
    f.data.histories.data.result[0].values[0][1] = value;
    expect((await output(f)).artifact.containers[0].history.reason).toBe("malformed");
  });

  it("history before this container's start cannot describe its current instance", async () => {
    const f = fixture();
    f.data.pods[0].status.containerStatuses[0].state.running.startedAt = TIME;
    f.data.histories.data.result[0].values[0][0] = Date.parse(TIME) / 1000 - 30;
    expect((await output(f)).artifact.containers[0].history.reason).toBe("malformed");
  });

  it("after-only pods require their own image identity for history", async () => {
    const f = fixture();
    const extra = pod("public-web", 4);
    f.data.after = [...clone(f.data.pods), extra];
    f.data.histories.data.result.push({
      metric: {
        deployment_environment: "production",
        k8s_cluster_id: CLUSTER,
        k8s_namespace_name: NAMESPACE,
        k8s_pod_uid: extra.metadata.uid,
        k8s_pod_name: extra.metadata.name,
        k8s_container_name: "web",
      },
      values: [[Date.parse(TIME) / 1000, "10485760"]],
    });
    const { artifact } = await output(f);
    expect(artifact.containers.find((r) => r.podUid === extra.metadata.uid).history).toEqual({
      status: "unknown",
      reason: "no-identity-matching-series",
    });

    const exact = fixture();
    const exactExtra = pod("public-web", 4);
    exact.data.after = [...clone(exact.data.pods), exactExtra];
    exact.data.histories.data.result.push({
      metric: {
        deployment_environment: "production",
        k8s_cluster_id: CLUSTER,
        k8s_namespace_name: NAMESPACE,
        k8s_pod_uid: exactExtra.metadata.uid,
        k8s_pod_name: exactExtra.metadata.name,
        k8s_container_name: "web",
        container_image_id: exactExtra.status.containerStatuses[0].imageID,
      },
      values: [[Date.parse(TIME) / 1000, "10485760"]],
    });
    expect(
      (await output(exact)).artifact.containers.find((r) => r.podUid === exactExtra.metadata.uid).history.status,
    ).toBe("available");
  });

  it("Kubernetes errors retain partial observations and a closed failure reason", async () => {
    for (const reason of ["unauthorized", "forbidden", "timeout", "output-limit", "malformed"]) {
      const f = fixture();
      const read = f.read;
      f.read = async (path) => {
        if (path.includes("/events?")) throw new CaptureRefusal(reason);
        return read(path);
      };
      const { artifact, code } = await output(f);
      expect(code).toBe(1);
      expect(artifact.reasons).toContain(reason);
      expect(artifact.containers[0].riskFlags).toContain("near-limit");
    }
  });

  it.each(["both", "before-only", "after-only"])(
    "retains a failed evicted pod from %s snapshots as context",
    async (snapshot) => {
      const f = fixture();
      const evicted = pod("marketplace", 4);
      evicted.status.phase = "Failed";
      evicted.status.reason = "Evicted";
      f.data.after = clone(f.data.pods);
      if (snapshot !== "after-only") f.data.pods.push(evicted);
      if (snapshot !== "before-only") f.data.after.push(clone(evicted));
      f.data.events = [
        {
          involvedObject: { kind: "Pod", name: evicted.metadata.name, namespace: NAMESPACE, uid: evicted.metadata.uid },
          reason: "Evicted",
          lastTimestamp: TIME,
          count: 1,
          message: SENTINEL,
        },
      ];
      const { artifact, code, text } = await output(f);
      expect(code).toBe(0);
      expect(validateArtifact(artifact)).toBe(true);
      expect(artifact.nonRunningPods).toEqual([
        {
          component: "marketplace",
          pod: evicted.metadata.name,
          podUid: evicted.metadata.uid,
          phase: "Failed",
          events: { status: "available", value: [{ reason: "Evicted", time: TIME, count: 1 }] },
        },
      ]);
      expect(artifact.riskFlags).toEqual(["eviction-observed"]);
      expect(text).not.toContain(SENTINEL);
    },
  );

  it.each(["Pending", "Succeeded", "Unknown", SENTINEL, undefined])(
    "closes non-running phase %s without changing completeness",
    async (phase) => {
      const f = fixture();
      const stopped = pod("marketplace", 4);
      stopped.status.phase = phase;
      f.data.pods.push(stopped);
      const { artifact, code, text } = await output(f);
      expect(code).toBe(0);
      if (["Pending", "Succeeded", "Unknown"].includes(phase))
        expect(artifact.nonRunningPods[0]).toMatchObject({
          phase,
          events: { status: "unknown", reason: "no-observed-events" },
        });
      else expect(artifact.nonRunningPods).toEqual([]);
      expect(artifact.riskFlags).toEqual([]);
      expect(text).not.toContain(SENTINEL);
    },
  );

  it("retains only exact-identity non-running OOM events and reports their artifact risk", async () => {
    const f = fixture();
    const stopped = pod("marketplace", 4);
    stopped.status.phase = "Failed";
    f.data.pods.push(stopped);
    const involvedObject = { uid: stopped.metadata.uid, name: stopped.metadata.name, namespace: NAMESPACE };
    f.data.events = [
      { involvedObject, reason: "OOMKilling", eventTime: TIME, series: { count: 2 }, message: SENTINEL },
      { involvedObject: { ...involvedObject, uid: uid(999) }, reason: "Evicted", lastTimestamp: TIME },
      { involvedObject: { ...involvedObject, name: "other" }, reason: "Evicted", lastTimestamp: TIME },
      { involvedObject: { ...involvedObject, namespace: "other" }, reason: "Evicted", lastTimestamp: TIME },
    ];
    const { artifact, code } = await output(f);
    expect(code).toBe(0);
    expect(artifact.nonRunningPods[0].events.value).toEqual([{ reason: "OOMKilling", time: TIME, count: 2 }]);
    expect(artifact.riskFlags).toEqual(["oom-observed"]);
  });
});

describe("bounds and page completeness", () => {
  it("compares full imageID, not just its digest, across capture and history", async () => {
    const drift = fixture();
    drift.data.after = clone(drift.data.pods);
    drift.data.after[1].status.containerStatuses[0].imageID = `synthetic/alias@${image(1)}`;
    expect((await output(drift)).artifact.containers[1].current.reason).toBe("identity-drift");
    const historical = fixture();
    historical.data.histories.data.result[1].metric.container_image_id = `synthetic/alias@${image(1)}`;
    expect((await output(historical)).artifact.containers[1].history.reason).toBe("no-identity-matching-series");
  });
  it("malformed nested identity types produce an incomplete artifact, not an exception", async () => {
    const f = fixture();
    f.data.pods[1].metadata.name = { toString: SENTINEL };
    const { artifact, code, text } = await output(f);
    expect(code).toBe(1);
    expect(artifact.reasons).toContain("identity-unavailable");
    expect(text).not.toContain(SENTINEL);
  });
  it("nested malformed history is explicitly unknown without losing current observations", async () => {
    const f = fixture();
    f.data.histories.data.result.push(null);
    const { artifact, code } = await output(f);
    expect(code).toBe(0);
    expect(artifact.containers[0].history.reason).toBe("malformed");
    expect(artifact.containers[0].riskFlags).toContain("near-limit");
  });
  it.each([
    ["1Ki", 1024],
    ["1.5Mi", 1572864],
    ["1G", 1e9],
    ["1000m", 1],
    ["1e6", 1e6],
    ["0.1", 1],
  ])("converts Kubernetes quantity %s", (quantity, bytes) => {
    expect(limitBytes(quantity)).toBe(bytes);
  });

  it.each(["empty", "truncated", "count-mismatch", "endless", "cap+1"])("%s inventory cannot pass", async (mode) => {
    const f = fixture();
    const read = f.read;
    f.read = async (path) => {
      if (!path.includes("/pods?")) return read(path);
      if (mode === "empty") return page([], { continue: "next", remainingItemCount: 2 });
      if (mode === "truncated") return page(f.data.pods, { remainingItemCount: 1 });
      if (mode === "count-mismatch")
        return path.includes("continue=")
          ? page([pod("marketplace", 10)])
          : page(f.data.pods, { continue: "next", remainingItemCount: 2 });
      if (mode === "endless")
        return page([pod("marketplace", Number(path.match(/next(\d)/)?.[1] ?? 0) + 10)], {
          continue: `next${f.data.paths.length}`,
        });
      return page(Array.from({ length: 33 }, (_, n) => pod(n % 2 ? "marketplace" : "public-web", n + 1)));
    };
    const result = await output(f);
    expect(result.code).toBe(1);
    expect(result.artifact.completeness).toBe("incomplete");
  });

  it("reads every page and refuses an omitted tail; no duplicate UID can hide a replica", async () => {
    const f = fixture();
    const read = f.read;
    f.read = async (path) =>
      path.includes("/pods?")
        ? path.includes("continue=")
          ? page(f.data.pods.slice(1))
          : page(f.data.pods.slice(0, 1), { continue: "synthetic-token", remainingItemCount: 2 })
        : read(path);
    expect((await output(f)).code).toBe(0);
    const duplicate = fixture();
    duplicate.data.pods.push(clone(duplicate.data.pods[0]));
    expect((await output(duplicate)).code).toBe(1);
  });

  it("32 production-shaped pods plus a large unrelated node inventory fit the byte cap without retention", async () => {
    const f = fixture();
    f.data.pods = Array.from({ length: 32 }, (_, n) => pod(n % 2 ? "marketplace" : "public-web", n + 1));
    f.data.summary.pods = f.data.pods.map((p) => ({
      podRef: { uid: p.metadata.uid, name: p.metadata.name, namespace: NAMESPACE },
      containers: [{ name: "web", memory: { time: TIME, workingSetBytes: 100 } }],
    }));
    f.data.summary.unrelated = Array.from({ length: 1024 }, () => ({ ignored: SENTINEL.repeat(240) }));
    const raw = JSON.stringify(f.data.summary);
    expect(Buffer.byteLength(raw)).toBeLessThan(BOUNDS.bytes);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(8 * 1024 * 1024);
    const { artifact, code, text } = await output(f);
    expect(code).toBe(0);
    expect(artifact.containers).toHaveLength(32);
    expect(text.length).toBeLessThan(100_000);
    expect(text).not.toContain(SENTINEL);
  });

  it("bounds non-running context across both snapshots without changing completeness", async () => {
    const f = fixture();
    const stopped = (n) => {
      const p = pod("marketplace", n);
      p.status.phase = "Failed";
      return p;
    };
    f.data.after = [...clone(f.data.pods), ...Array.from({ length: 29 }, (_, n) => stopped(n + 100))];
    f.data.pods.push(...Array.from({ length: 29 }, (_, n) => stopped(n + 10)));
    const { artifact, code } = await output(f);
    expect(code).toBe(0);
    expect(artifact.reasons).toEqual([]);
    expect(artifact.nonRunningPods).toHaveLength(BOUNDS.pods);
    expect(new Set(artifact.nonRunningPods.map((p) => p.podUid)).size).toBe(BOUNDS.pods);
    expect(artifact.containers).toHaveLength(3);
  });

  it.each([
    (a) => {
      a.containers[0].current.value.secret = SENTINEL;
    },
    (a) => {
      a.containers[0].current.value.workingSetBytes = NaN;
    },
    (a) => {
      a.containers[0].history.value.count = -1;
    },
    (a) => {
      a.containers[0].history.value.end = "invalid";
    },
    (a) => {
      a.containers[0].events = {
        status: "available",
        value: [{ reason: "Evicted", time: TIME, count: 1, message: SENTINEL }],
      };
    },
    (a) => {
      a.containers[0].lastTermination = {
        status: "available",
        value: { reason: SENTINEL, finishedAt: TIME, exitCode: 0 },
      };
    },
    (a) => {
      a.containers[0].riskFlags.push(SENTINEL);
    },
    (a) => {
      a.containers[0].percent = Infinity;
    },
    (a) => {
      a.provenance.private = SENTINEL;
    },
    (a) => {
      a.riskFlags.push(SENTINEL);
    },
    (a) => {
      a.nonRunningPods = [
        {
          component: "marketplace",
          pod: "synthetic-stopped",
          podUid: uid(4),
          phase: "Failed",
          events: { status: "available", value: [{ reason: "Evicted", time: TIME, count: 1, message: SENTINEL }] },
        },
      ];
    },
    (a) => {
      a.nonRunningPods = [
        {
          component: "marketplace",
          pod: "synthetic-stopped",
          podUid: uid(4),
          phase: SENTINEL,
          events: { status: "unknown", reason: "no-observed-events" },
        },
      ];
    },
    (a) => {
      a.nonRunningPods = Array.from({ length: BOUNDS.pods + 1 }, () => ({}));
    },
  ])("rejects nested invalid retained output", async (mutate) => {
    const a = await collect(fixture());
    mutate(a);
    expect(validateArtifact(a)).toBe(false);
  });
});

describe("fixed, bounded, secret-safe adapters", () => {
  it.each([
    ["kubectl", ["exec", "pod", "--", "env"]],
    ["kubectl", ["logs", "pod"]],
    ["kubectl", ["get", "pods"]],
    ["kubectl", ["get", "--raw", "/api/v1/namespaces/other/pods", "--request-timeout=15s"]],
    ["kubectl", ["get", "--raw", "/api/v1/nodes/node/proxy/logs", "--request-timeout=15s"]],
    ["kubectl", ["delete", "pod"]],
    ["terraform", ["apply"]],
    ["doctl", ["registry", "login"]],
  ])("refuses non-fixed provider argv %s %j", (program, args) => {
    expect(() => admitCommand(program, args)).toThrow("command-refused");
  });

  it("executes admitted reads with a scrubbed environment and a 15-second/16-MiB bound", async () => {
    const execute = vi.fn((program, args, options, done) => {
      expect(program).toBe("kubectl");
      expect(options.timeout).toBe(15_000);
      expect(options.maxBuffer).toBe(BOUNDS.bytes);
      expect(Object.keys(options.env).sort()).toEqual(["HOME", "KUBECONFIG", "PATH"]);
      expect(JSON.stringify(options.env)).not.toContain(SENTINEL);
      done(null, '{"synthetic":true}', SENTINEL);
    });
    const read = commandReader(
      {
        ...environment(),
        HOME: "/synthetic/home",
        PATH: "/synthetic/bin",
        DIGITALOCEAN_ACCESS_TOKEN: SENTINEL,
        AWS_PROFILE: SENTINEL,
        NODE_OPTIONS: SENTINEL,
      },
      execute,
    );
    await expect(read("/api/v1/nodes/synthetic-node/proxy/stats/summary")).resolves.toEqual({ synthetic: true });
    await expect(read("/api/v1/secrets")).rejects.toThrow("command-refused");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, SENTINEL, "output-limit"],
    [{ killed: true }, SENTINEL, "timeout"],
    [{}, `(Unauthorized) ${SENTINEL}`, "unauthorized"],
    [{}, `(Forbidden) ${SENTINEL}`, "forbidden"],
    [{}, `(NotFound) ${SENTINEL}`, "not-found"],
    [{}, SENTINEL, "failed"],
  ])("reduces process failure to closed reason %j", (error, stderr, expected) => {
    expect(commandFailure(error, stderr)).toBe(expected);
  });

  it("process malformed/oversized output never returns raw text", async () => {
    for (const text of [SENTINEL, " ".repeat(BOUNDS.bytes + 1)]) {
      const read = commandReader(environment(), (_p, _a, _o, done) => done(null, text, SENTINEL));
      await expect(read("/api/v1/nodes/synthetic-node/proxy/stats/summary")).rejects.toThrow(
        text === SENTINEL ? "malformed" : "output-limit",
      );
    }
  });

  it("uses only the fixed HTTPS endpoint, query, window and header without redirects", async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      expect(url.origin + url.pathname).toBe("https://prometheus.chasesets.com/api/v1/query_range");
      expect(url.searchParams.get("query")).toBe(
        `container_memory_working_set_bytes{deployment_environment="production",k8s_namespace_name="${NAMESPACE}"}`,
      );
      expect(Number(url.searchParams.get("end")) - Number(url.searchParams.get("start"))).toBe(900);
      expect(url.searchParams.get("step")).toBe("30");
      expect(options.redirect).toBe("manual");
      expect(options.headers).toEqual({ "X-Chase-Sets-Observability-Query": SENTINEL });
      return new Response('{"synthetic":true}');
    });
    await expect(readHistory(SENTINEL, Date.parse(END), fetchImpl)).resolves.toEqual({ synthetic: true });
    await expect(readHistory("", Date.parse(END), fetchImpl)).rejects.toThrow("credentials-unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [302, "redirect"],
    [500, "http-error"],
  ])("HTTP %s never retains upstream body", async (status, reason) => {
    await expect(
      readHistory(SENTINEL, Date.parse(END), async () => new Response(SENTINEL, { status })),
    ).rejects.toThrow(reason);
  });

  it("refuses malformed, advertised oversized and streamed cap+1 bodies", async () => {
    await expect(readHistory(SENTINEL, Date.parse(END), async () => new Response(SENTINEL))).rejects.toThrow(
      "malformed",
    );
    await expect(
      readHistory(
        SENTINEL,
        Date.parse(END),
        async () => new Response(SENTINEL, { headers: { "content-length": String(BOUNDS.bytes + 1) } }),
      ),
    ).rejects.toThrow("output-limit");
    await expect(
      readHistory(
        SENTINEL,
        Date.parse(END),
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(BOUNDS.bytes));
                c.enqueue(new Uint8Array(1));
                c.close();
              },
            }),
          ),
      ),
    ).rejects.toThrow("output-limit");
  });

  it("times out both stalled headers and an endless body without real waiting", async () => {
    vi.useFakeTimers();
    for (const fetchImpl of [
      async () => new Promise(() => {}),
      async () =>
        new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
          }),
        ),
    ]) {
      const pending = readHistory(SENTINEL, Date.parse(END), fetchImpl);
      const assertion = expect(pending).rejects.toThrow("timeout");
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    }
  });

  it("sentinel-bearing upstream failures never reach artifact, stdout or stderr", async () => {
    const stdout = vi.spyOn(console, "log");
    const stderr = vi.spyOn(console, "error");
    const f = fixture();
    f.history = async () => {
      throw new Error(SENTINEL);
    };
    const { text } = await output(f);
    expect(text + JSON.stringify(stdout.mock.calls) + JSON.stringify(stderr.mock.calls)).not.toContain(SENTINEL);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});

const workflow = parse(
  readFileSync(new URL("../.github/workflows/platform-production-memory-probe.yml", import.meta.url), "utf8"),
);
function checkWorkflow(w) {
  const job = w.jobs?.capture;
  const steps = job?.steps ?? [];
  const context = steps.find((s) => s.id === "context");
  const collectStep = steps.find((s) => s.id === "collect");
  const secrets = steps.flatMap((s) =>
    Object.entries(s.env ?? {})
      .filter(([, v]) => String(v).includes("secrets."))
      .map(([, v]) => [s.id, v]),
  );
  return (
    steps.length === 9 &&
    (JSON.stringify(w).match(/secrets\./g) ?? []).length === 4 &&
    JSON.stringify(w.permissions) === JSON.stringify({ contents: "read" }) &&
    !job?.permissions &&
    !job?.env &&
    !w.env &&
    Object.keys(w.on).join() === "workflow_dispatch" &&
    Object.keys(w.on.workflow_dispatch.inputs).join() === "confirm" &&
    job.environment === "production" &&
    job["timeout-minutes"] === 10 &&
    w.concurrency.group === "platform-production-memory-probe" &&
    w.concurrency["cancel-in-progress"] === false &&
    steps[0].id === "admit" &&
    !Object.values(steps[0].env).some((v) => v.includes("secrets.")) &&
    steps[1].with.ref === "${{ github.sha }}" &&
    steps[1].with["persist-credentials"] === false &&
    steps.find((s) => s.uses?.startsWith("digitalocean/action-doctl@"))?.with.no_auth === "true" &&
    secrets.length === 4 &&
    secrets.every(([id, value]) =>
      id === "context"
        ? /^\$\{\{ secrets\.(SPACES_ACCESS_ID|SPACES_SECRET_KEY|DIGITALOCEAN_ACCESS_TOKEN) \}\}$/.test(value)
        : id === "collect" && value === "${{ secrets.PROMETHEUS_QUERY_TOKEN }}",
    ) &&
    context.run.includes("key=doks/production.tfstate") &&
    context.run.includes("--expiry-seconds 900") &&
    context.run.includes("chmod 600") &&
    context.run.includes("context-credentials-unavailable") &&
    !/terraform (?:apply|plan|state)|kubectl |registry|\bexec\b|\blogs\b/.test(context.run) &&
    collectStep.run === "node scripts/production-memory-probe.mjs" &&
    collectStep.env.KUBECONFIG === "${{ runner.temp }}/production-memory-probe.kubeconfig" &&
    steps.some(
      (s) => s.if === "always()" && s.run === 'rm -f -- "${RUNNER_TEMP}/production-memory-probe.kubeconfig"',
    ) &&
    steps.at(-1).with["retention-days"] === 14 &&
    steps.at(-1).with["if-no-files-found"] === "error"
  );
}

describe("workflow production credential boundary", () => {
  it("authority fragment binds every secret to its actual one-based workflow step", () => {
    const { grants } = JSON.parse(
      readFileSync(
        new URL("../.github/authority/platform-production-memory-probe/capture.json", import.meta.url),
        "utf8",
      ),
    );
    const expected = workflow.jobs.capture.steps.flatMap((step, index) =>
      Object.values(step.env ?? {}).flatMap((value) => {
        const name = /^\$\{\{ secrets\.([A-Z_]+) \}\}$/.exec(value)?.[1];
        return name
          ? [
              {
                file: ".github/workflows/platform-production-memory-probe.yml",
                jobId: "capture",
                stepAnchor: `name:${step.name}#${index + 1}`,
                secretName: name,
              },
            ]
          : [];
      }),
    );
    expect(grants.map(({ purpose: _purpose, ...grant }) => grant)).toEqual(expect.arrayContaining(expected));
    expect(grants).toHaveLength(expected.length);
  });
  it("has fixed main-only admission before step-local secrets, no install scripts, and always cleanup", () => {
    expect(checkWorkflow(workflow)).toBe(true);
    expect(workflow.jobs.capture.steps.some((s) => /pnpm|npm |registry login/.test(s.run ?? s.uses ?? ""))).toBe(false);
  });

  it.each([
    ["workflow_dispatch", "refs/heads/main", "capture production web memory", "chase-sets/chase-sets", true],
    ["push", "refs/heads/main", "capture production web memory", "chase-sets/chase-sets", false],
    ["workflow_dispatch", "refs/heads/other", "capture production web memory", "chase-sets/chase-sets", false],
    ["workflow_dispatch", "refs/heads/main", "yes", "chase-sets/chase-sets", false],
    ["workflow_dispatch", "refs/heads/main", "capture production web memory", "synthetic/fork", false],
  ])("executes the actual admission shell for %s %s %s", (event, ref, confirm, repository, allowed) => {
    const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
    const run = () =>
      execFileSync(shell, ["--noprofile", "--norc", "-c", workflow.jobs.capture.steps[0].run], {
        timeout: 5000,
        env: { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_REPOSITORY: repository, CAPTURE_CONFIRM: confirm },
        stdio: "pipe",
      });
    if (allowed) expect(run).not.toThrow();
    else expect(run).toThrow();
  });

  it.each([
    (w) => {
      w.permissions.actions = "write";
    },
    (w) => {
      w.jobs.capture.env = { PRIVATE: "${{ secrets.PROMETHEUS_QUERY_TOKEN }}" };
    },
    (w) => {
      w.on.workflow_dispatch.inputs.namespace = { type: "string" };
    },
    (w) => {
      w.jobs.capture.steps[4].with.no_auth = "false";
    },
    (w) => {
      w.jobs.capture.steps[2].env = { PRIVATE: "${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}" };
    },
    (w) => {
      w.jobs.capture.steps[5].run += "\nkubectl exec pod -- env";
    },
    (w) => {
      w.jobs.capture.steps[5].run += "\nkubectl logs pod";
    },
    (w) => {
      w.jobs.capture.steps[5].run += "\nterraform apply";
    },
    (w) => {
      w.jobs.capture.steps[6].run += " --url https://other.invalid";
    },
  ])("refuses caller targets, writes/exec/logs, extra permissions or misplaced secrets", (mutate) => {
    const candidate = clone(workflow);
    mutate(candidate);
    expect(checkWorkflow(candidate)).toBe(false);
  });

  it("withheld context credentials fail in the actual shell before Terraform or doctl", () => {
    const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
    const script = workflow.jobs.capture.steps.find((s) => s.id === "context").run;
    for (const missing of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "DIGITALOCEAN_ACCESS_TOKEN"]) {
      const env = { AWS_ACCESS_KEY_ID: SENTINEL, AWS_SECRET_ACCESS_KEY: SENTINEL, DIGITALOCEAN_ACCESS_TOKEN: SENTINEL };
      env[missing] = "";
      try {
        execFileSync(shell, ["--noprofile", "--norc", "-c", script], { timeout: 5000, env, stdio: "pipe" });
        throw new Error("unexpected success");
      } catch (error) {
        expect(error.status).toBe(1);
        expect(error.stderr.toString().trim()).toBe("context-credentials-unavailable");
        expect(error.stdout.toString()).toBe("");
      }
    }
  });
});
