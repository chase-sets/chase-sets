import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { parse } from "yaml";
import { instant, readTerminalEvidence, sha256 } from "./census-terminal-evidence.mjs";

export const CONTEXT = "do-nyc3-chase-sets-staging-doks";
export const READS = Object.freeze(
  [
    ["nodes", "Node"],
    ["namespaces", "Namespace"],
    ["pods", "Pod"],
    ["events", "Event"],
    ["configmap", "ConfigMap"],
  ].map(([resource, kind]) => Object.freeze({ resource, kind })),
);
const preview = (name) => /^chase-sets-(pr|gate|verify)-/.test(name);
const hashPattern = /^[a-f0-9]{64}$/;
const textPattern = /^[a-zA-Z0-9_.:/@+ -]{1,512}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = (value) => sha256(JSON.stringify(value));
const requiredOwners = Object.freeze({
  pr: ["platform-pr.yml", "preview-deploy-smoke"],
  gate: ["platform-merge-gate-verification.yml", "verify"],
  stranded: ["platform-merge-gate-verification.yml", "stranded-fixture-drill"],
  ephemeral: ["platform-ephemeral-verification.yml", "verify-release"],
  automatic: ["platform-production.yml", "dispatch-ephemeral-verification"],
  observer: ["platform-merge-qualification-observer.yml", "cleanup"],
  cleanup: ["platform-preview-cleanup.yml", "destroy-preview"],
});

