#!/usr/bin/env node
// Read-only Collections cutover authority capture. One run captures one target into one
// `collections-cutover-provider-capture/v1` of counts, names, revisions and digests. Every provider read passes
// `admitCommand`, every GitHub read passes `admitRequest`, every direct statement passes `admitStatement` and every
// pooled statement passes `admitPooledStatement`; raw provider output stays in memory, and a read that cannot prove
// completeness becomes a governed unknown, never an empty set or 0. The capture never ends, signals or disables a
// session, pool or user: a backend it cannot attribute stays `unknown`.
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { containsFloor, databaseIdentityDigest, deriveFloor } from "./collections-anonymous-owner-redaction.mjs";
import {
  applyProviderCapture,
  PROVIDER_CAPTURE_FIELDS,
  PROVIDER_CAPTURE_SCHEMA_VERSION,
  TARGETS,
} from "./collections-cutover-authority-packet.mjs";
import { buildHelmHistoryArgs, buildHelmValuesArgs } from "./platform-kubernetes-deployment.mjs";
import { databaseUrlsFromTerraformState } from "./terraform-state-database-urls.mjs";

export const RECOVERY_COMMIT = "0d2c4764abac49958bea691b13d7d67df683a2f9";
export const WRITER_KEYS = Object.freeze(["DATABASE_URL_COLLECTIONS", "BOOTSTRAP_DATABASE_URL_COLLECTIONS"]);
// The runtime key carries the pooled URL wherever a pool serves it; the bootstrap key is always the direct URL
// (`platform-kubernetes-secret.mjs` builds BOOTSTRAP_DATABASE_URL_* with directUrlFor).
const [POOLED_CREDENTIAL, BOOTSTRAP_CREDENTIAL] = WRITER_KEYS;
export const POOL_CONTEXT = "collections";
export const POOL_NAME = "collections-runtime";
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
export const SESSION_ROW_CAP = 256;
// Filters only on columns every role can see: a hidden session must surface as a null backend_start, never vanish.
const SESSION_SCOPE = "FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()";
// The independent total, read before and after the rows. It also names the capture's own backend, so a census that
// lists that backend is refused rather than trusted.
export const SESSION_TOTAL_SQL = `SELECT pg_backend_pid() AS self_pid, count(*)::int AS total ${SESSION_SCOPE}`;
// One bounded row per other backend; the row past the cap proves an overflow instead of silently truncating.
export const SESSION_ROWS_SQL = `SELECT pid, backend_start, state, backend_type, usename AS role,
  application_name AS application, host(client_addr) AS client_address
${SESSION_SCOPE} ORDER BY pid LIMIT ${SESSION_ROW_CAP + 1}`;
// One read-only transaction through the pooled URL names the server backend PgBouncer assigned to it.
export const POOLED_READ_SQL = Object.freeze([
  "BEGIN READ ONLY",
  `SELECT pg_backend_pid() AS pid, current_setting('transaction_read_only') AS read_only,
  (SELECT backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS backend_start`,
  "ROLLBACK",
]);
const GITHUB_API = "https://api.github.com";
export const RUN_PAGE_LIMIT = 100;
export const MAX_RUN_PAGES = 10;
// GitHub re-runs a workflow run for up to 30 days after it was created; one more day covers a rerun still executing.
export const HOLDER_RUN_WINDOW_DAYS = 31;
const CAPTURE_WORKFLOW = ".github/workflows/collections-cutover-authority-capture.yml";
const EXPORT_ACTION = "./.github/actions/export-managed-postgres-authority";

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
 * The closed read set, by exact text: the session's own probe, the backend census and its total, the exported
 * `observe()` statements and a plain EXPLAIN of the count among them. Any other statement, SELECT or not, is refused.
 */
export function admitStatement(sql, countSql, observationSql) {
  const observed = Array.isArray(observationSql) ? observationSql : [];
  const admitted =
    sql === READ_ONLY_PROBE_SQL ||
    sql === SESSION_TOTAL_SQL ||
    sql === SESSION_ROWS_SQL ||
    observed.includes(sql) ||
    (observed.includes(countSql) && sql === `EXPLAIN (FORMAT JSON) ${countSql}`);
  if (!admitted) throw new CaptureRefusal("statement-refused");
}

/** The pooled session's closed read set: one read-only transaction that names its own backend. */
export function admitPooledStatement(sql) {
  if (!POOLED_READ_SQL.includes(sql)) throw new CaptureRefusal("statement-refused");
}

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const RUNS_PATH =
  /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/[A-Za-z0-9_.-]{1,100}\.ya?ml\/runs\?per_page=100&created=%3E%3D\d{4}-\d{2}-\d{2}&page=([1-9][0-9]?)$/;
const JOBS_PATH =
  /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/[1-9][0-9]{0,19}\/attempts\/[1-9][0-9]{0,3}\/jobs\?per_page=100$/;

