import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTE_MATRIX_ROUTES,
  PROMETHEUS_QUERY_TOKEN_HEADER,
  READ_CONSISTENCY_ROUTE_MATRIX_EVIDENCE_VERSION,
  buildReadConsistencyRouteMatrixEvidence,
  parseReadConsistencyRouteMatrixEvidenceArgs,
  prometheusResultValue,
  queryPrometheusInstant,
  routeMatrixPrometheusQueries,
  routeMatrixRouteEvidence,
  runReadConsistencyRouteMatrixEvidence,
  validateReadConsistencyRouteMatrixEvidenceOptions,
  workSignalErrorRateQuery,
} from "./read-consistency-route-matrix-evidence.mjs";

const checkedAt = "2026-06-30T20:00:00.000Z";

describe("read consistency route matrix evidence", () => {
  it("parses Prometheus route-matrix options from flags and environment", () => {
    expect(
      parseReadConsistencyRouteMatrixEvidenceArgs(
        [
          "--prometheus-url",
          "https://prometheus.staging.chasesets.com",
          "--environment",
          "staging",
          "--window",
          "45m",
          "--checked-at",
          checkedAt,
          "--out",
          "artifacts/route-matrix.json",
        ],
        {},
      ),
    ).toMatchObject({
      prometheusUrl: "https://prometheus.staging.chasesets.com",
      environment: "staging",
      window: "45m",
      checkedAt,
      outPath: "artifacts/route-matrix.json",
    });

    expect(
      parseReadConsistencyRouteMatrixEvidenceArgs([], {
        PROMETHEUS_URL: "https://prometheus.example.test",
        PROMETHEUS_QUERY_TOKEN: "secret-token",
      }),
    ).toMatchObject({
      prometheusUrl: "https://prometheus.example.test",
      prometheusToken: "secret-token",
      environment: "staging",
      window: "30m",
    });
  });

  it("validates required options without contacting Prometheus", () => {
    expect(
      validateReadConsistencyRouteMatrixEvidenceOptions({
        prometheusUrl: null,
        environment: "",
        checkedAt: "soon",
        window: "forever",
      }),
    ).toEqual([
      "PROMETHEUS_URL or --prometheus-url is required.",
      "--environment is required.",
      "--checked-at must be an ISO timestamp.",
      "--window must be a Prometheus range such as 30m, 2h, or 1d.",
    ]);
  });

  it("builds support-safe route matrix evidence and redacts Prometheus credentials", () => {
    const routes = DEFAULT_ROUTE_MATRIX_ROUTES.map((route) =>
      routeMatrixRouteEvidence(route, {
        sampleCount: 24,
        p95Ms: 420,
        p99Ms: 710,
        timeoutRate: 0,
        workSignalErrorRate: 0,
        missingReceiptCount: 0,
        missingTargetContextCount: 0,
        exactDependencyFallbackCount: 0,
      }),
    );

    const evidence = buildReadConsistencyRouteMatrixEvidence({
      environment: "staging",
      checkedAt,
      window: "30m",
      prometheusUrl: "https://user:password@prometheus.staging.chasesets.com/api?token=secret",
      globalWorkSignalErrorRate: 0,
      routes,
    });

    expect(evidence).toMatchObject({
      schemaVersion: READ_CONSISTENCY_ROUTE_MATRIX_EVIDENCE_VERSION,
      environment: "staging",
      summary: {
        routeCount: 6,
        passingRouteCount: 6,
        globalWorkSignalErrorRate: 0,
      },
      source: {
        queryUrl: "https://prometheus.staging.chasesets.com/api",
      },
    });
    expect(evidence.routes[0]).toMatchObject({
      routeTemplate: "/checkout/buy/session/:sessionId",
      targetContext: "checkout",
      projectionName: "checkout.session-projection",
      wakeBeforeWait: {
        status: "pass",
        sampleCount: 24,
        p95Ms: 420,
        p99Ms: 710,
        targetContext: "checkout",
        projectionName: "checkout.session-projection",
      },
      metricLabels: {
        mountPath: "/api/marketplace",
        routePath: "/account/checkout-sessions/:sessionId",
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("password");
    expect(JSON.stringify(evidence)).not.toContain("secret");
  });

  it("fails a route when samples, labels, or safety counters are not green", () => {
    const route = routeMatrixRouteEvidence(DEFAULT_ROUTE_MATRIX_ROUTES[3], {
      sampleCount: 0,
      p95Ms: 420,
      p99Ms: 710,
      timeoutRate: 0,
      workSignalErrorRate: 0,
      missingReceiptCount: 0,
      missingTargetContextCount: 0,
      exactDependencyFallbackCount: 0,
    });

    expect(route).toMatchObject({
      routeTemplate: "/account/payouts/:payoutId",
      targetContext: "settlement",
      projectionName: "settlement-payout-projection",
      wakeBeforeWait: {
        status: "fail",
        sampleCount: 0,
      },
    });
  });

  it("builds bounded Prometheus queries for each route", () => {
    const checkout = DEFAULT_ROUTE_MATRIX_ROUTES[0];
    const queries = routeMatrixPrometheusQueries(checkout, "30m");

    expect(queries.sampleCount).toContain("chase_sets_projection_freshness_evaluations_total");
    expect(queries.sampleCount).toContain('mount_path="/api/marketplace"');
    expect(queries.sampleCount).toContain('route_path="/account/checkout-sessions/:sessionId"');
    expect(queries.sampleCount).toContain('target_context="checkout"');
    expect(queries.sampleCount).toContain('projection="checkout.session-projection"');
    expect(queries.sampleCount).toContain('wait_mode="exact-dependency"');
    expect(queries.p95Ms).toContain("histogram_quantile(0.95");
    expect(queries.p99Ms).toContain("chase_sets_projection_freshness_wait_duration_ms_bucket");
    expect(queries.missingTargetContextCount).toContain('target_context_header=~"missing|present_invalid"');
    expect(queries.exactDependencyFallbackCount).toContain('wait_mode!="exact-dependency"');
    expect(workSignalErrorRateQuery("30m")).toContain("chase_sets_projection_freshness_work_signal_errors_total");
  });

  it("collects route evidence through an injected Prometheus query function", async () => {
    const evidence = await runReadConsistencyRouteMatrixEvidence(
      {
        prometheusUrl: "https://prometheus.staging.chasesets.com",
        environment: "staging",
        window: "30m",
        checkedAt,
      },
      async (query) => {
        if (query.includes("work_signal_errors")) {
          return 0;
        }
        if (query.includes("histogram_quantile(0.95")) {
          return 420;
        }
        if (query.includes("histogram_quantile(0.99")) {
          return 710;
        }
        if (query.includes('outcome="timeout"')) {
          return 0;
        }
        if (query.includes('receipt="missing"')) {
          return 0;
        }
        if (query.includes("target_context_header")) {
          return 0;
        }
        if (query.includes('wait_mode!="exact-dependency"')) {
          return 0;
        }
        return 24;
      },
    );

    expect(evidence.summary).toMatchObject({
      routeCount: 6,
      passingRouteCount: 6,
    });
    expect(evidence.routes.every((route) => route.wakeBeforeWait.status === "pass")).toBe(true);
  });

  it("reads the first Prometheus vector value as a number", () => {
    expect(prometheusResultValue([{ value: [1_782_800_000, "42.4"] }])).toBe(42.4);
    expect(prometheusResultValue([])).toBeNull();
    expect(prometheusResultValue([{ value: [1_782_800_000, "NaN"] }])).toBeNull();
  });

  it("sends the staging observability query token with the Prometheus gateway header", async () => {
    const seen = [];
    const value = await queryPrometheusInstant("up", {
      prometheusUrl: "https://prometheus.staging.chasesets.com",
      prometheusToken: "secret-token",
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return {
          ok: true,
          async json() {
            return {
              status: "success",
              data: {
                result: [{ value: [1_782_800_000, "1"] }],
              },
            };
          },
        };
      },
    });

    expect(value).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].url.toString()).toBe("https://prometheus.staging.chasesets.com/api/v1/query?query=up");
    expect(seen[0].init.headers).toEqual({
      [PROMETHEUS_QUERY_TOKEN_HEADER]: "secret-token",
    });
    expect(seen[0].init.headers).not.toHaveProperty("Authorization");
  });
});
