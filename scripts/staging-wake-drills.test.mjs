import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERGENCE_BUDGET_MS,
  DEFAULT_LOAD_CONCURRENCY,
  DEFAULT_LOAD_ITERATIONS,
  DEFAULT_SOURCE_CONTEXTS,
  DRILL_KINDS,
  LOAD_LIMITS,
  MAX_CONVERGENCE_BUDGET_MS,
  STAGING_WAKE_DRILLS_VERSION,
  assertRedactedDrillEvidence,
  buildDrillEvidence,
  clampLoadPlan,
  classifyCanaryWriteResult,
  contextDatabaseEnvName,
  evaluateConvergenceSample,
  parseStagingWakeDrillArgs,
  pollForConvergence,
  renderDrillStepSummary,
  runStagingWakeDrill,
  selectActiveCheckpoints,
  summarizeLoadResults,
  validateStagingWakeDrillOptions,
} from "./staging-wake-drills.mjs";

const baseEnv = {
  PLATFORM_CONTROL_DATABASE_URL: "postgresql://control:secret@db.example:25060/control?sslmode=require",
  DATABASE_URL_CHECKOUT: "postgresql://checkout:secret@db.example:25060/checkout?sslmode=require",
};

function parsedOptions(argv, env = baseEnv) {
  return parseStagingWakeDrillArgs(argv, env);
}

function fakeDeps(overrides = {}) {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    sampleSourceContext: async () => ({
      head: "10",
      relayCursor: { position: "10", ownerId: "worker-a", ageMs: 100 },
      checkpoints: [
        {
          checkpointKey: "checkout.session-projection:checkout:v1",
          projectionName: "checkout.session-projection",
          subscriptionVersion: 1,
          position: "10",
          ageMs: 50,
        },
      ],
    }),
    runCanaryWrite: async (_options, iteration) => ({
      iteration,
      correlationId: `wake-drill-test-${iteration}`,
      exitCode: 0,
      finalState: "pass",
      promotionDecision: "promote",
      failureReason: null,
      readyLatencyMs: 1200,
      segments: { writeToCheckoutReadyMs: 1200 },
    }),
    fetchWakeStatus: null,
    ...overrides,
  };
}

describe("staging wake drills argument handling", () => {
  it("parses the drill kind, defaults, and env-derived database URLs", () => {
    const options = parsedOptions(["reconciliation", "--base-url", "https://marketplace.staging.chasesets.com"]);

    expect(options.drillKind).toBe("reconciliation");
    expect(options.sourceContexts).toEqual([...DEFAULT_SOURCE_CONTEXTS]);
    expect(options.convergenceBudgetMs).toBe(DEFAULT_CONVERGENCE_BUDGET_MS);
    expect(options.contextDatabaseUrls.checkout).toBe(baseEnv.DATABASE_URL_CHECKOUT);
    expect(options.controlDatabaseUrl).toBe(baseEnv.PLATFORM_CONTROL_DATABASE_URL);
    expect(validateStagingWakeDrillOptions(options)).toEqual([]);
  });

  it("maps hyphenated context names onto database env names", () => {
    expect(contextDatabaseEnvName("public-presence")).toBe("DATABASE_URL_PUBLIC_PRESENCE");
  });

  it("clamps the convergence budget to the allowed window", () => {
    const options = parsedOptions(["reconciliation", "--skip-canary-write", "--convergence-budget-ms", "99999999"]);
    expect(options.convergenceBudgetMs).toBe(MAX_CONVERGENCE_BUDGET_MS);
  });

  it("rejects unknown drill kinds and missing database URLs", () => {
    const options = parsedOptions(["chaos"], {});
    const errors = validateStagingWakeDrillOptions(options);

    expect(errors.some((error) => error.includes(DRILL_KINDS.join(", ")))).toBe(true);
    expect(errors.some((error) => error.includes("PLATFORM_CONTROL_DATABASE_URL"))).toBe(true);
    expect(errors.some((error) => error.includes("DATABASE_URL_CHECKOUT"))).toBe(true);
  });

  it("requires a base URL when the drill generates canary writes, but not for audit-only runs", () => {
    const writeOptions = parsedOptions(["reconciliation"]);
    expect(validateStagingWakeDrillOptions(writeOptions).some((error) => error.includes("--base-url"))).toBe(true);

    const auditOnly = parsedOptions(["reconciliation", "--skip-canary-write"]);
    expect(validateStagingWakeDrillOptions(auditOnly)).toEqual([]);
  });

  it("requires both admin credentials when wake-status snapshots are requested", () => {
    const options = parsedOptions(
      ["reconciliation", "--skip-canary-write", "--admin-base-url", "https://admin.staging.chasesets.com"],
      { ...baseEnv, PLATFORM_ADMIN_EMAIL: "ops@chasesets.test" },
    );

    expect(validateStagingWakeDrillOptions(options).some((error) => error.includes("PLATFORM_ADMIN_PASSWORD"))).toBe(
      true,
    );
  });
});