/** The closed GitHub read set: one repository's workflow run pages inside the page bound and run-attempt job lists. */
export function admitRequest(url, repository) {
  const path = typeof url === "string" && url.startsWith(`${GITHUB_API}/`) ? url.slice(GITHUB_API.length) : "";
  const runs = RUNS_PATH.exec(path);
  const jobs = JOBS_PATH.exec(path);
  const admitted =
    REPOSITORY.test(repository ?? "") &&
    ((runs !== null && runs[1] === repository && Number(runs[2]) <= MAX_RUN_PAGES) ||
      (jobs !== null && jobs[1] === repository));
  if (!admitted) throw new CaptureRefusal("request-refused");
}

const GITHUB_HEADERS = Object.freeze({
  accept: "application/vnd.github+json",
  "user-agent": "chase-sets-collections-cutover-authority-capture",
  "x-github-api-version": "2022-11-28",
});

/** Runs one admitted, unauthenticated GitHub GET; the body stays in memory and a failure yields a closed reason. */
export function githubReadRunner(fetchImpl = globalThis.fetch) {
  return async (url) => {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: GITHUB_HEADERS,
        signal: AbortSignal.timeout(60_000),
      });
      if (
        response.status === 429 ||
        (response.status === 403 && response.headers?.get?.("x-ratelimit-remaining") === "0")
      )
        return { ok: false, reason: "rate-limited" };
      if (response.status === 403) return { ok: false, reason: "github-forbidden" };
      if (response.status === 404) return { ok: false, reason: "not-found" };
      if (!response.ok) return { ok: false, reason: "failed" };
      const stdout = await response.text();
      return stdout.length > 16 * 1024 * 1024 ? { ok: false, reason: "output-limit" } : { ok: true, stdout };
    } catch (error) {
      return { ok: false, reason: error?.name === "TimeoutError" ? "timeout" : "failed" };
    }
  };
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

// The parsed state stays in this run's memory for the pool identity and is never written anywhere.
async function readTerraformState(run) {
  const result = await run("terraform", [...TERRAFORM_STATE_PULL]);
  if (!result.ok) return { read: { status: "unknown", reason: result.reason } };
  const state = parseJson(result.stdout);
  return Number.isSafeInteger(state?.serial) && /^[0-9a-f-]{36}$/.test(state?.lineage ?? "")
    ? { read: { status: "complete", serial: state.serial, lineage: state.lineage }, state }
    : { read: { status: "unknown", reason: "malformed" } };
}

const ROLE_DIGEST = "collections-session-role/v1";
const APPLICATION_DIGEST = "collections-session-application/v1";
const CLIENT_ADDRESS_DIGEST = "collections-session-client-address/v1";
const POOL_HOST_DIGEST = "collections-pool-host/v1";

/**
 * The Collections pool's allowlisted identity (context, name, mode, size, host and user digests) and its pooled URL,
 * both from the state already pulled. The URL exists only to open the pooled read and is never serialized.
 */
function collectionsPool(pulled, target, caPath) {
  if (pulled.read.status !== "complete")
    return { identity: { status: "unknown", blocked: [["terraform", pulled.read.reason]] } };
  const resources = Array.isArray(pulled.state.resources) ? pulled.state.resources : [];
  const instances = (type) =>
    resources
      .filter((resource) => resource?.type === type && resource?.name === "contexts")
      .flatMap((resource) => (Array.isArray(resource.instances) ? resource.instances : []))
      .filter((instance) => instance?.index_key === POOL_CONTEXT);
  const pools = instances("digitalocean_database_connection_pool");
  const users = instances("digitalocean_database_user");
  const pool = pools.length === 1 ? pools[0].attributes : undefined;
  const user = pool?.user || (users.length === 1 ? users[0].attributes?.name : undefined);
  if (
    pool?.name !== POOL_NAME ||
    pool.mode !== "transaction" ||
    !Number.isSafeInteger(pool.size) ||
    pool.size < 1 ||
    typeof pool.host !== "string" ||
    pool.host.length === 0 ||
    typeof user !== "string" ||
    user.length === 0
  ) {
    return { identity: { status: "unknown", blocked: [["pool", "pool-state"]] } };
  }
  let url = null;
  if (typeof caPath === "string" && caPath.length > 0) {
    try {
      url = databaseUrlsFromTerraformState(pulled.state, {
        contexts: [POOL_CONTEXT],
        environmentName: target,
        connectionMode: "pooled",
        selectionMode: "pooled-only",
        caPath,
      })[0]?.url;
    } catch {
      url = null;
    }
  }
  return {
    identity: {
      status: "complete",
      value: {
        context: POOL_CONTEXT,
        name: POOL_NAME,
        mode: "transaction",
        size: pool.size,
        hostDigest: digestOf(POOL_HOST_DIGEST, pool.host.toLowerCase()),
        userDigest: digestOf(ROLE_DIGEST, user),
      },
    },
    url: url ?? null,
    unavailable: typeof caPath === "string" && caPath.length > 0 ? "pool-state" : "ca-missing",
  };
}

