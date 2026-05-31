import { describe, expect, it } from "vitest";
import { CANARY_ANALYSIS_VERSION, evaluateCanaryAnalysis, parseCanaryAnalysisArgs } from "./canary-analysis.mjs";

describe("canary analysis", () => {
  it("passes when every required signal passes", () => {
    const result = evaluateCanaryAnalysis({
      releaseCommit: "a".repeat(40),
      checkedAt: "2026-05-31T13:00:00.000Z",
      observationWindowSeconds: 600,
      signals: [
        { name: "route-error-rate", owner: "platform-runtime", baseline: 0.01, canary: 0.011, maxIncrease: 0.005 },
        { name: "worker-backlog", owner: "platform-operations", status: "pass" },
      ],
    });

    expect(result.schemaVersion).toBe(CANARY_ANALYSIS_VERSION);
    expect(result.passesCanaryAnalysisGate).toBe(true);
    expect(result.signals[0]).toMatchObject({ status: "pass", required: true });
  });

  it("fails closed when required signals are missing", () => {
    const result = evaluateCanaryAnalysis({
      releaseCommit: "b".repeat(40),
      checkedAt: "2026-05-31T13:00:00.000Z",
      signals: [{ name: "projection-lag", owner: "platform-operations" }],
    });

    expect(result.passesCanaryAnalysisGate).toBe(false);
    expect(result.errors).toContain("Required canary signal projection-lag did not pass: missing.");
  });

  it("fails when canary metrics exceed the allowed increase", () => {
    const result = evaluateCanaryAnalysis({
      releaseCommit: "c".repeat(40),
      checkedAt: "2026-05-31T13:00:00.000Z",
      signals: [{ name: "route-latency-p95", owner: "platform-runtime", baseline: 250, canary: 400, maxIncrease: 50 }],
    });

    expect(result.passesCanaryAnalysisGate).toBe(false);
    expect(result.signals[0].status).toBe("fail");
  });

  it("does not block on optional signals", () => {
    const result = evaluateCanaryAnalysis({
      releaseCommit: "d".repeat(40),
      checkedAt: "2026-05-31T13:00:00.000Z",
      signals: [{ name: "preview-only-signal", owner: "platform-runtime", required: false }],
    });

    expect(result.passesCanaryAnalysisGate).toBe(true);
    expect(result.signals[0]).toMatchObject({ required: false, status: "missing" });
  });

  it("parses file input from flags or environment", () => {
    expect(parseCanaryAnalysisArgs(["--file", "canary.json"], {})).toMatchObject({ filePath: "canary.json" });
    expect(parseCanaryAnalysisArgs([], { CANARY_ANALYSIS_INPUT: "artifacts/canary.json" })).toMatchObject({
      filePath: "artifacts/canary.json",
    });
  });
});
