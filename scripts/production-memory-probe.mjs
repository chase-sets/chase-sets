#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const NAMESPACE = "chase-sets-platform";
export const COMPONENTS = ["marketplace", "public-web"];
export const OUTPUT = "artifacts/production-memory-probe/capture.json";
export const BOUNDS = { pods: 32, containers: 256, pages: 4, events: 512, bytes: 16 * 1024 * 1024, timeout: 15_000 };
const SELECTOR =
  "app.kubernetes.io/instance=chase-sets-platform,app.kubernetes.io/component in (marketplace,public-web)";
const POD_PATH = `/api/v1/namespaces/${NAMESPACE}/pods?limit=32&labelSelector=${encodeURIComponent(SELECTOR)}`;
const EVENT_PATH = `/api/v1/namespaces/${NAMESPACE}/events?limit=128&fieldSelector=${encodeURIComponent("involvedObject.kind=Pod")}`;
// kubeletstats container.memory.working_set (By), translated to Prometheus naming.
const QUERY = `container_memory_working_set_bytes{deployment_environment="production",k8s_namespace_name="${NAMESPACE}"}`;
const ENDPOINT = "https://prometheus.chasesets.com/api/v1/query_range";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REASONS = new Set([
  "credentials-unavailable",
  "context-unavailable",
  "provenance-unavailable",
  "command-refused",
  "unauthorized",
  "forbidden",
  "not-found",
  "failed",
  "timeout",
  "output-limit",
  "malformed",
  "page-bound",
  "count-mismatch",
  "inventory-bound",
  "missing-component",
  "identity-unavailable",
  "limit-unavailable",
  "usage-unavailable",
  "stale",
  "identity-drift",
  "limit-drift",
  "restart-drift",
  "redirect",
  "http-error",
  "no-identity-matching-series",
  "termination-unavailable",
  "events-unavailable",
  "no-observed-events",
  "output-invalid",
]);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const utc = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString().slice(0, 19) === v.slice(0, 19);
const unknown = (reason) => ({ status: "unknown", reason });
const known = (value) => ({ status: "available", value });
export class CaptureRefusal extends Error {}
const refuse = (reason) => {
  throw new CaptureRefusal(reason);
};
const reasonOf = (error) => (error instanceof CaptureRefusal && REASONS.has(error.message) ? error.message : "failed");

/** Only exact scoped GET paths; no exec, logs, arbitrary resources or commands. */
export function admitCommand(program, args) {
  if (
    program !== "kubectl" ||
    !Array.isArray(args) ||
    args.length !== 4 ||
    args[0] !== "get" ||
    args[1] !== "--raw" ||
    args[3] !== "--request-timeout=15s"
  )
    refuse("command-refused");
  const path = args[2];
  const base = typeof path === "string" ? path.split("&continue=")[0] : "";
  const continuation = typeof path === "string" ? path.slice(base.length) : "";
  if (
    (base === POD_PATH || base === EVENT_PATH) &&
    (continuation === "" || /^&continue=[A-Za-z0-9%._~-]{1,2048}$/.test(continuation))
  )
    return;
  if (typeof path === "string" && /^\/api\/v1\/nodes\/[a-z0-9][a-z0-9.-]{0,252}\/proxy\/stats\/summary$/.test(path))
    return;
  refuse("command-refused");
}

export function commandFailure(error, stderr) {
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output-limit";
  if (error?.killed || error?.code === "ETIMEDOUT") return "timeout";
  if (/\(Unauthorized\)/.test(String(stderr))) return "unauthorized";
  if (/\(Forbidden\)/.test(String(stderr))) return "forbidden";
  if (/\(NotFound\)/.test(String(stderr))) return "not-found";
  return "failed";
}

/** Child process environment deliberately excludes provider tokens and session configuration. */
export function commandReader(env, execute = execFile) {
  return async (path) => {
    const args = ["get", "--raw", path, "--request-timeout=15s"];
    admitCommand("kubectl", args);
    const stdout = await new Promise((accept, reject) => {
      execute(
        "kubectl",
        args,
        {
          encoding: "utf8",
          timeout: BOUNDS.timeout,
          maxBuffer: BOUNDS.bytes,
          windowsHide: true,
          env: { PATH: env.PATH, HOME: env.HOME, KUBECONFIG: env.KUBECONFIG },
        },
        (error, output, stderr) => (error ? reject(new CaptureRefusal(commandFailure(error, stderr))) : accept(output)),
      );
    });
    if (Buffer.byteLength(stdout) > BOUNDS.bytes) refuse("output-limit");
    try {
      return JSON.parse(stdout);
    } catch {
      refuse("malformed");
    }
  };
}