// The same-run pooled read. A writable pooled transaction refuses the whole capture like a writable direct session.
async function readPooledBackend(openPooled, pool) {
  if (pool.identity.status !== "complete") return { status: "unknown", reason: "pool-state" };
  if (!pool.url) return { status: "unknown", reason: pool.unavailable };
  if (typeof openPooled !== "function") return { status: "unknown", reason: "unavailable" };
  let client;
  try {
    client = await openPooled(pool.url);
  } catch {
    return { status: "unknown", reason: "pooled-connection-failed" };
  }
  const query = async (sql) => {
    admitPooledStatement(sql);
    return client.query(sql);
  };
  try {
    await query(POOLED_READ_SQL[0]);
    const row = (await query(POOLED_READ_SQL[1]))?.rows?.[0];
    await query(POOLED_READ_SQL[2]);
    if (row?.read_only !== "on") throw new CaptureRefusal("database-session-writable");
    const start = instantOf(row.backend_start);
    return Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isFinite(start?.getTime())
      ? { status: "complete", pid: row.pid, backendStart: start.toISOString() }
      : { status: "unknown", reason: "malformed" };
  } catch (error) {
    if (error instanceof CaptureRefusal) throw error;
    return { status: "unknown", reason: "failed" };
  } finally {
    await Promise.resolve(client?.end?.()).catch(() => {});
  }
}

