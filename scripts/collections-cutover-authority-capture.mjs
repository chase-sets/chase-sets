#!/usr/bin/env node
// Read-only Collections cutover authority capture. One run captures one target into one
// `collections-cutover-provider-capture/v1` of counts, names, revisions and digests. Every provider read passes
// `admitCommand` and every database statement passes `admitStatement`; raw provider output stays in memory, and
// a read that cannot prove completeness becomes a governed unknown, never an empty set or 0.
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { containsFloor, databaseIdentityDigest, deriveFloor } from "./collections-anonymous-owner-redaction.mjs";
import {
  applyProviderCapture,
  PROVIDER_CAPTURE_FIELDS,
  PROVIDER_CAPTURE_SCHEMA_VERSION,
  TARGETS,
} from "./collections-cutover-authority-packet.mjs";
import { buildHelmHistoryArgs, buildHelmValuesArgs } from "./platform-kubernetes-deployment.mjs";

export const RECOVERY_COMMIT = "0d2c4764abac49958bea691b13d7d67df683a2f9";
export const WRITER_KEYS = Object.freeze(["DATABASE_URL_COLLECTIONS", "BOOTSTRAP_DATABASE_URL_COLLECTIONS"]);
export const KUBERNETES_LISTS = Object.freeze({
  rollouts: "/apis/argoproj.io/v1alpha1/rollouts",
  deployments: "/apis/apps/v1/deployments",
  replicasets: "/apis/apps/v1/replicasets",
  jobs: "/apis/batch/v1/jobs",
  cronjobs: "/apis/batch/v1/cronjobs",
  pods: "/api/v1/pods",
});
export const PAGE_LIMIT = 500;
export const MAX_PAGES = 200;
export const HELM_HISTORY_MAX = 256;
const REQUEST_TIMEOUT = "--request-timeout=60s";
const TERRAFORM_STATE_PULL = Object.freeze(["-chdir=infrastructure/digitalocean/platform", "state", "pull"]);
export const READ_ONLY_PROBE_SQL = "SHOW default_transaction_read_only";
// Filters only on columns every role can see: a hidden session must surface as a null backend_start, never vanish.
export const SESSION_ACTIVITY_SQL = `SELECT state, usename AS role, application_name AS application, backend_type,
  count(*)::int AS sessions, min(backend_start) AS oldest_backend_start,
  (count(*) - count(backend_start))::int AS hidden
FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
GROUP BY state, usename, application_name, backend_type`;

export class CaptureRefusal extends Error {}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const SHA40 = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const LIST_PATH = new RegExp(
  `^(?:${Object.values(KUBERNETES_LISTS).map(escapeRegExp).join("|")})\\?limit=${PAGE_LIMIT}(?:&continue=[A-Za-z0-9%._~-]+)?$`,
);
const sameArgs = (args, expected) =>
  args.length === expected.length && expected.every((value, index) => args[index] === value);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The closed provider allowlist: paged all-namespace lists, Helm history and values, Terraform state pull. */
export function admitCommand(program, args) {
  const admitted =
    Array.isArray(args) &&
    args.every((arg) => typeof arg === "string") &&
    ((program === "kubectl" && sameArgs(args, ["get", "--raw", args[2], REQUEST_TIMEOUT]) && LIST_PATH.test(args[2])) ||
      (program === "helm" && sameArgs(args, [...buildHelmHistoryArgs(), "--max", String(HELM_HISTORY_MAX)])) ||
      (program === "helm" &&
        /^[1-9][0-9]{0,8}$/.test(args[6] ?? "") &&
        sameArgs(args, buildHelmValuesArgs({ revision: Number(args[6]) }))) ||
      (program === "terraform" && sameArgs(args, TERRAFORM_STATE_PULL)));
  if (!admitted) throw new CaptureRefusal("command-refused");
}

/**
 * The closed read set, by exact text: the session's own probe and aggregate, the exported `observe()` statements
 * and a plain EXPLAIN of the count among them. Any other statement, SELECT or not, is refused.
 */
