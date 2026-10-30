import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
export const MAX_LOG_BYTES = 1_048_576;
export const READ_TIMEOUT_MS = 30_000;
export const READ_TOTAL_TIMEOUT_MS = 300_000;
export const MAX_WINDOW_MS = 120_000;
export const STAGING_CONTEXT = "do-nyc3-chase-sets-staging-doks";
export const ROW_NAMES = ["web", "ingressAccess", "ingressError", "controllerDefault", "collector"];
export const AC5_PROBE_VERSION = "ac5-logging-probe/v2";
export const EXPECTED_MARKETPLACE_WORKLOAD = "deployment/chase-sets-platform-chase-sets-platform-marketplace";
export const EXPECTED_COLLECTOR_DAEMONSET = "chase-sets-platform-chase-sets-platform-observability-agent";
export const EXPECTED_COLLECTOR_CONFIGMAP = "chase-sets-platform-chase-sets-platform-observability";

export function isCompleteLogRead({ bytes, exit = 0 }) {
  return exit === 0 && bytes < MAX_LOG_BYTES;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value ?? "", "utf8");
}

export function toRfc3339(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("ac5_invalid_timestamp");
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildProbeWindow({ r1At, r4At }) {
  const r1 = new Date(r1At);
  const r4 = new Date(r4At);
  if (Number.isNaN(r1.valueOf()) || Number.isNaN(r4.valueOf()) || r4 < r1)
    throw new Error("ac5_invalid_request_window");
  const t0Ms = r1.valueOf() - 5_000;
  const t1Ms = r4.valueOf() + 15_000;
  if (t1Ms - t0Ms > MAX_WINDOW_MS) throw new Error("ac5_probe_window_too_long");
  return { t0: toRfc3339(new Date(t0Ms)), t1: toRfc3339(new Date(t1Ms)), t0Ms, t1Ms };
}

function parseTimestamp(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(.*)$/);
  if (!match || !RFC3339.test(match[1])) return null;
  const value = Date.parse(match[1]);
  return Number.isNaN(value) ? null : { at: value, timestamp: match[1], body: match[2] };
}

export function filterLogWindow(text, { t0Ms, t1Ms }) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter(Boolean);
  const selected = [];
  for (const line of lines) {
    const parsed = parseTimestamp(line);
    if (!parsed) return { complete: false, text: "", lines: [], reason: "unparsable timestamp" };
    if (parsed.at >= t0Ms && parsed.at <= t1Ms) selected.push(line);
  }
  return { complete: true, text: selected.join("\n"), lines: selected };
}

export function buildKubectlLogsArgs({ namespace, pod, since, context = STAGING_CONTEXT }) {
  if (
    !/^[a-z0-9-]{1,63}$/.test(namespace) ||
    !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(pod) ||
    !RFC3339.test(since) ||
    context !== STAGING_CONTEXT
  )
    throw new Error("ac5_invalid_logs_arguments");
  return [
    `--context=${context}`,
    "logs",
    pod,
    "--namespace",
    namespace,
    "--timestamps",
    `--since-time=${since}`,
    `--limit-bytes=${MAX_LOG_BYTES}`,
  ];
}

export function buildCurlRequestArgs({
  host,
  path,
  sentinels,
  sentinel,
  resolveIP,
  method = "GET",
  userAgent,
  r4 = false,
}) {
  const values = typeof sentinels === "object" && sentinels ? sentinels : { query: sentinel, referer: sentinel };
  if (!host || !path.startsWith("/") || !values.query || !values.referer || !resolveIP || !userAgent)
    throw new Error("ac5_invalid_request_arguments");
  if (!/^[a-z0-9.-]+$/i.test(host) || !/^[a-f0-9:.]+$/i.test(resolveIP) || !["GET", "POST"].includes(method))
    throw new Error("ac5_invalid_request_arguments");
  return [
    "--silent",
    "--show-error",
    "--max-time",
    "10",
    "--max-redirs",
    "0",
    ...(r4 ? ["--insecure"] : []),
    "--output",
    process.platform === "win32" ? "NUL" : "/dev/null",
    "--write-out",
    "%{http_code}",
    "--resolve",
    `${host}:443:${resolveIP}`,
    "--header",
    `Referer: https://example.test/?code=${values.referer}`,
    "--header",
    `User-Agent: ${userAgent}`,
    ...(method === "POST" ? ["--request", "POST", "--header", "Content-Length: 1048577"] : []),
    `https://${host}${path}?probe=${values.query}`,
  ];
}

