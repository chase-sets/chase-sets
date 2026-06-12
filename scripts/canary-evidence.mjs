#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CANARY_ANALYSIS_VERSION, evaluateCanaryAnalysis } from "./canary-analysis.mjs";
import { normalizeString, readEnv, readOption, readRepeatedOptions } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const CANARY_EVIDENCE_VERSION = CANARY_ANALYSIS_VERSION;

export const REQUIRED_CANARY_SIGNALS = [
  {
    name: "app-platform-deployment-phase",
    owner: "infrastructure/deployment-workflow",
    source: "DigitalOcean App Platform deployment phase",
    maxIncrease: 0,
    currentState: "available-now",
    detail: "Canary components must be ready and the App Platform deployment must be ACTIVE.",
  },
  {
    name: "route-error-rate",
    owner: "platform-runtime/route-owner",
    source: "HTTP telemetry by route and host",
    maxIncrease: 0.005,
    currentState: "needs-instrumentation",
    detail: "Compare public, admin, marketplace, and API route error rate to the stable baseline.",
  },
  {
    name: "route-latency-p95",
    owner: "platform-runtime/route-owner",
    source: "HTTP latency histogram by route and host",
    maxIncrease: 50,
    currentState: "needs-instrumentation",
    detail: "Compare p95 latency in milliseconds to the stable baseline.",
  },
  {
    name: "worker-health-backlog",
    owner: "platform-operations/infrastructure-runtime",
    source: "worker heartbeat and durable job backlog telemetry",
    maxIncrease: 0,
    currentState: "needs-instrumentation",
    detail: "No new sustained backlog or runner failure may appear during the canary window.",
  },
  {
    name: "projection-lag-poison-events",
    owner: "owning-bounded-context/platform-operations",
    source: "projection operation snapshots and poison-event telemetry",
    maxIncrease: 0,
    currentState: "available-now",
    detail: "No new degraded projection group or poison event may be caused by the canary release.",
  },
  {
    name: "checkout-order-payment-errors",
    owner: "checkout/ordering/payments",
    source: "checkout, order, payment, and provider-health telemetry",
    maxIncrease: 0,
    currentState: "needs-instrumentation",
    detail: "No increase in command failures, session failures, or payment provider-health failures.",
  },
  {
    name: "settlement-payout-errors",
    owner: "settlement",
    source: "settlement operation telemetry for payout setup, readiness, and provider reconciliation",
    maxIncrease: 0,
    currentState: "available-now",
    detail:
      "No increase in payout setup session failures, readiness refresh failures, readiness webhook ignores, setup-blocked payout requests, or provider reconciliation failures.",
  },
  {
    name: "fulfillment-postage-callback-errors",
    owner: "fulfillment",
    source: "postage provider callback telemetry",
    maxIncrease: 0,
    currentState: "needs-instrumentation",
    detail: "No new callback signature, parse, or provider reconciliation failures.",
  },
  {
    name: "transactional-email-callback-errors",
    owner: "notifications",
    source: "SES/SNS callback and outbox telemetry",
    maxIncrease: 0,
    currentState: "needs-instrumentation",
    detail: "No callback or outbox delivery failure spike during the canary window.",
  },
  {
    name: "database-pool-pressure",
    owner: "infrastructure-runtime",
    source: "database pool and migration telemetry",
    maxIncrease: 0,
    currentState: "needs-instrumentation",
    detail: "No connection exhaustion, saturation, or bootstrap migration pressure.",
  },
  {
    name: "ucp-discovery-signed-write-health",
    owner: "ucp-facade-owners",
    source: "UCP discovery and signed-write telemetry",
    maxIncrease: 0,
    currentState: "deferred",
    detail: "Discovery stays healthy and signed-write rejects do not spike once UCP is enabled.",
  },
];