export function admitStatement(sql, countSql, observationSql) {
  const observed = Array.isArray(observationSql) ? observationSql : [];
  const admitted =
    sql === READ_ONLY_PROBE_SQL ||
    sql === SESSION_ACTIVITY_SQL ||
    observed.includes(sql) ||
    (observed.includes(countSql) && sql === `EXPLAIN (FORMAT JSON) ${countSql}`);
  if (!admitted) throw new CaptureRefusal("statement-refused");
}

export function commandFailure(error, stderr) {
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output-limit";
  if (error?.killed || error?.code === "ETIMEDOUT") return "timeout";
  const text = String(stderr ?? "");
  if (/\(Forbidden\)/.test(text)) return "forbidden";
  if (/\(NotFound\)/.test(text)) return "not-found";
  return "failed";
}

/** Runs one admitted provider command; stdout stays in memory and stderr only yields a closed reason. */
export function execFileRunner(execFileImpl = execFile) {
  return (program, args) =>
    new Promise((resolveRun) => {
      execFileImpl(
        program,
        args,
        { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) =>
          resolveRun(error ? { ok: false, reason: commandFailure(error, stderr) } : { ok: true, stdout }),
      );
    });
}

// Complete only when the final page carries no continue token and the items equal the first page plus its
// remainingItemCount; a 404 on the first page means the API server does not serve the resource type.
async function listResource(run, resource) {
  const items = [];
  let first;
  let token = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const next = token ? `&continue=${encodeURIComponent(token)}` : "";
    if (!/^[A-Za-z0-9%._~-]*$/.test(next.slice("&continue=".length))) return { status: "unknown", reason: "malformed" };
    const result = await run("kubectl", [
      "get",
      "--raw",
      `${KUBERNETES_LISTS[resource]}?limit=${PAGE_LIMIT}${next}`,
      REQUEST_TIMEOUT,
    ]);
    if (!result.ok) {
      return result.reason === "not-found" && page === 0
        ? { status: "notServed" }
        : { status: "unknown", reason: result.reason };
    }
    const body = parseJson(result.stdout);
    if (!isObject(body) || !Array.isArray(body.items)) return { status: "unknown", reason: "malformed" };
    first ??= body;
    items.push(...body.items);
    token = typeof body.metadata?.continue === "string" ? body.metadata.continue : "";
    if (!token) {
      const remaining = page === 0 ? (first.metadata?.remainingItemCount ?? 0) : first.metadata?.remainingItemCount;
      return Number.isSafeInteger(remaining) && items.length === first.items.length + remaining
        ? { status: "complete", items }
        : { status: "unknown", reason: "count-mismatch" };
    }
  }
  return { status: "unknown", reason: "page-bound" };
}

// Every retained revision with its `global.image.tag` commit: the chart appVersion is constant, the tag is not.
async function readHelmRevisions(run) {
  const history = await run("helm", [...buildHelmHistoryArgs(), "--max", String(HELM_HISTORY_MAX)]);
  if (!history.ok) return { status: "unknown", reason: history.reason };
  const entries = parseJson(history.stdout);
  if (
    !Array.isArray(entries) ||
    !entries.every((entry) => Number.isSafeInteger(entry?.revision) && typeof entry.status === "string")
  ) {
    return { status: "unknown", reason: "malformed" };
  }
  if (entries.length >= HELM_HISTORY_MAX) return { status: "unknown", reason: "max" };
  if (entries.some((entry) => entry.status.startsWith("pending-"))) return { status: "unknown", reason: "pending" };
  const revisions = [];
  for (const entry of [...entries].sort((left, right) => left.revision - right.revision)) {
    const values = await run("helm", buildHelmValuesArgs({ revision: entry.revision }));
    if (!values.ok) return { status: "unknown", reason: values.reason };
    const image = parseJson(values.stdout)?.global?.image;
    if (!SHA40.test(image?.tag ?? "")) return { status: "unknown", reason: "tag" };
    const digest = IMAGE_DIGEST.test(image?.digest ?? "") ? image.digest : null;
    revisions.push({ revision: entry.revision, status: entry.status, commit: image.tag, digest });
  }
  return { status: "complete", revisions };
}

