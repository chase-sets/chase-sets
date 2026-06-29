import { describe, expect, it } from "vitest";
import {
  STAGING_MIXED_VERSION_WAKE_DRILL_VERSION,
  buildStagingMixedVersionWakeDrillEvidence,
  parseStagingMixedVersionWakeDrillArgs,
  renderMixedVersionStepSummary,
  validateStagingMixedVersionWakeDrillOptions,
} from "./staging-mixed-version-wake-drill.mjs";

const baselineCommit = "1111111111111111111111111111111111111111";
const candidateCommit = "2222222222222222222222222222222222222222";

function deployRun(overrides = {}) {
  return {
    databaseId: 12345,
    status: "completed",
    conclusion: "success",
    headSha: candidateCommit,
    url: "https://github.com/chase-sets/chase-sets/actions/runs/12345",
    jobs: [
      {
        name: "Resolve Release",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-06-29T12:00:00Z",
        completedAt: "2026-06-29T12:01:00Z",
      },
      {
        name: "Deploy Staging",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-06-29T12:10:00Z",
        completedAt: "2026-06-29T12:20:00Z",
        url: "https://github.com/chase-sets/chase-sets/actions/runs/12345/job/1",
      },
    ],
    ...overrides,
  };
}

function wakeDrill(overrides = {}) {
  return {
    schemaVersion: "staging-wake-drills/v1",
    drillKind: "load",
    verdict: "pass",
    checkedAt: "2026-06-29T12:12:00Z",
    completedAt: "2026-06-29T12:18:00Z",
    correlationPrefix: "wake-drill-test",
    loadSummary: {
      attempted: 12,
      promoted: 12,
      readinessPassRate: 1,
      readyLatencyMs: { samples: 12, min: 1000, p50: 2000, p95: 3000, max: 3000 },
    },
    convergence: {
      converged: true,
      convergedAfterMs: 673,
      finalSamples: {
        checkout: {
          relayCursorGap: "0",
          checkpointGaps: [
            {
              checkpointKey: "checkout.session-projection:checkout:v1",
              projectionName: "checkout.session-projection",
              gap: "0",
              converged: true,
            },
          ],
        },
      },
    },
    wakeStatusAfter: {
      wakeStore: {
        intentSummary: {
          failedCount: 0,
          staleClaimCount: 0,
          queuedCount: 0,
        },
      },
    },
    wakeRuntimeAfterLoad: {
      final: {
        activeWakeCapableWorkerCount: 2,
      },
    },
    redaction: {
      databaseUrls: "never-recorded",
      adminCredentials: "never-recorded",
      sessionTokens: "never-recorded",
      guestEmails: "never-recorded",
    },
    ...overrides,
  };
}

function loadEvaluation(overrides = {}) {
  return {
    schemaVersion: "push-wake-load-evidence/v1",
    verdict: "pass",
    profile: "representative-volume",
    verdictReasons: [],
    redaction: {
      sensitiveValues: "not-detected",
      leakMatchCount: 0,
    },
    ...overrides,
  };
}

describe("staging mixed-version wake drill args", () => {
  it("parses repeated wake drill and evaluator paths", () => {
    const options = parseStagingMixedVersionWakeDrillArgs([
      "--deploy-run-json",
      "deploy.json",
      "--wake-drill-json",
      "reconciliation.json",
      "--wake-drill-json",
      "load.json",
      "--load-evaluation-json",
      "load-evaluation.json",
      "--baseline-commit",
      baselineCommit,
      "--out",
      "out.json",
    ]);

    expect(options.deployRunJsonPath).toBe("deploy.json");
    expect(options.wakeDrillJsonPaths).toEqual(["reconciliation.json", "load.json"]);
    expect(options.loadEvaluationJsonPaths).toEqual(["load-evaluation.json"]);
    expect(options.baselineCommit).toBe(baselineCommit);
    expect(options.outPath).toBe("out.json");
    expect(validateStagingMixedVersionWakeDrillOptions(options)).toEqual([]);
  });

  it("requires an input deploy run, at least one wake artifact, and a baseline commit", () => {
    const errors = validateStagingMixedVersionWakeDrillOptions(
      parseStagingMixedVersionWakeDrillArgs(["--baseline-commit", "not-a-sha"]),
    );

    expect(errors).toContain("--deploy-run-json is required.");
    expect(errors).toContain("At least one --wake-drill-json path is required.");
    expect(errors).toContain("--baseline-commit must be a 40-character commit SHA.");
  });
});