describe("load plan clamping", () => {
  it("uses bounded defaults", () => {
    expect(clampLoadPlan({})).toMatchObject({
      iterations: DEFAULT_LOAD_ITERATIONS,
      concurrency: DEFAULT_LOAD_CONCURRENCY,
      bounded: true,
    });
  });

  it("clamps iterations and concurrency to the hard caps", () => {
    const plan = clampLoadPlan({ iterations: "500", concurrency: "64" });
    expect(plan.iterations).toBe(LOAD_LIMITS.maxIterations);
    expect(plan.concurrency).toBe(LOAD_LIMITS.maxConcurrency);
  });

  it("never runs more workers than iterations", () => {
    expect(clampLoadPlan({ iterations: "1", concurrency: "4" }).concurrency).toBe(1);
  });
});

describe("checkpoint selection and convergence evaluation", () => {
  it("keeps only the highest subscription version per projection", () => {
    const active = selectActiveCheckpoints([
      { checkpoint_key: "p:checkout:v1", projection_name: "p", subscription_version: 1, position: "3", age_ms: 90 },
      { checkpoint_key: "p:checkout:v2", projection_name: "p", subscription_version: 2, position: "9", age_ms: 10 },
      { checkpoint_key: "q:checkout:v1", projection_name: "q", subscription_version: 1, position: "9", age_ms: 10 },
    ]);

    expect(active).toHaveLength(2);
    expect(active.find((entry) => entry.projectionName === "p")?.subscriptionVersion).toBe(2);
  });

  it("converges when the relay cursor and every checkpoint reach the head", () => {
    const evaluation = evaluateConvergenceSample({
      head: "42",
      relayCursor: { position: "42", ownerId: "worker-a", ageMs: 10 },
      checkpoints: [
        { checkpointKey: "a", projectionName: "a", subscriptionVersion: 1, position: "42" },
        { checkpointKey: "b", projectionName: "b", subscriptionVersion: 1, position: "50" },
      ],
    });

    expect(evaluation.converged).toBe(true);
    expect(evaluation.relayCursorGap).toBe("0");
    expect(evaluation.reasons).toEqual([]);
  });

  it("detects a missed relay fan-out as a cursor stuck behind the event-store head", () => {
    const evaluation = evaluateConvergenceSample({
      head: "42",
      relayCursor: { position: "30", ownerId: "worker-a", ageMs: 600000 },
      checkpoints: [{ checkpointKey: "a", projectionName: "a", subscriptionVersion: 1, position: "42" }],
    });

    expect(evaluation.converged).toBe(false);
    expect(evaluation.relayCursorGap).toBe("12");
    expect(evaluation.reasons).toContain("relay-cursor-behind-event-store-head");
  });

  it("detects projection checkpoint lag and missing surfaces", () => {
    const lagging = evaluateConvergenceSample({
      head: "42",
      relayCursor: { position: "42" },
      checkpoints: [{ checkpointKey: "a", projectionName: "a", subscriptionVersion: 1, position: "41" }],
    });
    expect(lagging.reasons).toContain("projection-checkpoint-behind-event-store-head");

    const missing = evaluateConvergenceSample({ head: "42", relayCursor: null, checkpoints: [] });
    expect(missing.reasons).toContain("relay-cursor-missing");
    expect(missing.reasons).toContain("no-projection-checkpoints-found");
  });
});