async function readTerraformState(run) {
  const result = await run("terraform", [...TERRAFORM_STATE_PULL]);
  if (!result.ok) return { status: "unknown", reason: result.reason };
  const state = parseJson(result.stdout);
  return Number.isSafeInteger(state?.serial) && /^[0-9a-f-]{36}$/.test(state?.lineage ?? "")
    ? { status: "complete", serial: state.serial, lineage: state.lineage }
    : { status: "unknown", reason: "malformed" };
}

function guardedSession(database, countSql, observationSql, refusals) {
  return {
    query: async (sql, values) => {
      try {
        admitStatement(sql, countSql, observationSql);
      } catch (error) {
        refusals.push(error.message);
        throw error;
      }
      return database.query(sql, values);
    },
  };
}

async function attempt(read) {
  try {
    return await read();
  } catch {
    return { status: "unknown", reason: "failed" };
  }
}

// One default_transaction_read_only=on session: the redaction dryRun path, a plain EXPLAIN of its exported count
// and the pg_stat_activity aggregate. A writable session or a refused statement refuses the whole capture.
async function readDatabase({ database, redact, countSql, observationSql }) {
  if (!database) {
    const unavailable = { status: "unknown", reason: "connection-failed" };
    return { count: unavailable, plan: unavailable, sessions: unavailable };
  }
  const refusals = [];
  const session = guardedSession(database, countSql, observationSql, refusals);
  const readOnly = async () =>
    (await session.query(READ_ONLY_PROBE_SQL))?.rows?.[0]?.default_transaction_read_only === "on";
  const opened = await readOnly().catch(() => null);
  if (opened === null) {
    const failed = { status: "unknown", reason: "connection-failed" };
    return { count: failed, plan: failed, sessions: failed };
  }
  if (!opened) throw new CaptureRefusal("database-session-writable");
  const count = await attempt(async () => {
    const dry = await redact(session, { dryRun: true });
    return Number.isSafeInteger(dry?.before) && dry.codes?.length === 0
      ? { status: "complete", value: dry.before }
      : { status: "unknown", reason: "malformed" };
  });
  const plan = await attempt(async () => {
    const rows = (await session.query(`EXPLAIN (FORMAT JSON) ${countSql}`))?.rows;
    const value = rows?.[0]?.["QUERY PLAN"];
    return Array.isArray(value) ? { status: "complete", value } : { status: "unknown", reason: "malformed" };
  });
  const sessions = await attempt(async () => {
    const rows = (await session.query(SESSION_ACTIVITY_SQL))?.rows;
    return Array.isArray(rows) ? { status: "complete", rows } : { status: "unknown", reason: "malformed" };
  });
  if (refusals.length > 0) throw new CaptureRefusal("statement-refused");
  if ((await readOnly().catch(() => null)) === false) throw new CaptureRefusal("database-session-writable");
  return { count, plan, sessions };
}

const digestOf = (kind, value) => (typeof value === "string" ? sha256(`${kind}\u0000${value}`) : null);
const instantOf = (value) => (value instanceof Date || typeof value === "string" ? new Date(value) : null);

