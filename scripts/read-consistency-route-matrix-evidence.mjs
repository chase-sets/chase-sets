#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    samplerFile: readOption(argv, "--sampler-file") ?? readEnv("READ_CONSISTENCY_ROUTE_MATRIX_SAMPLER_FILE", env),
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

/**
 * Optional join against the route-matrix sampler artifact: the
 * sampler self-generates traffic where the design permits and records a
 * support-safe blocker for every route it cannot drive (private/representative
 * commerce state, unconfigured observation inputs). Without the join, a
 * blocked-by-design route with zero in-window samples is indistinguishable
 * from a regression, and the evidence stays red on every ambient-less window.
 */
export function samplerRoutesByTemplate(samplerReport) {
  if (!samplerReport || !Array.isArray(samplerReport.routes)) {
    return new Map();
  }

  return new Map(
    samplerReport.routes
      .filter((route) => isNonEmptyString(route?.routeTemplate))
      .map((route) => [
        route.routeTemplate,
        {
          status: isNonEmptyString(route.status) ? route.status : "unknown",
          outcomeCategory: isNonEmptyString(route.outcomeCategory) ? route.outcomeCategory : null,
          blockerCategory: isNonEmptyString(route.blockerCategory) ? route.blockerCategory : null,
        },
      ]),
  );
}

export async function runReadConsistencyRouteMatrixEvidence(options, queryPrometheus = null, samplerReport = null) {
  const query =
    queryPrometheus ??
    ((prometheusQuery) =>
      queryPrometheusInstant(prometheusQuery, {
        prometheusUrl: options.prometheusUrl,
        prometheusToken: options.prometheusToken,
      }));
  const samplerRoutes = samplerRoutesByTemplate(samplerReport);
  const globalWorkSignalErrorRate = await query(workSignalErrorRateQuery(options.window));
  const routes = [];

  for (const route of DEFAULT_ROUTE_MATRIX_ROUTES) {
    const queries = routeMatrixPrometheusQueries(route, options.window);
    const [
      sampleCount,
      p95Ms,
      p99Ms,
      timeoutRate,
      missingReceiptCount,
      diagnosticMissingReceiptCount,
      missingTargetContextCount,
      fallbackCount,
    ] = await Promise.all([
      query(queries.sampleCount),
      query(queries.p95Ms),
      query(queries.p99Ms),
      query(queries.timeoutRate),
      query(queries.missingReceiptCount),
      query(queries.diagnosticMissingReceiptCount),
      query(queries.missingTargetContextCount),
      query(queries.exactDependencyFallbackCount),
    ]);

    routes.push(
      routeMatrixRouteEvidence(
        route,
        {
          sampleCount,
          p95Ms,
          p99Ms,
          timeoutRate,
          workSignalErrorRate: globalWorkSignalErrorRate,
          missingReceiptCount,
          diagnosticMissingReceiptCount,
          missingTargetContextCount,
          exactDependencyFallbackCount: fallbackCount,
        },
        samplerRoutes.get(route.routeTemplate) ?? null,
      ),
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
      diagnosticMissingReceiptCount: nonNegativeInteger(route.wakeBeforeWait.diagnosticMissingReceiptCount),
      missingTargetContextCount: nonNegativeInteger(route.wakeBeforeWait.missingTargetContextCount),
      exactDependencyFallbackCount: nonNegativeInteger(route.wakeBeforeWait.exactDependencyFallbackCount),
      ...(route.wakeBeforeWait.sampler
        ? {
            sampler: {
              status: route.wakeBeforeWait.sampler.status,
              outcomeCategory: route.wakeBeforeWait.sampler.outcomeCategory ?? null,
              blockerCategory: route.wakeBeforeWait.sampler.blockerCategory ?? null,
            },
          }
        : {}),
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
      failingRouteCount: routes.filter((route) => route.wakeBeforeWait.status === "fail").length,
      // Blocked = the sampler recorded a support-safe blocker and the window
      // held zero samples: a coverage gap to close, never proof
      // of wake health and never conflated with a failing route.
      blockedRouteCount: routes.filter((route) => route.wakeBeforeWait.status === "blocked").length,
      coverage: routes.some((route) => route.wakeBeforeWait.status === "blocked") ? "partial" : "full",
      globalWorkSignalErrorRate: nonNegativeRate(input.globalWorkSignalErrorRate),
    },
    routes,
  };
}