export function parseCanaryEvidenceArgs(argv, env = process.env) {
  const prometheusHeaders = readPrometheusHeaders({
    headerOptions: readRepeatedOptions(argv, "--prometheus-header"),
    headersJson:
      readOption(argv, "--prometheus-headers-json") ??
      readEnv("CANARY_PROMETHEUS_HEADERS", env) ??
      readEnv("PROMETHEUS_HEADERS", env),
  });

  return {
    outPath: readOption(argv, "--out") ?? readEnv("CANARY_EVIDENCE_OUT", env),
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    observationWindowSeconds: normalizeNonNegativeInteger(
      readOption(argv, "--observation-window-seconds") ?? readEnv("CANARY_OBSERVATION_WINDOW_SECONDS", env) ?? "300",
    ),
    sourceFiles: readRepeatedOptions(argv, "--source-file"),
    prometheusBaseUrl:
      readOption(argv, "--prometheus-base-url") ??
      readEnv("CANARY_PROMETHEUS_URL", env) ??
      readEnv("PROMETHEUS_URL", env),
    prometheusQueryFile: readOption(argv, "--prometheus-query-file") ?? readEnv("CANARY_PROMETHEUS_QUERY_FILE", env),
    prometheusHeaders,
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function collectCanaryEvidence(options) {
  const telemetrySources = await Promise.all([
    ...options.sourceFiles.map(readTelemetrySource),
    ...(options.prometheusBaseUrl && options.prometheusQueryFile
      ? [
          collectPrometheusTelemetry({
            baseUrl: options.prometheusBaseUrl,
            queryFile: options.prometheusQueryFile,
            headers: options.prometheusHeaders,
            fetchImpl: options.fetchImpl ?? globalThis.fetch,
          }),
        ]
      : []),
  ]);
  const telemetry = mergeTelemetrySources(telemetrySources);
  const evidence = buildCanaryEvidence({
    releaseCommit: options.releaseCommit,
    observationWindowSeconds: options.observationWindowSeconds,
    checkedAt: options.checkedAt,
    telemetry,
  });
  const analysis = evaluateCanaryAnalysis(evidence);

  if (options.outPath) {
    await writeJsonRecord(options.outPath, evidence);
  }

  return { evidence, analysis };
}

export async function collectPrometheusTelemetry({ baseUrl, queryFile, headers = {}, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required for Prometheus canary evidence.");
  }

  const queryConfig = JSON.parse(await readFile(queryFile, "utf8"));
  const signals = [];
  for (const signal of readSignals(queryConfig)) {
    const errors = validatePrometheusSignalConfig(signal);
    if (errors.length > 0) {
      throw new Error(`Invalid Prometheus canary signal ${signal.name ?? "unknown"}: ${errors.join(" ")}`);
    }

    const [baseline, canary] = await Promise.all([
      queryPrometheus({ baseUrl, query: signal.baselineQuery, headers, fetchImpl }),
      queryPrometheus({ baseUrl, query: signal.canaryQuery, headers, fetchImpl }),
    ]);

    const source = normalizeString(signal.source) ?? `Prometheus: ${signal.canaryQuery}`;
    signals.push({
      name: signal.name,
      owner: signal.owner,
      required: signal.required,
      source,
      currentState: signal.currentState ?? "available-now",
      baseline,
      canary,
      maxIncrease: signal.maxIncrease,
      threshold:
        typeof signal.threshold === "string"
          ? signal.threshold
          : typeof signal.maxIncrease === "number"
            ? `<= baseline + ${signal.maxIncrease}`
            : undefined,
      status: baseline === null || canary === null ? "missing" : undefined,
      detail:
        baseline === null || canary === null
          ? `Prometheus returned no numeric result for ${signal.name}.`
          : signal.detail,
    });
  }
  return { signals };
}

export function readPrometheusHeaders({ headerOptions = [], headersJson } = {}) {
  const headers = {};

  if (headersJson) {
    let parsed;
    try {
      parsed = JSON.parse(headersJson);
    } catch {
      throw new Error("Prometheus headers must be a JSON object.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Prometheus headers must be a JSON object.");
    }
    for (const [name, value] of Object.entries(parsed)) {
      const normalizedName = normalizeHeaderName(name);
      if (normalizedName) {
        headers[normalizedName] = String(value);
      }
    }
  }

  for (const option of headerOptions) {
    const separatorIndex = option.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error(`Prometheus header must use "Name: value" format: ${option}`);
    }
    const normalizedName = normalizeHeaderName(option.slice(0, separatorIndex));
    if (normalizedName) {
      headers[normalizedName] = option.slice(separatorIndex + 1).trim();
    }
  }

  return headers;
}

export function validatePrometheusSignalConfig(signal) {
  const errors = [];
  if (!normalizeString(signal?.name)) {
    errors.push("name is required.");
  }
  if (!normalizeString(signal?.owner)) {
    errors.push("owner is required.");
  }
  if (!normalizeString(signal?.source)) {
    errors.push("source is required.");
  }
  if (!normalizeString(signal?.baselineQuery)) {
    errors.push("baselineQuery is required.");
  }
  if (!normalizeString(signal?.canaryQuery)) {
    errors.push("canaryQuery is required.");
  }
  if (typeof signal?.maxIncrease !== "number" || !Number.isFinite(signal.maxIncrease) || signal.maxIncrease < 0) {
    errors.push("maxIncrease must be a non-negative number.");
  }
  return errors;
}

export function buildCanaryEvidence(input) {
  const telemetry = input.telemetry ?? {};

  return {
    schemaVersion: CANARY_EVIDENCE_VERSION,
    releaseCommit: input.releaseCommit ?? "",
    checkedAt: input.checkedAt,
    observationWindowSeconds: normalizeNonNegativeInteger(input.observationWindowSeconds ?? 0),
    signals: REQUIRED_CANARY_SIGNALS.map((signal) => buildSignalEvidence(signal, telemetry[signal.name])),
  };
}

function buildSignalEvidence(signal, telemetry) {
  if (!telemetry) {
    return {
      name: signal.name,
      owner: signal.owner,
      required: true,
      source: signal.source,
      currentState: signal.currentState,
      maxIncrease: signal.maxIncrease,
      status: "missing",
      detail: `No telemetry found for ${signal.name} from ${signal.source}. ${signal.detail}`,
    };
  }

  return {
    name: signal.name,
    owner: normalizeString(telemetry.owner) ?? signal.owner,
    required: telemetry.required !== false,
    source: normalizeString(telemetry.source) ?? signal.source,
    currentState: normalizeString(telemetry.currentState) ?? signal.currentState,
    ...(typeof telemetry.baseline === "number" ? { baseline: telemetry.baseline } : {}),
    ...(typeof telemetry.canary === "number" ? { canary: telemetry.canary } : {}),
    ...(typeof telemetry.maxIncrease === "number"
      ? { maxIncrease: telemetry.maxIncrease }
      : { maxIncrease: signal.maxIncrease }),
    ...(typeof telemetry.status === "string" ? { status: telemetry.status } : {}),
    ...(typeof telemetry.threshold === "string" ? { threshold: telemetry.threshold } : {}),
    detail: normalizeString(telemetry.detail) ?? signal.detail,
  };
}

async function readTelemetrySource(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function queryPrometheus({ baseUrl, query, headers, fetchImpl }) {
  const url = new URL("/api/v1/query", baseUrl);
  url.searchParams.set("query", query);
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`Prometheus query failed: ${response.status}`);
  }
  const body = await response.json();
  return readPrometheusNumber(body);
}

