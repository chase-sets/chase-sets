#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";

export const READ_CONSISTENCY_ROUTE_MATRIX_EVIDENCE_VERSION = "read-consistency-route-matrix-evidence/v1";
export const DEFAULT_PROMETHEUS_WINDOW = "30m";
export const PROMETHEUS_QUERY_TOKEN_HEADER = "X-Chase-Sets-Observability-Query";

export const DEFAULT_ROUTE_MATRIX_ROUTES = [
  {
    label: "checkout",
    routeTemplate: "/checkout/buy/session/:sessionId",
    metricMountPath: "/api/marketplace",
    metricRoutePath: "/account/checkout-sessions/:sessionId",
    targetContext: "checkout",
    projectionName: "checkout.session-projection",
  },
  {
    label: "cart",
    routeTemplate: "/account/cart",
    metricMountPath: "/api/marketplace",
    metricRoutePath: "/account/cart",
    targetContext: "checkout",
    projectionName: "checkout.cart-projection",
  },
  {
    label: "sell-list",
    routeTemplate: "/account/sell-list",
    metricMountPath: "/api/marketplace",
    metricRoutePath: "/account/sell-list",
    targetContext: "checkout",
    projectionName: "checkout.sell-list-projection",
  },
  {
    label: "payout",
    routeTemplate: "/account/payouts/:payoutId",
    metricMountPath: "/api/settlement",
    metricRoutePath: "/payouts/:id",
    targetContext: "settlement",
    projectionName: "settlement-payout-projection",
  },
  {
    label: "payment",
    routeTemplate: "/account/payments/:paymentId",
    metricMountPath: "/api/marketplace",
    metricRoutePath: "/account/payments/:id",
    targetContext: "payments",
    projectionName: "payments-payment-projection",
  },
  {
    label: "listing",
    routeTemplate: "/account/listings/:listingId",
    metricMountPath: "/api/marketplace",
    metricRoutePath: "/account/listings/:id",
    targetContext: "marketplace",
    projectionName: "marketplace-listing-projection",
  },
];

export function parseReadConsistencyRouteMatrixEvidenceArgs(argv, env = process.env) {
  return {
    prometheusUrl: readOption(argv, "--prometheus-url") ?? readEnv("PROMETHEUS_URL", env),
    prometheusToken: readOption(argv, "--prometheus-token") ?? readEnv("PROMETHEUS_QUERY_TOKEN", env),
    environment: readOption(argv, "--environment") ?? readEnv("ROUTE_MATRIX_EVIDENCE_ENVIRONMENT", env) ?? "staging",
    window: readOption(argv, "--window") ?? readEnv("ROUTE_MATRIX_EVIDENCE_WINDOW", env) ?? DEFAULT_PROMETHEUS_WINDOW,
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    outPath:
      readOption(argv, "--out") ??
      readEnv("READ_CONSISTENCY_ROUTE_MATRIX_EVIDENCE_OUT", env) ??
      "artifacts/wake-drills/read-consistency-route-matrix-evidence.json",
  };
}

export function validateReadConsistencyRouteMatrixEvidenceOptions(options) {
  const errors = [];
  if (!isNonEmptyString(options.prometheusUrl)) {
    errors.push("PROMETHEUS_URL or --prometheus-url is required.");
  }
  if (!isNonEmptyString(options.environment)) {
    errors.push("--environment is required.");
  }
  if (!isIsoTimestamp(options.checkedAt)) {
    errors.push("--checked-at must be an ISO timestamp.");
  }
  if (!/^[1-9][0-9]*(?:s|m|h|d)$/.test(options.window)) {
    errors.push("--window must be a Prometheus range such as 30m, 2h, or 1d.");
  }
  return errors;
}

export async function runReadConsistencyRouteMatrixEvidence(options, queryPrometheus = null) {
  const query =
    queryPrometheus ??
    ((prometheusQuery) =>
      queryPrometheusInstant(prometheusQuery, {
        prometheusUrl: options.prometheusUrl,
        prometheusToken: options.prometheusToken,
      }));
  const globalWorkSignalErrorRate = await query(workSignalErrorRateQuery(options.window));
  const routes = [];

  for (const route of DEFAULT_ROUTE_MATRIX_ROUTES) {
    const queries = routeMatrixPrometheusQueries(route, options.window);
    const [sampleCount, p95Ms, p99Ms, timeoutRate, missingReceiptCount, missingTargetContextCount, fallbackCount] =
      await Promise.all([
        query(queries.sampleCount),
        query(queries.p95Ms),
        query(queries.p99Ms),
        query(queries.timeoutRate),
        query(queries.missingReceiptCount),
        query(queries.missingTargetContextCount),
        query(queries.exactDependencyFallbackCount),
      ]);

    routes.push(
      routeMatrixRouteEvidence(route, {
        sampleCount,
        p95Ms,
        p99Ms,
        timeoutRate,
        workSignalErrorRate: globalWorkSignalErrorRate,
        missingReceiptCount,
        missingTargetContextCount,
        exactDependencyFallbackCount: fallbackCount,
      }),
    );
  }

  return buildReadConsistencyRouteMatrixEvidence({
    environment: options.environment,
    checkedAt: options.checkedAt,
    window: options.window,
    prometheusUrl: options.prometheusUrl,
    routes,
    globalWorkSignalErrorRate,
  });
}

