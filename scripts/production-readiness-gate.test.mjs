import { describe, expect, it } from "vitest";
import {
  DEFAULT_READINESS_BUDGET_MS,
  DEFAULT_READINESS_SOURCE_CONTEXTS,
  MAX_READINESS_BUDGET_MS,
  PRODUCTION_READINESS_GATE_VERSION,
  buildReadinessEvidence,
  evaluateReadinessSample,
  parseProductionReadinessGateArgs,
  pollForReadiness,
  renderReadinessStepSummary,
  validateProductionReadinessGateOptions,
} from "./production-readiness-gate.mjs";

const baseEnv = {
  PLATFORM_CONTROL_DATABASE_URL: "postgresql://control:secret@db.example:25060/control?sslmode=require",
  DATABASE_URL_CHECKOUT: "postgresql://checkout:secret@db.example:25060/checkout?sslmode=require",
};

function checkpoint(position, key = "checkout.session-projection:checkout:v2") {
  return {
    checkpointKey: key,
    projectionName: key.split(":")[0],
    subscriptionVersion: 2,
    position,
    ageMs: 50,
  };
}

describe("production readiness gate options", () => {
  it("parses defaults and env-derived database URLs", () => {
    const options = parseProductionReadinessGateArgs([], baseEnv);

    expect(options.sourceContexts).toEqual([...DEFAULT_READINESS_SOURCE_CONTEXTS]);
    expect(options.budgetMs).toBe(DEFAULT_READINESS_BUDGET_MS);
    expect(options.contextDatabaseUrls.checkout).toBe(baseEnv.DATABASE_URL_CHECKOUT);
    expect(options.outPath).toBe("artifacts/release-health/production-readiness-gate.json");
    expect(validateProductionReadinessGateOptions(options)).toEqual([]);
  });

  it("clamps the budget and requires database URLs per audited context", () => {
    const clamped = parseProductionReadinessGateArgs(["--budget-ms", "99999999"], baseEnv);
    expect(clamped.budgetMs).toBe(MAX_READINESS_BUDGET_MS);

    const missing = parseProductionReadinessGateArgs(["--source-contexts", "checkout,marketplace"], baseEnv);
    const errors = validateProductionReadinessGateOptions(missing);
    expect(errors.some((error) => error.includes("DATABASE_URL_MARKETPLACE"))).toBe(true);

    const noControl = parseProductionReadinessGateArgs([], { DATABASE_URL_CHECKOUT: baseEnv.DATABASE_URL_CHECKOUT });
    expect(
      validateProductionReadinessGateOptions(noControl).some((error) =>
        error.includes("PLATFORM_CONTROL_DATABASE_URL"),
      ),
    ).toBe(true);
  });
});

describe("readiness evaluation", () => {
  it("is ready when every checkpoint reaches the event-store head", () => {
    const evaluation = evaluateReadinessSample({
      head: "10",
      relayCursor: null,
      checkpoints: [checkpoint("10"), checkpoint("12", "checkout.cart-projection:checkout:v1")],
    });

    expect(evaluation.ready).toBe(true);
    expect(evaluation.reasons).toEqual([]);
    expect(evaluation.checkpointGaps.map((entry) => entry.converged)).toEqual([true, true]);
  });

  it("is not ready while any checkpoint trails the head", () => {
    const evaluation = evaluateReadinessSample({
      head: "10",
      relayCursor: null,
      checkpoints: [checkpoint("7")],
    });

    expect(evaluation.ready).toBe(false);
    expect(evaluation.reasons).toContain("projection-checkpoint-behind-event-store-head");
    expect(evaluation.checkpointGaps[0].gap).toBe("3");
  });

  it("reports missing checkpoints and never requires a relay cursor (production relay is killed)", () => {
    const evaluation = evaluateReadinessSample({ head: "10", relayCursor: null, checkpoints: [] });

    expect(evaluation.ready).toBe(false);
    expect(evaluation.reasons).toEqual(["no-projection-checkpoints-found"]);
    expect(evaluation.relayCursor).toBeNull();

    const withCursor = evaluateReadinessSample({
      head: "10",
      relayCursor: { position: "4", ownerId: "worker-a", ageMs: 100 },
      checkpoints: [checkpoint("10")],
    });
    expect(withCursor.ready).toBe(true);
    expect(withCursor.relayCursor).toEqual({ position: "4", ageMs: 100 });
  });
});