class AcquisitionRefusal extends Error {}
function need(condition, reason) {
  if (!condition) throw new AcquisitionRefusal(reason);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value) {
  need(typeof value === "string" && textPattern.test(value), "STOP_UNSAFE_PROJECTION");
  return value;
}
function timestamp(value) {
  try {
    instant(value);
  } catch {
    need(false, "STOP_TIMESTAMP");
  }
  return value;
}
function integer(value) {
  need(Number.isSafeInteger(value) && value >= 0, "STOP_RECORD_SHAPE");
  return value;
}
function optional(value, key, validate) {
  return Object.hasOwn(value, key) ? { [key]: value[key] === null ? null : validate(value[key]) } : {};
}
function metadata(record, namespaced) {
  const m = record?.metadata;
  need(object(m), "STOP_METADATA");
  return {
    uid: text(m.uid),
    name: text(m.name),
    createdAt: timestamp(m.creationTimestamp),
    ...(namespaced ? { namespace: text(m.namespace) } : {}),
    ...optional(m, "deletionTimestamp", timestamp),
  };
}
function conditions(values) {
  need(Array.isArray(values), "STOP_CONDITIONS");
  const seen = new Set();
  return values.map((c) => {
    need(object(c) && !seen.has(c.type) && ["True", "False", "Unknown"].includes(c.status), "STOP_CONDITIONS");
    seen.add(c.type);
    return { type: text(c.type), status: c.status, lastTransitionTime: timestamp(c.lastTransitionTime) };
  });
}
function node(record) {
  const m = metadata(record, false);
  need(object(record.spec) && object(record.status) && object(record.metadata.labels), "STOP_NODE_SHAPE");
  const labels = record.metadata.labels;
  const state = conditions(record.status.conditions);
  need(
    ["Ready", "MemoryPressure", "DiskPressure", "PIDPressure"].every((type) => state.some((c) => c.type === type)),
    "STOP_NODE_PRESSURE",
  );
  need(
    !Object.hasOwn(record.spec, "unschedulable") || typeof record.spec.unschedulable === "boolean",
    "STOP_NODE_SHAPE",
  );
  const taints = Object.hasOwn(record.spec, "taints") ? record.spec.taints : [];
  need(Array.isArray(taints) && object(record.status.allocatable), "STOP_NODE_SHAPE");
  const allocation = Object.fromEntries(
    ["cpu", "memory", "pods"].map((key) => [key, text(record.status.allocatable[key])]),
  );
  return {
    ...m,
    pool: Object.hasOwn(labels, "chase-sets.com/pool") ? text(labels["chase-sets.com/pool"]) : null,
    instanceType: text(labels["node.kubernetes.io/instance-type"]),
    conditions: state,
    ...optional(record.spec, "unschedulable", (value) => value),
    ...(Object.hasOwn(record.spec, "taints")
      ? {
          taints: taints.map((t) => {
            need(object(t) && ["NoSchedule", "PreferNoSchedule", "NoExecute"].includes(t.effect), "STOP_TAINT");
            return {
              key: text(t.key),
              ...optional(t, "value", text),
              effect: t.effect,
              ...optional(t, "timeAdded", timestamp),
            };
          }),
        }
      : {}),
    allocatable: allocation,
  };
}
function namespace(record) {
  const m = metadata(record, false);
  need(["Active", "Terminating"].includes(record.status?.phase), "STOP_NAMESPACE_SHAPE");
  return { ...m, phase: record.status.phase };
}
function containerState(value) {
  need(object(value) && Object.keys(value).length === 1, "STOP_CONTAINER_STATE");
  const [state] = Object.keys(value);
  need(["running", "waiting", "terminated"].includes(state) && object(value[state]), "STOP_CONTAINER_STATE");
  const v = value[state];
  if (state === "running") timestamp(v.startedAt);
  if (state === "terminated") {
    need(Number.isInteger(v.exitCode), "STOP_CONTAINER_STATE");
    timestamp(v.startedAt);
    timestamp(v.finishedAt);
  }
  return {
    [state]: {
      ...optional(v, "reason", text),
      ...optional(v, "startedAt", timestamp),
      ...optional(v, "finishedAt", timestamp),
      ...optional(v, "exitCode", (n) => {
        need(Number.isInteger(n), "STOP_CONTAINER_STATE");
        return n;
      }),
    },
  };
}
function pod(record) {
  const m = metadata(record, true);
  need(
    object(record.spec) &&
      object(record.status) &&
      ["Pending", "Running", "Succeeded", "Failed", "Unknown"].includes(record.status.phase),
    "STOP_POD_SHAPE",
  );
  need(Array.isArray(record.spec.containers) && record.spec.containers.length > 0, "STOP_POD_SHAPE");
  const names = new Set();
  for (const [parent, keys] of [
    [record.spec, ["initContainers", "ephemeralContainers"]],
    [record.status, ["initContainerStatuses", "containerStatuses", "ephemeralContainerStatuses"]],
  ]) {
    need(
      keys.every((key) => !Object.hasOwn(parent, key) || Array.isArray(parent[key])),
      "STOP_POD_SHAPE",
    );
  }
  const declared = [
    ...(record.spec.initContainers ?? []),
    ...record.spec.containers,
    ...(record.spec.ephemeralContainers ?? []),
  ];
  for (const c of declared) {
    need(object(c) && !names.has(c.name), "STOP_POD_SHAPE");
    text(c.name);
    text(c.image);
    names.add(c.name);
  }
  const statuses = [
    ...(record.status.initContainerStatuses ?? []),
    ...(record.status.containerStatuses ?? []),
    ...(record.status.ephemeralContainerStatuses ?? []),
  ];
  const seen = new Set();
  const observed = statuses.map((c) => {
    need(object(c) && names.has(c.name) && !seen.has(c.name) && typeof c.ready === "boolean", "STOP_CONTAINER_SHAPE");
    seen.add(c.name);
    return {
      name: text(c.name),
      image: text(c.image),
      ...optional(c, "imageID", (v) => (v === "" ? "" : text(v))),
      ...optional(c, "containerID", (v) => (v === "" ? "" : text(v))),
      restartCount: integer(c.restartCount),
      state: containerState(c.state),
      ...(object(c.lastState) && Object.keys(c.lastState).length ? { lastState: containerState(c.lastState) } : {}),
    };
  });
  const containers = declared.map(
    (c) => observed.find((status) => status.name === c.name) ?? { name: c.name, image: c.image },
  );
  return {
    ...m,
    phase: record.status.phase,
    ...optional(record.spec, "nodeName", text),
    ...(record.metadata.labels?.["app.kubernetes.io/component"] === undefined
      ? {}
      : { component: text(record.metadata.labels["app.kubernetes.io/component"]) }),
    containers,
    ...optional(record.status, "startTime", timestamp),
  };
}
function event(record) {
  const m = metadata(record, true);
  const involved = record.involvedObject;
  need(object(involved), "STOP_EVENT_SHAPE");
  return {
    ...m,
    reason: text(record.reason),
    ...optional(record, "count", integer),
    ...optional(record, "firstTimestamp", timestamp),
    ...optional(record, "lastTimestamp", timestamp),
    ...optional(record, "eventTime", timestamp),
    ...optional(record, "series", (s) => {
      need(object(s), "STOP_EVENT_SHAPE");
      return { count: integer(s.count), lastObservedTime: timestamp(s.lastObservedTime) };
    }),
    involvedObject: {
      uid: text(involved.uid),
      kind: text(involved.kind),
      name: text(involved.name),
      ...optional(involved, "namespace", text),
    },
  };
}
function autoscaler(record) {
  const m = metadata(record, true);
  need(
    m.name === "cluster-autoscaler-status" && m.namespace === "kube-system" && object(record.data),
    "STOP_AUTOSCALER",
  );
  need(typeof record.data.status === "string", "STOP_AUTOSCALER");
  const clusterStatus = record.data.status.split(/^NodeGroups:/m)[0];
  const matches = [
    ...clusterStatus.matchAll(
      /^[ \t]*ScaleDown:[ \t]+(NoCandidates|CandidatesPresent|InProgress)(?:[ \t]+\(candidates=\d+\))?[ \t]*$/gm,
    ),
  ];
  need(matches.length === 1, "STOP_AUTOSCALER_UNKNOWN");
  return { ...m, scaleDown: matches[0][1], source: "kube-system/cluster-autoscaler-status:data.status" };
}
const projectors = { Node: node, Namespace: namespace, Pod: pod, Event: event, ConfigMap: autoscaler };