/** Bounded streaming read: both headers and the complete body share a deadline; redirects are never followed. */
export async function readHistory(token, end, fetchImpl = fetch) {
  if (typeof token !== "string" || !token.trim()) refuse("credentials-unavailable");
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    query: QUERY,
    start: String(end / 1000 - 900),
    end: String(end / 1000),
    step: "30",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOUNDS.timeout);
  const expired = new Promise((_, reject) =>
    controller.signal.addEventListener("abort", () => reject(new CaptureRefusal("timeout")), { once: true }),
  );
  let reader;
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        headers: { "X-Chase-Sets-Observability-Query": token },
        redirect: "manual",
        signal: controller.signal,
      }),
      expired,
    ]);
    if (response.status >= 300 && response.status < 400) refuse("redirect");
    if (!response.ok)
      refuse(response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : "http-error");
    if (Number(response.headers.get("content-length")) > BOUNDS.bytes) refuse("output-limit");
    reader = response.body?.getReader();
    if (!reader) refuse("malformed");
    const parts = [];
    let size = 0;
    while (true) {
      const part = await Promise.race([reader.read(), expired]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > BOUNDS.bytes) refuse("output-limit");
      parts.push(Buffer.from(part.value));
    }
    try {
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      refuse("malformed");
    }
  } catch (error) {
    if (controller.signal.aborted) refuse("timeout");
    throw new CaptureRefusal(reasonOf(error));
  } finally {
    clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => {});
  }
}

/** Kubernetes quantities are exact bytes here; fractional bytes round up as Kubernetes does. */
export function limitBytes(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)([EPTGMK]i|[EPTGMkK]|m|[eE][+-]?\d+)?$/.exec(value);
  if (!match) return null;
  const units = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    m: 1e-3,
  };
  const multiplier = !match[2] ? 1 : (units[match[2]] ?? Number(`1${match[2]}`));
  const bytes = Math.ceil(Number(match[1]) * multiplier);
  return integer(bytes) && bytes > 0 ? bytes : null;
}

async function list(read, path, cap) {
  const items = [];
  let token = "";
  let expected;
  let version;
  try {
    for (let page = 0; page < BOUNDS.pages; page++) {
      const body = await read(path + (token ? `&continue=${encodeURIComponent(token)}` : ""));
      if (
        !object(body) ||
        !Array.isArray(body.items) ||
        !object(body.metadata) ||
        typeof body.metadata.resourceVersion !== "string" ||
        !body.metadata.resourceVersion
      )
        refuse("malformed");
      if (page && version !== body.metadata.resourceVersion) refuse("count-mismatch");
      version = body.metadata.resourceVersion;
      const remaining = body.metadata.remainingItemCount;
      if (remaining !== undefined && !integer(remaining)) refuse("malformed");
      if (page === 0 && remaining !== undefined) expected = body.items.length + remaining;
      items.push(...body.items);
      if (items.length > cap) refuse("inventory-bound");
      token = body.metadata.continue ?? "";
      if (typeof token !== "string" || token.length > 1024 || (token && !body.items.length)) refuse("malformed");
      if (!token) {
        if ((remaining !== undefined && remaining !== 0) || (expected !== undefined && expected !== items.length))
          refuse("count-mismatch");
        return { items, reason: null };
      }
      if (remaining === 0) refuse("count-mismatch");
    }
    refuse("page-bound");
  } catch (error) {
    return { items: items.slice(0, cap), reason: reasonOf(error) };
  }
}

function digest(imageID) {
  if (typeof imageID !== "string") return null;
  const value = imageID.match(/(?:^|@)(sha256:[0-9a-f]{64})$/)?.[1];
  return value ?? null;
}

