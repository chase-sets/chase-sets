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
        diagnosticMissingReceiptCount: 5,
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

  it("reports sampler-blocked routes with zero samples as blocked coverage gaps, never failures", () => {
    // Issue #4721: routes the sampler cannot drive (support-safe blocker
    // recorded — private/representative commerce state, unconfigured
    // observation inputs) must not read identically to a wake regression.
    const blocked = routeMatrixRouteEvidence(
      DEFAULT_ROUTE_MATRIX_ROUTES[3],
      {
        sampleCount: 0,
        p95Ms: null,
        p99Ms: null,
        timeoutRate: 0,
        workSignalErrorRate: 0,
        missingReceiptCount: 0,
        missingTargetContextCount: 0,
        exactDependencyFallbackCount: 0,
      },
      {
        status: "blocked",
        outcomeCategory: "payout-ready-private-state-required",
        blockerCategory: "private-payout-state-required",
      },
    );

    expect(blocked.wakeBeforeWait).toMatchObject({
      status: "blocked",
      sampleCount: 0,
      sampler: {
        status: "blocked",
        outcomeCategory: "payout-ready-private-state-required",
        blockerCategory: "private-payout-state-required",
      },
    });
  });

  it("keeps the strict metric verdict when a sampler-blocked route still has in-window samples", () => {
    const route = routeMatrixRouteEvidence(
      DEFAULT_ROUTE_MATRIX_ROUTES[0],
      {
        sampleCount: 12,
        p95Ms: null,
        p99Ms: null,
        timeoutRate: 1,
        workSignalErrorRate: 0,
        missingReceiptCount: 0,
        missingTargetContextCount: 0,
        exactDependencyFallbackCount: 0,
      },
      { status: "blocked", outcomeCategory: "irrelevant", blockerCategory: "irrelevant" },
    );

    // Real in-window traffic always wins: samples present and timing out is a
    // genuine failure regardless of what the sampler reported.
    expect(route.wakeBeforeWait.status).toBe("fail");
  });

  it("keeps the metric verdict for sampled routes and parses the sampler file option", () => {
    const sampled = routeMatrixRouteEvidence(
      DEFAULT_ROUTE_MATRIX_ROUTES[0],
      {
        sampleCount: 12,
        p95Ms: 420,
        p99Ms: 710,
        timeoutRate: 0,
        workSignalErrorRate: 0,
        missingReceiptCount: 0,
        missingTargetContextCount: 0,
        exactDependencyFallbackCount: 0,
      },
      { status: "sampled", outcomeCategory: "sampled", blockerCategory: null },
    );
    expect(sampled.wakeBeforeWait.status).toBe("pass");
    expect(sampled.wakeBeforeWait.sampler).toMatchObject({ status: "sampled" });

    expect(
      parseReadConsistencyRouteMatrixEvidenceArgs(["--sampler-file", "artifacts/wake-drills/sampler.json"], {}),
    ).toMatchObject({ samplerFile: "artifacts/wake-drills/sampler.json" });
  });

  it("joins the sampler report per route and summarizes partial coverage", async () => {
    const samplerReport = {
      schemaVersion: "read-consistency-route-matrix-sampler/v1",
      routes: [
        { routeTemplate: "/checkout/buy/session/:sessionId", status: "sampled", outcomeCategory: "sampled" },
        {
          routeTemplate: "/account/cart",
          status: "blocked",
          outcomeCategory: "account-cart-probe-missing",
          blockerCategory: "redacted-account-cart-observation-required",
        },
        {
          routeTemplate: "/account/sell-list",
          status: "blocked",
          outcomeCategory: "sell-list-source-unavailable",
          blockerCategory: "representative-state-required",
        },
        {
          routeTemplate: "/account/payouts/:payoutId",
          status: "blocked",
          outcomeCategory: "payout-ready-private-state-required",
          blockerCategory: "private-payout-state-required",
        },
        {
          routeTemplate: "/account/payments/:paymentId",
          status: "blocked",
          outcomeCategory: "payment-target-private-state-required",
          blockerCategory: "private-payment-state-required",
        },
        {
          routeTemplate: "/account/listings/:listingId",
          status: "blocked",
          outcomeCategory: "owned-listing-private-state-required",
          blockerCategory: "private-listing-state-required",
        },
      ],
    };
    const evidence = await runReadConsistencyRouteMatrixEvidence(
      {
        prometheusUrl: "https://prometheus.staging.chasesets.com",
        environment: "staging",
        window: "30m",
        checkedAt,
      },
      async (query) => {
        // Only the checkout route has in-window traffic, and it is green.
        const checkoutRoute = query.includes('route_path="/account/checkout-sessions/:sessionId"');
        if (query.includes("work_signal_errors")) {
          return 0;
        }
        if (query.includes("histogram_quantile(0.95")) {
          return checkoutRoute ? 420 : null;
        }
        if (query.includes("histogram_quantile(0.99")) {
          return checkoutRoute ? 710 : null;
        }
        if (
          query.includes('outcome="timeout"') ||
          query.includes('receipt="missing"') ||
          query.includes("target_context_header") ||
          query.includes('wait_mode!="exact-dependency"')
        ) {
          return 0;
        }
        return checkoutRoute ? 12 : 0;
      },
      samplerReport,
    );

    expect(evidence.summary).toMatchObject({
      routeCount: 6,
      passingRouteCount: 1,
      failingRouteCount: 0,
      blockedRouteCount: 5,
      coverage: "partial",
    });
    const byTemplate = new Map(evidence.routes.map((route) => [route.routeTemplate, route.wakeBeforeWait]));
    expect(byTemplate.get("/checkout/buy/session/:sessionId")).toMatchObject({
      status: "pass",
      sampler: { status: "sampled" },
    });
    expect(byTemplate.get("/account/cart")).toMatchObject({
      status: "blocked",
      sampler: { blockerCategory: "redacted-account-cart-observation-required" },
    });
    // Blocked routes are a reported coverage gap; a run with zero failing
    // sampled routes is not a wake regression (exit semantics fail only on
    // routes with status "fail").
    expect(evidence.routes.some((route) => route.wakeBeforeWait.status === "fail")).toBe(false);
  });

  it("skips sampler measurements captured during an active deploy window", async () => {
    const samplerReport = {
      schemaVersion: "read-consistency-route-matrix-sampler/v1",
      deployWindow: {
        schemaVersion: "read-consistency-route-matrix-deploy-window/v1",
        status: "active",
        source: "github-actions+argo-rollouts",
        activeRunCount: 1,
        activeRolloutCount: 1,
      },
      routes: [
        {
          routeTemplate: "/checkout/buy/session/:sessionId",
          status: "skipped",
          outcomeCategory: "deploy-window-active",
        },
        { routeTemplate: "/account/cart", status: "blocked", outcomeCategory: "account-cart-probe-missing" },
        { routeTemplate: "/account/sell-list", status: "blocked", outcomeCategory: "sell-list-source-unavailable" },
        { routeTemplate: "/account/payouts/:payoutId", status: "blocked", outcomeCategory: "payout-state-required" },
        { routeTemplate: "/account/payments/:paymentId", status: "blocked", outcomeCategory: "payment-state-required" },
        { routeTemplate: "/account/listings/:listingId", status: "blocked", outcomeCategory: "listing-state-required" },
      ],
    };
    const evidence = await runReadConsistencyRouteMatrixEvidence(
      { prometheusUrl: "https://prometheus.staging.chasesets.com", environment: "staging", window: "30m", checkedAt },
      async (query) => {
        if (query.includes("work_signal_errors")) return 0;
        if (query.includes("histogram_quantile")) return null;
        return query.includes('route_path="/account/checkout-sessions/:sessionId"') ? 12 : 0;
      },
      samplerReport,
    );

    expect(evidence).toMatchObject({
      deployWindow: { status: "active", activeRunCount: 1, activeRolloutCount: 1 },
      summary: {
        sampledRouteCount: 0,
        skippedRouteCount: 1,
        failingRouteCount: 0,
        blockedRouteCount: 5,
        coverage: "partial",
      },
    });
    expect(evidence.routes[0].wakeBeforeWait).toMatchObject({
      status: "skipped",
      sampleCount: 12,
      deploymentWindow: { status: "active" },
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
    expect(queries.sampleCount).toContain('receipt="present"');
    expect(queries.sampleCount).toContain('wait_mode="exact-dependency"');
    expect(queries.p95Ms).toContain("histogram_quantile(0.95");
    expect(queries.p99Ms).toContain("chase_sets_projection_freshness_wait_duration_ms_bucket");
    expect(queries.missingReceiptCount).toContain('receipt="missing"');
    expect(queries.missingReceiptCount).toContain('outcome!="missing-receipt"');
    expect(queries.diagnosticMissingReceiptCount).toContain('outcome="missing-receipt"');
    expect(queries.missingTargetContextCount).toContain('receipt="present"');
    expect(queries.missingTargetContextCount).toContain('target_context_header=~"missing|present_invalid"');
    expect(queries.exactDependencyFallbackCount).toContain('receipt="present"');
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
          return query.includes('outcome="missing-receipt"') ? 12 : 0;
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