function projectRead(body, kind) {
  need(object(body) && body.apiVersion === "v1", "STOP_LIST_SHAPE");
  if (kind === "ConfigMap") {
    need(body.kind === kind, "STOP_LIST_SHAPE");
    return { resourceVersion: text(body.metadata?.resourceVersion), records: [autoscaler(body)] };
  }
  need(
    [`${kind}List`, "List"].includes(body.kind) && Array.isArray(body.items) && object(body.metadata),
    "STOP_LIST_SHAPE",
  );
  need(
    (!Object.hasOwn(body.metadata, "continue") || body.metadata.continue === "") &&
      (!Object.hasOwn(body.metadata, "remainingItemCount") || body.metadata.remainingItemCount === 0),
    "STOP_INCOMPLETE_LIST",
  );
  const seen = new Set();
  const records = body.items.map((record) => {
    need(object(record) && record.apiVersion === "v1" && record.kind === kind, "STOP_RECORD_KIND");
    const result = projectors[kind](record);
    need(!seen.has(result.uid), "STOP_DUPLICATE_UID");
    seen.add(result.uid);
    return result;
  });
  return { resourceVersion: text(body.metadata.resourceVersion), records };
}

function validateSource(input, producers) {
  const { admitted, source, capability } = input;
  need(object(admitted) && object(capability) && object(source), "STOP_WITHHELD_AUTHORITY");
  need(
    same(Object.keys(capability).sort(), ["context", "hostAdmission", "mode", "ownerIds", "reviewHash"]),
    "STOP_CAPABILITY_GAP",
  );
  need(
    admitted.sourceHash === digest(source) &&
      admitted.capabilityHash === digest(capability) &&
      same(producers?.binding, capability),
    "STOP_SOURCE_CAPABILITY_BINDING",
  );
  need(
    typeof capability.hostAdmission === "string" &&
      capability.hostAdmission.length > 0 &&
      capability.mode === "read-only" &&
      capability.context === CONTEXT,
    "STOP_WITHHELD_AUTHORITY",
  );
  need(
    hashPattern.test(capability.reviewHash) &&
      /^[a-f0-9]{40}$/.test(source.head) &&
      Array.isArray(source.owners) &&
      Array.isArray(source.files),
    "STOP_SOURCE_PLAN",
  );
  need(
    typeof producers.clusterRead === "function" &&
      typeof producers.inventoryRead === "function" &&
      typeof producers.automaticVariableRead === "function" &&
      typeof producers.previewGateRead === "function",
    "STOP_CAPABILITY_GAP",
  );
  need(/^[\w.-]+\/[\w.-]+$/.test(source.repository), "STOP_SOURCE_PLAN");
  const files = new Map();
  for (const file of source.files) {
    need(
      /^\.github\/workflows\/[\w.-]+\.yml$/.test(file.path) &&
        !files.has(file.path) &&
        typeof file.bytes === "string" &&
        sha256(file.bytes) === file.sha256,
      "STOP_SOURCE_FILE",
    );
    files.set(file.path, parse(file.bytes));
  }
  const ids = new Set();
  for (const owner of source.owners) {
    need(
      object(owner) &&
        !ids.has(owner.id) &&
        ["pr", "gate", "stranded", "ephemeral", "automatic", "observer", "cleanup", "indirect"].includes(owner.role),
      "STOP_OWNER_PLAN",
    );
    text(owner.id);
    ids.add(owner.id);
    need(
      object(files.get(owner.path)?.jobs?.[owner.job]) &&
        Number.isSafeInteger(owner.workflowId) &&
        owner.workflowId > 0,
      "STOP_OWNER_SOURCE",
    );
    const url = new URL(owner.url);
    need(
      url.origin === "https://api.github.com" &&
        url.pathname === `/repos/${source.repository}/actions/workflows/${owner.workflowId}/runs` &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password,
      "STOP_INVENTORY_URL",
    );
  }
  for (const [role, [path, job]] of Object.entries(requiredOwners)) {
    need(
      source.owners.some((o) => o.role === role && o.path === `.github/workflows/${path}` && o.job === job),
      "STOP_OWNER_OMISSION",
    );
  }
  need(
    Array.isArray(source.indirectOwners) &&
      source.indirectOwners.every((id) => source.owners.some((o) => o.id === id && o.role === "indirect")),
    "STOP_INDIRECT_OWNERS",
  );
  need(
    source.owners.filter((o) => o.role === "indirect").every((o) => source.indirectOwners.includes(o.id)),
    "STOP_INDIRECT_OWNERS",
  );
  need(
    same(
      capability.ownerIds,
      source.owners.map((o) => o.id),
    ),
    "STOP_CAPABILITY_GAP",
  );
}

