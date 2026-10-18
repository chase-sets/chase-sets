#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import process from "node:process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { parseMemoryMib } from "./merge-gate-verification.mjs";
import { MERGE_GATE_NAMESPACE_PATTERN, VERIFICATION_NAMESPACE_PATTERN } from "./ephemeral-verification-namespace.mjs";
import { readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const PREVIEW_POOL_CENSUS_SCHEMA_VERSION = "preview-pool-census/v1";
export const PREVIEW_NAMESPACE_PREFIXES = Object.freeze({
  pr: "chase-sets-pr-",
  gate: "chase-sets-gate-",
  verify: "chase-sets-verify-",
});
export const PREVIEW_COMPONENTS = Object.freeze([
  "public-web",
  "marketplace",
  "admin-web",
  "platform-api",
  "platform-worker",
  "preview-postgres",
  "platform-bootstrap",
]);
const execFileAsync = promisify(execFile);
const PREVIEW_POOL_LABEL = "chase-sets.com/pool";
const PREVIEW_POOL_VALUE = "preview";
const PREVIEW_NAMESPACE_RE = /^chase-sets-pr-\d+$/;

export function previewNamespaceKind(name) {
  const value = String(name ?? "").trim();
  if (PREVIEW_NAMESPACE_RE.test(value)) return "pr";
  if (MERGE_GATE_NAMESPACE_PATTERN.test(value)) return "gate";
  if (VERIFICATION_NAMESPACE_PATTERN.test(value)) return "verify";
  return null;
}

export function filterPreviewNamespaces(namespaces) {
  return (Array.isArray(namespaces) ? namespaces : [])
    .map((namespace) => {
      const metadata = namespace?.metadata ?? namespace;
      const name = metadata?.name;
      const kind = previewNamespaceKind(name);
      return kind ? { kind, name, creationTimestamp: metadata.creationTimestamp ?? null } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseCpuRequest(value) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?m$/.test(text)) return Number(text.slice(0, -1));
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
  return 0;
}

function requestForContainer(container) {
  const requests = container?.resources?.requests ?? {};
  return {
    cpuMillicores: parseCpuRequest(requests.cpu),
    memoryMi: parseMemoryMib(requests.memory) ?? 0,
  };
}

function observationRequestForContainer(container) {
  const resources = container?.resources ?? {};
  return {
    memoryRequestMi: parseMemoryMib(resources.requests?.memory),
    memoryLimitMi: parseMemoryMib(resources.limits?.memory),
  };
}

function isTerminalPod(pod) {
  return ["Succeeded", "Failed"].includes(pod?.status?.phase);
}

function podNamespace(pod) {
  return pod?.metadata?.namespace ?? "";
}

function podName(pod) {
  return pod?.metadata?.name ?? "";
}

function componentForPod(pod, containerName) {
  const labels = pod?.metadata?.labels ?? {};
  return (
    labels["app.kubernetes.io/component"] ??
    (PREVIEW_COMPONENTS.includes(containerName) ? containerName : podName(pod))
  );
}

export function dedupeEvents(events) {
  const allowedReasons = new Set(["Evicted", "FailedScheduling", "TriggeredScaleUp", "NotTriggerScaleUp"]);
  const byUid = new Map();
  for (const event of asArray(events)) {
    const reason = event?.reason;
    if (!allowedReasons.has(reason)) continue;
    const namespace = event?.metadata?.namespace ?? null;
    if (reason !== "Evicted" && !previewNamespaceKind(namespace)) continue;
    const uid = event?.metadata?.uid ?? `${event?.metadata?.namespace ?? ""}/${event?.metadata?.name ?? ""}`;
    const count = Number(event?.count ?? event?.series?.count ?? 1);
    const firstTimestamp = event?.firstTimestamp ?? event?.eventTime ?? event?.metadata?.creationTimestamp ?? null;
    const lastTimestamp = event?.lastTimestamp ?? event?.series?.lastObservedTime ?? event?.eventTime ?? null;
    const existing = byUid.get(uid);
    if (existing) {
      existing.count = Math.max(existing.count, Number.isFinite(count) && count > 0 ? count : 1);
      existing.firstTimestamp = [existing.firstTimestamp, firstTimestamp].filter(Boolean).sort()[0] ?? null;
      existing.lastTimestamp = [existing.lastTimestamp, lastTimestamp].filter(Boolean).sort().at(-1) ?? null;
      continue;
    }
    byUid.set(uid, {
      uid,
      namespace: event?.metadata?.namespace ?? null,
      name: event?.metadata?.name ?? null,
      reason,
      message: typeof event?.message === "string" ? event.message : null,
      count: Number.isFinite(count) && count > 0 ? count : 1,
      firstTimestamp,
      lastTimestamp,
    });
  }
  return [...byUid.values()].sort((left, right) => left.uid.localeCompare(right.uid));
}

export function reduceContainerPeaks(peaks, observations) {
  const next = new Map(peaks instanceof Map ? peaks : []);
  for (const observation of asArray(observations)) {
    const key = observation.key ?? `${observation.namespace}/${observation.pod}/${observation.container}`;
    const previous = next.get(key);
    const value = Number.isFinite(observation.maxWorkingSetBytes) ? observation.maxWorkingSetBytes : null;
    next.set(key, {
      key,
      namespace: observation.namespace ?? previous?.namespace ?? null,
      pod: observation.pod ?? previous?.pod ?? null,
      container: observation.container ?? previous?.container ?? null,
      component: observation.component ?? previous?.component ?? null,
      phase: observation.phase ?? previous?.phase ?? null,
      terminatedReason: observation.terminatedReason ?? previous?.terminatedReason ?? null,
      evictedReason: observation.evictedReason ?? previous?.evictedReason ?? null,
      memoryRequestMi: observation.memoryRequestMi ?? previous?.memoryRequestMi ?? null,
      memoryLimitMi: observation.memoryLimitMi ?? previous?.memoryLimitMi ?? null,
      node: observation.node ?? previous?.node ?? null,
      maxWorkingSetBytes:
        value === null ? (previous?.maxWorkingSetBytes ?? null) : Math.max(previous?.maxWorkingSetBytes ?? 0, value),
      sampleCount: (previous?.sampleCount ?? 0) + 1,
      firstSeen: previous?.firstSeen ?? observation.seenAt ?? null,
      lastSeen: observation.seenAt ?? previous?.lastSeen ?? null,
    });
  }
  return next;
}

function nodeIsPreview(node) {
  return node?.metadata?.labels?.[PREVIEW_POOL_LABEL] === PREVIEW_POOL_VALUE;
}

function nodeAllocatable(node) {
  const allocatable = node?.status?.allocatable ?? {};
  return { cpuMillicores: parseCpuRequest(allocatable.cpu), memoryMi: parseMemoryMib(allocatable.memory) ?? 0 };
}

function nodeReady(node) {
  return node?.status?.conditions?.find((condition) => condition.type === "Ready")?.status === "True";
}

function nodeRecord(node) {
  const allocatable = nodeAllocatable(node);
  return {
    name: node?.metadata?.name ?? null,
    pool: node?.metadata?.labels?.[PREVIEW_POOL_LABEL] ?? null,
    instanceType:
      node?.metadata?.labels?.["node.kubernetes.io/instance-type"] ??
      node?.metadata?.labels?.["beta.kubernetes.io/instance-type"] ??
      null,
    ready: nodeReady(node),
    allocatable,
  };
}

function podContainerStatuses(pod, containerName) {
  const status = asArray(pod?.status?.containerStatuses).find((entry) => entry.name === containerName);
  const terminated = status?.state?.terminated ?? status?.lastState?.terminated;
  return {
    terminatedReason: terminated?.reason ?? null,
    evictedReason: pod?.status?.reason === "Evicted" ? pod.status.reason : null,
  };
}

export function computeSizing(values, nodes, maxNodes) {
  const components = values?.components ?? {};
  const requestSources = [
    ...PREVIEW_COMPONENTS.slice(0, 5).map((name) => [`components.${name}`, components[name]?.resources?.requests?.memory]),
    ["previewPostgres", values?.previewPostgres?.resources?.requests?.memory],
    ["components.platform-bootstrap", components["platform-bootstrap"]?.resources?.requests?.memory],
  ];
  const missing = requestSources.filter(([, value]) => !(parseMemoryMib(value) > 0)).map(([name]) => name);
  if (missing.length) throw new Error(`seven preview workload memory requests must be positive: ${missing.join(", ")}`);
  const namespaceRequestMi = requestSources.reduce((sum, [, value]) => sum + parseMemoryMib(value), 0);
  const previewNodes = asArray(nodes).filter(
    (node) => node?.pool === PREVIEW_POOL_VALUE || node?.metadata?.labels?.[PREVIEW_POOL_LABEL] === PREVIEW_POOL_VALUE,
  );
  const perNode = previewNodes.map((node) => {
    const available = node.allocatable.memoryMi - (node.nonPreviewRequests?.memoryMi ?? 0);
    return Math.max(0, Math.floor(available / namespaceRequestMi));
  });
  const liveN = perNode.reduce((sum, value) => sum + value, 0);
  const maxNodeCount = Number.isInteger(maxNodes) ? maxNodes : Number(maxNodes);
  const maxPerNode = perNode.length ? Math.min(...perNode) : 0;
  return {
    namespaceRequestMi,
    perNode,
    N: { live: liveN, maxNodes: Number.isInteger(maxNodeCount) ? maxPerNode * maxNodeCount : liveN },
  };
}

export function allowlistedKubectlArgs(args) {
  const argv = asArray(args).map(String);
  if (argv[0] !== "get") return false;
  if (
    argv.includes("apply") ||
    argv.includes("delete") ||
    argv.includes("patch") ||
    argv.includes("edit") ||
    argv.includes("exec") ||
    argv.includes("logs")
  )
    return false;
  if (argv.includes("--raw")) return argv[1] === "--raw" || (argv[1] === "get" && argv[2] === "--raw");
  return true;
}

async function kubectlJson(args, dependencies) {
  const argv = ["get", ...args, "-o", "json"];
  if (!allowlistedKubectlArgs(argv))
    throw new Error(`kubectl command rejected by read-only allowlist: ${argv.join(" ")}`);
  const output = await dependencies.kubectl(argv);
  return typeof output === "string" ? JSON.parse(output) : output;
}

export function createKubectlRunner({ command = "kubectl", env = process.env } = {}) {
  return async (args) => {
    if (!allowlistedKubectlArgs(args))
      throw new Error(`kubectl command rejected by read-only allowlist: ${args.join(" ")}`);
    const result = await execFileAsync(command, args, { env, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
    return result.stdout;
  };
}

async function kubectlRaw(args, dependencies) {
  const argv = ["get", "--raw", args];
  if (!allowlistedKubectlArgs(argv))
    throw new Error(`kubectl command rejected by read-only allowlist: ${argv.join(" ")}`);
  const output = await dependencies.kubectl(argv);
  return typeof output === "string" ? JSON.parse(output) : output;
}

async function listSnapshot(dependencies, { includeEvents = true } = {}) {
  const reads = [
    ["nodes", kubectlJson(["nodes"], dependencies)],
    ["pods", kubectlJson(["pods", "--all-namespaces"], dependencies)],
    ["namespaces", kubectlJson(["namespaces"], dependencies)],
    ["autoscaler", kubectlJson(["configmap", "cluster-autoscaler-status", "--namespace", "kube-system"], dependencies)],
  ];
  if (includeEvents) reads.push(["events", kubectlJson(["events", "--all-namespaces"], dependencies)]);
  const settled = await Promise.all(reads.map(async ([name, promise]) => {
    try {
      return { name, value: await promise };
    } catch (error) {
      return { name, error: String(error?.message ?? error) };
    }
  }));
  const values = new Map(settled.filter((entry) => !entry.error).map((entry) => [entry.name, entry.value]));
  const errors = settled.filter((entry) => entry.error).map((entry) => `${entry.name}: ${entry.error}`);
  return {
    snapshot: {
      nodes: asArray(values.get("nodes")?.items),
      pods: asArray(values.get("pods")?.items),
      namespaces: asArray(values.get("namespaces")?.items),
      events: asArray(values.get("events")?.items),
      autoscaler: values.get("autoscaler") ?? null,
    },
    errors,
    successfulReads: new Set(values.keys()),
  };
}

function buildNodeRecords(snapshot) {
  const previewNamespaces = filterPreviewNamespaces(snapshot.namespaces);
  const previewNames = new Set(previewNamespaces.map((namespace) => namespace.name));
  return asArray(snapshot.nodes).map((node) => {
    const record = nodeRecord(node);
    if (!nodeIsPreview(node)) return record;
    const nonPreviewPods = asArray(snapshot.pods).filter(
      (pod) => pod?.spec?.nodeName === record.name && !previewNames.has(podNamespace(pod)) && !isTerminalPod(pod),
    );
    const requests = nonPreviewPods.flatMap((pod) => asArray(pod?.spec?.containers).map(requestForContainer));
    record.nonPreviewRequests = {
      cpuMillicores: requests.reduce((sum, request) => sum + request.cpuMillicores, 0),
      memoryMi: requests.reduce((sum, request) => sum + request.memoryMi, 0),
      pods: nonPreviewPods.map((pod) => ({
        namespace: podNamespace(pod),
        name: podName(pod),
        requests: asArray(pod?.spec?.containers).map((container) => ({
          name: container.name ?? null,
          ...requestForContainer(container),
        })),
      })),
    };
    return record;
  });
}

function observationIndex(snapshot, seenAt) {
  const observations = [];
  for (const pod of asArray(snapshot.pods)) {
    if (!previewNamespaceKind(podNamespace(pod))) continue;
    for (const container of asArray(pod?.spec?.containers)) {
      const status = podContainerStatuses(pod, container.name);
      const request = requestForContainer(container);
      observations.push({
        key: `${podNamespace(pod)}/${podName(pod)}/${container.name ?? ""}`,
        namespace: podNamespace(pod),
        pod: podName(pod),
        container: container.name ?? null,
        component: componentForPod(pod, container.name),
        phase: pod?.status?.phase ?? null,
        ...status,
        ...request,
        ...observationRequestForContainer(container),
        node: pod?.spec?.nodeName ?? null,
        maxWorkingSetBytes: null,
        seenAt,
      });
    }
  }
  return observations;
}

function statsObservations(stats, snapshot, seenAt) {
  const pods = new Map(asArray(snapshot.pods).map((pod) => [`${podNamespace(pod)}/${podName(pod)}`, pod]));
  const observations = [];
  for (const podStats of asArray(stats?.pods)) {
    const pod = pods.get(`${podStats?.podRef?.namespace ?? ""}/${podStats?.podRef?.name ?? ""}`);
    if (!pod || !previewNamespaceKind(podNamespace(pod))) continue;
    for (const containerStats of asArray(podStats?.containers)) {
      const container = asArray(pod?.spec?.containers).find((entry) => entry.name === containerStats.name);
      if (!container) continue;
      const base = observationIndex(
        { pods: [pod], namespaces: [{ metadata: { name: podNamespace(pod) } }] },
        seenAt,
      ).find((entry) => entry.container === containerStats.name);
      observations.push({
        ...base,
        maxWorkingSetBytes: Number(containerStats?.memory?.workingSetBytes ?? NaN),
        seenAt,
      });
    }
  }
  return observations;
}

export async function collectSnapshot({
  dependencies,
  peaks = new Map(),
  seenAt = new Date().toISOString(),
  sizing,
  includeEvents = true,
} = {}) {
  const listed = await listSnapshot(dependencies, { includeEvents });
  const snapshot = listed.snapshot;
  const errors = [...listed.errors];
  const nodeRecords = buildNodeRecords(snapshot);
  const baseObservations = observationIndex(snapshot, seenAt);
  const stats = await Promise.all(
    nodeRecords
      .filter((node) => node.name && node.pool === PREVIEW_POOL_VALUE)
      .map(async (node) => {
        try {
          return { node, value: await kubectlRaw(`/api/v1/nodes/${encodeURIComponent(node.name)}/proxy/stats/summary`, dependencies) };
        } catch (error) {
          errors.push(`stats/summary ${node.name}: ${String(error?.message ?? error)}`);
          return { node, value: null };
        }
      }),
  );
  const statObservations = stats.flatMap(({ value }) => statsObservations(value, snapshot, seenAt));
  const statKeys = new Set(statObservations.map((observation) => observation.key));
  const observations = [...statObservations, ...baseObservations.filter((observation) => !statKeys.has(observation.key))];
  let computedSizing = sizing ?? null;
  if (computedSizing === null && dependencies.values) {
    try {
      computedSizing = computeSizing(dependencies.values, nodeRecords, dependencies.maxNodes);
    } catch (error) {
      errors.push(`sizing: ${String(error?.message ?? error)}`);
    }
  }
  return {
    snapshot,
    nodeRecords,
    namespaces: filterPreviewNamespaces(snapshot.namespaces),
    events: dedupeEvents(snapshot.events),
    autoscalerStatus: snapshot.autoscaler?.data?.status ?? null,
    peaks: reduceContainerPeaks(peaks, observations),
    sizing: computedSizing,
    errors,
    successfulReads: listed.successfulReads,
  };
}

export async function runCensus({
  mode = "snapshot",
  durationMinutes = 45,
  intervalSeconds = 10,
  dependencies = { kubectl: createKubectlRunner() },
  values,
  maxNodes = 3,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
} = {}) {
  if (!new Set(["snapshot", "sample"]).has(mode)) throw new Error("mode must be snapshot or sample");
  const startedAt = now().toISOString();
  const errors = [];
  let peaks = new Map();
  let latest = null;
  let events = [];
  let lastEventRead = Number.NEGATIVE_INFINITY;
  const endAt = Date.now() + (mode === "sample" ? durationMinutes * 60_000 : 0);
  dependencies = { ...dependencies, values, maxNodes };
  do {
    const shouldReadEvents = mode !== "sample" || Date.now() - lastEventRead >= 60_000;
    const result = await collectSnapshot({
      dependencies,
      peaks,
      seenAt: now().toISOString(),
      includeEvents: shouldReadEvents,
    });
    const reads = result.successfulReads ?? new Set();
    if (!latest) latest = result;
    if (reads.has("nodes") && reads.has("pods") && reads.has("namespaces")) latest.nodeRecords = result.nodeRecords;
    if (reads.has("namespaces")) latest.namespaces = result.namespaces;
    if (reads.has("autoscaler")) latest.autoscalerStatus = result.autoscalerStatus;
    if (result.sizing !== null && !result.errors.some((error) => error.startsWith("sizing:"))) latest.sizing = result.sizing;
    peaks = result.peaks;
    if (shouldReadEvents && reads.has("events")) {
      events = dedupeEvents([...events, ...result.events]);
      lastEventRead = Date.now();
    }
    errors.push(...result.errors);
    if (mode !== "sample" || Date.now() >= endAt) break;
    await sleep(Math.min(intervalSeconds * 1000, Math.max(0, endAt - Date.now())));
  } while (Date.now() < endAt);

  if (mode === "sample") {
    const final = await collectSnapshot({ dependencies, peaks, seenAt: now().toISOString(), includeEvents: true });
    const reads = final.successfulReads ?? new Set();
    if (!latest) latest = final;
    if (reads.has("nodes") && reads.has("pods") && reads.has("namespaces")) latest.nodeRecords = final.nodeRecords;
    if (reads.has("namespaces")) latest.namespaces = final.namespaces;
    if (reads.has("autoscaler")) latest.autoscalerStatus = final.autoscalerStatus;
    if (final.sizing !== null && !final.errors.some((error) => error.startsWith("sizing:"))) latest.sizing = final.sizing;
    peaks = final.peaks;
    if (reads.has("events")) events = dedupeEvents([...events, ...final.events]);
    errors.push(...final.errors);
  }

  const peakContainers = [...peaks.values()].map((entry) => ({ ...entry, thinSample: entry.sampleCount < 3 }));
  const record = {
    schemaVersion: PREVIEW_POOL_CENSUS_SCHEMA_VERSION,
    result: errors.length ? "partial" : "success",
    mode,
    startedAt,
    finishedAt: now().toISOString(),
    intervalSeconds: mode === "sample" ? intervalSeconds : null,
    durationMinutes: mode === "sample" ? durationMinutes : 0,
    lowerBound:
      mode === "sample" ? `sampled every ${intervalSeconds} seconds; peaks can miss between-sample spikes` : null,
    nodes: latest?.nodeRecords ?? [],
    namespaces: latest?.namespaces ?? [],
    containers: peakContainers,
    events,
    autoscalerStatus: latest?.autoscalerStatus ?? null,
    sizing: latest?.sizing ?? null,
    thinSamples: peakContainers.filter((entry) => entry.thinSample).map((entry) => entry.key),
    errors,
  };
  return record;
}

async function readValues(valuesPath) {
  if (!valuesPath) return null;
  return parseYaml(await readFile(valuesPath, "utf8"));
}

function maxNodesFromTerraform() {
  try {
    const source = readFileSync("infrastructure/digitalocean/doks/variables.tf", "utf8");
    return Number(source.match(/variable\s+"preview_node_pool_max_nodes"[\s\S]*?default\s*=\s*(\d+)/)?.[1] ?? 3);
  } catch {
    return 3;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = readOption(argv, "--mode") ?? "snapshot";
  const durationMinutes = Number(readOption(argv, "--duration-minutes") ?? 45);
  const intervalSeconds = Number(readOption(argv, "--interval-seconds") ?? 10);
  const out = readOption(argv, "--out") ?? "artifacts/preview-pool-census.json";
  const valuesPath = readOption(argv, "--values");
  const values = await readValues(valuesPath);
  if (!["snapshot", "sample"].includes(mode)) throw new Error("mode must be snapshot or sample");
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 60)
    throw new Error("duration-minutes must be an integer from 1 to 60");
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 60)
    throw new Error("interval-seconds must be an integer from 5 to 60");
  if (values) computeSizing(values, [], maxNodesFromTerraform());
  const record = await runCensus({ mode, durationMinutes, intervalSeconds, values, maxNodes: maxNodesFromTerraform() });
  await writeJsonRecord(out, record);
  if (record.result !== "success") process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("preview-pool-census.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
