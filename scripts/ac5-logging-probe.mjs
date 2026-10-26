import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import process from "node:process";

const execFileAsync = promisify(execFile);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_LOG_BYTES = 1_048_576;
const READ_TIMEOUT_MS = 30_000;
export const READ_TOTAL_TIMEOUT_MS = 300_000;
const ROW_NAMES = ["web", "ingressAccess", "ingressError", "controllerDefault", "collector"];

export const AC5_PROBE_VERSION = "ac5-logging-probe/v1";

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
  return { t0: toRfc3339(new Date(r1.valueOf() - 5_000)), t1: toRfc3339(new Date(r4.valueOf() + 15_000)) };
}

export function buildKubectlLogsArgs({ namespace, pod, since }) {
  if (!/^[a-z0-9-]{1,63}$/.test(namespace) || !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(pod) || !RFC3339.test(since)) {
    throw new Error("ac5_invalid_logs_arguments");
  }
  return [
    "logs",
    pod,
    "--namespace",
    namespace,
    "--timestamps",
    `--since-time=${since}`,
    `--limit-bytes=${MAX_LOG_BYTES}`,
  ];
}

export function buildCurlRequestArgs({ host, path, sentinel, resolveIP, method = "GET" }) {
  if (!host || !path.startsWith("/") || !sentinel || !resolveIP || !["GET", "POST"].includes(method))
    throw new Error("ac5_invalid_request_arguments");
  const resolve = resolveIP ? [`--resolve`, `${host}:443:${resolveIP}`] : [];
  return [
    "--silent",
    "--show-error",
    "--max-time",
    "10",
    "--output",
    process.platform === "win32" ? "NUL" : "/dev/null",
    "--write-out",
    "%{http_code}",
    ...resolve,
    "--header",
    `Referer: https://example.test/?code=${sentinel}`,
    ...(method === "POST" ? ["--request", "POST", "--header", "Content-Length: 1048577"] : []),
    `https://${host}${path}?probe=${sentinel}`,
  ];
}

export function classifyCollectorConfig(config) {
  const text = JSON.stringify(config?.data ?? {});
  const required = ["http.target", "http.url", "url.full", "url.query"];
  const traceDeletes = required.every((key) => text.includes(key)) && /trace|traces/i.test(text);
  const logDeletes = required.every((key) => text.includes(key)) && /log|logs/i.test(text);
  return { traceDeletes, logDeletes };
}

export function selectReadyPods(podList, { namespace, role }) {
  if (!Array.isArray(podList?.items) || podList.metadata?.continue) throw new Error("ac5_pod_list_incomplete");
  return podList.items
    .filter((pod) => {
      const labels = pod.metadata?.labels ?? {};
      const ready =
        pod.status?.phase === "Running" &&
        (pod.status?.conditions ?? []).some((condition) => condition.type === "Ready" && condition.status === "True");
      const roleMatch =
        role === "controller"
          ? labels["app.kubernetes.io/name"] === "ingress-nginx"
          : labels["app.kubernetes.io/name"] === "marketplace";
      return pod.metadata?.namespace === namespace && roleMatch && ready;
    })
    .map((pod) => pod.metadata.name)
    .sort();
}

function row(status, reasons, controls = {}) {
  return { status, reasons, controls };
}

function containsForbidden(lines, sentinels) {
  const forbidden = [...sentinels, "?", "#", "referer", "referrer"].filter(Boolean);
  return lines.some((line) => forbidden.some((value) => line.includes(value)));
}

function routeLines(lines, path, method) {
  const expression = new RegExp(`\\b${method}\\s+${path.replaceAll("/", "\\/")}\\b`);
  return lines.filter((line) => expression.test(line));
}

function allControls(lines, routes) {
  return routes.every(({ method, path, status }) =>
    routeLines(lines, path, method).some((line) => (status ? new RegExp(`\\b${status}\\b`).test(line) : true)),
  );
}