function safePageUrl(owner, page) {
  return `${owner.url}?per_page=100&page=${page}`;
}
function page(record, owner, ordinal) {
  need(
    object(record) &&
      record.url === safePageUrl(owner, ordinal) &&
      record.method === "GET" &&
      record.status === 200 &&
      record.apiVersion === "2022-11-28",
    "STOP_INVENTORY_RESPONSE",
  );
  need(
    typeof record.body === "string" &&
      record.encoding === "utf8" &&
      record.sha256 === sha256(record.body) &&
      record.bytes === Buffer.byteLength(record.body) &&
      object(record.headers),
    "STOP_INVENTORY_BYTES",
  );
  need(
    instant(timestamp(record.captureCompletedAt)).ticks >= instant(timestamp(record.captureStartedAt)).ticks,
    "STOP_INVENTORY_INTERVAL",
  );
  need(
    Object.keys(record.headers).every((key) =>
      ["link", "content-type", "date", "x-github-request-id", "x-github-api-version-selected"].includes(key),
    ),
    "STOP_UNSAFE_HEADERS",
  );
  const body = JSON.parse(record.body);
  need(
    object(body) &&
      Number.isSafeInteger(body.total_count) &&
      body.total_count >= 0 &&
      body.total_count < 1000 &&
      Array.isArray(body.workflow_runs) &&
      body.workflow_runs.length <= 100,
    "STOP_INVENTORY_TOTAL",
  );
  const pages = Math.max(1, Math.ceil(body.total_count / 100));
  need(ordinal <= pages, "STOP_INVENTORY_LINK");
  const links = new Map();
  for (const link of record.headers.link ? record.headers.link.split(",") : []) {
    const match = /^\s*<([^>]+)>; rel="(next|last|first|prev)"\s*$/.exec(link);
    need(match && !links.has(match[2]), "STOP_INVENTORY_LINK");
    const expectedPage = { next: ordinal + 1, last: pages, first: 1, prev: ordinal - 1 }[match[2]];
    need(
      expectedPage >= 1 && expectedPage <= pages && match[1] === safePageUrl(owner, expectedPage),
      "STOP_INVENTORY_LINK",
    );
    links.set(match[2], match[1]);
  }
  need(links.has("next") === ordinal < pages, "STOP_INVENTORY_LINK");
  need(
    body.workflow_runs.length === Math.min(100, Math.max(0, body.total_count - (ordinal - 1) * 100)),
    "STOP_INVENTORY_PAGE",
  );
  return body;
}
function retainResponse(record) {
  return Object.fromEntries(
    [
      "url",
      "method",
      "status",
      "apiVersion",
      "encoding",
      "bytes",
      "sha256",
      "headers",
      "body",
      "captureStartedAt",
      "captureCompletedAt",
    ].map((key) => [key, structuredClone(record[key])]),
  );
}