function sessionWriters(read) {
  if (read.status !== "complete") return read;
  const { rows } = read;
  if (rows.some((row) => row.hidden !== 0 || !Number.isFinite(instantOf(row.oldest_backend_start)?.getTime()))) {
    return { status: "unknown", reason: "hidden" };
  }
  const items = rows
    .map((row) => ({
      state: row.state,
      backendType: row.backend_type,
      roleDigest: digestOf("collections-session-role/v1", row.role),
      applicationDigest: digestOf("collections-session-application/v1", row.application),
      sessions: row.sessions,
      oldestBackendStart: instantOf(row.oldest_backend_start).toISOString(),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    .map((item, index) => ({ id: `session:${index + 1}`, ...item }));
  return { status: "complete", items };
}

function podSpecOf(resource, object) {
  if (resource === "pods") return object.spec;
  if (resource === "cronjobs") return object.spec?.jobTemplate?.spec?.template?.spec;
  return object.spec?.template?.spec;
}

const containersOf = (spec) =>
  ["initContainers", "containers", "ephemeralContainers"].flatMap((key) =>
    Array.isArray(spec?.[key]) ? spec[key] : [],
  );
const kubernetesName = (value) => (typeof value === "string" && /^[a-z0-9.-]{1,253}$/.test(value) ? value : "unnamed");

/** Names the writer keys and envFrom Secrets a pod spec references; env values are never read. */
export function writerReferences(spec) {
  const found = new Set();
  for (const container of containersOf(spec)) {
    for (const entry of Array.isArray(container?.env) ? container.env : []) {
      if (WRITER_KEYS.includes(entry?.name)) found.add(`env:${entry.name}`);
      const reference = entry?.valueFrom?.secretKeyRef;
      if (WRITER_KEYS.includes(reference?.key))
        found.add(`secretKeyRef:${kubernetesName(reference.name)}/${reference.key}`);
    }
    for (const source of Array.isArray(container?.envFrom) ? container.envFrom : []) {
      if (isObject(source?.secretRef)) found.add(`envFrom:secret/${kubernetesName(source.secretRef.name)}`);
    }
  }
  return [...found].sort();
}

const controllerKind = (object) =>
  (Array.isArray(object.metadata?.ownerReferences) ? object.metadata.ownerReferences : []).find(
    (owner) => owner?.controller === true,
  )?.kind;

// Pods controlled by a listed ReplicaSet or Job are covered by their owner; every other referencing pod is a writer.
function classify(resource, object) {
  const replicas = Number.isSafeInteger(object.spec?.replicas) ? object.spec.replicas : 1;
  if (resource === "rollouts" || resource === "deployments")
    return [replicas > 0 ? "serving" : "dormant", { replicas }];
  if (resource === "replicasets") {
    if (replicas > 0) return ["serving", { replicas }];
    return [["Deployment", "Rollout"].includes(controllerKind(object)) ? "rollback" : "dormant", { replicas }];
  }
  if (resource === "jobs") {
    const active = Number.isSafeInteger(object.status?.active) ? object.status.active : 0;
    return [object.spec?.suspend === true ? "suspended" : "job", { active }];
  }
  if (resource === "cronjobs") return [object.spec?.suspend === true ? "suspended" : "cronjob", {}];
  if (["ReplicaSet", "Job"].includes(controllerKind(object))) return null;
  const phase = ["Pending", "Running", "Succeeded", "Failed", "Unknown"].includes(object.status?.phase)
    ? object.status.phase
    : null;
  return ["serving", { phase }];
}

function commitsOf(images, digestCommits) {
  const commits = new Set();
  for (const image of images) {
    const tag = /:([0-9a-f]{40})(?:@sha256:[0-9a-f]{64})?$/.exec(image)?.[1];
    const digest = /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1];
    const commit = tag ?? (digest ? digestCommits.get(digest) : undefined);
    if (commit) commits.add(commit);
  }
  return [...commits].sort();
}

function kubernetesWriters(reads, context) {
  const writers = [];
  for (const resource of Object.keys(KUBERNETES_LISTS)) {
    const list = reads[resource];
    if (list.status !== "complete") continue;
    for (const object of list.items) {
      const spec = podSpecOf(resource, object);
      const references = writerReferences(spec);
      if (references.length === 0) continue;
      const classified = classify(resource, object);
      if (!classified) continue;
      const images = [...new Set(containersOf(spec).map((container) => container?.image))]
        .filter((image) => typeof image === "string")
        .sort();
      const revisions = commitsOf(images, context.digestCommits);
      writers.push({
        kind: classified[0],
        item: {
          id: `${resource}:${kubernetesName(object.metadata?.namespace)}/${kubernetesName(object.metadata?.name)}`,
          ...classified[1],
          references,
          images,
          revisions,
          containsFloor: revisions.length > 0 ? revisions.every(context.containsFloor) : null,
        },
      });
    }
  }
  return writers;
}

const POD_PHASES = new Set(["Pending", "Running", "Succeeded", "Failed", "Unknown"]);
const CONTAINER_SLOTS = Object.freeze([
  ["init", "initContainers", "initContainerStatuses"],
  ["regular", "containers", "containerStatuses"],
  ["ephemeral", "ephemeralContainers", "ephemeralContainerStatuses"],
]);
const SAFE_CONTAINER_REASON = /^[A-Za-z]{1,64}$/;

const podPhase = (pod) => (POD_PHASES.has(pod.status?.phase) ? pod.status.phase : "Unknown");

function containerState(status) {
  if (!isObject(status?.state)) return "absent";
  for (const state of ["waiting", "terminated", "running"]) {
    if (isObject(status.state[state])) return state;
  }
  return "absent";
}

function containerReason(status, state) {
  const reason = status?.state?.[state]?.reason;
  return typeof reason === "string" && SAFE_CONTAINER_REASON.test(reason) ? reason : "unnamed";
}

function unresolvedContainerAttributions(pod) {
  const attributions = [];
  for (const [slot, specKey, statusKey] of CONTAINER_SLOTS) {
    const containers = Array.isArray(pod.spec?.[specKey]) ? pod.spec[specKey] : [];
    const statuses = Array.isArray(pod.status?.[statusKey]) ? pod.status[statusKey] : [];
    for (const container of containers) {
      const status = statuses.find((entry) => entry?.name === container?.name);
      const imageID = typeof status?.imageID === "string" ? status.imageID : "";
      if (/sha256:[0-9a-f]{64}$/.test(imageID)) continue;
      const state = containerState(status);
      attributions.push({
        pod: `pods:${kubernetesName(pod.metadata?.namespace)}/${kubernetesName(pod.metadata?.name)}`,
        slot,
        phase: podPhase(pod),
        state,
        reason: containerReason(status, state),
      });
    }
  }
  return attributions;
}

function unresolvedImageReason(attributions) {
  const details = attributions
    .slice(0, 10)
    .map(({ pod, slot, phase, state, reason }) => `${pod} slot:${slot} phase:${phase} state:${state} reason:${reason}`)
    .join(", ");
  return `unresolved-image; total:${attributions.length}; ${details}`;
}

// Writer pods' resolved image digests over init, regular and ephemeral containers; a container without a resolved
// imageID is not a digest yet. Attribution is bounded and contains only allowlisted pod/container state metadata.
function imageDigests(pods) {
  if (pods.status !== "complete") return pods;
  const digests = new Set();
  const unresolved = [];
  for (const pod of pods.items) {
    if (writerReferences(pod.spec).length === 0) continue;
    const attributions = unresolvedContainerAttributions(pod);
    unresolved.push(...attributions);
    const statuses = CONTAINER_SLOTS.flatMap(([, , statusKey]) =>
      Array.isArray(pod.status?.[statusKey]) ? pod.status[statusKey] : [],
    );
    for (const container of containersOf(pod.spec)) {
      const digest = /sha256:[0-9a-f]{64}$/.exec(
        statuses.find((status) => status?.name === container?.name)?.imageID ?? "",
      );
      if (digest) digests.add(digest[0]);
    }
  }
  return unresolved.length > 0
    ? { status: "unknown", reason: "unresolved-image", attribution: unresolvedImageReason(unresolved) }
    : { status: "complete", value: [...digests].sort() };
}

const SOURCE_LABELS = {
  ...Object.fromEntries(
    Object.entries(KUBERNETES_LISTS).map(([resource, path]) => [
      resource,
      `kubectl get --raw ${path} (all namespaces)`,
    ]),
  ),
  helm: "helm history and get values chase-sets-platform",
  terraform: "terraform state pull",
  count: "redactLegacyAnonymousOwners dryRun: true observe() count",
  plan: "EXPLAIN (FORMAT JSON) of the exported legacy owner count",
  sessions: "pg_stat_activity aggregate",
  database: "DATABASE_URL_COLLECTIONS",
};
const HOST_ACTIONS = {
  forbidden: "grant the capture kubeconfig read on the refused source",
  timeout: "retry when the source answers inside the 60s bound",
  "count-mismatch": "retry; the list changed or withheld remainingItemCount while paging",
  "page-bound": `raise MAX_PAGES above ${MAX_PAGES} pages of ${PAGE_LIMIT}`,
  max: `raise HELM_HISTORY_MAX above ${HELM_HISTORY_MAX} retained revisions`,
  pending: "let the pending Helm operation settle",
  tag: "repair the revision whose global.image.tag is not a commit",
  "deployed-count": "settle the release on exactly one deployed Helm revision",
  hidden: "grant the capture role pg_read_all_stats so hidden sessions show backend_start",
  "unresolved-image": "retry once every writer container reports a resolved imageID",
  "connection-failed": "restore the Collections read-only session",
};

function unknownFrom(target, blocked) {
  return {
    status: "unknown",
    missingAuthority: blocked.map(([source, reason, detail]) => `${SOURCE_LABELS[source]}: ${detail ?? reason}`).join("; "),
    hostAction: `${[...new Set(blocked.map(([, reason]) => HOST_ACTIONS[reason] ?? "inspect the failing read"))].join("; ")}, then re-dispatch the capture for ${target}`,
  };
}

const concrete = (value, source) => ({ value, source });

function writerSetFor(target, kind, sources, reads, writers) {
  const blocked = sources
    .filter((source) => reads[source].status === "unknown")
    .map((source) => [source, reads[source].reason]);
  if (blocked.length > 0) return unknownFrom(target, blocked);
  const items = writers.filter((writer) => writer.kind === kind).map((writer) => writer.item);
  const coverage = Object.fromEntries(
    sources.map((source) => [
      source,
      reads[source].status === "notServed"
        ? { status: "notServed" }
        : { status: "complete", listed: (reads[source].items ?? reads[source].revisions).length },
    ]),
  );
  return {
    collected: items.length,
    authoritativeTotal: items.length,
    items,
    coverage,
    source: sources.map((source) => SOURCE_LABELS[source]).join(" + "),
  };
}

function demonstrated(target, sources, reads) {
  const blocked = sources
    .filter((source) => reads[source].status === "unknown")
    .map((source) => [source, reads[source].reason]);
  return blocked.length > 0
    ? unknownFrom(target, blocked)
    : concrete("demonstrated", `complete read-only ${sources.map((source) => SOURCE_LABELS[source]).join(" + ")}`);
}

/** Captures one target; `floor` is the runner's derived floor, never the recovery commit. */
export async function captureProviderAuthority(
  { target, floor, databaseUrl, head, now = () => new Date() },
  dependencies,
) {
  if (!TARGETS.includes(target)) throw new CaptureRefusal("target-invalid");
  if (!SHA40.test(floor ?? "")) throw new CaptureRefusal("floor-ambiguous");
  if (floor === RECOVERY_COMMIT) throw new CaptureRefusal("floor-is-recovery-commit");
  const capturedAt = now().toISOString();
  const run = async (program, args) => {
    admitCommand(program, args);
    return dependencies.run(program, args);
  };
  const ancestry = new Map();
  const contains = (revision) => {
    if (!ancestry.has(revision)) ancestry.set(revision, dependencies.containsFloor(floor, revision));
    return ancestry.get(revision);
  };

  const reads = {};
  for (const resource of Object.keys(KUBERNETES_LISTS)) reads[resource] = await listResource(run, resource);
  reads.helm = await readHelmRevisions(run);
  reads.terraform = await readTerraformState(run);
  let identity;
  try {
    identity = databaseIdentityDigest(target, databaseUrl);
  } catch {
    identity = null;
  }
  Object.assign(reads, await readDatabase(identity ? dependencies : {}));
  reads.sessions = sessionWriters(reads.sessions);

  const revisions = reads.helm.status === "complete" ? reads.helm.revisions : [];
  const digestCommits = new Map(revisions.filter((entry) => entry.digest).map((entry) => [entry.digest, entry.commit]));
  const writers = kubernetesWriters(reads, { digestCommits, containsFloor: contains });
  for (const entry of revisions.filter((revision) => revision.status !== "deployed")) {
    writers.push({
      kind: "rollback",
      item: {
        id: `helm:chase-sets-platform/${entry.revision}`,
        status: entry.status,
        revisions: [entry.commit],
        containsFloor: contains(entry.commit),
      },
    });
  }
  for (const item of reads.sessions.items ?? []) writers.push({ kind: "session", item });
  const deployed = revisions.filter((entry) => entry.status === "deployed");
  const digests = imageDigests(reads.pods);
  const helmField = (build) =>
    reads.helm.status === "complete" ? build() : unknownFrom(target, [["helm", reads.helm.reason]]);
  const terraformField = (key) =>
    reads.terraform.status === "complete"
      ? concrete(reads.terraform[key], `${SOURCE_LABELS.terraform} landing/${target}.tfstate ${key}`)
      : unknownFrom(target, [["terraform", reads.terraform.reason]]);
  const databaseField = (key, value) =>
    reads[key].status === "complete"
      ? concrete(value(reads[key]), SOURCE_LABELS[key])
      : unknownFrom(target, [[key, reads[key].reason]]);

  const fields = {
    environment: concrete(target, "workflow input target, bound to the job environment of the same name"),
    databaseIdentityDigest: identity
      ? concrete(identity, "databaseIdentityDigest over DATABASE_URL_COLLECTIONS host, port and database")
      : unknownFrom(target, [["database", "malformed"]]),
    terraformStateSerial: terraformField("serial"),
    terraformStateLineage: terraformField("lineage"),
    releaseCommit: helmField(() =>
      deployed.length === 1
        ? concrete(deployed[0].commit, `global.image.tag of deployed Helm revision ${deployed[0].revision}`)
        : unknownFrom(target, [["helm", "deployed-count"]]),
    ),
    imageDigests:
      digests.status === "complete"
        ? concrete(
            digests.value,
            "imageID in status.initContainerStatuses, containerStatuses and ephemeralContainerStatuses of writer pods",
          )
        : unknownFrom(target, [["pods", digests.reason, digests.attribution]]),
    "writers.serving": writerSetFor(
      target,
      "serving",
      ["rollouts", "deployments", "replicasets", "pods"],
      reads,
      writers,
    ),
    "writers.suspended": writerSetFor(target, "suspended", ["jobs", "cronjobs"], reads, writers),
    "writers.dormant": writerSetFor(target, "dormant", ["rollouts", "deployments", "replicasets"], reads, writers),
    "writers.rollback": writerSetFor(target, "rollback", ["replicasets", "helm"], reads, writers),
    "writers.job": writerSetFor(target, "job", ["jobs"], reads, writers),
    "writers.cronjob": writerSetFor(target, "cronjob", ["cronjobs"], reads, writers),
    "writers.session": writerSetFor(target, "session", ["sessions"], reads, writers),
    "gates.rollout.observeAuthority": demonstrated(target, ["rollouts", "deployments", "replicasets"], reads),
    "gates.traffic.observeAuthority": demonstrated(target, ["pods"], reads),
    "gates.job.observeAuthority": demonstrated(target, ["jobs"], reads),
    "gates.cronjob.observeAuthority": demonstrated(target, ["cronjobs"], reads),
    "gates.rollback-floor.observeAuthority": demonstrated(target, ["helm"], reads),
    "gates.credential-session-fence.observeAuthority": demonstrated(target, ["sessions"], reads),
    deployedCommitAncestry: helmField(() =>
      concrete(
        {
          floor,
          revisions: revisions.map((entry) => ({ ...entry, containsFloor: contains(entry.commit) })),
        },
        "git merge-base --is-ancestor of each Helm revision's global.image.tag against the derived floor",
      ),
    ),
    legacyRawRowCount: databaseField("count", (read) => read.value),
    legacyCountQueryPlan: databaseField("plan", (read) => ({
      statementSha256: sha256(dependencies.countSql ?? ""),
      plan: read.value,
    })),
  };
  return { schemaVersion: PROVIDER_CAPTURE_SCHEMA_VERSION, target, capturedAt, head, codes: [], fields };
}

/** The job-side packet: the derived floor and its first-parent commit time stand in for the activation merge. */
export function jobPacket(floor, mergedAt) {
  const activationMerge = { commit: floor, mergedAt, source: "git first-parent floor commit" };
  return {
    writerAuthority: { schemaVersion: "collections-writer-authority/v1", activationMerge, targets: {} },
    authorityMatrix: { schemaVersion: "collections-cutover-authority-matrix/v1", targets: {} },
    runnerBinding: {
      schemaVersion: "collections-redaction-runner-binding/v1",
      recoveryCommit: RECOVERY_COMMIT,
      floor: { status: "derived", commit: floor, source: "deriveFloor" },
      targets: {},
    },
  };
}

export const missingFieldCount = (capture) =>
  PROVIDER_CAPTURE_FIELDS.filter((name) => {
    const value = capture?.fields?.[name];
    return !isObject(value) || value.status === "unknown";
  }).length;

const option = (argv, name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

/** Writes exactly one capture (a failure writes one with codes) and fails on any codes or apply errors. */
export async function runCapture({ argv, env, dependencies, io }) {
  const target = option(argv, "--target");
  const out = option(argv, "--out");
  const startedAt = new Date().toISOString();
  let capture;
  let packet = null;
  try {
    if (!TARGETS.includes(target)) throw new CaptureRefusal("target-invalid");
    if (typeof out !== "string" || out.length === 0) throw new CaptureRefusal("output-required");
    const floor = dependencies.deriveFloor();
    packet = jobPacket(floor, dependencies.floorCommittedAt(floor));
    capture = await captureProviderAuthority(
      { target, floor, databaseUrl: env.DATABASE_URL_COLLECTIONS, head: env.GITHUB_SHA },
      dependencies,
    );
  } catch (error) {
    const code =
      error instanceof CaptureRefusal || error?.message === "floor-ambiguous" ? error.message : "capture-failed";
    capture = {
      schemaVersion: PROVIDER_CAPTURE_SCHEMA_VERSION,
      target: TARGETS.includes(target) ? target : null,
      capturedAt: startedAt,
      head: SHA40.test(env.GITHUB_SHA ?? "") ? env.GITHUB_SHA : null,
      codes: [code],
      fields: {},
    };
  }
  const check = applyProviderCapture(packet, capture);
  const verdict = check.verdict;
  const missing = missingFieldCount(capture);
  if (typeof out === "string" && out.length > 0) {
    await io.mkdir(dirname(out), { recursive: true });
    await io.writeFile(out, `${JSON.stringify(capture, null, 2)}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    await io.appendFile(
      env.GITHUB_STEP_SUMMARY,
      `## Collections cutover authority capture\n\n- Verdict: ${verdict}\n- Missing: ${missing}\n`,
    );
  }
  io.log(JSON.stringify({ verdict, missing }));
  if (capture.codes.length > 0 || check.errors.length > 0) {
    io.error(JSON.stringify({ codes: capture.codes, errors: check.errors }));
    return 1;
  }
  return 0;
}

async function main() {
  const root = process.cwd();
  const { register } = await import("tsx/esm/api");
  const unregister = register();
  let client;
  try {
    const { default: pg } = await import("pg");
    const { normalizePgPoolConnectionString, resolvePgPoolSslConfig } =
      await import("../infrastructure/event-core-postgres/index.ts");
    const { redactLegacyAnonymousOwners, legacyAnonymousOwnerCountSql, anonymousOwnerObservationSql } =
      await import("../bounded-contexts/collections/features/saved-lists/api/anonymous-owner-redaction.ts");
    let database = null;
    try {
      const connectionString = normalizePgPoolConnectionString(process.env.DATABASE_URL_COLLECTIONS ?? "");
      client = new pg.Client({
        connectionString,
        ssl: resolvePgPoolSslConfig(connectionString),
        options: "-c default_transaction_read_only=on",
        connectionTimeoutMillis: 15_000,
        statement_timeout: 30_000,
        query_timeout: 45_000,
      });
      client.on("error", () => {});
      await client.connect();
      database = client;
    } catch {
      database = null;
    }
    process.exitCode = await runCapture({
      argv: process.argv.slice(2),
      env: process.env,
      io: { mkdir, writeFile, appendFile, log: console.log, error: console.error },
      dependencies: {
        run: execFileRunner(),
        database,
        redact: redactLegacyAnonymousOwners,
        countSql: legacyAnonymousOwnerCountSql,
        observationSql: anonymousOwnerObservationSql,
        deriveFloor: () => deriveFloor(root),
        containsFloor: (floor, revision) => containsFloor(root, floor, revision),
        floorCommittedAt: (floor) =>
          execFileSync("git", ["-C", root, "log", "-1", "--format=%cI", floor], {
            encoding: "utf8",
            timeout: 15_000,
            stdio: ["ignore", "pipe", "pipe"],
          }).trim(),
      },
    });
  } finally {
    if (client) await client.end().catch(() => {});
    unregister();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error(JSON.stringify({ code: "capture-failed" }));
    process.exitCode = 1;
  });
}