describe("convergence polling", () => {
  it("polls until durable positions converge and reports the convergence time", async () => {
    let calls = 0;
    const deps = fakeDeps({
      sampleSourceContext: async () => {
        calls += 1;
        return {
          head: "10",
          relayCursor: { position: calls >= 3 ? "10" : "7", ownerId: "worker-a", ageMs: 10 },
          checkpoints: [
            { checkpointKey: "k", projectionName: "k", subscriptionVersion: 1, position: calls >= 3 ? "10" : "6" },
          ],
        };
      },
    });

    const result = await pollForConvergence(
      { sourceContexts: ["checkout"], convergenceBudgetMs: 60_000, pollIntervalMs: 1_000 },
      deps,
    );

    expect(result.converged).toBe(true);
    expect(result.sampleCount).toBe(3);
    expect(result.convergedAfterMs).toBe(2_000);
  });

  it("stops at the budget and reports the final stuck sample", async () => {
    const deps = fakeDeps({
      sampleSourceContext: async () => ({
        head: "10",
        relayCursor: { position: "4", ownerId: "worker-a", ageMs: 10 },
        checkpoints: [{ checkpointKey: "k", projectionName: "k", subscriptionVersion: 1, position: "10" }],
      }),
    });

    const result = await pollForConvergence(
      { sourceContexts: ["checkout"], convergenceBudgetMs: 5_000, pollIntervalMs: 1_000 },
      deps,
    );

    expect(result.converged).toBe(false);
    expect(result.convergedAfterMs).toBeNull();
    expect(result.finalSamples.checkout.relayCursorGap).toBe("6");
  });
});

describe("canary write classification", () => {
  it("accepts promote and slo-exceeded outcomes as verified writes", () => {
    expect(classifyCanaryWriteResult({ exitCode: 0, failureReason: null })).toBeNull();
    expect(classifyCanaryWriteResult({ exitCode: 1, failureReason: "checkout-ready-slo-exceeded" })).toBeNull();
  });

  it("flags config errors and unverified writes", () => {
    expect(classifyCanaryWriteResult({ exitCode: 2, failureReason: null })).toBe("canary-write-config-error");
    expect(classifyCanaryWriteResult({ exitCode: null, failureReason: null })).toBe("canary-write-config-error");
    expect(classifyCanaryWriteResult({ exitCode: 1, failureReason: "missing-after-write" })).toBe(
      "canary-write-unverified",
    );
  });
});

describe("load summary", () => {
  it("aggregates readiness pass rate and latency percentiles", () => {
    const summary = summarizeLoadResults([
      { exitCode: 0, promotionDecision: "promote", readyLatencyMs: 1000 },
      { exitCode: 0, promotionDecision: "promote", readyLatencyMs: 2000 },
      { exitCode: 1, promotionDecision: "abort", readyLatencyMs: null },
      { exitCode: 0, promotionDecision: "promote", readyLatencyMs: 4000 },
    ]);

    expect(summary.attempted).toBe(4);
    expect(summary.promoted).toBe(3);
    expect(summary.configErrors).toBe(0);
    expect(summary.readinessPassRate).toBe(0.75);
    expect(summary.readyLatencyMs).toMatchObject({ samples: 3, min: 1000, p50: 2000, p95: 4000, max: 4000 });
  });

  it("counts config errors separately from measured aborts", () => {
    const summary = summarizeLoadResults([
      { exitCode: 2, promotionDecision: null, readyLatencyMs: null },
      { exitCode: null, promotionDecision: null, readyLatencyMs: null },
    ]);

    expect(summary.configErrors).toBe(2);
    expect(summary.readinessPassRate).toBe(0);
    expect(summary.readyLatencyMs.samples).toBe(0);
    expect(summary.readyLatencyMs.p50).toBeNull();
  });
});