function validateRun(run, owner) {
  need(
    object(run) &&
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      run.workflow_id === owner.workflowId &&
      run.path === owner.path &&
      /^[a-f0-9]{40}$/.test(run.head_sha) &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0,
    "STOP_PRODUCER_IDENTITY",
  );
  text(run.event);
  text(run.status);
  if (run.status === "completed") {
    need(
      [
        "success",
        "failure",
        "neutral",
        "cancelled",
        "skipped",
        "timed_out",
        "action_required",
        "stale",
        "startup_failure",
      ].includes(run.conclusion),
      "STOP_PRODUCER_STATUS",
    );
  } else {
    need(run.conclusion === null, "STOP_PRODUCER_STATUS");
  }
}
function eligible(run, owner, enabled, gate, sourceHash) {
  if (run.status === "completed") return false;
  if (owner.role === "automatic") return enabled;
  if (owner.role === "ephemeral") {
    need(["workflow_dispatch", "workflow_run"].includes(run.event), "STOP_PRODUCER_ELIGIBILITY");
    return run.event === "workflow_dispatch" || enabled;
  }
  if (owner.role === "pr") {
    need(
      object(gate) &&
        typeof gate.labelPreview === "boolean" &&
        typeof gate.clusterPreview === "boolean" &&
        gate.head === run.head_sha &&
        gate.runId === run.id &&
        gate.attempt === run.run_attempt &&
        gate.sourceHash === sourceHash &&
        hashPattern.test(gate.evidenceHash),
      "STOP_PRODUCER_ELIGIBILITY",
    );
    return gate.labelPreview || gate.clusterPreview;
  }
  // Cleanup and observer activity can invalidate the quiet slot even without creating a namespace.
  return true;
}