function projectPods(pods, errors) {
  const result = [];
  const seen = new Set();
  for (const pod of pods) {
    const component = pod?.metadata?.labels?.["app.kubernetes.io/component"];
    if (
      !COMPONENTS.includes(component) ||
      pod?.metadata?.labels?.["app.kubernetes.io/instance"] !== NAMESPACE ||
      pod?.metadata?.namespace !== NAMESPACE ||
      !matches(NAME, pod?.metadata?.name) ||
      !matches(UUID, pod?.metadata?.uid)
    ) {
      errors.add("identity-unavailable");
      continue;
    }
    if (seen.has(pod.metadata.uid)) {
      errors.add("identity-unavailable");
      continue;
    }
    seen.add(pod.metadata.uid);
    if (pod.status?.phase !== "Running") continue;
    const regular = Array.isArray(pod.spec?.containers) ? pod.spec.containers : [];
    const specs = [
      ...regular,
      ...(Array.isArray(pod.spec?.initContainers) ? pod.spec.initContainers : []),
      ...(Array.isArray(pod.spec?.ephemeralContainers) ? pod.spec.ephemeralContainers : []),
    ];
    const statuses = [
      ...(Array.isArray(pod.status?.containerStatuses) ? pod.status.containerStatuses : []),
      ...(Array.isArray(pod.status?.initContainerStatuses) ? pod.status.initContainerStatuses : []),
      ...(Array.isArray(pod.status?.ephemeralContainerStatuses) ? pod.status.ephemeralContainerStatuses : []),
    ];
    if (statuses.some((status) => status?.state?.running && !specs.some((spec) => spec?.name === status.name)))
      errors.add("identity-unavailable");
    const names = new Set();
    if (!specs.length || !matches(NAME, pod.spec?.nodeName)) {
      errors.add("identity-unavailable");
      continue;
    }
    for (const spec of specs) {
      const status = statuses.find((s) => s?.name === spec?.name);
      // Regular containers must be present; only running init/ephemeral containers consume current memory.
      if (!regular.includes(spec) && !status?.state?.running) continue;
      if (!matches(NAME, spec?.name) || names.has(spec.name)) {
        errors.add("identity-unavailable");
        continue;
      }
      names.add(spec.name);
      const imageDigest = digest(status?.imageID);
      const startedAt = status?.state?.running?.startedAt;
      const restarts = status?.restartCount;
      if (
        !imageDigest ||
        !utc(startedAt) ||
        !integer(restarts) ||
        statuses.filter((s) => s?.name === spec.name).length !== 1
      )
        errors.add("identity-unavailable");
      const limit = limitBytes(spec?.resources?.limits?.memory);
      if (limit === null) errors.add("limit-unavailable");
      const termination = status?.lastState?.terminated;
      const terminationReason = ["OOMKilled", "Error", "Completed", "ContainerCannotRun", "StartError"].includes(
        termination?.reason,
      )
        ? termination.reason
        : null;
      result.push({
        component,
        pod: pod.metadata.name,
        podUid: pod.metadata.uid,
        container: spec.name,
        node: pod.spec.nodeName,
        imageDigest,
        startedAt: utc(startedAt) ? startedAt : null,
        restarts: integer(restarts) ? restarts : null,
        limitBytes: limit,
        lastTermination:
          terminationReason && utc(termination.finishedAt) && integer(termination.exitCode)
            ? known({ reason: terminationReason, finishedAt: termination.finishedAt, exitCode: termination.exitCode })
            : unknown("termination-unavailable"),
      });
      if (result.length > BOUNDS.containers) {
        errors.add("inventory-bound");
        return result.slice(0, BOUNDS.containers);
      }
    }
  }
  for (const component of COMPONENTS)
    if (!result.some((r) => r.component === component)) errors.add("missing-component");
  return result;
}

function currentUsage(summary, row, at) {
  if (!Array.isArray(summary?.pods) || summary.node?.nodeName !== row.node) return unknown("malformed");
  const matches = summary.pods.filter(
    (p) => p?.podRef?.uid === row.podUid && p.podRef.name === row.pod && p.podRef.namespace === NAMESPACE,
  );
  if (matches.length !== 1 || !Array.isArray(matches[0].containers)) return unknown("usage-unavailable");
  const containers = matches[0].containers.filter((c) => c?.name === row.container);
  const memory = containers.length === 1 ? containers[0].memory : null;
  if (!integer(memory?.workingSetBytes) || !utc(memory?.time)) return unknown("usage-unavailable");
  const age = at - Date.parse(memory.time);
  if (age < 0 || age > 120_000 || Date.parse(memory.time) < Date.parse(row.startedAt)) return unknown("stale");
  return known({ time: memory.time, workingSetBytes: memory.workingSetBytes });
}