function readPrometheusNumber(body) {
  if (body?.status !== "success") {
    return null;
  }
  const resultType = body?.data?.resultType;
  const result = body?.data?.result;
  if (resultType === "scalar" && Array.isArray(result)) {
    return toNumber(result[1]);
  }
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0];
    if (Array.isArray(first?.value)) {
      return toNumber(first.value[1]);
    }
    if (Array.isArray(first?.values) && first.values.length > 0) {
      return toNumber(first.values.at(-1)?.[1]);
    }
  }
  return null;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mergeTelemetrySources(sources) {
  const merged = {};
  for (const source of sources) {
    for (const signal of readSignals(source)) {
      if (typeof signal.name === "string" && signal.name.trim()) {
        merged[signal.name.trim()] = signal;
      }
    }
  }
  return merged;
}

function readSignals(source) {
  if (Array.isArray(source?.signals)) {
    return source.signals;
  }
  if (source?.signals && typeof source.signals === "object") {
    return Object.entries(source.signals).map(([name, value]) => ({ name, ...(value ?? {}) }));
  }
  return [];
}

async function main(argv, env = process.env) {
  try {
    const options = parseCanaryEvidenceArgs(argv, env);
    if (!options.outPath) {
      console.error("CANARY_EVIDENCE_OUT or --out is required.");
      return 2;
    }
    const result = await collectCanaryEvidence(options);
    console.log(JSON.stringify(result.evidence, null, 2));
    if (!result.analysis.passesCanaryAnalysisGate) {
      for (const error of result.analysis.errors ?? []) {
        console.error(error);
      }
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function normalizeNonNegativeInteger(value) {
  const normalized = Number.parseInt(String(value), 10);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : 0;
}

function normalizeHeaderName(name) {
  const normalized = normalizeString(name);
  if (!normalized) {
    return null;
  }
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(normalized)) {
    throw new Error(`Invalid Prometheus header name: ${normalized}`);
  }
  return normalized;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