async function inventory(source, producers, enabled, budget) {
  const owners = [];
  for (const owner of source.owners) {
    const records = [],
      hashes = [],
      ids = new Set();
    const openingPages = [],
      closingPages = [];
    let total;
    const gates = new Map();
    const readGate = async (run) => {
      if (owner.role !== "pr" || run.status === "completed") return undefined;
      budget();
      const gate = await producers.previewGateRead({
        owner: owner.id,
        runId: run.id,
        attempt: run.run_attempt,
        head: run.head_sha,
        sourceHash: source.files.find((f) => f.path === owner.path).sha256,
      });
      budget();
      return gate;
    };
    for (let ordinal = 1; ordinal <= 10; ordinal++) {
      budget();
      const response = await producers.inventoryRead({
        owner: owner.id,
        url: safePageUrl(owner, ordinal),
        method: "GET",
        apiVersion: "2022-11-28",
      });
      budget();
      const body = page(response, owner, ordinal);
      if (total === undefined) total = body.total_count;
      need(total === body.total_count, "STOP_INVENTORY_RACE");
      hashes.push(response.sha256);
      openingPages.push(retainResponse(response));
      for (const run of body.workflow_runs) {
        validateRun(run, owner);
        need(!ids.has(run.id), "STOP_INVENTORY_DUPLICATE");
        ids.add(run.id);
      }
      for (const run of body.workflow_runs) {
        const gate = await readGate(run);
        const active = eligible(run, owner, enabled, gate, source.files.find((f) => f.path === owner.path).sha256);
        if (gate !== undefined) gates.set(run.id, digest(gate));
        records.push({
          id: run.id,
          attempt: run.run_attempt,
          head: run.head_sha,
          status: run.status,
          event: run.event,
          active,
        });
      }
      if (records.length === total) break;
      need(ordinal < 10, "STOP_INVENTORY_CAP");
    }
    need(ids.size === total, "STOP_INVENTORY_COUNT");
    // Re-read every page, not just the first page: a last-page race is decisive.
    for (let ordinal = 1; ordinal <= hashes.length; ordinal++) {
      budget();
      const response = await producers.inventoryRead({
        owner: owner.id,
        url: safePageUrl(owner, ordinal),
        method: "GET",
        apiVersion: "2022-11-28",
      });
      budget();
      const closing = page(response, owner, ordinal);
      need(response.sha256 === hashes[ordinal - 1], "STOP_INVENTORY_RACE");
      closingPages.push(retainResponse(response));
      for (const run of closing.workflow_runs) validateRun(run, owner);
      for (const run of closing.workflow_runs) {
        const gate = await readGate(run);
        if (gate !== undefined) need(digest(gate) === gates.get(run.id), "STOP_PRODUCER_GATE_RACE");
      }
    }
    owners.push({
      owner: owner.id,
      total,
      unique: ids.size,
      pageHashes: hashes,
      openingPages,
      closingPages,
      gateHashes: Object.fromEntries(gates),
      records,
    });
  }
  return owners;
}