export function buildReadConsistencyRouteMatrixEvidence(input) {
  const routes = input.routes.map((route) => ({
    routeTemplate: route.routeTemplate,
    targetContext: route.targetContext,
    projectionName: route.projectionName,
    wakeBeforeWait: {
      status: route.wakeBeforeWait.status,
      sampleCount: nonNegativeInteger(route.wakeBeforeWait.sampleCount),
      p95Ms: nullableNonNegativeInteger(route.wakeBeforeWait.p95Ms),
      p99Ms: nullableNonNegativeInteger(route.wakeBeforeWait.p99Ms),
      timeoutRate: nonNegativeRate(route.wakeBeforeWait.timeoutRate),
      workSignalErrorRate: nonNegativeRate(route.wakeBeforeWait.workSignalErrorRate),
      missingReceiptCount: nonNegativeInteger(route.wakeBeforeWait.missingReceiptCount),
      missingTargetContextCount: nonNegativeInteger(route.wakeBeforeWait.missingTargetContextCount),
      exactDependencyFallbackCount: nonNegativeInteger(route.wakeBeforeWait.exactDependencyFallbackCount),
      targetContext: route.targetContext,
      projectionName: route.projectionName,
    },
    metricLabels: {
      mountPath: route.metricLabels.mountPath,
      routePath: route.metricLabels.routePath,
      targetContext: route.targetContext,
      projectionName: route.projectionName,
    },
  }));

  return {
    schemaVersion: READ_CONSISTENCY_ROUTE_MATRIX_EVIDENCE_VERSION,
    environment: input.environment,
    checkedAt: input.checkedAt,
    window: input.window,
    source: {
      kind: "prometheus",
      queryUrl: redactPrometheusUrl(input.prometheusUrl),
      metricFamilies: [
        "chase_sets_projection_freshness_evaluations_total",
        "chase_sets_projection_freshness_wait_duration_ms_bucket",
        "chase_sets_projection_freshness_work_signal_errors_total",
      ],
    },
    summary: {
      routeCount: routes.length,
      passingRouteCount: routes.filter((route) => route.wakeBeforeWait.status === "pass").length,
      globalWorkSignalErrorRate: nonNegativeRate(input.globalWorkSignalErrorRate),
    },
    routes,
  };
}

export function routeMatrixRouteEvidence(route, measurement) {
  const sampleCount = nonNegativeInteger(measurement.sampleCount);
  const p95Ms = nullableNonNegativeInteger(measurement.p95Ms);
  const p99Ms = nullableNonNegativeInteger(measurement.p99Ms);
  const timeoutRate = nonNegativeRate(measurement.timeoutRate);
  const workSignalErrorRate = nonNegativeRate(measurement.workSignalErrorRate);
  const missingReceiptCount = nonNegativeInteger(measurement.missingReceiptCount);
  const missingTargetContextCount = nonNegativeInteger(measurement.missingTargetContextCount);
  const exactDependencyFallbackCount = nonNegativeInteger(measurement.exactDependencyFallbackCount);
  const status =
    sampleCount > 0 &&
    p95Ms !== null &&
    p99Ms !== null &&
    timeoutRate === 0 &&
    workSignalErrorRate === 0 &&
    missingReceiptCount === 0 &&
    missingTargetContextCount === 0 &&
    exactDependencyFallbackCount === 0
      ? "pass"
      : "fail";

  return {
    routeTemplate: route.routeTemplate,
    targetContext: route.targetContext,
    projectionName: route.projectionName,
    metricLabels: {
      mountPath: route.metricMountPath,
      routePath: route.metricRoutePath,
    },
    wakeBeforeWait: {
      status,
      sampleCount,
      p95Ms,
      p99Ms,
      timeoutRate,
      workSignalErrorRate,
      missingReceiptCount,
      missingTargetContextCount,
      exactDependencyFallbackCount,
    },
  };
}