export function routeMatrixRouteEvidence(route, measurement, samplerRoute = null) {
  const sampleCount = nonNegativeInteger(measurement.sampleCount);
  const p95Ms = nullableNonNegativeInteger(measurement.p95Ms);
  const p99Ms = nullableNonNegativeInteger(measurement.p99Ms);
  const timeoutRate = nonNegativeRate(measurement.timeoutRate);
  const workSignalErrorRate = nonNegativeRate(measurement.workSignalErrorRate);
  const missingReceiptCount = nonNegativeInteger(measurement.missingReceiptCount);
  const diagnosticMissingReceiptCount = nonNegativeInteger(measurement.diagnosticMissingReceiptCount);
  const missingTargetContextCount = nonNegativeInteger(measurement.missingTargetContextCount);
  const exactDependencyFallbackCount = nonNegativeInteger(measurement.exactDependencyFallbackCount);
  const metricStatus =
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
  // A route the sampler could not drive (support-safe blocker recorded) with
  // zero in-window samples is a coverage gap, not an SLO regression: report it
  // as `blocked` so the evidence distinguishes "no traffic possible" from
  // "traffic present and failing". Ambient samples always win —
  // any nonzero sampleCount keeps the strict metric-based verdict.
  const status = samplerRoute?.status === "blocked" && sampleCount === 0 ? "blocked" : metricStatus;

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
      diagnosticMissingReceiptCount,
      missingTargetContextCount,
      exactDependencyFallbackCount,
      ...(samplerRoute
        ? {
            sampler: {
              status: samplerRoute.status,
              outcomeCategory: samplerRoute.outcomeCategory,
              blockerCategory: samplerRoute.blockerCategory,
            },
          }
        : {}),
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
  const receiptBackedRouteLabels = `${routeLabels},receipt="present"`;
  const routeOnlyLabels = prometheusLabels({
    mount_path: route.metricMountPath,
    route_path: route.metricRoutePath,
  });
  const receiptBackedRouteOnlyLabels = `${routeOnlyLabels},receipt="present"`;

  return {
    sampleCount: `sum(increase(chase_sets_projection_freshness_evaluations_total{${receiptBackedRouteLabels},wait_mode="exact-dependency"}[${window}]))`,
    p95Ms: `histogram_quantile(0.95, sum by (le) (rate(chase_sets_projection_freshness_wait_duration_ms_bucket{${receiptBackedRouteLabels},wait_mode="exact-dependency",outcome="fresh"}[${window}])))`,
    p99Ms: `histogram_quantile(0.99, sum by (le) (rate(chase_sets_projection_freshness_wait_duration_ms_bucket{${receiptBackedRouteLabels},wait_mode="exact-dependency",outcome="fresh"}[${window}])))`,
    timeoutRate: `sum(increase(chase_sets_projection_freshness_evaluations_total{${receiptBackedRouteLabels},wait_mode="exact-dependency",outcome="timeout"}[${window}])) / clamp_min(sum(increase(chase_sets_projection_freshness_evaluations_total{${receiptBackedRouteLabels},wait_mode="exact-dependency"}[${window}])), 1)`,
    missingReceiptCount: `sum(increase(chase_sets_projection_freshness_evaluations_total{${routeLabels},wait_mode="exact-dependency",receipt="missing",outcome!="missing-receipt"}[${window}]))`,
    diagnosticMissingReceiptCount: `sum(increase(chase_sets_projection_freshness_evaluations_total{${routeLabels},wait_mode="exact-dependency",receipt="missing",outcome="missing-receipt"}[${window}]))`,
    missingTargetContextCount: `sum(increase(chase_sets_projection_freshness_evaluations_total{${receiptBackedRouteLabels},wait_mode="exact-dependency",target_context_header=~"missing|present_invalid"}[${window}]))`,
    exactDependencyFallbackCount: `sum(increase(chase_sets_projection_freshness_evaluations_total{${receiptBackedRouteOnlyLabels},wait_mode!="exact-dependency"}[${window}]))`,
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
  let samplerReport = null;
  if (isNonEmptyString(options.samplerFile)) {
    try {
      samplerReport = JSON.parse(await readFile(options.samplerFile, "utf8"));
    } catch (error) {
      console.error(
        `--sampler-file '${options.samplerFile}' could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 2;
    }
  }
  const evidence = await runReadConsistencyRouteMatrixEvidence(options, null, samplerReport);
  if (options.outPath) {
    await mkdir(dirname(options.outPath), { recursive: true });
    await writeFile(options.outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  console.log(JSON.stringify(evidence, null, 2));
  // Fail only on routes with real in-window signal that breaches. Routes the
  // sampler recorded as blocked-by-design surface as `blocked` with
  // coverage: "partial" — a loudly reported coverage gap, not gate noise that
  // reads identically to a wake regression. The release-health
  // report keeps treating any non-pass route as not-passing evidence.
  return evidence.routes.some((route) => route.wakeBeforeWait.status === "fail") ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