function historyFor(body, row, clusterId, end) {
  if (
    body?.status !== "success" ||
    body?.data?.resultType !== "matrix" ||
    !Array.isArray(body?.data?.result) ||
    body.data.result.length > BOUNDS.containers * 4
  )
    return unknown("malformed");
  if (body.data.result.some((series) => !object(series) || !object(series.metric))) return unknown("malformed");
  const series = body.data.result.filter(
    ({ metric: m }) =>
      m?.deployment_environment === "production" &&
      m.k8s_cluster_id === clusterId &&
      m.k8s_namespace_name === NAMESPACE &&
      m.k8s_pod_uid === row.podUid &&
      m.k8s_pod_name === row.pod &&
      m.k8s_container_name === row.container &&
      digest(m.container_image_id) === row.imageDigest,
  );
  if (series.length !== 1) return unknown("no-identity-matching-series");
  const values = series[0].values;
  if (!Array.isArray(values) || !values.length || values.length > 31) return unknown("malformed");
  let maximumBytes = 0;
  let previous = -Infinity;
  for (const sample of values) {
    if (
      !Array.isArray(sample) ||
      sample.length !== 2 ||
      typeof sample[0] !== "number" ||
      typeof sample[1] !== "string" ||
      !/^\d+(?:\.\d+)?$/.test(sample[1])
    )
      return unknown("malformed");
    const [time, text] = sample;
    const usage = Number(text);
    if (
      !integer(usage) ||
      time * 1000 < Math.max(end - 900_000, Date.parse(row.startedAt)) ||
      time * 1000 > end ||
      time <= previous
    )
      return unknown("malformed");
    maximumBytes = Math.max(maximumBytes, usage);
    previous = time;
  }
  return known({
    maximumBytes,
    count: values.length,
    start: new Date(end - 900_000).toISOString(),
    end: new Date(end).toISOString(),
  });
}

function eventsFor(items, row, failure) {
  if (failure) return unknown("events-unavailable");
  const records = [];
  for (const event of items) {
    if (
      event?.involvedObject?.uid !== row.podUid ||
      event.involvedObject.name !== row.pod ||
      event.involvedObject.namespace !== NAMESPACE ||
      !["OOMKilled", "OOMKilling", "Evicted"].includes(event.reason)
    )
      continue;
    const time = event.lastTimestamp ?? event.eventTime;
    const count = event.count ?? event.series?.count ?? 1;
    if (!utc(time) || !integer(count) || count === 0) return unknown("events-unavailable");
    records.push({ reason: event.reason, time, count });
  }
  return records.length ? known(records) : unknown("no-observed-events");
}