export async function acquireC1Evidence(
  input,
  producers,
  { clock = () => performance.now(), now = () => new Date().toISOString() } = {},
) {
  const snapshots = [];
  try {
    validateSource(input, producers);
    input = structuredClone(input);
    const start = clock();
    need(
      Number.isFinite(input.slot?.startedAt) &&
        Number.isFinite(input.slot?.deadline) &&
        input.slot.deadline - input.slot.startedAt === 30000 &&
        start >= input.slot.startedAt &&
        start < input.slot.deadline,
      "STOP_SLOT",
    );
    const budget = () => {
      need(clock() <= input.slot.deadline, "STOP_SLOT_OVERRUN");
    };
    for (const { resource, kind } of READS) {
      budget();
      const args = [
        "--context",
        CONTEXT,
        "--request-timeout=20s",
        "get",
        resource === "events" ? "events.v1." : resource,
      ];
      if (["pods", "events"].includes(resource)) args.push("--all-namespaces");
      if (resource === "configmap") args.push("cluster-autoscaler-status", "--namespace", "kube-system");
      args.push("--output=json");
      const before = clock(),
        startedAt = now();
      const result = await producers.clusterRead({ resource, args, context: CONTEXT, requestTimeoutMs: 20000 });
      const elapsedMs = clock() - before,
        completedAt = now();
      need(elapsedMs >= 0 && elapsedMs <= 20000 && result?.exitCode === 0, "STOP_CLUSTER_READ");
      budget();
      need(typeof result.stdout === "string", "STOP_CLUSTER_JSON");
      const projection = projectRead(JSON.parse(result.stdout), kind);
      // Validate all records above, then filter. Raw payload and stderr never leave this frame.
      const previewNodes = snapshots[0]?.records ?? [];
      const relevantPods = snapshots[2]?.records ?? [];
      const records = projection.records.filter((r) =>
        kind === "Node"
          ? r.pool === "preview"
          : kind === "Namespace"
            ? preview(r.name)
            : kind === "Pod"
              ? preview(r.namespace) || previewNodes.some((n) => n.name === r.nodeName)
              : kind === "Event"
                ? preview(r.namespace) ||
                  ["Node", "Namespace"].includes(r.involvedObject.kind) ||
                  relevantPods.some((p) => p.uid === r.involvedObject.uid)
                : true,
      );
      snapshots.push({
        resource,
        startedAt,
        completedAt,
        elapsedMs,
        resourceVersion: projection.resourceVersion,
        records,
      });
    }
    budget();
    const automatic = await producers.automaticVariableRead({
      name: "PLATFORM_EPHEMERAL_VERIFICATION_ENABLED",
      repository: input.source.repository,
    });
    budget();
    need(
      object(automatic) &&
        ((automatic.present === false && automatic.value === null) ||
          (automatic.present === true && ["true", "false"].includes(automatic.value))),
      "STOP_AUTOMATIC_VARIABLE",
    );
    const producersInventory = await inventory(input.source, producers, automatic.value === "true", budget);
    budget();
    const closingAutomatic = await producers.automaticVariableRead({
      name: "PLATFORM_EPHEMERAL_VERIFICATION_ENABLED",
      repository: input.source.repository,
    });
    budget();
    need(same(automatic, closingAutomatic), "STOP_AUTOMATIC_VARIABLE_RACE");
    const nodes = snapshots[0].records,
      namespaces = snapshots[1].records;
    const reasons = [];
    if (nodes.length !== 1) reasons.push("PREVIEW_NODE_COUNT");
    const candidate = nodes[0];
    if (candidate) {
      if (candidate.instanceType !== "s-4vcpu-8gb") reasons.push("INSTANCE_TYPE");
      if (candidate.unschedulable || candidate.deletionTimestamp) reasons.push("NODE_LIFECYCLE");
      if (
        candidate.conditions.find((c) => c.type === "Ready").status !== "True" ||
        candidate.conditions.some((c) => c.type.endsWith("Pressure") && c.status !== "False")
      )
        reasons.push("NODE_CONDITIONS");
      if (
        (candidate.taints ?? []).length !== 1 ||
        !(candidate.taints ?? []).some(
          (t) => t.key === "chase-sets.com/preview-only" && t.value === "true" && t.effect === "NoSchedule",
        )
      )
        reasons.push("NODE_TAINTS");
    }
    if (namespaces.length) reasons.push("PREVIEW_NAMESPACES");
    if (producersInventory.some((o) => o.records.some((r) => r.active))) reasons.push("COMPETING_PRODUCER");
    budget();
    const finished = clock();
    need(finished <= input.slot.deadline, "STOP_SLOT_OVERRUN");
    const snapshot = {
      sourceHash: input.admitted.sourceHash,
      capabilityHash: input.admitted.capabilityHash,
      slot: { ...input.slot },
      reads: snapshots,
      inventory: producersInventory,
      automaticEnabled: automatic.value === "true",
      elapsedMs: finished - start,
    };
    return {
      state: reasons.length ? "REFUSED" : "ADMITTED",
      reasons,
      nodeUid: candidate?.uid ?? null,
      snapshot,
      snapshotHash: digest(snapshot),
    };
  } catch (error) {
    return {
      state: "STOP",
      reasons: [error instanceof AcquisitionRefusal ? error.message : "STOP_ACQUISITION"],
      nodeUid: null,
    };
  }
}

export async function recheckC1Evidence(input, prior, producers, timing) {
  if (
    prior?.state !== "ADMITTED" ||
    !object(prior.snapshot) ||
    prior.snapshotHash !== digest(prior.snapshot) ||
    prior.nodeUid !== prior.snapshot.reads?.[0]?.records?.[0]?.uid ||
    prior.snapshot.sourceHash !== input?.admitted?.sourceHash ||
    prior.snapshot.capabilityHash !== input?.admitted?.capabilityHash ||
    !same(prior.snapshot.slot, input?.slot)
  )
    return { state: "STOP", reasons: ["STOP_RECHECK_BINDING"], nodeUid: null };
  const previousUid = prior.nodeUid;
  const current = await acquireC1Evidence(input, producers, timing);
  if (current.state === "ADMITTED" && current.nodeUid !== previousUid)
    return { ...current, state: "REFUSED", reasons: ["NODE_UID_REPLACED"] };
  return current;
}