describe("staging mixed-version wake evidence", () => {
  it("passes when wake traffic overlaps a successful staging deploy with distinct versions", () => {
    const evidence = buildStagingMixedVersionWakeDrillEvidence({
      baselineCommit,
      checkedAt: "2026-06-29T12:30:00Z",
      deployRun: deployRun(),
      wakeDrills: [wakeDrill()],
      loadEvaluations: [loadEvaluation()],
    });

    expect(evidence).toMatchObject({
      schemaVersion: STAGING_MIXED_VERSION_WAKE_DRILL_VERSION,
      issueNumbers: [1365],
      environment: "staging",
      verdict: "pass",
      verdictReasons: [],
      baseline: { commit: baselineCommit },
      candidate: { commit: candidateCommit },
      deployWindow: {
        startedAt: "2026-06-29T12:10:00Z",
        completedAt: "2026-06-29T12:20:00Z",
      },
      trafficWindow: {
        startedAt: "2026-06-29T12:12:00Z",
        completedAt: "2026-06-29T12:18:00Z",
      },
      durableConvergence: {
        allWakeDrillsConverged: true,
        maxCheckoutRelayCursorGap: 0,
        maxCheckoutCheckpointGap: 0,
      },
    });
    expect(evidence.envelopeOutcomeCounts).toMatchObject({
      syntheticWakeAttempts: 12,
      promotedWakeAttempts: 12,
      passedWakeDrills: 1,
      passedLoadEvaluations: 1,
      rawLogCountSource: "not-used",
    });
  });

  it("fails when baseline and candidate are the same commit", () => {
    const evidence = buildStagingMixedVersionWakeDrillEvidence({
      baselineCommit: candidateCommit,
      deployRun: deployRun(),
      wakeDrills: [wakeDrill()],
      loadEvaluations: [loadEvaluation()],
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.verdictReasons).toContain("baseline-and-candidate-commit-match");
  });

  it("fails when wake traffic does not overlap the staging deploy window", () => {
    const evidence = buildStagingMixedVersionWakeDrillEvidence({
      baselineCommit,
      deployRun: deployRun(),
      wakeDrills: [
        wakeDrill({
          checkedAt: "2026-06-29T12:21:00Z",
          completedAt: "2026-06-29T12:25:00Z",
        }),
      ],
      loadEvaluations: [loadEvaluation()],
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.verdictReasons).toContain("wake-traffic-did-not-overlap-staging-deploy");
  });

  it("fails when the deploy, wake drill, or load evaluator failed", () => {
    const evidence = buildStagingMixedVersionWakeDrillEvidence({
      baselineCommit,
      deployRun: deployRun({ conclusion: "failure" }),
      wakeDrills: [wakeDrill({ verdict: "fail" })],
      loadEvaluations: [loadEvaluation({ verdict: "fail", verdictReasons: ["durable-positions-did-not-converge"] })],
    });

    expect(evidence.verdictReasons).toContain("platform-deploy-run-not-successful");
    expect(evidence.verdictReasons).toContain("wake-drill-verdict-not-pass");
    expect(evidence.verdictReasons).toContain("load-evaluator-verdict-not-pass");
  });

  it("fails closed when composed evidence leaks sensitive values", () => {
    expect(() =>
      buildStagingMixedVersionWakeDrillEvidence({
        baselineCommit,
        deployRun: deployRun(),
        wakeDrills: [wakeDrill({ correlationPrefix: "postgresql://user:secret@example.invalid/db" })],
        loadEvaluations: [loadEvaluation()],
      }),
    ).toThrow(/leaked sensitive values/);
  });

  it("renders a concise GitHub step summary", () => {
    const summary = renderMixedVersionStepSummary(
      buildStagingMixedVersionWakeDrillEvidence({
        baselineCommit,
        deployRun: deployRun(),
        wakeDrills: [wakeDrill()],
        loadEvaluations: [loadEvaluation()],
      }),
    );

    expect(summary).toContain("Staging mixed-version wake drill");
    expect(summary).toContain("Baseline: 11111111");
    expect(summary).toContain("Candidate: 22222222");
    expect(summary).toContain("| load | pass | 12 | 12 | yes | 0 | 0 |");
  });
});