/** One capture preserves validated observations even when another replica/source is incomplete. */
export async function collect({ env, read = commandReader(env), history = readHistory, now = () => new Date() }) {
  const startedAt = now().toISOString();
  const errors = new Set();
  const provenance =
    matches(SHA, env.GITHUB_SHA) &&
    matches(/^[1-9]\d{0,19}$/, env.GITHUB_RUN_ID) &&
    matches(/^[1-9]\d{0,5}$/, env.GITHUB_RUN_ATTEMPT)
      ? {
          toolingSha: env.GITHUB_SHA,
          runId: env.GITHUB_RUN_ID,
          runAttempt: env.GITHUB_RUN_ATTEMPT,
          job: "capture",
          step: "collect",
        }
      : null;
  const clusterId = matches(UUID, env.CAPTURE_CLUSTER_ID) ? env.CAPTURE_CLUSTER_ID : null;
  if (!provenance) errors.add("provenance-unavailable");
  if (!clusterId || !env.KUBECONFIG) errors.add("context-unavailable");
  if (!env.PROMETHEUS_QUERY_TOKEN?.trim()) errors.add("credentials-unavailable");
  let rows = [];
  if (!errors.size) {
    const before = await list(read, POD_PATH, BOUNDS.pods);
    if (before.reason) errors.add(before.reason);
    rows = projectPods(before.items, errors);
    const samples = new Map();
    for (const node of new Set(rows.map((r) => r.node))) {
      try {
        samples.set(node, await read(`/api/v1/nodes/${node}/proxy/stats/summary`));
      } catch (error) {
        errors.add(reasonOf(error));
      }
    }
    const captured = now().getTime();
    let historical;
    let historyReason;
    try {
      historical = await history(env.PROMETHEUS_QUERY_TOKEN, captured);
    } catch (error) {
      historyReason = reasonOf(error);
    }
    const events = await list(read, EVENT_PATH, BOUNDS.events);
    if (events.reason) errors.add(events.reason);
    const after = await list(read, POD_PATH, BOUNDS.pods);
    if (after.reason) errors.add(after.reason);
    const afterRows = projectPods(after.items, errors);
    const key = (r) => `${r.podUid}/${r.container}`;
    if (rows.length !== afterRows.length || afterRows.some((a) => !rows.some((b) => key(a) === key(b))))
      errors.add("identity-drift");
    const added = afterRows.filter((a) => !rows.some((b) => key(a) === key(b)));
    if (rows.length + added.length > BOUNDS.containers) errors.add("inventory-bound");
    rows = [...rows, ...added].slice(0, BOUNDS.containers);
    const finished = now().getTime();
    rows = rows.map((row) => {
      const other = afterRows.find((r) => key(r) === key(row));
      let current = currentUsage(samples.get(row.node), row, finished);
      if (
        added.includes(row) ||
        !other ||
        ["pod", "node", "component", "imageDigest", "startedAt"].some((field) => other[field] !== row[field]) ||
        !row.imageDigest ||
        !row.startedAt
      )
        current = unknown("identity-drift");
      else if (other.limitBytes !== row.limitBytes || row.limitBytes === null) current = unknown("limit-drift");
      else if (other.restarts !== row.restarts || row.restarts === null) current = unknown("restart-drift");
      if (current.status === "unknown") errors.add(current.reason);
      const recentHistory = historyReason ? unknown(historyReason) : historyFor(historical, row, clusterId, captured);
      const eventContext = eventsFor(events.items, row, events.reason);
      const percent =
        current.status === "available" && row.limitBytes
          ? (current.value.workingSetBytes / row.limitBytes) * 100
          : null;
      const riskFlags = [];
      if (percent !== null && percent >= 80) riskFlags.push("near-limit");
      if (
        row.lastTermination.value?.reason === "OOMKilled" ||
        eventContext.value?.some((e) => e.reason.startsWith("OOM"))
      )
        riskFlags.push("oom-observed");
      if (eventContext.value?.some((e) => e.reason === "Evicted")) riskFlags.push("eviction-observed");
      return {
        ...row,
        current,
        percent,
        classification: percent === null ? "unknown" : percent >= 80 ? "near" : "below-near-threshold",
        history: recentHistory,
        events: eventContext,
        riskFlags,
      };
    });
  }
  return {
    schemaVersion: "production-memory-probe/v1",
    environment: "production",
    namespace: NAMESPACE,
    clusterId,
    provenance,
    startedAt,
    endedAt: now().toISOString(),
    completeness: errors.size ? "incomplete" : "complete",
    reasons: [...errors].sort(),
    containers: rows,
  };
}