describe("drill evidence", () => {
  const convergedConvergence = {
    converged: true,
    convergedAfterMs: 4_000,
    sampleCount: 2,
    finalSamples: {
      checkout: {
        head: "10",
        relayCursorPosition: "10",
        relayCursorGap: "0",
        relayCursorAgeMs: 50,
        relayCursorOwnerId: "worker-a",
        checkpointGaps: [
          {
            checkpointKey: "checkout.session-projection:checkout:v1",
            projectionName: "checkout.session-projection",
            subscriptionVersion: 1,
            position: "10",
            gap: "0",
            converged: true,
          },
        ],
        converged: true,
        reasons: [],
      },
    },
  };

  it("builds passing evidence with the schema version and redaction manifest", () => {
    const evidence = buildDrillEvidence({
      drillKind: "reconciliation",
      checkedAt: "2026-06-11T00:00:00.000Z",
      completedAt: "2026-06-11T00:02:00.000Z",
      correlationPrefix: "wake-drill-test",
      sourceContexts: ["checkout"],
      convergenceBudgetMs: 120_000,
      pollIntervalMs: 5_000,
      convergence: convergedConvergence,
      verdictReasons: [],
    });

    expect(evidence.schemaVersion).toBe(STAGING_WAKE_DRILLS_VERSION);
    expect(evidence.verdict).toBe("pass");
    expect(evidence.redaction.databaseUrls).toBe("never-recorded");
  });

  it("fails closed when evidence would leak connection strings, emails, or tokens", () => {
    expect(assertRedactedDrillEvidence({ note: "postgresql://user:secret@host:25060/db" }).length).toBeGreaterThan(0);
    expect(assertRedactedDrillEvidence({ note: "ops@chasesets.test" }).length).toBeGreaterThan(0);
    expect(assertRedactedDrillEvidence({ note: "Bearer abc.def" }).length).toBeGreaterThan(0);
    expect(assertRedactedDrillEvidence({ sessionToken: "anything" }).length).toBeGreaterThan(0);
    expect(() =>
      buildDrillEvidence({
        drillKind: "reconciliation",
        checkedAt: "2026-06-11T00:00:00.000Z",
        completedAt: "2026-06-11T00:02:00.000Z",
        correlationPrefix: "postgresql://user:secret@host/db",
        sourceContexts: ["checkout"],
        convergenceBudgetMs: 120_000,
        pollIntervalMs: 5_000,
        convergence: convergedConvergence,
        verdictReasons: [],
      }),
    ).toThrow(/leaked sensitive values/);
  });

  it("renders a step summary with per-context gaps and load statistics", () => {
    const summary = renderDrillStepSummary({
      drillKind: "load",
      verdict: "pass",
      verdictReasons: [],
      convergenceBudgetMs: 120_000,
      convergence: convergedConvergence,
      loadPlan: { iterations: 4, concurrency: 2 },
      loadSummary: summarizeLoadResults([
        { exitCode: 0, promotionDecision: "promote", readyLatencyMs: 1500 },
        { exitCode: 0, promotionDecision: "promote", readyLatencyMs: 2500 },
      ]),
    });

    expect(summary).toContain("Staging wake drill: load");
    expect(summary).toContain("| checkout | 10 | 0 |");
    expect(summary).toContain("readiness pass rate 1");
    expect(summary).toContain("push-wake-recovery-drills.md");
  });
});