function statementDeletes(statements) {
  const required = ["http.target", "http.url", "url.full", "url.query"];
  const text = Array.isArray(statements) ? statements.join("\n") : "";
  const present = required.filter((key) =>
    new RegExp(`delete_key\\(\\s*attributes\\s*,\\s*[\"']${key.replaceAll(".", "\\.")}\\b`, "i").test(text),
  );
  return { present, complete: present.length === required.length };
}

export function classifyCollectorConfig(config) {
  const configs = [];
  for (const [name, source] of Object.entries(config?.data ?? {})) {
    let document;
    try {
      document = parseYaml(String(source));
    } catch {
      continue;
    }
    const processor = document?.processors?.["transform/drop_sensitive"];
    if (!processor) continue;
    const trace = statementDeletes((processor.trace_statements ?? []).flatMap((item) => item?.statements ?? []));
    const log = statementDeletes((processor.log_statements ?? []).flatMap((item) => item?.statements ?? []));
    configs.push({
      name,
      traceDeletes: trace.complete,
      logDeletes: log.complete,
      traceCount: trace.present.length,
      logCount: log.present.length,
    });
  }
  return {
    traceDeletes: configs.length > 0 && configs.every((item) => item.traceDeletes),
    logDeletes: configs.length > 0 && configs.every((item) => item.logDeletes),
    traceCount: configs.reduce((sum, item) => sum + item.traceCount, 0),
    logCount: configs.reduce((sum, item) => sum + item.logCount, 0),
    configs,
  };
}

export function selectReadyPods(podList, { namespace, role }) {
  if (!Array.isArray(podList?.items) || podList.metadata?.continue) throw new Error("ac5_pod_list_incomplete");
  const expected =
    role === "controller" ? { name: "ingress-nginx" } : { name: "chase-sets-platform", component: "marketplace" };
  return podList.items
    .filter((pod) => {
      const labels = pod.metadata?.labels ?? {};
      const ready =
        pod.status?.phase === "Running" &&
        (pod.status?.conditions ?? []).some((condition) => condition.type === "Ready" && condition.status === "True");
      return (
        pod.metadata?.namespace === namespace &&
        labels["app.kubernetes.io/name"] === expected.name &&
        (!expected.component || labels["app.kubernetes.io/component"] === expected.component) &&
        ready
      );
    })
    .map((pod) => pod.metadata.name)
    .sort();
}

function row(status, reasons, controls = {}, controlLines = []) {
  return { status, reasons, controls, controlLines };
}
function requestMap(requests) {
  return new Map((requests ?? []).map((request) => [request.name, request]));
}
function requestFailed(requests, name, expectedStatus) {
  const request = requestMap(requests).get(name);
  return !request || request.exit !== 0 || request.status !== expectedStatus;
}

function parseWebLine(line) {
  const parsed = parseTimestamp(line);
  if (!parsed) return null;
  const match = parsed.body.match(/^(GET|POST)\s+(\S+)\s+(\d{3})\b/);
  return match
    ? { timestamp: parsed.timestamp, method: match[1], path: match[2], status: Number(match[3]), raw: line }
    : null;
}