describe("readiness polling", () => {
  function fakeDeps(samples) {
    let nowMs = 0;
    let index = 0;
    return {
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
      sampleSourceContext: async () => samples[Math.min(index++, samples.length - 1)],
    };
  }

  it("returns ready once checkpoints converge within the budget", async () => {
    const deps = fakeDeps([
      { head: "10", relayCursor: null, checkpoints: [checkpoint("7")] },
      { head: "10", relayCursor: null, checkpoints: [checkpoint("10")] },
    ]);

    const readiness = await pollForReadiness(
      { sourceContexts: ["checkout"], budgetMs: 60_000, pollIntervalMs: 5_000 },
      deps,
    );

    expect(readiness.ready).toBe(true);
    expect(readiness.readyAfterMs).toBe(5_000);
    expect(readiness.sampleCount).toBe(2);
  });

  it("stops at the budget and reports the final unconverged sample", async () => {
    const deps = fakeDeps([{ head: "10", relayCursor: null, checkpoints: [checkpoint("3")] }]);

    const readiness = await pollForReadiness(
      { sourceContexts: ["checkout"], budgetMs: 12_000, pollIntervalMs: 5_000 },
      deps,
    );

    expect(readiness.ready).toBe(false);
    expect(readiness.readyAfterMs).toBeNull();
    expect(readiness.finalSamples.checkout.reasons).toContain("projection-checkpoint-behind-event-store-head");
  });
});

describe("readiness evidence", () => {
  function evidenceFor(readiness) {
    return buildReadinessEvidence({
      checkedAt: "2026-06-11T00:00:00.000Z",
      completedAt: "2026-06-11T00:01:00.000Z",
      sourceContexts: ["checkout"],
      budgetMs: 300_000,
      pollIntervalMs: 5_000,
      readiness,
    });
  }

  it("builds warn-and-proceed evidence with the gate version and outcome", () => {
    const evidence = evidenceFor({
      ready: true,
      readyAfterMs: 15_000,
      sampleCount: 4,
      finalSamples: {
        checkout: { head: "10", checkpointGaps: [], relayCursor: null, ready: true, reasons: [] },
      },
    });

    expect(evidence.schemaVersion).toBe(PRODUCTION_READINESS_GATE_VERSION);
    expect(evidence.gateBehavior).toBe("warn-and-proceed");
    expect(evidence.outcome).toBe("ready");

    const summary = renderReadinessStepSummary(evidence);
    expect(summary).toContain("warn-and-proceed");
    expect(summary).toContain("**ready**");
  });

  it("reports budget expiry and rejects evidence containing sensitive values", () => {
    const expired = evidenceFor({
      ready: false,
      readyAfterMs: null,
      sampleCount: 60,
      finalSamples: {
        checkout: {
          head: "10",
          checkpointGaps: [{ checkpointKey: "k", gap: "3", converged: false }],
          relayCursor: null,
          ready: false,
          reasons: ["projection-checkpoint-behind-event-store-head"],
        },
      },
    });
    expect(expired.outcome).toBe("budget-expired");
    expect(renderReadinessStepSummary(expired)).toContain("budget expired");

    expect(() =>
      evidenceFor({
        ready: true,
        readyAfterMs: 0,
        sampleCount: 1,
        finalSamples: {
          checkout: {
            head: "postgresql://user:secret@db.example:25060/checkout",
            checkpointGaps: [],
            relayCursor: null,
            ready: true,
            reasons: [],
          },
        },
      }),
    ).toThrow("leaked sensitive values");
  });
});