describe("drill orchestration", () => {
  const reconciliationOptions = {
    drillKind: "reconciliation",
    checkedAt: "2026-06-11T00:00:00.000Z",
    correlationPrefix: "wake-drill-test",
    sourceContexts: ["checkout"],
    convergenceBudgetMs: 30_000,
    pollIntervalMs: 1_000,
    skipCanaryWrite: false,
    baseUrl: "https://marketplace.staging.chasesets.com",
  };

  it("runs the reconciliation drill: write, converge, snapshot, pass", async () => {
    const snapshots = [];
    const evidence = await runStagingWakeDrill(reconciliationOptions, {
      ...fakeDeps(),
      fetchWakeStatus: async () => {
        snapshots.push("snapshot");
        return { generatedAt: "2026-06-11T00:00:00.000Z", wakeStore: { available: true } };
      },
    });

    expect(evidence.verdict).toBe("pass");
    expect(evidence.canaryWrite.attempted).toBe(true);
    expect(evidence.canaryWrite.correlationId).toBe("wake-drill-test-w1");
    expect(evidence.convergence.converged).toBe(true);
    expect(snapshots).toHaveLength(2);
    expect(evidence.wakeStatusBefore).not.toBeNull();
    expect(evidence.wakeStatusAfter).not.toBeNull();
  });

  it("fails the drill when durable positions never converge", async () => {
    const evidence = await runStagingWakeDrill(
      { ...reconciliationOptions, skipCanaryWrite: true, convergenceBudgetMs: 5_000 },
      fakeDeps({
        sampleSourceContext: async () => ({
          head: "10",
          relayCursor: { position: "2", ownerId: "worker-a", ageMs: 900000 },
          checkpoints: [{ checkpointKey: "k", projectionName: "k", subscriptionVersion: 1, position: "10" }],
        }),
      }),
    );

    expect(evidence.verdict).toBe("fail");
    expect(evidence.verdictReasons).toContain("durable-positions-did-not-converge-within-budget");
  });

  it("fails the drill when the canary write cannot be trusted", async () => {
    const evidence = await runStagingWakeDrill(reconciliationOptions, {
      ...fakeDeps(),
      runCanaryWrite: async (_options, iteration) => ({
        iteration,
        correlationId: `wake-drill-test-${iteration}`,
        exitCode: 1,
        finalState: "fail",
        promotionDecision: "abort",
        failureReason: "missing-after-write",
        readyLatencyMs: null,
        segments: null,
      }),
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.verdictReasons).toContain("canary-write-unverified");
  });

  it("runs the bounded load drill and aggregates iteration results", async () => {
    const seenIterations = [];
    const evidence = await runStagingWakeDrill(
      { ...reconciliationOptions, drillKind: "load", iterations: "5", concurrency: "2" },
      fakeDeps({
        runCanaryWrite: async (options, iteration) => {
          seenIterations.push(iteration);
          expect(options.skipNegativeProbe).toBe(true);
          return {
            iteration,
            correlationId: `wake-drill-test-${iteration}`,
            exitCode: 0,
            finalState: "pass",
            promotionDecision: "promote",
            failureReason: null,
            readyLatencyMs: 1100,
            segments: { writeToCheckoutReadyMs: 1100 },
          };
        },
      }),
    );

    expect(evidence.verdict).toBe("pass");
    expect(evidence.loadPlan.iterations).toBe(5);
    expect(evidence.loadPlan.concurrency).toBe(2);
    expect(seenIterations).toHaveLength(5);
    expect(evidence.loadSummary.promoted).toBe(5);
    expect(evidence.loadResults.map((result) => result.iteration)).toEqual(["l1", "l2", "l3", "l4", "l5"]);
  });

  it("keeps degraded wake-status snapshots from masking the drill verdict reasons", async () => {
    const evidence = await runStagingWakeDrill(
      { ...reconciliationOptions, skipCanaryWrite: true },
      {
        ...fakeDeps(),
        fetchWakeStatus: async () => {
          throw new Error("admin endpoint unavailable");
        },
      },
    );

    expect(evidence.verdict).toBe("fail");
    expect(evidence.verdictReasons).toContain("wake-status-snapshot-before-failed");
    expect(evidence.verdictReasons).toContain("wake-status-snapshot-after-failed");
  });
});