export function classifyAc5Rows({ marketplaceLogs, controllerLogs, collector, sentinels }) {
  const marketplace = String(marketplaceLogs?.text ?? marketplaceLogs ?? "")
    .split(/\r?\n/)
    .filter(Boolean);
  const controller = String(controllerLogs?.text ?? controllerLogs ?? "")
    .split(/\r?\n/)
    .filter(Boolean);
  const results = {};
  if (!marketplaceLogs?.complete || !controllerLogs?.complete) {
    for (const name of ROW_NAMES) results[name] = row("INCONCLUSIVE", ["required log read incomplete"]);
    return results;
  }
  const sentinelsFound = containsForbidden([...marketplace, ...controller], sentinels);
  results.web = sentinelsFound
    ? row("FAIL", ["sentinel, query, or fragment found in serving log"])
    : routeLines(marketplace, "/sign-in", "GET").length === 1
      ? row("PASS", [], { r1: 1 })
      : row("INCONCLUSIVE", ["missing exactly one marketplace R1 control"]);
  results.ingressAccess = sentinelsFound
    ? row("FAIL", ["sentinel, query, or fragment found in serving log"])
    : allControls(controller, [
          { method: "GET", path: "/sign-in" },
          { method: "GET", path: "/api/health" },
          { method: "POST", path: "/sign-in" },
          { method: "GET", path: "/probe", status: 404 },
        ])
      ? row("PASS", [], { r1: 1, r2: 1, r3: 1, r4: 1 })
      : row("INCONCLUSIVE", ["missing ingress pathname control"]);
  const errorControls = controller.filter((line) =>
    /client intended to send too large body|request:\s*POST\s+\/sign-in/i.test(line),
  );
  results.ingressError = sentinelsFound
    ? row("FAIL", ["sentinel, query, or fragment found in serving log"])
    : errorControls.length === 1 && !/referrer:\s*\S+/i.test(errorControls[0])
      ? row("PASS", [], { r3: 1 })
      : row("INCONCLUSIVE", ["missing exactly one R3 error control"]);
  const r4Controls = routeLines(controller, "/probe", "GET").filter((line) => /\b404\b/.test(line));
  results.controllerDefault = sentinelsFound
    ? row("FAIL", ["sentinel, query, or fragment found in controller default line"])
    : r4Controls.length === 1 && !/referrer\s*:/i.test(r4Controls[0])
      ? row("PASS", [], { r4: 1 })
      : row("INCONCLUSIVE", ["missing exactly one pathname-only R4 404 control"]);
  const collectorOk = collector?.traceDeletes === true && collector?.logDeletes === true;
  results.collector = collectorOk
    ? row("PASS", [], { traceDeletes: 4, logDeletes: 4 })
    : row("INCONCLUSIVE", ["collector delete inventory incomplete"]);
  return results;
}