export function routeMatrixPrometheusQueries(route, window) {
  const routeLabels = prometheusLabels({
    mount_path: route.metricMountPath,
    route_path: route.metricRoutePath,
    target_context: route.targetContext,
    projection: route.projectionName,
  });
  const routeOnlyLabels = prometheusLabels({
    mount_path: route.metricMountPath,
    route_path: route.metricRoutePath,
  });

  return {
    sampleCount: `sum(increase(chase_sets_projection_freshness_evaluations_total{${routeLabels},wait_mode="exact-dependency"}[${window}]))`,
    p95Ms: `histogram_quantile(0.95, sum by (le) (rate(chase_sets_projection_freshness_wait_duration_ms_bucket{${routeLabels},wait_mode="exact-dependency",outcome="fresh"}[${window}])))`,
    p99Ms: `histogram_quantile(0.99, sum by (le) (rate(chase_sets_projection_freshness_wait_duration_ms_bucket{${routeLabels},wait_mode="exact-dependency",outcome="fresh"}[${window}])))`,
    timeoutRate: `sum(increase(chase_sets_projection_freshness_evaluations_total{${routeLabels},wait_mode="exact-dependency",outcome="timeout"}[${window}])) / clamp_min(sum(increase(chase_sets_projection_freshness_evaluations_total{${routeLabels},wait_mode="exact-dependency"}[${window}])), 1)`,
    missingReceiptCount: `sum(increase(chase_sets_projection_freshness_evaluations_total{${routeLabels},wait_mode="exact-dependency",receipt="missing"}[${window}]))`,
    missingTargetContextCount: `sum(increase(chase_sets_projection_freshness_evaluations_total{${routeLabels},wait_mode="exact-dependency",target_context_header=~"missing|present_invalid"}[${window}]))`,
    exactDependencyFallbackCount: `sum(increase(chase_sets_projection_freshness_evaluations_total{${routeOnlyLabels},wait_mode!="exact-dependency"}[${window}]))`,
  };
}

export function workSignalErrorRateQuery(window) {
  return `sum(increase(chase_sets_projection_freshness_work_signal_errors_total{wait_mode="exact-dependency"}[${window}])) / clamp_min(sum(increase(chase_sets_projection_freshness_evaluations_total{wait_mode="exact-dependency"}[${window}])), 1)`;
}

export async function queryPrometheusInstant(query, options = {}) {
  if (!isNonEmptyString(options.prometheusUrl)) {
    throw new Error("queryPrometheusInstant requires prometheusUrl.");
  }
  const endpoint = new URL("/api/v1/query", trimTrailingSlash(options.prometheusUrl));
  endpoint.searchParams.set("query", query);
  const headers = {};
  if (isNonEmptyString(options.prometheusToken)) {
    headers[PROMETHEUS_QUERY_TOKEN_HEADER] = options.prometheusToken;
  }
  const response = await (options.fetchImpl ?? fetch)(endpoint, { headers });
  if (!response.ok) {
    throw new Error(`Prometheus query failed with HTTP ${response.status}.`);
  }
  const payload = await response.json();
  if (payload?.status !== "success") {
    throw new Error(`Prometheus query failed: ${payload?.error ?? "unknown error"}.`);
  }
  return prometheusResultValue(payload?.data?.result);
}

export function prometheusResultValue(result) {
  if (!Array.isArray(result) || result.length === 0) {
    return null;
  }
  const value = result[0]?.value;
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const parsed = Number(value[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function prometheusLabels(labels) {
  return Object.entries(labels)
    .map(([key, value]) => `${key}="${escapePrometheusLabel(value)}"`)
    .join(",");
}

function escapePrometheusLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function nullableNonNegativeInteger(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function nonNegativeRate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(1, parsed);
}

function redactPrometheusUrl(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "invalid-url";
  }
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function isIsoTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && value.includes("T");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function main(argv, env = process.env) {
  const options = parseReadConsistencyRouteMatrixEvidenceArgs(argv, env);
  const errors = validateReadConsistencyRouteMatrixEvidenceOptions(options);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    return 2;
  }
  const evidence = await runReadConsistencyRouteMatrixEvidence(options);
  if (options.outPath) {
    await mkdir(dirname(options.outPath), { recursive: true });
    await writeFile(options.outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  console.log(JSON.stringify(evidence, null, 2));
  return evidence.routes.every((route) => route.wakeBeforeWait.status === "pass") ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