async function readSessionCensus(session) {
  const before = (await session.query(SESSION_TOTAL_SQL))?.rows?.[0];
  const rows = (await session.query(SESSION_ROWS_SQL))?.rows;
  const after = (await session.query(SESSION_TOTAL_SQL))?.rows?.[0];
  const totals = [before, after];
  if (
    !Array.isArray(rows) ||
    !totals.every((total) => Number.isSafeInteger(total?.total) && Number.isSafeInteger(total?.self_pid)) ||
    before.self_pid !== after.self_pid
  ) {
    return { status: "unknown", reason: "malformed" };
  }
  return { status: "complete", self: before.self_pid, totals: [before.total, after.total], rows };
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
// and the per-backend census, taken after the pooled read so the backend that read used is listed. A writable
// session or a refused statement refuses the whole capture.
async function readDatabase({ database, redact, countSql, observationSql }, readPooled) {
  const notRead = { status: "unknown", reason: "connection-failed" };
  if (!database) return { count: notRead, plan: notRead, sessions: notRead, pooled: notRead };
  const refusals = [];
  const session = guardedSession(database, countSql, observationSql, refusals);
  const readOnly = async () =>
    (await session.query(READ_ONLY_PROBE_SQL))?.rows?.[0]?.default_transaction_read_only === "on";
  const opened = await readOnly().catch(() => null);
  if (opened === null) return { count: notRead, plan: notRead, sessions: notRead, pooled: notRead };
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
  const pooled = await readPooled();
  const sessions = await attempt(() => readSessionCensus(session));
  if (refusals.length > 0) throw new CaptureRefusal("statement-refused");
  if ((await readOnly().catch(() => null)) === false) throw new CaptureRefusal("database-session-writable");
  return { count, plan, sessions, pooled };
}

const digestOf = (kind, value) => (typeof value === "string" ? sha256(`${kind}\u0000${value}`) : null);
const instantOf = (value) => (value instanceof Date || typeof value === "string" ? new Date(value) : null);
const SESSION_STATES = new Set([
  "active",
  "idle",
  "idle in transaction",
  "idle in transaction (aborted)",
  "fastpath function call",
  "disabled",
]);
const SAFE_BACKEND_TYPE = /^[a-z][a-z0-9 _-]{0,63}$/;

// Complete only when both totals agree, the rows equal them inside the cap, each backend is listed once, the
// capture's own backend is absent and every backend_start is visible. Raw role, application and address values
// are digested here and dropped; no other column is ever copied.
function backendCensus(read) {
  if (read.status !== "complete") return read;
  const { self, totals, rows } = read;
  const refused = (reason) => ({ status: "unknown", reason });
  if (rows.length > SESSION_ROW_CAP) return refused("session-cap");
  if (totals[0] !== totals[1]) return refused("census-unstable");
  if (rows.length !== totals[0]) return refused("census-mismatch");
  if (!rows.every((row) => Number.isSafeInteger(row?.pid) && row.pid > 0)) return refused("malformed");
  if (new Set(rows.map((row) => row.pid)).size !== rows.length) return refused("census-duplicate");
  if (rows.some((row) => row.pid === self)) return refused("census-self");
  if (rows.some((row) => !Number.isFinite(instantOf(row.backend_start)?.getTime()))) return refused("hidden");
  const items = rows
    .map((row) => ({
      id: `backend:${row.pid}`,
      pid: row.pid,
      backendStart: instantOf(row.backend_start).toISOString(),
      state: SESSION_STATES.has(row.state) ? row.state : null,
      backendType: SAFE_BACKEND_TYPE.test(row.backend_type ?? "") ? row.backend_type : "unnamed",
      roleDigest: digestOf(ROLE_DIGEST, row.role),
      applicationDigest: digestOf(APPLICATION_DIGEST, row.application),
      clientAddressDigest: digestOf(CLIENT_ADDRESS_DIGEST, row.client_address),
    }))
    .sort((left, right) => left.pid - right.pid);
  return { status: "complete", items };
}

/**
 * `pooler` needs the same-run pooled read's PID and backend_start on this row, the pool user's role digest and a
 * complete holder census. A matching role, address, Terraform endpoint or blank application alone stays `unknown`,
 * as does any backend once the pooled read is missing or the pool recycled its backend. A pooler row carries the
 * holders' revisions and their floor ancestry; an unknown row carries none.
 */
function classifySessions(items, pool, pooled, holders) {
  return items.map((item) => {
    const poolMatch = {
      pid: pooled.status === "complete" ? item.pid === pooled.pid : null,
      backendStart: pooled.status === "complete" ? item.backendStart === pooled.backendStart : null,
      role: pool.status === "complete" ? item.roleDigest === pool.value.userDigest : null,
    };
    const pooler = holders.status === "complete" && Object.values(poolMatch).every((match) => match === true);
    return {
      ...item,
      poolMatch,
      classification: pooler ? "pooler" : "unknown",
      revisions: pooler ? holders.revisions : [],
      containsFloor: pooler ? holders.containsFloor : null,
    };
  });
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

/**
 * The subset of `writerReferences` that can carry the pooled URL: the runtime Secret key, the runtime env name unless
 * it is sourced from the bootstrap key, and whole-Secret envFrom. Bootstrap-only consumers hold the direct URL.
 */
export function pooledCredentialReferences(spec) {
  const found = new Set();
  for (const container of containersOf(spec)) {
    for (const entry of Array.isArray(container?.env) ? container.env : []) {
      const reference = entry?.valueFrom?.secretKeyRef;
      if (reference?.key === POOLED_CREDENTIAL)
        found.add(`secretKeyRef:${kubernetesName(reference.name)}/${POOLED_CREDENTIAL}`);
      else if (entry?.name === POOLED_CREDENTIAL && reference?.key !== BOOTSTRAP_CREDENTIAL)
        found.add(`env:${POOLED_CREDENTIAL}`);
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
        pooledReferences: pooledCredentialReferences(spec),
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

/** The workflow files at the checked-out capture head, read whole for the pooled-step census. */
export function workflowFiles(root) {
  const directory = join(root, ".github", "workflows");
  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({ path: `.github/workflows/${name}`, text: readFileSync(join(directory, name), "utf8") }));
}

const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]{1,100}\.ya?ml$/;

async function readWorkflows(read) {
  if (typeof read !== "function") return { status: "unknown", blocked: [["workflows", "unavailable"]] };
  let files;
  try {
    files = await read();
  } catch {
    return { status: "unknown", blocked: [["workflows", "failed"]] };
  }
  if (!Array.isArray(files) || files.length === 0) return { status: "unknown", blocked: [["workflows", "malformed"]] };
  const workflows = [];
  for (const file of files) {
    if (!WORKFLOW_PATH.test(file?.path ?? "") || typeof file.text !== "string")
      return { status: "unknown", blocked: [["workflows", "malformed"]] };
    try {
      workflows.push({ path: file.path, document: parseYaml(file.text) });
    } catch {
      return { status: "unknown", blocked: [["workflows", "workflow-unparsed", `workflow-unparsed: ${file.path}`]] };
    }
  }
  if (new Set(workflows.map((workflow) => workflow.path)).size !== workflows.length)
    return { status: "unknown", blocked: [["workflows", "census-duplicate"]] };
  workflows.sort((left, right) => (left.path < right.path ? -1 : 1));
  return { status: "complete", workflows };
}

const ENV_REFERENCE = /^\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
// The holder workflows' target expression: a dispatch selects its input, every other event takes the literal default.
const DISPATCH_DEFAULT =
  /^\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.environment\s*\|\|\s*'(staging|production)'\s*\}\}$/;
const unresolvedText = (value) => value.includes("$");
// Blank mode and contexts take the exporters' own defaults (`inputs.connection-mode || 'direct'`, contexts `all`).
const modeOf = (value) => {
  const text = String(value ?? "").trim() || "direct";
  return unresolvedText(text) ? "unresolved" : text;
};
function contextsOf(value) {
  const text = String(value ?? "").trim() || "all";
  if (unresolvedText(text)) return "unresolved";
  if (text === "all") return "all";
  return [
    ...new Set(
      text
        .split(",")
        .map((context) => context.trim())
        .filter(Boolean),
    ),
  ]
    .sort()
    .join(",");
}
const holdsCollections = (contexts) =>
  contexts === "all" || contexts === "unresolved" || contexts.split(",").includes(POOL_CONTEXT);
function cliFlag(script, name) {
  return new RegExp(`${name}(?:=|[ \\t]+)("?)([^\\s"]+)\\1`).exec(script)?.[2];
}

// A literal environment, the dispatch-default expression (one `env.` indirection allowed) or unresolved.
function targetRule(value, job, workflow) {
  let text = typeof value === "string" ? value.trim() : "";
  const reference = ENV_REFERENCE.exec(text);
  if (reference) text = String(job?.env?.[reference[1]] ?? workflow?.env?.[reference[1]] ?? "").trim();
  if (TARGETS.includes(text)) return { fixed: text };
  const dispatch = DISPATCH_DEFAULT.exec(text);
  return dispatch ? { otherwise: dispatch[1] } : {};
}
const stepTarget = (rule) => rule.fixed ?? (rule.otherwise ? "selectable" : "unresolved");
const runTarget = (rule, event) =>
  rule.fixed ?? (rule.otherwise ? (event === "workflow_dispatch" ? "selectable" : rule.otherwise) : "unresolved");
const reaches = (value, target) => value === target || value === "selectable" || value === "unresolved";

/**
 * One step's pooled-credential acquisition, or null when it provably exports none: the export action in pooled
 * url-export mode, the Kubernetes Secret exporter with pooled query URLs, or a pooled Terraform state export. An
 * expression or shell variable in its mode, contexts or target keeps the step a holder.
 */
function pooledAcquisition(step, job, workflow) {
  if (step?.uses === EXPORT_ACTION) {
    const input = isObject(step.with) ? step.with : {};
    const mode = modeOf(input["connection-mode"]);
    if (mode === "direct" || String(input.mode ?? "url-export").trim() === "trust-only-kubernetes-secret") return null;
    return {
      acquisition: "export-managed-postgres-authority",
      mode,
      contexts: contextsOf(input.contexts),
      rule: targetRule(input.environment, job, workflow),
    };
  }
  const script = typeof step?.run === "string" ? step.run : "";
  // A flag the script omits falls back to the env the step inherits, as each exporter's own option parsing does.
  const flagOrEnv = (flag, name) =>
    cliFlag(script, flag) ?? step.env?.[name] ?? job?.env?.[name] ?? workflow?.env?.[name];
  if (/platform-kubernetes-secret\.mjs/.test(script) && /--export-database-urls/.test(script)) {
    const mode = modeOf(cliFlag(script, "--query-connection-mode"));
    if (mode === "direct") return null;
    return {
      acquisition: "platform-kubernetes-secret",
      mode,
      contexts: "all",
      rule: targetRule(flagOrEnv("--database-environment", "DEPLOYMENT_ENVIRONMENT"), job, workflow),
    };
  }
  if (/terraform-state-database-urls\.mjs/.test(script)) {
    if (cliFlag(script, "--mode") === "trust-only-kubernetes-secret") return null;
    const mode = modeOf(flagOrEnv("--connection-mode", "TERRAFORM_STATE_DATABASE_URL_CONNECTION_MODE"));
    if (mode === "direct") return null;
    return {
      acquisition: "terraform-state-database-urls",
      mode,
      contexts: contextsOf(flagOrEnv("--contexts", "TERRAFORM_STATE_DATABASE_URL_CONTEXTS")),
      rule: targetRule(flagOrEnv("--environment", "DEPLOYMENT_ENVIRONMENT") ?? "staging", job, workflow),
    };
  }
  return null;
}

const triggersOf = (workflow) => {
  const on = workflow?.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on;
  return isObject(on) ? Object.keys(on) : [];
};

function pooledSteps(workflows) {
  const steps = [];
  for (const { path, document } of workflows) {
    for (const [job, definition] of Object.entries(isObject(document?.jobs) ? document.jobs : {})) {
      (Array.isArray(definition?.steps) ? definition.steps : []).forEach((step, index) => {
        const found = pooledAcquisition(step, definition, document);
        if (!found) return;
        steps.push({
          workflow: path,
          job,
          jobName: typeof definition.name === "string" ? definition.name : job,
          step: index + 1,
          reusable: triggersOf(document).includes("workflow_call"),
          ...found,
        });
      });
    }
  }
  return steps;
}

// Every run created inside the rerun window; the pages must reconcile with one stable total_count.
async function listWorkflowRuns(request, repository, workflow, since) {
  const file = workflow.slice(".github/workflows/".length);
  const runs = [];
  let total;
  for (let page = 1; page <= MAX_RUN_PAGES; page++) {
    const result = await request(
      `${GITHUB_API}/repos/${repository}/actions/workflows/${file}/runs?per_page=${RUN_PAGE_LIMIT}&created=%3E%3D${since}&page=${page}`,
    );
    if (!result.ok)
      return { status: "unknown", reason: result.reason === "not-found" ? "workflow-unregistered" : result.reason };
    const body = parseJson(result.stdout);
    if (!Number.isSafeInteger(body?.total_count) || !Array.isArray(body.workflow_runs))
      return { status: "unknown", reason: "malformed" };
    total ??= body.total_count;
    if (body.total_count !== total) return { status: "unknown", reason: "census-unstable" };
    if (total > RUN_PAGE_LIMIT * MAX_RUN_PAGES) return { status: "unknown", reason: "run-page-bound" };
    runs.push(...body.workflow_runs);
    if (runs.length >= total || body.workflow_runs.length < RUN_PAGE_LIMIT) break;
  }
  if (runs.length !== total) return { status: "unknown", reason: "census-mismatch" };
  const valid = (run) =>
    Number.isSafeInteger(run?.id) &&
    run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0 &&
    typeof run.status === "string" &&
    typeof run.event === "string";
  if (!runs.every(valid)) return { status: "unknown", reason: "malformed" };
  if (new Set(runs.map((run) => run.id)).size !== runs.length) return { status: "unknown", reason: "census-duplicate" };
  return { status: "complete", runs };
}

async function listAttemptJobs(request, repository, run) {
  const result = await request(
    `${GITHUB_API}/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=${RUN_PAGE_LIMIT}`,
  );
  if (!result.ok) return { status: "unknown", reason: result.reason };
  const body = parseJson(result.stdout);
  if (!Number.isSafeInteger(body?.total_count) || !Array.isArray(body.jobs))
    return { status: "unknown", reason: "malformed" };
  if (body.total_count > RUN_PAGE_LIMIT) return { status: "unknown", reason: "jobs-page-bound" };
  return body.jobs.length === body.total_count
    ? { status: "complete", jobs: body.jobs }
    : { status: "unknown", reason: "census-mismatch" };
}

const EXECUTING = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const SAFE_EVENT = /^[a-z_]{1,40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const RUN_ATTEMPT = /^[1-9][0-9]{0,3}$/;

/**
 * Every holder of the pooled Collections credential for this target, each bound to the revision it executes and
 * that revision's floor ancestry: this capture, each pooled-credential step at capture head, each executing run of
 * those workflows (a rerun executes its own head_sha, never current main) and each Kubernetes runtime consumer.
 * Provable non-holders are listed as exclusions; any unreadable source leaves the whole census unknown.
 */
async function censusHolders({
  target,
  head,
  capture,
  capturedAt,
  repository,
  request,
  workflows,
  kubernetes,
  contains,
}) {
  if (workflows.status !== "complete") return workflows;
  if (kubernetes.status !== "complete") return kubernetes;
  const bound = (commit) =>
    SHA40.test(commit ?? "")
      ? { revisions: [commit], containsFloor: contains(commit) }
      : { revisions: [], containsFloor: null };
  const credential = { credentialSource: POOLED_CREDENTIAL };
  const items = [
    {
      id:
        RUN_ID.test(capture?.id ?? "") && RUN_ATTEMPT.test(capture?.attempt ?? "")
          ? `capture:${capture.id}/${capture.attempt}`
          : "capture:unbound",
      source: "capture",
      workflow: CAPTURE_WORKFLOW,
      ...credential,
      ...bound(head),
    },
  ];
  const exclusions = [];
  const holding = [];
  const steps = pooledSteps(workflows.workflows);
  for (const step of steps) {
    const entry = {
      id: `workflow:${step.workflow}#${step.job}/${step.step}`,
      workflow: step.workflow,
      job: step.job,
      step: step.step,
      acquisition: step.acquisition,
      contexts: step.contexts,
      target: stepTarget(step.rule),
    };
    if (!holdsCollections(step.contexts)) exclusions.push({ ...entry, reason: "contexts-exclude-collections" });
    else if (!reaches(entry.target, target)) exclusions.push({ ...entry, reason: "target-mismatch" });
    else if (step.reusable) {
      return { status: "unknown", blocked: [["workflows", "reusable-holder", `reusable-holder: ${step.workflow}`]] };
    } else {
      items.push({ ...entry, source: "workflow-step", mode: step.mode, ...credential, ...bound(head) });
      holding.push(step);
    }
  }
  const runs = {};
  const holderWorkflows = [...new Set(holding.map((step) => step.workflow))].sort();
  if (holderWorkflows.length > 0 && (!REPOSITORY.test(repository ?? "") || typeof request !== "function")) {
    return { status: "unknown", blocked: [["holders", "repository"]] };
  }
  const since = new Date(Date.parse(capturedAt) - HOLDER_RUN_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const workflow of holderWorkflows) {
    const listed = await listWorkflowRuns(request, repository, workflow, since);
    if (listed.status !== "complete")
      return { status: "unknown", blocked: [["holders", listed.reason, `${workflow}: ${listed.reason}`]] };
    const owning = holding.filter((step) => step.workflow === workflow);
    const executing = listed.runs.filter((run) => EXECUTING.has(run.status)).sort((left, right) => left.id - right.id);
    runs[workflow] = { status: "complete", listed: listed.runs.length, executing: executing.length };
    for (const run of executing) {
      const targets = [...new Set(owning.map((step) => runTarget(step.rule, run.event)))].sort();
      const entry = {
        id: `run:${run.id}/${run.run_attempt}`,
        workflow,
        runId: run.id,
        attempt: run.run_attempt,
        event: SAFE_EVENT.test(run.event) ? run.event : "unnamed",
        status: run.status,
        target: targets.join(","),
      };
      if (!targets.some((value) => reaches(value, target))) {
        exclusions.push({ ...entry, reason: "target-mismatch" });
        continue;
      }
      const jobs = await listAttemptJobs(request, repository, run);
      if (jobs.status !== "complete")
        return { status: "unknown", blocked: [["holders", jobs.reason, `${entry.id}: ${jobs.reason}`]] };
      const names = new Set(owning.map((step) => step.jobName));
      const jobIds = jobs.jobs
        .filter((job) => names.has(job?.name) && Number.isSafeInteger(job.id))
        .map((job) => job.id)
        .sort((left, right) => left - right);
      items.push({ ...entry, source: "workflow-run", jobIds, ...credential, ...bound(run.head_sha) });
    }
  }
  items.push(...kubernetes.holders);
  exclusions.push(...kubernetes.exclusions);
  const floors = items.map((item) => item.containsFloor);
  return {
    status: "complete",
    items,
    exclusions,
    coverage: {
      workflows: { status: "complete", listed: workflows.workflows.length, pooledSteps: steps.length },
      runs,
      kubernetes: { status: "complete", listed: kubernetes.holders.length + kubernetes.exclusions.length },
    },
    revisions: [...new Set(items.flatMap((item) => item.revisions))].sort(),
    containsFloor: floors.every((floor) => floor === true)
      ? true
      : floors.some((floor) => floor === false)
        ? false
        : null,
  };
}

// In-cluster runtime consumers from the same Kubernetes inventory as the writers; a bootstrap-only consumer is an
// explicit exclusion because its key is the direct URL.
function kubernetesHolders(reads, writers) {
  const blocked = Object.keys(KUBERNETES_LISTS)
    .filter((resource) => reads[resource].status === "unknown")
    .map((resource) => [resource, reads[resource].reason]);
  if (blocked.length > 0) return { status: "unknown", blocked };
  const holders = [];
  const exclusions = [];
  for (const writer of writers.filter((candidate) => Array.isArray(candidate.pooledReferences))) {
    if (writer.pooledReferences.length === 0) {
      exclusions.push({ id: writer.item.id, reason: "direct-bootstrap-credential" });
      continue;
    }
    holders.push({
      id: writer.item.id,
      source: "kubernetes",
      kind: writer.kind,
      credentialSource: POOLED_CREDENTIAL,
      references: writer.pooledReferences,
      revisions: writer.item.revisions,
      containsFloor: writer.item.containsFloor,
    });
  }
  return { status: "complete", holders, exclusions };
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
  sessions: "pg_stat_activity per-backend census reconciled with its independent total",
  database: "DATABASE_URL_COLLECTIONS",
  pool: "terraform state pull digitalocean_database_connection_pool.contexts[collections]",
  pooledRead: "BEGIN READ ONLY pg_backend_pid() through the collections-runtime pool",
  workflows: "pooled-credential steps in .github/workflows at capture head",
  holders: "GitHub Actions run and attempt-job lists of pooled-credential workflows",
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
  "session-cap": `raise SESSION_ROW_CAP above ${SESSION_ROW_CAP} backends`,
  "census-unstable": "retry when the census holds still between its reads",
  "census-mismatch": "retry; the listed rows disagree with their independent total",
  "census-duplicate": "retry; the census listed one identity twice",
  "census-self": "inspect the census; it listed the capture's own backend",
  "pool-state": "restore the collections-runtime transaction pool and its user in the Terraform state",
  "ca-missing": "export PGSSLROOTCERT with the managed Postgres CA before the capture step",
  "pooled-connection-failed": "restore the collections-runtime pooled session",
  "rate-limited": "retry after the GitHub API rate limit resets",
  "github-forbidden": "make the holder workflow's Actions runs readable to the capture",
  "workflow-unregistered": "register the holder workflow on the default branch",
  "workflow-unparsed": "repair the workflow YAML at capture head",
  "reusable-holder": "attribute the reusable workflow's pooled step to its callers' runs",
  "run-page-bound": `raise MAX_RUN_PAGES above ${MAX_RUN_PAGES} pages of ${RUN_PAGE_LIMIT}`,
  "jobs-page-bound": `page the attempt job list beyond ${RUN_PAGE_LIMIT} jobs`,
  repository: "run the capture in GitHub Actions so GITHUB_REPOSITORY names the repository",
  unavailable: "wire the capture's read dependency",
};

function unknownFrom(target, blocked) {
  return {
    status: "unknown",
    missingAuthority: blocked
      .map(([source, reason, detail]) => `${SOURCE_LABELS[source]}: ${detail ?? reason}`)
      .join("; "),
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

// The session set plus its attribution evidence; a governed unknown census carries none.
function sessionWriterSet(target, reads, writers, { pool, pooled, holders }) {
  const set = writerSetFor(target, "session", ["sessions"], reads, writers);
  if (set.status === "unknown") return set;
  return {
    ...set,
    pool: pool.status === "complete" ? concrete(pool.value, SOURCE_LABELS.pool) : unknownFrom(target, pool.blocked),
    pooledRead:
      pooled.status === "complete"
        ? concrete({ pid: pooled.pid, backendStart: pooled.backendStart }, SOURCE_LABELS.pooledRead)
        : unknownFrom(target, [["pooledRead", pooled.reason]]),
    holders:
      holders.status === "complete"
        ? {
            collected: holders.items.length,
            authoritativeTotal: holders.items.length,
            items: holders.items,
            exclusions: holders.exclusions,
            coverage: holders.coverage,
            source: `${SOURCE_LABELS.workflows} + ${SOURCE_LABELS.holders} + Kubernetes runtime consumers + this capture`,
          }
        : unknownFrom(target, holders.blocked),
  };
}

/** Captures one target; `floor` is the runner's derived floor, never the recovery commit. */
export async function captureProviderAuthority(
  { target, floor, databaseUrl, head, caPath, repository, run: captureRun, now = () => new Date() },
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
  const request =
    typeof dependencies.request === "function"
      ? async (url) => {
          admitRequest(url, repository);
          return dependencies.request(url);
        }
      : undefined;
  const ancestry = new Map();
  const contains = (revision) => {
    if (!ancestry.has(revision)) ancestry.set(revision, dependencies.containsFloor(floor, revision));
    return ancestry.get(revision);
  };

  const reads = {};
  for (const resource of Object.keys(KUBERNETES_LISTS)) reads[resource] = await listResource(run, resource);
  reads.helm = await readHelmRevisions(run);
  const pulled = await readTerraformState(run);
  reads.terraform = pulled.read;
  const pool = collectionsPool(pulled, target, caPath);
  let identity;
  try {
    identity = databaseIdentityDigest(target, databaseUrl);
  } catch {
    identity = null;
  }
  Object.assign(
    reads,
    await readDatabase(identity ? dependencies : {}, () => readPooledBackend(dependencies.openPooled, pool)),
  );
  reads.sessions = backendCensus(reads.sessions);

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
  const holders =
    reads.sessions.status === "complete"
      ? await censusHolders({
          target,
          head,
          capture: captureRun,
          capturedAt,
          repository,
          request,
          workflows: await readWorkflows(dependencies.readWorkflows),
          kubernetes: kubernetesHolders(reads, writers),
          contains,
        })
      : { status: "unknown", blocked: [["sessions", reads.sessions.reason]] };
  const evidence = { pool: pool.identity, pooled: reads.pooled, holders };
  for (const item of classifySessions(reads.sessions.items ?? [], evidence.pool, evidence.pooled, holders))
    writers.push({ kind: "session", item });
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
    "writers.session": sessionWriterSet(target, reads, writers, evidence),
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
      {
        target,
        floor,
        databaseUrl: env.DATABASE_URL_COLLECTIONS,
        head: env.GITHUB_SHA,
        caPath: env.PGSSLROOTCERT,
        repository: env.GITHUB_REPOSITORY,
        run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT },
      },
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
    // PgBouncer refuses unknown startup parameters, so the pooled client sends no options or statement_timeout;
    // its one transaction is BEGIN READ ONLY instead.
    const openPooled = async (url) => {
      const connectionString = normalizePgPoolConnectionString(url);
      const pooled = new pg.Client({
        connectionString,
        ssl: resolvePgPoolSslConfig(connectionString),
        connectionTimeoutMillis: 15_000,
        query_timeout: 45_000,
      });
      pooled.on("error", () => {});
      try {
        await pooled.connect();
      } catch (error) {
        await pooled.end().catch(() => {});
        throw error;
      }
      return pooled;
    };
    process.exitCode = await runCapture({
      argv: process.argv.slice(2),
      env: process.env,
      io: { mkdir, writeFile, appendFile, log: console.log, error: console.error },
      dependencies: {
        run: execFileRunner(),
        request: githubReadRunner(),
        readWorkflows: () => workflowFiles(root),
        openPooled,
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
