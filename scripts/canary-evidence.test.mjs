import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { evaluateCanaryAnalysis } from "./canary-analysis.mjs";
import {
  buildCanaryEvidence,
  collectCanaryEvidence,
  collectPrometheusTelemetry,
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

  it("marks unsupported required signals missing so analysis fails closed", () => {
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
      status: "missing",
      source: "HTTP telemetry by route and host",
    });
    expect(analysis.passesCanaryAnalysisGate).toBe(false);
    expect(analysis.errors).toContain("Required canary signal route-error-rate did not pass: missing.");
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
          canary: signal.name === "route-latency-p95" ? 75 : 0,
          maxIncrease: signal.name === "route-latency-p95" ? 50 : signal.maxIncrease,
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
    expect(result.analysis.errors).toContain("Required canary signal route-latency-p95 did not pass: fail.");
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

  it("merges Prometheus telemetry into canary evidence and still fails missing required signals closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chase-sets-canary-prometheus-merge-"));
    const queryFile = join(directory, "queries.json");
    await writeFile(
      queryFile,
      `${JSON.stringify({
        signals: [
          {
            name: "route-latency-p95",
            owner: "platform-runtime/route-owner",
            source: "Prometheus route latency p95 by release cohort",
            baselineQuery: "baseline_latency",
            canaryQuery: "canary_latency",
            maxIncrease: 50,
          },
        ],
      })}\n`,
    );

    const result = await collectCanaryEvidence({
      releaseCommit,
      checkedAt: "2026-06-01T12:00:00.000Z",
      observationWindowSeconds: 300,
      sourceFiles: [],
      prometheusBaseUrl: "https://prometheus.example",
      prometheusQueryFile: queryFile,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ status: "success", data: { resultType: "scalar", result: [1_802_000_000, "25"] } }),
      }),
    });

    expect(result.evidence.signals.find((signal) => signal.name === "route-latency-p95")).toMatchObject({
      baseline: 25,
      canary: 25,
      currentState: "available-now",
    });
    expect(result.analysis.passesCanaryAnalysisGate).toBe(false);
    expect(result.analysis.errors).toContain("Required canary signal route-error-rate did not pass: missing.");
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
      }),
    ).toEqual(["owner is required.", "source is required.", "maxIncrease must be a non-negative number."]);
  });

  it("keeps the production Prometheus query file valid for required canary gates", async () => {
    const queryConfig = JSON.parse(
      await readFile(
        "bounded-contexts/platform-operations/features/release-dashboard/read-model/canary-prometheus-queries.json",
        "utf8",
      ),
    );
    const signals = queryConfig.signals ?? [];

    expect(signals.map((signal) => signal.name)).toEqual(
      expect.arrayContaining([
        "app-platform-deployment-phase",
        "route-error-rate",
        "route-latency-p95",
        "checkout-order-payment-errors",
        "settlement-payout-errors",
      ]),
    );
    expect(signals.flatMap(validatePrometheusSignalConfig)).toEqual([]);
  });
});