function keys(value, expected) {
  return object(value) && Object.keys(value).sort().join(",") === expected.split(" ").sort().join(",");
}
function observation(value, check) {
  return (
    (keys(value, "status reason") && value.status === "unknown" && REASONS.has(value.reason)) ||
    (keys(value, "status value") && value.status === "available" && check(value.value))
  );
}
/** Recursively closed retained schema; upstream metadata never passes through. */
export function validateArtifact(a) {
  if (
    !keys(
      a,
      "schemaVersion environment namespace clusterId provenance startedAt endedAt completeness reasons containers",
    ) ||
    a.schemaVersion !== "production-memory-probe/v1" ||
    a.environment !== "production" ||
    a.namespace !== NAMESPACE ||
    !(a.clusterId === null || matches(UUID, a.clusterId)) ||
    !utc(a.startedAt) ||
    !utc(a.endedAt) ||
    Date.parse(a.endedAt) < Date.parse(a.startedAt)
  )
    return false;
  if (
    a.provenance !== null &&
    (!keys(a.provenance, "toolingSha runId runAttempt job step") ||
      !matches(SHA, a.provenance.toolingSha) ||
      !matches(/^[1-9]\d{0,19}$/, a.provenance.runId) ||
      !matches(/^[1-9]\d{0,5}$/, a.provenance.runAttempt) ||
      a.provenance.job !== "capture" ||
      a.provenance.step !== "collect")
  )
    return false;
  if (
    !["complete", "incomplete"].includes(a.completeness) ||
    !Array.isArray(a.reasons) ||
    a.reasons.some((r) => !REASONS.has(r)) ||
    !Array.isArray(a.containers) ||
    a.containers.length > BOUNDS.containers
  )
    return false;
  if (
    a.completeness === "complete" &&
    (a.reasons.length ||
      !a.clusterId ||
      !a.provenance ||
      COMPONENTS.some((c) => !a.containers.some((r) => r.component === c)))
  )
    return false;
  return a.containers.every((r) => {
    if (
      !keys(
        r,
        "component pod podUid container node imageDigest startedAt restarts limitBytes lastTermination current percent classification history events riskFlags",
      ) ||
      !COMPONENTS.includes(r.component) ||
      ![r.pod, r.container, r.node].every((v) => typeof v === "string" && NAME.test(v)) ||
      !matches(UUID, r.podUid) ||
      !(r.imageDigest === null || matches(DIGEST, r.imageDigest)) ||
      !(r.startedAt === null || utc(r.startedAt)) ||
      !(r.restarts === null || integer(r.restarts)) ||
      !(r.limitBytes === null || (integer(r.limitBytes) && r.limitBytes > 0))
    )
      return false;
    if (
      !observation(
        r.lastTermination,
        (t) =>
          keys(t, "reason finishedAt exitCode") &&
          ["OOMKilled", "Error", "Completed", "ContainerCannotRun", "StartError"].includes(t.reason) &&
          utc(t.finishedAt) &&
          integer(t.exitCode),
      )
    )
      return false;
    if (!observation(r.current, (c) => keys(c, "time workingSetBytes") && utc(c.time) && integer(c.workingSetBytes)))
      return false;
    if (
      !observation(
        r.history,
        (h) =>
          keys(h, "maximumBytes count start end") &&
          integer(h.maximumBytes) &&
          integer(h.count) &&
          h.count > 0 &&
          h.count <= 31 &&
          utc(h.start) &&
          utc(h.end) &&
          Date.parse(h.end) - Date.parse(h.start) === 900_000,
      )
    )
      return false;
    if (
      !observation(
        r.events,
        (events) =>
          Array.isArray(events) &&
          events.length > 0 &&
          events.length <= BOUNDS.events &&
          events.every(
            (e) =>
              keys(e, "reason time count") &&
              ["OOMKilled", "OOMKilling", "Evicted"].includes(e.reason) &&
              utc(e.time) &&
              integer(e.count) &&
              e.count > 0,
          ),
      )
    )
      return false;
    if (
      !Array.isArray(r.riskFlags) ||
      r.riskFlags.some((f) => !["near-limit", "oom-observed", "eviction-observed"].includes(f))
    )
      return false;
    const percent =
      r.current.status === "available" && r.limitBytes ? (r.current.value.workingSetBytes / r.limitBytes) * 100 : null;
    if (
      r.percent !== percent ||
      r.classification !== (percent === null ? "unknown" : percent >= 80 ? "near" : "below-near-threshold") ||
      !Number.isFinite(percent ?? 0)
    )
      return false;
    return (
      a.completeness !== "complete" ||
      (r.current.status === "available" &&
        r.imageDigest !== null &&
        r.startedAt !== null &&
        r.restarts !== null &&
        r.limitBytes !== null)
    );
  });
}

export async function runCapture({
  env = process.env,
  read,
  history,
  now,
  write = writeFile,
  makeDirectory = mkdir,
} = {}) {
  const artifact = await collect({ env, read, history, now });
  if (!validateArtifact(artifact)) refuse("output-invalid");
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  if (Buffer.byteLength(text) > BOUNDS.bytes) refuse("output-limit");
  // Exact credential values are a final output boundary, never a redaction of raw retained bodies.
  if (
    [env.PROMETHEUS_QUERY_TOKEN, env.DIGITALOCEAN_ACCESS_TOKEN, env.AWS_SECRET_ACCESS_KEY, env.AWS_ACCESS_KEY_ID].some(
      (secret) => secret && text.includes(secret),
    )
  )
    refuse("output-invalid");
  await makeDirectory(dirname(OUTPUT), { recursive: true });
  await write(OUTPUT, text, { mode: 0o600 });
  return artifact.completeness === "complete" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    console.error("command-refused");
    process.exitCode = 1;
  } else
    try {
      process.exitCode = await runCapture();
    } catch (error) {
      console.error(reasonOf(error));
      process.exitCode = 1;
    }
}