export function serializeEvidence({ qualification, requests, reads, rows }) {
  const evidence = {
    schemaVersion: AC5_PROBE_VERSION,
    qualification,
    requests: requests.map(({ name, method, path, status, exit }) => ({ name, method, path, status, exit })),
    reads: reads.map(({ namespace, pod, exit, bytes, complete, timedOut }) => ({
      namespace,
      pod,
      exit,
      bytes,
      complete,
      timedOut,
    })),
    rows: Object.fromEntries(ROW_NAMES.map((name) => [name, rows[name]])),
  };
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

function assertReadOnlyKubectl(args) {
  const verb = args[0];
  if (verb !== "get" && verb !== "logs") throw new Error("ac5_read_only_command_refused");
  if (
    args.includes("exec") ||
    args.includes("apply") ||
    args.includes("patch") ||
    args.includes("delete") ||
    args.includes("secret")
  ) {
    throw new Error("ac5_read_only_command_refused");
  }
}

async function runCommand(command, args, { timeout = READ_TIMEOUT_MS, runner = execFileAsync } = {}) {
  if (/(?:^|[\\/])kubectl(?:\.exe)?$/i.test(command)) assertReadOnlyKubectl(args);
  try {
    const result = await runner(command, args, {
      timeout,
      maxBuffer: MAX_LOG_BYTES + 16_384,
      windowsHide: true,
      encoding: "utf8",
    });
    const stdout = String(result.stdout ?? "");
    const bytes = Buffer.byteLength(stdout);
    return { exit: 0, stdout, bytes, complete: bytes <= MAX_LOG_BYTES, timedOut: false };
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const timedOut = error?.killed === true || error?.code === "ETIMEDOUT";
    return {
      exit: Number.isInteger(error?.code) ? error.code : 1,
      stdout,
      bytes: Buffer.byteLength(stdout),
      complete: false,
      timedOut,
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

function parseArgs(argv) {
  const options = {
    kubectl: "kubectl",
    gh: "gh",
    output: "artifacts/ac5-logging-probe/evidence.json",
    marketplaceNamespace: "chase-sets-platform",
    controllerNamespace: "ingress-nginx",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error("ac5_unknown_argument");
    const key = arg.slice(2).replaceAll("-", "");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error("ac5_argument_value_missing");
    const keys = {
      deployRunId: "deployRunId",
      mergeSha: "mergeSha",
      promotedDigest: "promotedDigest",
      stagingHost: "stagingHost",
      r4Host: "r4Host",
      output: "output",
      kubectl: "kubectl",
      gh: "gh",
      marketplaceNamespace: "marketplaceNamespace",
      controllerNamespace: "controllerNamespace",
    };
    const target = keys[key];
    if (!target) throw new Error("ac5_unknown_argument");
    options[target] = value;
  }
  if (
    !/^\d+$/.test(options.deployRunId ?? "") ||
    !SHA.test(options.mergeSha ?? "") ||
    !DIGEST.test(options.promotedDigest ?? "")
  )
    throw new Error("ac5_qualification_identity_invalid");
  if (!options.stagingHost || !options.r4Host) throw new Error("ac5_hosts_required");
  return options;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const runner = dependencies.runner ?? execFileAsync;
  const run = (command, args, settings) => runCommand(command, args, { ...settings, runner });
  const deploy = jsonOutput(
    await run(options.gh, ["run", "view", options.deployRunId, "--json", "headSha,status,conclusion"], {
      timeout: 30_000,
    }),
    "deploy",
  );
  if (deploy.headSha !== options.mergeSha || deploy.status !== "completed" || deploy.conclusion !== "success")
    throw new Error("ac5_deploy_not_successful_for_merge");
  const marketplaceRollout = jsonOutput(
    await run(options.kubectl, [
      "get",
      "rollout",
      "-n",
      options.marketplaceNamespace,
      "-l",
      "app.kubernetes.io/name=marketplace",
      "-o",
      "json",
    ]),
    "marketplace_rollout",
  );
  const collectorDaemonSet = jsonOutput(
    await run(options.kubectl, [
      "get",
      "daemonset",
      "observability-agent",
      "-n",
      options.marketplaceNamespace,
      "-o",
      "json",
    ]),
    "collector_rollout",
  );
  const collectorConfig = jsonOutput(
    await run(options.kubectl, [
      "get",
      "configmap",
      "observability-agent",
      "-n",
      options.marketplaceNamespace,
      "-o",
      "json",
    ]),
    "collector_config",
  );
  const pods = jsonOutput(
    await run(options.kubectl, [
      "get",
      "pods",
      "-n",
      options.marketplaceNamespace,
      "-l",
      "app.kubernetes.io/name=marketplace",
      "-o",
      "json",
    ]),
    "marketplace_pods",
  );
  const controllerPods = jsonOutput(
    await run(options.kubectl, [
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
    await run(options.kubectl, [
      "get",
      "configmap",
      "ingress-nginx-controller",
      "-n",
      options.controllerNamespace,
      "-o",
      "json",
    ]),
    "controller_config",
  );
  const service = jsonOutput(
    await run(options.kubectl, [
      "get",
      "service",
      "ingress-nginx-controller",
      "-n",
      options.controllerNamespace,
      "-o",
      "json",
    ]),
    "controller_service",
  );
  const ingress = jsonOutput(await run(options.kubectl, ["get", "ingress", "-A", "-o", "json"]), "ingress_hosts");
  const marketplaceReady = selectReadyPods(pods, { namespace: options.marketplaceNamespace, role: "marketplace" });
  const controllerReady = selectReadyPods(controllerPods, {
    namespace: options.controllerNamespace,
    role: "controller",
  });
  if (!marketplaceReady.length || !controllerReady.length) throw new Error("ac5_ready_pods_missing");
  const rolloutStatus = marketplaceRollout.status ?? {};
  if (
    rolloutStatus.observedGeneration !== marketplaceRollout.metadata?.generation ||
    rolloutStatus.updatedReplicas !== rolloutStatus.readyReplicas ||
    rolloutStatus.readyReplicas !== rolloutStatus.replicas ||
    rolloutStatus.replicas !== 1
  )
    throw new Error("ac5_marketplace_rollout_incomplete");
  const collectorStatus = collectorDaemonSet.status ?? {};
  if (
    collectorStatus.desiredNumberScheduled !== collectorStatus.updatedNumberScheduled ||
    collectorStatus.updatedNumberScheduled !== collectorStatus.numberReady ||
    collectorStatus.numberReady !== collectorStatus.numberAvailable
  )
    throw new Error("ac5_collector_rollout_incomplete");
  const marketplaceDigest = pods.items
    .find((pod) => pod.metadata.name === marketplaceReady[0])
    ?.status?.containerStatuses?.[0]?.imageID?.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
  if (marketplaceDigest !== options.promotedDigest) throw new Error("ac5_marketplace_digest_mismatch");
  if (configMap.data?.["error-log-path"] !== "/dev/null" || typeof configMap.data?.["log-format-upstream"] !== "string")
    throw new Error("ac5_controller_config_mismatch");
  const ip = service.status?.loadBalancer?.ingress?.[0]?.ip;
  if (
    !ip ||
    !Array.isArray(ingress.items) ||
    !ingress.items.some((item) => (item.spec?.rules ?? []).some((rule) => rule.host === options.stagingHost)) ||
    ingress.items.some((item) => (item.spec?.rules ?? []).some((rule) => rule.host === options.r4Host))
  )
    throw new Error("ac5_ingress_host_qualification_failed");
  const sentinels = [`ac5-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`];
  const requests = [];
  async function send(name, method, path, host) {
    const started = new Date();
    const args = buildCurlRequestArgs({ host, path, sentinel: sentinels[0], resolveIP: ip, method });
    const result = await run("curl", args, { timeout: 10_000 });
    const ended = new Date();
    const status = Number.parseInt(result.stdout.trim(), 10);
    requests.push({
      name,
      method,
      path,
      status: Number.isInteger(status) ? status : null,
      exit: result.exit,
      start: toRfc3339(started),
      end: toRfc3339(ended),
    });
    return ended;
  }
  const r1At = await send("R1", "GET", "/sign-in", options.stagingHost);
  await send("R2", "GET", "/api/health", options.stagingHost);
  await send("R3", "POST", "/sign-in", options.stagingHost, { "Content-Length": "1048577" });
  const r4At = await send("R4", "GET", "/probe", options.r4Host);
  const expectedStatuses = [200, 200, 413, 404];
  if (
    requests.some(
      (requestRecord, index) => requestRecord.exit !== 0 || requestRecord.status !== expectedStatuses[index],
    )
  )
    throw new Error("ac5_request_status_mismatch");
  const window = buildProbeWindow({ r1At, r4At });
  const reads = [];
  const readDeadline = Date.now() + READ_TOTAL_TIMEOUT_MS;
  for (const pod of [
    ...controllerReady.map((name) => ({ namespace: options.controllerNamespace, pod: name })),
    ...marketplaceReady.map((name) => ({ namespace: options.marketplaceNamespace, pod: name })),
  ]) {
    const remaining = Math.max(1, Math.min(READ_TIMEOUT_MS, readDeadline - Date.now()));
    const result = await run(options.kubectl, buildKubectlLogsArgs({ ...pod, since: window.t0 }), {
      timeout: remaining,
    });
    reads.push({ ...pod, ...result });
  }
  const controllerLogs = reads
    .filter((read) => read.namespace === options.controllerNamespace)
    .map((read) => read.stdout)
    .join("\n");
  const marketplaceLogs = reads
    .filter((read) => read.namespace === options.marketplaceNamespace)
    .map((read) => read.stdout)
    .join("\n");
  const rows = classifyAc5Rows({
    marketplaceLogs: {
      complete: reads.filter((read) => read.namespace === options.marketplaceNamespace).every((read) => read.complete),
      text: marketplaceLogs,
    },
    controllerLogs: {
      complete: reads.filter((read) => read.namespace === options.controllerNamespace).every((read) => read.complete),
      text: controllerLogs,
    },
    sentinels,
    collector: classifyCollectorConfig(collectorConfig),
  });
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(
    options.output,
    serializeEvidence({
      qualification: {
        deployRunId: options.deployRunId,
        mergeSha: options.mergeSha,
        promotedDigest: options.promotedDigest,
        marketplaceReady,
        controllerReady,
        controllerIP: ip,
        stagingHost: options.stagingHost,
        r4Host: options.r4Host,
        t0: window.t0,
        t1: window.t1,
      },
      requests,
      reads,
      rows,
    }),
    "utf8",
  );
  return rows;
}

export { main };

if (process.argv[1] && process.argv[1].endsWith("ac5-logging-probe.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "ac5_probe_failed");
    process.exitCode = 1;
  });
}
