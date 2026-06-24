import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { evaluateCanaryAnalysis } from "./canary-analysis.mjs";
import {
  buildCanaryEvidence,
  collectCanaryEvidence,
  collectPrometheusTelemetry,
  readPrometheusHeaders,
  REQUIRED_CANARY_SIGNALS,
  validatePrometheusSignalConfig,
} from "./canary-evidence.mjs";

const releaseCommit = "0123456789abcdef0123456789abcdef01234567";

describe("canary evidence collector", () => {
  it("builds passing canary-analysis evidence when every required signal has telemetry", () => {
    const telemetry = Object.fromEntries(
      REQUIRED_CANARY_SIGNALS.map((signal) => [
        signal.name,
        {
          baseline: 1,
          canary: 1,
          maxIncrease: signal.maxIncrease,
          source: `test ${signal.source}`,
          threshold: `<= baseline + ${signal.maxIncrease}`,
        },
      ]),
    );

    const evidence = buildCanaryEvidence({
      releaseCommit,
      checkedAt: "2026-05-31T12:00:00.000Z",
      observationWindowSeconds: 300,
      telemetry,
    });

    const analysis = evaluateCanaryAnalysis(evidence);

    expect(evidence.schemaVersion).toBe("canary-analysis/v1");
    expect(evidence.signals).toHaveLength(REQUIRED_CANARY_SIGNALS.length);
    expect(evidence.signals[0]).toMatchObject({
      source: expect.stringContaining("test"),
      threshold: "<= baseline + 0",
    });
    expect(analysis.passesCanaryAnalysisGate).toBe(true);
  });

  it("keeps unsupported optional signals visible while required signals fail closed", () => {
    const evidence = buildCanaryEvidence({
      releaseCommit,
      checkedAt: "2026-05-31T12:00:00.000Z",
      observationWindowSeconds: 300,
      telemetry: {
        "app-platform-deployment-phase": { status: "pass", source: "workflow deployment summary" },
      },
    });

    const analysis = evaluateCanaryAnalysis(evidence);

    expect(evidence.signals.find((signal) => signal.name === "route-error-rate")).toMatchObject({
      required: false,
      gateClass: "observation-only",
      status: "missing",
      source: "HTTP telemetry by route and host",
    });
    expect(evidence.signals.find((signal) => signal.name === "observability-transport")).toMatchObject({
      required: true,
      status: "missing",
      source: "Prometheus scrape health for the production OpenTelemetry Collector",
    });
    expect(evidence.signals.find((signal) => signal.name === "projection-lag-poison-events")).toMatchObject({
      required: true,
      gateClass: "required-critical-migrated",
      status: "missing",
      source: "projection operation snapshots and poison-event telemetry",
    });
    expect(evidence.signals.find((signal) => signal.name === "account-cart-post-write-consistency")).toMatchObject({
      required: true,
      gateClass: "required-critical-migrated",
      currentState: "available-now",
      status: "missing",
    });
    expect(evidence.signals.find((signal) => signal.name === "sell-rail-accept-checkout-handoff")).toMatchObject({
      required: true,
      gateClass: "required-critical-migrated",
      currentState: "available-now",
      status: "missing",
    });
    expect(analysis.passesCanaryAnalysisGate).toBe(false);
    expect(analysis.errors).not.toContain("Required canary signal route-error-rate did not pass: missing.");
    expect(analysis.errors).toContain("Required canary signal projection-lag-poison-events did not pass: missing.");
    expect(analysis.errors).toContain(
      "Required canary signal sell-rail-accept-checkout-handoff did not pass: missing.",
    );
  });

  it("keeps threshold failures visible after collecting source files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-canary-evidence-"));
    const sourceFile = join(directory, "telemetry.json");
    const outFile = join(directory, "canary-analysis.json");
    const signals = Object.fromEntries(
      REQUIRED_CANARY_SIGNALS.map((signal) => [
        signal.name,
        {
          baseline: 0,
          canary: signal.name === "settlement-payout-errors" ? 1 : 0,
          maxIncrease: signal.name === "settlement-payout-errors" ? 0 : signal.maxIncrease,
          source: signal.source,
        },
      ]),
    );
    await writeFile(sourceFile, `${JSON.stringify({ signals }, null, 2)}\n`);

    const result = await collectCanaryEvidence({
      outPath: outFile,
      releaseCommit,
      checkedAt: "2026-05-31T12:00:00.000Z",
      observationWindowSeconds: 300,
      sourceFiles: [sourceFile],
    });

    expect(result.analysis.passesCanaryAnalysisGate).toBe(false);
    expect(result.analysis.errors).toContain("Required canary signal settlement-payout-errors did not pass: fail.");
    expect(JSON.parse(await readFile(outFile, "utf8")).signals).toEqual(result.evidence.signals);
  });

  it("collects numeric production observability snapshots from Prometheus queries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-canary-prometheus-"));
    const queryFile = join(directory, "queries.json");
    await writeFile(
      queryFile,
      `${JSON.stringify(
        {
          signals: {
            "route-error-rate": {
              owner: "platform-runtime/route-owner",
              source: "Prometheus route error rate by release cohort",
              baselineQuery: 'sum(rate(http_requests_total{status=~"5.."}[15m]))',
              canaryQuery: 'sum(rate(http_requests_total{status=~"5..",release="canary"}[15m]))',
              maxIncrease: 0.005,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const seenQueries = [];

    const telemetry = await collectPrometheusTelemetry({
      baseUrl: "https://prometheus.example",
      queryFile,
      fetchImpl: async (url) => {
        const query = url.searchParams.get("query");
        seenQueries.push(query);
        return {
          ok: true,
          json: async () => ({
            status: "success",
            data: {
              resultType: "vector",
              result: [{ value: [1_802_000_000, query?.includes('release="canary"') ? "0.012" : "0.01"] }],
            },
          }),
        };
      },
    });

    expect(seenQueries).toEqual([
      'sum(rate(http_requests_total{status=~"5.."}[15m]))',
      'sum(rate(http_requests_total{status=~"5..",release="canary"}[15m]))',
    ]);
    expect(telemetry.signals[0]).toMatchObject({
      name: "route-error-rate",
      baseline: 0.01,
      canary: 0.012,
      source: "Prometheus route error rate by release cohort",
      threshold: "<= baseline + 0.005",
    });
  });

  it("keeps empty Prometheus query results missing instead of silently zeroing them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-canary-prometheus-empty-"));
    const queryFile = join(directory, "queries.json");
    await writeFile(
      queryFile,
      `${JSON.stringify({
        signals: [
          {
            name: "settlement-payout-errors",
            owner: "settlement",
            source: "Prometheus settlement operation failures",
            baselineQuery: "baseline_settlement",
            canaryQuery: "canary_settlement",
            maxIncrease: 0,
          },
          {
            name: "sell-rail-accept-checkout-handoff",
            owner: "checkout/marketplace/ordering",
            source: "Prometheus sell-rail handoff telemetry",
            baselineQuery: "baseline_sell_rail",
            canaryQuery: "canary_sell_rail",
            maxIncrease: 0,
          },
          {
            name: "payout-ready-handoff",
            owner: "settlement/checkout",
            source: "Prometheus payout-ready handoff telemetry",
            baselineQuery: "baseline_payout_ready",
            canaryQuery: "canary_payout_ready",
            maxIncrease: 0,
          },
        ],
      })}\n`,
    );

    const telemetry = await collectPrometheusTelemetry({
      baseUrl: "https://prometheus.example",
      queryFile,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ status: "success", data: { resultType: "vector", result: [] } }),
      }),
    });

    expect(telemetry.signals[0]).toMatchObject({
      name: "settlement-payout-errors",
      baseline: null,
      canary: null,
      status: "missing",
      detail: "Prometheus returned no numeric result for settlement-payout-errors.",
    });
  });

  it("passes protected Prometheus query headers without embedding credentials in the URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-canary-prometheus-headers-"));
    const queryFile = join(directory, "queries.json");
    await writeFile(
      queryFile,
      `${JSON.stringify({
        signals: [
          {
            name: "route-error-rate",
            owner: "platform-runtime/route-owner",
            source: "Prometheus route error rate by release cohort",
            baselineQuery: "baseline_errors",
            canaryQuery: "canary_errors",
            maxIncrease: 0.005,
          },
        ],
      })}\n`,
    );
    const seenRequests = [];

    await collectPrometheusTelemetry({
      baseUrl: "https://prometheus.example",
      queryFile,
      headers: {
        Authorization: "Bearer scoped-token",
        "X-Scope-OrgID": "chase-sets-production",
      },
      fetchImpl: async (url, init) => {
        seenRequests.push({ url: String(url), headers: init?.headers });
        return {
          ok: true,
          json: async () => ({ status: "success", data: { resultType: "scalar", result: [1_802_000_000, "0"] } }),
        };
      },
    });

    expect(seenRequests).toEqual([
      {
        url: "https://prometheus.example/api/v1/query?query=baseline_errors",
        headers: {
          Authorization: "Bearer scoped-token",
          "X-Scope-OrgID": "chase-sets-production",
        },
      },
      {
        url: "https://prometheus.example/api/v1/query?query=canary_errors",
        headers: {
          Authorization: "Bearer scoped-token",
          "X-Scope-OrgID": "chase-sets-production",
        },
      },
    ]);
  });

  it("parses Prometheus headers from JSON and repeated CLI options", () => {
    expect(
      readPrometheusHeaders({
        headersJson: JSON.stringify({ Authorization: "Bearer secret", "X-Scope-OrgID": "production" }),
        headerOptions: ["X-Extra: release-health"],
      }),
    ).toEqual({
      Authorization: "Bearer secret",
      "X-Scope-OrgID": "production",
      "X-Extra": "release-health",
    });

    expect(() => readPrometheusHeaders({ headersJson: "not-json" })).toThrow(
      "Prometheus headers must be a JSON object.",
    );
    expect(() => readPrometheusHeaders({ headerOptions: ["bad"] })).toThrow(
      'Prometheus header must use "Name: value" format: bad',
    );
    expect(() => readPrometheusHeaders({ headerOptions: ["Bad Header: value"] })).toThrow(
      "Invalid Prometheus header name: Bad Header",
    );
  });

  it("merges Prometheus telemetry into canary evidence and keeps missing optional signals out of the gate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-canary-prometheus-merge-"));
    const queryFile = join(directory, "queries.json");
    const sourceFile = join(directory, "source.json");
    await writeFile(
      queryFile,
      `${JSON.stringify({
        signals: [
          {
            name: "observability-transport",
            owner: "infrastructure/observability",
            source: "Prometheus scrape health for the production OpenTelemetry Collector",
            baselineQuery: "transport_baseline",
            canaryQuery: "transport_canary",
            maxIncrease: 0,
          },
          {
            name: "projection-lag-poison-events",
            owner: "owning-bounded-context/platform-operations",
            source: "Prometheus checkout projection freshness pending and error telemetry",
            baselineQuery: "baseline_projection",
            canaryQuery: "canary_projection",
            maxIncrease: 0,
          },
          {
            name: "checkout-session-freshness-slo",
            owner: "checkout/platform-operations",
            source: "Prometheus checkout session freshness SLO posture",
            baselineQuery: "checkout_slo_baseline",
            canaryQuery: "checkout_slo_canary",
            maxIncrease: 0,
            required: false,
            gateClass: "observation-only",
          },
          {
            name: "account-cart-post-write-consistency",
            owner: "checkout/account-cart",
            source: "Prometheus account-cart post-write consistency telemetry",
            baselineQuery: "account_cart_baseline",
            canaryQuery: "account_cart_canary",
            maxIncrease: 0,
          },
          {
            name: "settlement-payout-errors",
            owner: "settlement",
            source: "Prometheus settlement operation failures",
            baselineQuery: "baseline_settlement",
            canaryQuery: "canary_settlement",
            maxIncrease: 0,
          },
          {
            name: "sell-rail-accept-checkout-handoff",
            owner: "checkout/marketplace/ordering",
            source: "Prometheus sell-rail handoff telemetry",
            baselineQuery: "sell_rail_baseline",
            canaryQuery: "sell_rail_canary",
            maxIncrease: 0,
          },
          {
            name: "payout-ready-handoff",
            owner: "settlement/checkout",
            source: "Prometheus payout-ready handoff telemetry",
            baselineQuery: "payout_ready_baseline",
            canaryQuery: "payout_ready_canary",
            maxIncrease: 0,
          },
        ],
      })}\n`,
    );
    await writeFile(
      sourceFile,
      `${JSON.stringify({
        signals: {
          "app-platform-deployment-phase": {
            owner: "infrastructure/deployment-workflow",
            source: "GitHub Actions Stage 1 production canary",
            status: "pass",
          },
        },
      })}\n`,
    );

    const result = await collectCanaryEvidence({
      releaseCommit,
      checkedAt: "2026-06-01T12:00:00.000Z",
      observationWindowSeconds: 300,
      sourceFiles: [sourceFile],
      prometheusBaseUrl: "https://prometheus.example",
      prometheusQueryFile: queryFile,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ status: "success", data: { resultType: "scalar", result: [1_802_000_000, "0"] } }),
      }),
    });

    expect(result.evidence.signals.find((signal) => signal.name === "route-error-rate")).toMatchObject({
      required: false,
      status: "missing",
    });
    expect(result.evidence.signals.find((signal) => signal.name === "projection-lag-poison-events")).toMatchObject({
      baseline: 0,
      canary: 0,
      currentState: "available-now",
    });
    expect(result.evidence.signals.find((signal) => signal.name === "checkout-session-freshness-slo")).toMatchObject({
      required: false,
      gateClass: "observation-only",
      baseline: 0,
      canary: 0,
      currentState: "available-now",
    });
    expect(result.analysis.passesCanaryAnalysisGate).toBe(true);
  });

  it("lets direct production proof artifacts satisfy required release-health signals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-canary-direct-proof-"));
    const queryFile = join(directory, "queries.json");
    const stage1SourceFile = join(directory, "stage1.json");
    const readinessSourceFile = join(directory, "readiness.json");
    const settlementSourceFile = join(directory, "settlement.json");

    await writeFile(
      queryFile,
      `${JSON.stringify({
        signals: [
          {
            name: "observability-transport",
            owner: "infrastructure/observability",
            source: "Prometheus scrape health",
            baselineQuery: "transport_baseline",
            canaryQuery: "transport_canary",
            maxIncrease: 0,
          },
          {
            name: "projection-lag-poison-events",
            owner: "owning-bounded-context/platform-operations",
            source: "Prometheus projection telemetry",
            baselineQuery: "projection_baseline",
            canaryQuery: "projection_canary",
            maxIncrease: 0,
          },
          {
            name: "settlement-payout-errors",
            owner: "settlement",
            source: "Prometheus settlement telemetry",
            baselineQuery: "settlement_baseline",
            canaryQuery: "settlement_canary",
            maxIncrease: 0,
          },
          {
            name: "account-cart-post-write-consistency",
            owner: "checkout/account-cart",
            source: "Prometheus account-cart post-write consistency telemetry",
            baselineQuery: "account_cart_baseline",
            canaryQuery: "account_cart_canary",
            maxIncrease: 0,
          },
          {
            name: "sell-rail-accept-checkout-handoff",
            owner: "checkout/marketplace/ordering",
            source: "Prometheus sell-rail handoff telemetry",
            baselineQuery: "sell_rail_baseline",
            canaryQuery: "sell_rail_canary",
            maxIncrease: 0,
          },
          {
            name: "payout-ready-handoff",
            owner: "settlement/checkout",
            source: "Prometheus payout-ready handoff telemetry",
            baselineQuery: "payout_ready_baseline",
            canaryQuery: "payout_ready_canary",
            maxIncrease: 0,
          },
        ],
      })}\n`,
    );
    await writeFile(
      stage1SourceFile,
      `${JSON.stringify({
        signals: {
          "app-platform-deployment-phase": {
            owner: "infrastructure/deployment-workflow",
            source: "GitHub Actions Stage 1 production canary",
            status: "pass",
          },
        },
      })}\n`,
    );
    await writeFile(
      readinessSourceFile,
      `${JSON.stringify({
        schemaVersion: "production-readiness-gate/v1",
        outcome: "ready",
        readyAfterMs: 576,
        sourceContexts: ["checkout"],
      })}\n`,
    );
    await writeFile(
      settlementSourceFile,
      `${JSON.stringify({
        schemaVersion: "production-settlement-provider-health-canary/v1",
        status: "pass",
        providerName: "stripe",
        endpoint: "/api/settlement/provider-health",
      })}\n`,
    );

    const result = await collectCanaryEvidence({
      releaseCommit,
      checkedAt: "2026-06-01T12:00:00.000Z",
      observationWindowSeconds: 300,
      sourceFiles: [stage1SourceFile, readinessSourceFile, settlementSourceFile],
      prometheusBaseUrl: "https://prometheus.example",
      prometheusQueryFile: queryFile,
      fetchImpl: async (url) => {
        const query = url.searchParams.get("query");
        return {
          ok: true,
          json: async () => {
            if (query === "settlement_canary") {
              return { status: "success", data: { resultType: "vector", result: [] } };
            }
            return {
              status: "success",
              data: {
                resultType: "scalar",
                result: [1_802_000_000, query === "projection_canary" ? "0.1" : "0"],
              },
            };
          },
        };
      },
    });

    expect(result.evidence.signals.find((signal) => signal.name === "projection-lag-poison-events")).toMatchObject({
      status: "pass",
      source: "Production post-deploy readiness gate",
      detail: expect.stringContaining("checkout projections converged"),
    });
    expect(result.evidence.signals.find((signal) => signal.name === "settlement-payout-errors")).toMatchObject({
      status: "pass",
      source: "Production settlement provider-health telemetry canary",
      detail: expect.stringContaining("/api/settlement/provider-health"),
    });
    expect(result.analysis.passesCanaryAnalysisGate).toBe(true);
  });

  it("validates Prometheus signal ownership and thresholds before querying", () => {
    expect(
      validatePrometheusSignalConfig({
        name: "route-error-rate",
        owner: "platform-runtime/route-owner",
        source: "Prometheus route error rate by release cohort",
        baselineQuery: "baseline",
        canaryQuery: "canary",
        maxIncrease: 0.005,
      }),
    ).toEqual([]);

    expect(
      validatePrometheusSignalConfig({
        name: "route-error-rate",
        baselineQuery: "baseline",
        canaryQuery: "canary",
        required: "sometimes",
      }),
    ).toEqual([
      "owner is required.",
      "source is required.",
      "maxIncrease must be a non-negative number.",
      "required must be a boolean when provided.",
    ]);

    expect(
      validatePrometheusSignalConfig({
        name: "sell-rail-accept-checkout-handoff",
        owner: "checkout/marketplace/ordering",
        source: "Prometheus sell-rail handoff telemetry",
        baselineQuery: "vector(0)",
        canaryQuery: "sum(rate(chase_sets_post_write_consistency_events_total[15m]))",
        maxIncrease: 0,
        required: false,
        gateClass: "required-critical-migrated",
        currentState: "needs-instrumentation",
      }),
    ).toEqual(["required-critical-migrated needs-instrumentation signals require an exception."]);
  });

  it("keeps the production Prometheus query file valid for required canary gates", async () => {
    const queryConfig = JSON.parse(
      await readFile("infrastructure/observability/release-canary-prometheus-queries.json", "utf8"),
    );
    const signals = queryConfig.signals ?? [];

    expect(signals.map((signal) => signal.name)).toEqual(
      expect.arrayContaining([
        "observability-transport",
        "route-error-rate",
        "route-latency-p95",
        "projection-lag-poison-events",
        "checkout-session-freshness-slo",
        "account-cart-post-write-consistency",
        "checkout-order-payment-errors",
        "settlement-payout-errors",
        "sell-rail-accept-checkout-handoff",
        "payout-ready-handoff",
      ]),
    );
    expect(signals.flatMap(validatePrometheusSignalConfig)).toEqual([]);
    expect(signals.find((signal) => signal.name === "observability-transport")).toMatchObject({
      required: true,
      currentState: "available-now",
    });
    const projectionLagPoisonSignal = signals.find((signal) => signal.name === "projection-lag-poison-events");
    expect(projectionLagPoisonSignal).toMatchObject({
      required: true,
      currentState: "available-now",
      source: "Prometheus checkout projection freshness last-error and work-signal telemetry",
      threshold: "production projection freshness last-error/work-signal telemetry must remain zero",
      gateClass: "required-critical-migrated",
    });
    expect(projectionLagPoisonSignal.canaryQuery).toContain("chase_sets_projection_freshness_evaluations_total");
    expect(projectionLagPoisonSignal.canaryQuery).toContain(
      'chase_sets_projection_freshness_pending_total{last_error="present"}',
    );
    expect(projectionLagPoisonSignal.canaryQuery).toContain("chase_sets_projection_freshness_work_signal_errors_total");
    expect(projectionLagPoisonSignal.canaryQuery).not.toContain("chase_sets_projection_freshness_pending_total[15m]");
    const checkoutFreshnessSloSignal = signals.find((signal) => signal.name === "checkout-session-freshness-slo");
    expect(checkoutFreshnessSloSignal).toMatchObject({
      required: false,
      currentState: "available-now",
      gateClass: "observation-only",
      threshold:
        "checkout session freshness p95<=1000ms, p99<=2250ms, timeout rate<=0.1%, and pending projection lag p95=0",
    });
    expect(checkoutFreshnessSloSignal.canaryQuery).toContain("chase_sets_projection_freshness_wait_duration_ms_bucket");
    expect(checkoutFreshnessSloSignal.canaryQuery).toContain("chase_sets_projection_freshness_pending_lag_bucket");
    expect(checkoutFreshnessSloSignal.canaryQuery).toContain('route_path="/account/checkout-sessions/:sessionId"');
    expect(signals.find((signal) => signal.name === "route-error-rate")).toMatchObject({
      required: false,
      currentState: "needs-instrumentation",
      gateClass: "observation-only",
    });
    expect(signals.find((signal) => signal.name === "checkout-order-payment-errors")).toMatchObject({
      required: false,
      currentState: "needs-instrumentation",
    });
    expect(signals.find((signal) => signal.name === "account-cart-post-write-consistency")).toMatchObject({
      required: true,
      currentState: "available-now",
      gateClass: "required-critical-migrated",
      threshold: "production account-cart missing-strategy and freshness-timeout outcomes must remain zero",
    });
    expect(signals.find((signal) => signal.name === "account-cart-post-write-consistency")?.canaryQuery).toContain(
      'chase_sets_post_write_consistency_events_total{context="checkout",surface="account-cart"',
    );
    const settlementPayoutErrorsSignal = signals.find((signal) => signal.name === "settlement-payout-errors");
    expect(settlementPayoutErrorsSignal).toMatchObject({
      required: true,
      currentState: "available-now",
      gateClass: "required-critical-migrated",
    });
    expect(settlementPayoutErrorsSignal.canaryQuery).toContain(
      'max_over_time(chase_sets_settlement_operations_total{kind="provider-health-checked"}[15m])',
    );
    expect(settlementPayoutErrorsSignal.canaryQuery).not.toContain(
      'rate(chase_sets_settlement_operations_total{kind="provider-health-checked"}[15m])',
    );
    expect(signals.some((signal) => "emptyResultValue" in signal)).toBe(false);

    for (const signalName of ["sell-rail-accept-checkout-handoff", "payout-ready-handoff"]) {
      expect(signals.find((signal) => signal.name === signalName)).toMatchObject({
        required: true,
        gateClass: "required-critical-migrated",
        currentState: "available-now",
      });
      expect(signals.find((signal) => signal.name === signalName)?.canaryQuery).toContain(
        "chase_sets_post_write_consistency_events_total",
      );
      expect(signals.find((signal) => signal.name === signalName)?.canaryQuery).toContain(" or on() ");
      expect(signals.find((signal) => signal.name === signalName)).not.toHaveProperty("exception");
    }
  });
});