function parseControllerLine(line) {
  const parsed = parseTimestamp(line);
  if (!parsed) return null;
  const request = parsed.body.match(/"(GET|POST)\s+(\S+)\s+HTTP\/[^" ]+"\s+(\d{3})\b/);
  if (!request) return null;
  const quoted = [...parsed.body.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  return {
    timestamp: parsed.timestamp,
    method: request[1],
    path: request[2],
    status: Number(request[3]),
    userAgent: quoted[1] ?? parsed.body.match(/\bua=([^\s]+)/i)?.[1] ?? "",
    raw: line,
  };
}

function controlLine(entry) {
  return { timestamp: entry.timestamp, method: entry.method, path: entry.path, status: entry.status };
}
function controlsFor(entries, method, path, status) {
  return entries.filter((entry) => entry.method === method && entry.path === path && entry.status === status);
}

export function classifyAc5Rows({
  marketplaceLogs,
  controllerLogs,
  collector,
  sentinels = [],
  userAgent = "",
  requests = [],
  qualification = {},
}) {
  const marketplaceLines = Array.isArray(marketplaceLogs?.lines)
    ? marketplaceLogs.lines
    : String(marketplaceLogs?.text ?? marketplaceLogs ?? "")
        .split(/\r?\n/)
        .filter(Boolean);
  const controllerLines = Array.isArray(controllerLogs?.lines)
    ? controllerLogs.lines
    : String(controllerLogs?.text ?? controllerLogs ?? "")
        .split(/\r?\n/)
        .filter(Boolean);
  const results = {};
  if (marketplaceLogs?.complete !== true || controllerLogs?.complete !== true) {
    for (const name of ROW_NAMES) results[name] = row("INCONCLUSIVE", ["required log read incomplete"]);
    return results;
  }
  const webEntries = marketplaceLines.map(parseWebLine).filter(Boolean);
  const controllerEntries = controllerLines.map(parseControllerLine).filter(Boolean);
  const attributed = controllerEntries.filter((entry) => entry.userAgent === userAgent);
  const controllerSentinel = controllerLines.some((line) =>
    sentinels.some((sentinel) => sentinel && line.includes(sentinel)),
  );
  const webForbidden = marketplaceLines.some(
    (line) =>
      sentinels.some((sentinel) => sentinel && line.includes(sentinel)) ||
      /[?#]|\b(?:referer|referrer):\s*\S+/i.test(line),
  );
  const attributedForbidden = attributed.some(
    (entry) => /[?#]/.test(entry.path) || /\b(?:referer|referrer):\s*\S+/i.test(entry.raw),
  );
  const errorLine = controllerLines.some((line) =>
    /client intended to send too large body|\[error\].*(?:request:|referrer:)/i.test(line),
  );
  const r1Web = webEntries.filter(
    (entry) => entry.method === "GET" && entry.path === "/sign-in" && entry.status === 200,
  );
  const otherWeb = webEntries.filter(
    (entry) =>
      ["/api/health", "/sign-in", "/probe"].includes(entry.path) &&
      !(entry.method === "GET" && entry.path === "/sign-in" && entry.status === 200),
  );
  results.web = webForbidden
    ? row(
        "FAIL",
        ["sentinel, query, fragment, or referrer found in marketplace log"],
        { r1: r1Web.length },
        r1Web.map(controlLine),
      )
    : requestFailed(requests, "R1", 200)
      ? row("INCONCLUSIVE", ["R1 request did not return HTTP 200"])
      : r1Web.length === 1 && otherWeb.length === 0
        ? row("PASS", [], { r1: 1 }, r1Web.map(controlLine))
        : row(
            "INCONCLUSIVE",
            ["missing exactly one marketplace R1 control or an R2-R4 line"],
            { r1: r1Web.length },
            r1Web.map(controlLine),
          );
  const r1 = controlsFor(attributed, "GET", "/sign-in", 200);
  const r2 = controlsFor(attributed, "GET", "/api/health", 200);
  const r3 = controlsFor(attributed, "POST", "/sign-in", 413);
  const accessControls = { r1: r1.length, r2: r2.length, r3: r3.length };
  results.ingressAccess =
    controllerSentinel || attributedForbidden
      ? row(
          "FAIL",
          ["sentinel, query, fragment, or referrer found in probe-attributed controller line"],
          accessControls,
          [...r1, ...r2, ...r3].map(controlLine),
        )
      : ["R1", "R2", "R3"].some((name, index) => requestFailed(requests, name, [200, 200, 413][index]))
        ? row(
            "INCONCLUSIVE",
            ["required ingress request did not return its expected status"],
            accessControls,
            [...r1, ...r2, ...r3].map(controlLine),
          )
        : r1.length === 1 && r2.length === 1 && r3.length === 1
          ? row("PASS", [], accessControls, [...r1, ...r2, ...r3].map(controlLine))
          : row(
              "INCONCLUSIVE",
              ["missing probe-attributed ingress pathname controls"],
              accessControls,
              [...r1, ...r2, ...r3].map(controlLine),
            );
  results.ingressError =
    controllerSentinel || attributedForbidden || errorLine
      ? row(
          "FAIL",
          [
            errorLine
              ? "request-scoped nginx error line present"
              : "sentinel, query, fragment, or referrer found in controller line",
          ],
          { r3: r3.length },
          r3.map(controlLine),
        )
      : requestFailed(requests, "R3", 413)
        ? row("INCONCLUSIVE", ["R3 request did not return HTTP 413"], { r3: r3.length }, r3.map(controlLine))
        : r3.length === 1
          ? row("PASS", [], { r3: 1 }, r3.map(controlLine))
          : row(
              "INCONCLUSIVE",
              ["missing probe-attributed R3 413 access control"],
              { r3: r3.length },
              r3.map(controlLine),
            );
  const r4 = attributed.filter((entry) => entry.method === "GET" && entry.path === "/probe");
  results.controllerDefault =
    controllerSentinel || attributedForbidden
      ? row(
          "FAIL",
          ["sentinel, query, fragment, or referrer found in controller line"],
          { r4: r4.length },
          r4.map(controlLine),
        )
      : qualification.defaultBackendLoggingDisabled !== true
        ? row("INCONCLUSIVE", ["default-backend logging qualification missing"])
        : requestFailed(requests, "R4", 404)
          ? row("INCONCLUSIVE", ["R4 request did not return HTTP 404"], { r4: r4.length }, r4.map(controlLine))
          : r4.length > 0
            ? row("FAIL", ["unexpected probe-attributed /probe access line"], { r4: r4.length }, r4.map(controlLine))
            : row("PASS", [], { r4: 0 }, []);
  const collectorOk = collector?.traceDeletes === true && collector?.logDeletes === true;
  results.collector = collectorOk
    ? row("PASS", [], { traceDeletes: collector.traceCount ?? 4, logDeletes: collector.logCount ?? 4 })
    : row("INCONCLUSIVE", ["collector delete inventory incomplete"], {
        traceDeletes: collector?.traceCount ?? 0,
        logDeletes: collector?.logCount ?? 0,
      });
  return results;
}

export function overallVerdict(rows) {
  const statuses = ROW_NAMES.map((name) => rows[name]?.status);
  if (statuses.some((status) => status === "FAIL")) return "FAIL";
  return statuses.every((status) => status === "PASS") ? "PASS" : "INCONCLUSIVE";
}
export function verdictExitCode(verdict) {
  return verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2;
}

function redact(value, sentinels = []) {
  let text = String(value ?? "");
  for (const sentinel of sentinels) if (sentinel) text = text.split(sentinel).join("[redacted]");
  return text.replace(/[?&][^\s]*/g, "?[redacted]");
}

export function serializeEvidence({ qualification, requests, reads, rows, sentinels = [], overall }) {
  const evidence = {
    schemaVersion: AC5_PROBE_VERSION,
    qualification,
    requests: (requests ?? []).map(({ name, method, path, status, exit, start, end, stderrBytes, stderrPrefix }) => ({
      name,
      method,
      path,
      status,
      exit,
      start,
      end,
      stderrBytes,
      stderrPrefix: redact(stderrPrefix, sentinels),
    })),
    reads: (reads ?? []).map(({ namespace, pod, exit, bytes, complete, timedOut, stderrBytes, stderrPrefix }) => ({
      namespace,
      pod,
      exit,
      bytes,
      complete,
      timedOut,
      stderrBytes,
      stderrPrefix: redact(stderrPrefix, sentinels),
    })),
    rows: Object.fromEntries(ROW_NAMES.map((name) => [name, rows?.[name] ?? row("INCONCLUSIVE", ["row missing"])])),
    overall: overall ?? overallVerdict(rows ?? {}),
  };
  const output = `${JSON.stringify(evidence, null, 2)}\n`;
  if (sentinels.some((sentinel) => sentinel && output.includes(sentinel))) throw new Error("ac5_evidence_sentinel");
  return output;
}

function kubectlArgsAfterContext(args) {
  return args[0]?.startsWith("--context=") ? args.slice(1) : args;
}
export function assertReadOnlyKubectl(args) {
  if (args[0] !== `--context=${STAGING_CONTEXT}`) throw new Error("ac5_read_only_command_refused");
  const actual = kubectlArgsAfterContext(args);
  const verb = actual[0];
  const resources = new Set([
    "deployment",
    "deployments",
    "daemonset",
    "daemonsets",
    "configmap",
    "configmaps",
    "pods",
    "pod",
    "service",
    "services",
    "ingress",
    "ingresses",
    "statefulsets",
    "statefulset",
    "deployments,daemonsets,statefulsets,services,configmaps",
  ]);
  if (verb !== "get" && verb !== "logs") throw new Error("ac5_read_only_command_refused");
  if (verb === "logs") return;
  if (!resources.has(actual[1]) || actual.some((arg) => /(?:^|[-/])secret(?:s|\/|$)/i.test(arg)))
    throw new Error("ac5_read_only_command_refused");
}

async function runCommand(command, args, { timeout = READ_TIMEOUT_MS, runner = execFileAsync, kubectl = false } = {}) {
  if (kubectl) assertReadOnlyKubectl(args);
  try {
    const result = await runner(command, args, {
      timeout,
      maxBuffer: MAX_LOG_BYTES + 16_384,
      windowsHide: true,
      encoding: "buffer",
    });
    const stdoutBuffer = asBuffer(result.stdout);
    const stderrBuffer = asBuffer(result.stderr);
    return {
      exit: 0,
      stdout: stdoutBuffer.toString("utf8"),
      bytes: stdoutBuffer.length,
      complete: isCompleteLogRead({ bytes: stdoutBuffer.length, exit: 0 }),
      timedOut: false,
      stderrBytes: stderrBuffer.length,
      stderrPrefix: stderrBuffer.subarray(0, 4096).toString("utf8"),
    };
  } catch (error) {
    const stdoutBuffer = asBuffer(error?.stdout);
    const stderrBuffer = asBuffer(error?.stderr);
    const exit = Number.isInteger(error?.code) ? error.code : Number.parseInt(error?.code, 10) || 1;
    return {
      exit,
      stdout: stdoutBuffer.toString("utf8"),
      bytes: stdoutBuffer.length,
      complete: false,
      timedOut: error?.killed === true || error?.code === "ETIMEDOUT",
      stderrBytes: stderrBuffer.length,
      stderrPrefix: stderrBuffer.subarray(0, 4096).toString("utf8"),
    };
  }
}

function jsonOutput(result, label) {
  if (result.exit !== 0 || !result.complete) throw new Error(`ac5_${label}_read_incomplete`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`ac5_${label}_json_invalid`);
  }
}

const OPTION_KEYS = {
  "deploy-run-id": "deployRunId",
  "merge-sha": "mergeSha",
  "fix-merge-sha": "fixMergeSha",
  "promoted-digest": "promotedDigest",
  "staging-host": "stagingHost",
  "r4-host": "r4Host",
  context: "context",
  output: "output",
  kubectl: "kubectl",
  gh: "gh",
  "marketplace-namespace": "marketplaceNamespace",
  "controller-namespace": "controllerNamespace",
  "marketplace-workload": "marketplaceWorkload",
  "collector-daemonset": "collectorDaemonSet",
  "collector-configmap": "collectorConfigMap",
  "controller-configmap": "controllerConfigMap",
  "controller-service": "controllerService",
};

export function parseArgs(argv) {
  const options = {
    kubectl: "kubectl",
    gh: "gh",
    output: "artifacts/ac5-logging-probe/evidence.json",
    marketplaceNamespace: "chase-sets-platform",
    controllerNamespace: "ingress-nginx",
    marketplaceWorkload: EXPECTED_MARKETPLACE_WORKLOAD,
    collectorDaemonSet: EXPECTED_COLLECTOR_DAEMONSET,
    collectorConfigMap: EXPECTED_COLLECTOR_CONFIGMAP,
    controllerConfigMap: "ingress-nginx-controller",
    controllerService: "ingress-nginx-controller",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) throw new Error("ac5_unknown_argument");
    const equal = raw.indexOf("=");
    const name = equal >= 0 ? raw.slice(2, equal) : raw.slice(2);
    const value = equal >= 0 ? raw.slice(equal + 1) : argv[++index];
    const target = OPTION_KEYS[name];
    if (!target) throw new Error("ac5_unknown_argument");
    if (!value || String(value).startsWith("--")) throw new Error("ac5_argument_value_missing");
    options[target] = value;
  }
  if (
    !/^\d+$/.test(options.deployRunId ?? "") ||
    !SHA.test(options.mergeSha ?? "") ||
    !DIGEST.test(options.promotedDigest ?? "")
  )
    throw new Error("ac5_qualification_identity_invalid");
  if (options.fixMergeSha && !SHA.test(options.fixMergeSha)) throw new Error("ac5_qualification_identity_invalid");
  if (!options.stagingHost || !options.r4Host || options.context !== STAGING_CONTEXT)
    throw new Error("ac5_staging_context_required");
  return options;
}

function workloadReady(workload, label) {
  const status = workload?.status ?? {};
  const desired = workload?.spec?.replicas;
  if (
    workload?.kind !== "Deployment" ||
    !Number.isInteger(desired) ||
    desired <= 0 ||
    status.observedGeneration !== workload.metadata?.generation ||
    status.updatedReplicas !== desired ||
    status.readyReplicas !== desired ||
    status.availableReplicas !== desired
  )
    throw new Error(`ac5_${label}_incomplete`);
}
function daemonSetReady(daemonSet) {
  const status = daemonSet?.status ?? {};
  if (
    status.observedGeneration !== daemonSet.metadata?.generation ||
    !Number.isInteger(status.desiredNumberScheduled) ||
    status.desiredNumberScheduled <= 0 ||
    status.updatedNumberScheduled !== status.desiredNumberScheduled ||
    status.numberReady !== status.desiredNumberScheduled ||
    status.numberAvailable !== status.desiredNumberScheduled
  )
    throw new Error("ac5_collector_rollout_incomplete");
}
function findResourceName(value) {
  const [kind, name] = String(value).split("/", 2);
  if (!kind || !name || !/^[a-z]+$/.test(kind) || !/^[a-z0-9.-]+$/.test(name))
    throw new Error("ac5_resource_name_invalid");
  return { kind, name };
}

function chartValues(root = process.cwd()) {
  const document = parseYaml(
    readFileSync(resolve(root, "infrastructure/helm/doks-ingress/ingress-nginx-values.yaml"), "utf8"),
  );
  const config = document?.controller?.config ?? {};
  if (/defaultBackend|enable-access-log-for-default-backend/i.test(JSON.stringify(document)))
    throw new Error("ac5_chart_default_backend_artifact_present");
  if (typeof config["log-format-upstream"] !== "string" || config["error-log-path"] !== "/dev/null")
    throw new Error("ac5_chart_config_invalid");
  return { logFormat: config["log-format-upstream"], errorLogPath: config["error-log-path"] };
}
function wildcardMatches(host, target) {
  if (!host) return true;
  if (!host.startsWith("*.")) return host === target;
  const suffix = host.slice(1);
  return (
    target.endsWith(suffix) &&
    target.slice(0, -suffix.length).length > 0 &&
    !target.slice(0, -suffix.length).includes(".")
  );
}
function assertNoForbiddenInventory(inventory) {
  for (const item of inventory?.items ?? [])
    if (/(?:default-backend|maintenance)/i.test(String(item.metadata?.name ?? "")))
      throw new Error("ac5_chart_inventory_forbidden_resource");
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  try {
    return await executeProbe(options, dependencies);
  } catch (error) {
    if (!(error instanceof Error) || !/^ac5_[a-z0-9_]+$/.test(error.message)) throw error;
    const refusal = error.message;
    const overall = "INCONCLUSIVE";
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(
      options.output,
      `${JSON.stringify({ schemaVersion: AC5_PROBE_VERSION, overall, refusal })}\n`,
      "utf8",
    );
    console.error(`INCONCLUSIVE ${refusal}`);
    process.exitCode = verdictExitCode(overall);
    return { overall, refusal, exitCode: process.exitCode };
  }
}

async function executeProbe(options, dependencies) {
  const runner = dependencies.runner ?? execFileAsync;
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const run = (command, args, settings) => runCommand(command, args, { ...settings, runner });
  const runKubectl = (args, settings) =>
    run(options.kubectl, args[0]?.startsWith("--context=") ? args : [`--context=${options.context}`, ...args], {
      ...settings,
      kubectl: true,
    });
  const deploy = jsonOutput(
    await run(
      options.gh,
      [
        "run",
        "view",
        options.deployRunId,
        "--repo",
        "chase-sets/chase-sets",
        "--json",
        "headSha,status,conclusion,workflowName,createdAt",
      ],
      { timeout: READ_TIMEOUT_MS },
    ),
    "deploy",
  );
  if (
    deploy.workflowName !== "Platform Deploy" ||
    deploy.headSha !== options.mergeSha ||
    deploy.status !== "completed" ||
    deploy.conclusion !== "success"
  )
    throw new Error("ac5_deploy_not_successful_for_merge");
  const deployRuns = jsonOutput(
    await run(
      options.gh,
      [
        "run",
        "list",
        "--repo",
        "chase-sets/chase-sets",
        "--workflow",
        "platform-production.yml",
        "--limit",
        "100",
        "--json",
        "databaseId,headSha,status,conclusion,workflowName,createdAt",
      ],
      { timeout: READ_TIMEOUT_MS },
    ),
    "deploy_list",
  );
  const deployAt = Date.parse(deploy.createdAt);
  if (
    deployRuns.some(
      (candidate) =>
        candidate.workflowName === "Platform Deploy" &&
        Date.parse(candidate.createdAt) > deployAt &&
        candidate.status !== "completed",
    )
  )
    throw new Error("ac5_newer_deploy_in_progress");
  const fixSha = options.fixMergeSha ?? options.mergeSha;
  const ancestor = await run("git", ["merge-base", "--is-ancestor", fixSha, deploy.headSha], {
    timeout: READ_TIMEOUT_MS,
  });
  if (ancestor.exit !== 0) throw new Error("ac5_fix_sha_not_ancestor");
  const chart = chartValues(dependencies.root);
  const workloadRef = findResourceName(options.marketplaceWorkload);
  const collectorDaemonSet = jsonOutput(
    await runKubectl([
      "get",
      "daemonset",
      options.collectorDaemonSet,
      "-n",
      options.marketplaceNamespace,
      "-o",
      "json",
    ]),
    "collector_rollout",
  );
  const collectorConfig = jsonOutput(
    await runKubectl([
      "get",
      "configmap",
      options.collectorConfigMap,
      "-n",
      options.marketplaceNamespace,
      "-o",
      "json",
    ]),
    "collector_config",
  );
  const marketplaceWorkload = jsonOutput(
    await runKubectl(["get", workloadRef.kind, workloadRef.name, "-n", options.marketplaceNamespace, "-o", "json"]),
    "marketplace_workload",
  );
  const pods = jsonOutput(
    await runKubectl([
      "get",
      "pods",
      "-n",
      options.marketplaceNamespace,
      "-l",
      "app.kubernetes.io/name=chase-sets-platform,app.kubernetes.io/component=marketplace",
      "--field-selector=status.phase=Running",
      "-o",
      "json",
    ]),
    "marketplace_pods",
  );
  const controllerPods = jsonOutput(
    await runKubectl([
      "get",
      "pods",
      "-n",
      options.controllerNamespace,
      "-l",
      "app.kubernetes.io/name=ingress-nginx",
      "-o",
      "json",
    ]),
    "controller_pods",
  );
  const configMap = jsonOutput(
    await runKubectl([
      "get",
      "configmap",
      options.controllerConfigMap,
      "-n",
      options.controllerNamespace,
      "-o",
      "json",
    ]),
    "controller_config",
  );
  const service = jsonOutput(
    await runKubectl(["get", "service", options.controllerService, "-n", options.controllerNamespace, "-o", "json"]),
    "controller_service",
  );
  const ingress = jsonOutput(await runKubectl(["get", "ingress", "-A", "-o", "json"]), "ingress_hosts");
  const inventory = jsonOutput(
    await runKubectl(["get", "deployments,daemonsets,statefulsets,services,configmaps", "-A", "-o", "json"]),
    "chart_inventory",
  );
  assertNoForbiddenInventory(inventory);
  workloadReady(marketplaceWorkload, "marketplace_workload");
  daemonSetReady(collectorDaemonSet);
  const marketplaceReady = selectReadyPods(pods, { namespace: options.marketplaceNamespace, role: "marketplace" });
  const controllerReady = selectReadyPods(controllerPods, {
    namespace: options.controllerNamespace,
    role: "controller",
  });
  if (!marketplaceReady.length || !controllerReady.length) throw new Error("ac5_ready_pods_missing");
  const marketplaceDigests = marketplaceReady
    .map((name) => pods.items.find((pod) => pod.metadata?.name === name)?.status?.containerStatuses ?? [])
    .flat()
    .map((status) => status.imageID?.match(/@(sha256:[a-f0-9]{64})$/)?.[1]);
  if (marketplaceDigests.length === 0 || marketplaceDigests.some((digest) => digest !== options.promotedDigest))
    throw new Error("ac5_marketplace_digest_mismatch");
  const configData = configMap.data ?? {};
  if (
    configData["enable-access-log-for-default-backend"] !== undefined &&
    configData["enable-access-log-for-default-backend"] !== "false"
  )
    throw new Error("ac5_default_backend_logging_enabled");
  if (configData["log-format-upstream"] !== chart.logFormat || configData["error-log-path"] !== chart.errorLogPath)
    throw new Error("ac5_controller_config_mismatch");
  const ip = service.status?.loadBalancer?.ingress?.[0]?.ip;
  const stagingRule = (ingress.items ?? [])
    .flatMap((item) => item.spec?.rules ?? [])
    .some((rule) => rule.host === options.stagingHost);
  const r4Captured = (ingress.items ?? [])
    .flatMap((item) => item.spec?.rules ?? [])
    .some((rule) => wildcardMatches(rule.host, options.r4Host));
  if (!ip || !stagingRule || r4Captured) throw new Error("ac5_ingress_host_qualification_failed");
  const collector = classifyCollectorConfig(collectorConfig);
  const nonce = (dependencies.randomBytes ?? randomBytes)(8).toString("hex");
  const userAgent = `ac5-probe/${nonce}`;
  const sentinels = [];
  const requests = [];
  async function send(name, method, path, host, expectedStatus) {
    const values = { query: `ac5-q-${nonce}-${name.toLowerCase()}`, referer: `ac5-r-${nonce}-${name.toLowerCase()}` };
    sentinels.push(values.query, values.referer);
    const startMs = now();
    const result = await run(
      "curl",
      buildCurlRequestArgs({ host, path, sentinels: values, resolveIP: ip, method, userAgent, r4: name === "R4" }),
      { timeout: 10_000 },
    );
    const endMs = now();
    const status = Number.parseInt(result.stdout.trim(), 10);
    requests.push({
      name,
      method,
      path,
      expectedStatus,
      status: Number.isInteger(status) ? status : null,
      exit: result.exit,
      start: toRfc3339(new Date(startMs)),
      end: toRfc3339(new Date(endMs)),
      stderrBytes: result.stderrBytes,
      stderrPrefix: result.stderrPrefix,
    });
    return { startMs, endMs };
  }
  const r1At = await send("R1", "GET", "/sign-in", options.stagingHost, 200);
  await send("R2", "GET", "/api/health", options.stagingHost, 200);
  await send("R3", "POST", "/sign-in", options.stagingHost, 413);
  const r4At = await send("R4", "GET", "/probe", options.r4Host, 404);
  const window = buildProbeWindow({ r1At: new Date(r1At.startMs), r4At: new Date(r4At.endMs) });
  while (now() < window.t1Ms) await sleep(Math.min(1_000, window.t1Ms - now()));
  const readDeadline = now() + READ_TOTAL_TIMEOUT_MS;
  const reads = [];
  for (const pod of [
    ...controllerReady.map((name) => ({ namespace: options.controllerNamespace, pod: name })),
    ...marketplaceReady.map((name) => ({ namespace: options.marketplaceNamespace, pod: name })),
  ]) {
    const remaining = Math.max(1, Math.min(READ_TIMEOUT_MS, readDeadline - now()));
    const result = await runKubectl(buildKubectlLogsArgs({ ...pod, since: window.t0, context: options.context }), {
      timeout: remaining,
    });
    const filtered = result.complete
      ? filterLogWindow(result.stdout, window)
      : { complete: false, text: "", lines: [] };
    reads.push({
      ...pod,
      ...result,
      text: filtered.text,
      lines: filtered.lines,
      complete: result.complete && filtered.complete,
    });
  }
  const controllerReads = reads.filter((read) => read.namespace === options.controllerNamespace);
  const marketplaceReads = reads.filter((read) => read.namespace === options.marketplaceNamespace);
  const rows = classifyAc5Rows({
    marketplaceLogs: {
      complete: marketplaceReads.length > 0 && marketplaceReads.every((read) => read.complete),
      lines: marketplaceReads.flatMap((read) => read.lines),
    },
    controllerLogs: {
      complete: controllerReads.length > 0 && controllerReads.every((read) => read.complete),
      lines: controllerReads.flatMap((read) => read.lines),
    },
    collector,
    sentinels,
    userAgent,
    requests,
    qualification: { defaultBackendLoggingDisabled: true },
  });
  let overall = overallVerdict(rows);
  let output;
  try {
    output = serializeEvidence({
      qualification: {
        deployRunId: options.deployRunId,
        mergeSha: options.mergeSha,
        fixMergeSha: fixSha,
        marketplaceReady,
        controllerReady,
        t0: window.t0,
        t1: window.t1,
      },
      requests,
      reads,
      rows,
      sentinels,
      overall,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "ac5_evidence_sentinel") throw error;
    overall = "FAIL";
    output = `${JSON.stringify({ schemaVersion: AC5_PROBE_VERSION, overall: "FAIL", refusal: "evidence contained a probe sentinel and was not retained" })}\n`;
  }
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, output, "utf8");
  process.exitCode = verdictExitCode(overall);
  console.log(`AC5 ${overall} ${ROW_NAMES.map((name) => `${name}=${rows[name].status}`).join(" ")}`);
  return { rows, overall, exitCode: process.exitCode };
}

export { main };
if (process.argv[1] && process.argv[1].endsWith("ac5-logging-probe.mjs"))
  main().catch((error) => {
    const code = error instanceof Error && /^ac5_[a-z0-9_]+$/.test(error.message) ? error.message : "ac5_probe_failed";
    console.error(`INCONCLUSIVE ${code}`);
    process.exitCode = 2;
  });