function localPath(path) {
  return (
    typeof path === "string" &&
    isAbsolute(path) &&
    !/^[\\/]{2}/.test(path) &&
    (process.platform !== "win32" || /^[A-Za-z]:[\\/]/.test(path))
  );
}
function inputFile(path) {
  need(localPath(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "STOP_INPUT_FILE");
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes.toString("utf8"));
  return { bytes, value, path: resolve(path) };
}
function writeNew(path, bytes, opened) {
  const fd = openSync(path, "wx", 0o600);
  opened();
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  need(readFileSync(path).equals(bytes), "STOP_OUTPUT_REREAD");
}

export function consumeCompleteEnvelope({ envelopeFile, admittedFile, custodyFile, outputs }) {
  let written = 0;
  try {
    const envelope = inputFile(envelopeFile),
      admitted = inputFile(admittedFile),
      custody = inputFile(custodyFile);
    need(
      object(custody.value) && Array.isArray(custody.value.inputs) && custody.value.inputs.length === 2,
      "STOP_INPUT_CUSTODY",
    );
    const expected = [envelope, admitted].map((f) => ({
      path: f.path,
      bytes: f.bytes.length,
      sha256: sha256(f.bytes),
    }));
    need(same(custody.value.inputs, expected), "STOP_INPUT_CUSTODY");
    need(
      same(custody.value.manifest, admitted.value.manifest) &&
        custody.value.externalManifestHash === admitted.value.externalManifestHash,
      "STOP_INPUT_CUSTODY",
    );
    const receipt = readTerminalEvidence(envelope.value, admitted.value);
    need(object(outputs) && same(Object.keys(outputs).sort(), ["envelope", "manifest", "receipt"]), "STOP_OUTPUT_PLAN");
    const paths = Object.values(outputs);
    need(
      paths.every(localPath) &&
        new Set(paths.map((p) => resolve(p))).size === 3 &&
        paths.every((p) => !existsSync(p)) &&
        paths.every((p) => ![envelope.path, admitted.path, custody.path].includes(resolve(p))),
      "STOP_OUTPUT_EXISTS",
    );
    // Reader refusal is still a receipt, not admission or partial success.
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    const envelopeBytes = envelope.bytes;
    const manifestBytes = Buffer.from(
      `${JSON.stringify(
        {
          inputs: [...expected, { path: custody.path, bytes: custody.bytes.length, sha256: sha256(custody.bytes) }],
          manifest: custody.value.manifest,
          externalManifestHash: custody.value.externalManifestHash,
          outputs: [
            { path: outputs.envelope, bytes: envelopeBytes.length, sha256: sha256(envelopeBytes) },
            { path: outputs.receipt, bytes: receiptBytes.length, sha256: sha256(receiptBytes) },
          ],
        },
        null,
        2,
      )}\n`,
    );
    for (const [path, bytes] of [
      [outputs.envelope, envelopeBytes],
      [outputs.manifest, manifestBytes],
      [outputs.receipt, receiptBytes],
    ]) {
      writeNew(path, bytes, () => {
        written++;
      });
    }
    return {
      state: receipt.bracketState === "STOP" ? "STOP" : "MATERIALIZED",
      receipt,
      outputHashes: { envelope: sha256(envelopeBytes), manifest: sha256(manifestBytes), receipt: sha256(receiptBytes) },
    };
  } catch {
    return {
      state: "STOP",
      reasons: [written ? "STOP_PARTIAL_MATERIALIZATION" : "STOP_FILE_CONSUMPTION"],
      partial: written > 0,
    };
  }
}

export function main(args) {
  const names = [
    "--envelope-file",
    "--admitted-file",
    "--custody-file",
    "--out-envelope",
    "--out-manifest",
    "--out-receipt",
  ];
  if (args.length !== names.length * 2 || names.some((name, i) => args[i * 2] !== name))
    return { state: "STOP", reasons: ["STOP_CLI_INPUTS"] };
  return consumeCompleteEnvelope({
    envelopeFile: args[1],
    admittedFile: args[3],
    custodyFile: args[5],
    outputs: { envelope: args[7], manifest: args[9], receipt: args[11] },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.state === "STOP" ? 1 : 0;
}
