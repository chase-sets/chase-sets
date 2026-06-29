import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoSensitiveLoadEvidenceValues,
  buildPushWakeLoadEvidence,
  LOAD_EVIDENCE_PROFILES,
  parsePushWakeLoadEvidenceArgs,
  PUSH_WAKE_LOAD_EVIDENCE_VERSION,
  renderPushWakeLoadEvidenceMarkdown,
} from "./push-wake-load-evidence.mjs";

function passingArtifact(overrides = {}) {
  return {
    schemaVersion: "staging-wake-drills/v1",
    drillKind: "load",
    environment: "staging",
    checkedAt: "2026-06-24T00:00:00.000Z",
    completedAt: "2026-06-24T00:02:00.000Z",
    correlationPrefix: "wake-drill-test",
    sourceContexts: ["checkout"],
    loadPlan: {
      iterations: 12,
      concurrency: 4,
      bounded: true,
      limits: { maxIterations: 12, maxConcurrency: 4 },
    },
    loadSummary: {
      attempted: 12,
      evidenceProduced: 12,
      configErrors: 0,
      promoted: 9,
      readinessPassRate: 0.75,
      readyLatencyMs: { samples: 12, min: 900, p50: 2_000, p95: 12_000, max: 14_000 },
    },
    loadReadinessDecision: {
      status: "accepted-burst-saturation-degradation",
      decision: "bounded-load-per-write-readiness-is-best-effort-when-durable-convergence-passes",
      reason: "ratified-burst-saturation-slo",
      acceptedBy: "docs/architecture/push-wake-slo-load-proof.md",
      readySloMs: 10_000,
      readinessPassRate: 0.75,
      durableConvergenceStatus: "pass",
    },
    convergence: {
      converged: true,
      convergedAfterMs: 50_900,
      sampleCount: 12,
      finalSamples: {
        checkout: {
          head: "42",
          relayCursorPosition: "42",
          relayCursorGap: "0",
          checkpointScope: {
            mode: "projection-names",
            projectionNames: ["checkout.session-projection"],
            missingProjectionNames: [],
            excludedCheckpointCount: 0,
            excludedLaggingCheckpointCount: 0,
            excludedMaxCheckpointGap: null,
          },
          checkpointGaps: [
            {
              checkpointKey: "checkout.session-projection:checkout:v1",
              projectionName: "checkout.session-projection",
              subscriptionVersion: 1,
              position: "42",
              gap: "0",
              converged: true,
            },
          ],
          converged: true,
          reasons: [],
        },
      },
    },
    wakeStatusBefore: wakeStatusSnapshot({ queuedCount: 0 }),
    wakeStatusAfter: wakeStatusSnapshot({ queuedCount: 0 }),
    wakeRuntimeAfterLoad: wakeRuntimeReadiness({ ready: true }),
    verdict: "pass",
    verdictReasons: [],
    redaction: {
      databaseUrls: "never-recorded",
      adminCredentials: "never-recorded",
      sessionTokens: "never-recorded",
      guestEmails: "never-recorded",
    },
    ...overrides,
  };
}

function wakeStatusSnapshot(intentSummary = {}, intentBreakdown = []) {
  return {
    generatedAt: "2026-06-24T00:02:00.000Z",
    wakeStore: {
      available: true,
      intentSummary: {
        queuedCount: 0,
        claimedCount: 0,
        failedCount: 0,
        expiredCount: 0,
        staleClaimCount: 0,
        oldestQueuedAgeMs: null,
        ...intentSummary,
      },
      intentBreakdown,
      checkpointSignals: {},
    },
    schedulers: {
      available: true,
      wakeCapableWorkerCount: 2,
      activeWakeCapableWorkerCount: 2,
      workers: [],
    },
  };
}

function wakeRuntimeReadiness(overrides = {}) {
  return {
    attempted: true,
    ready: true,
    readyAfterMs: 1_000,
    sampleCount: 1,
    initial: {
      ready: true,
      activeWakeCapableWorkerCount: 2,
      relayLeaseState: "active",
      relayOwnerId: "worker-a",
      reasons: [],
    },
    final: {
      ready: true,
      activeWakeCapableWorkerCount: 2,
      relayLeaseState: "active",
      relayOwnerId: "worker-a",
      reasons: [],
    },
    ...overrides,
  };
}

describe("push wake load evidence evaluator", () => {
  it("accepts a representative captured staging load artifact against the strict profile", () => {
    const evidence = buildPushWakeLoadEvidence({
      artifact: passingArtifact(),
      artifactPath: "artifacts/wake-drills/staging-wake-drill-load.json",
      checkedAt: "2026-06-24T00:03:00.000Z",
      profile: "representative-volume",
      budgetOverrides: {},
    });

    expect(evidence.schemaVersion).toBe(PUSH_WAKE_LOAD_EVIDENCE_VERSION);
    expect(evidence.verdict).toBe("pass");
    expect(evidence.budgets).toMatchObject(LOAD_EVIDENCE_PROFILES["representative-volume"]);
    expect(evidence.observations.loadSummary.evidenceProducedRate).toBe(1);
    expect(evidence.observations.loadReadinessDecision).toMatchObject({
      status: "accepted-burst-saturation-degradation",
      reason: "ratified-burst-saturation-slo",
    });
    expect(evidence.observations.durableConvergence.sourceContexts.checkout.checkpointScope).toMatchObject({
      mode: "projection-names",
      projectionNames: ["checkout.session-projection"],
    });
    expect(evidence.observations.wakeRuntime.afterLoad).toMatchObject({
      attempted: true,
      ready: true,
    });
    expect(evidence.redaction).toMatchObject({
      sourceArtifactStored: "not-copied",
      sensitiveValues: "not-detected",
      liveEnvironmentAccess: "not-used",
    });
  });

  it("keeps bounded-staging honest about not being production-like volume proof", () => {
    const evidence = buildPushWakeLoadEvidence({
      artifact: passingArtifact({ loadPlan: { iterations: 6, concurrency: 2, bounded: true } }),
      checkedAt: "2026-06-24T00:03:00.000Z",
      profile: "bounded-staging",
      budgetOverrides: {},
    });

    expect(evidence.verdict).toBe("pass");
    expect(evidence.warnings).toContain(
      "bounded-staging validates the existing drill artifact shape; it is not production-like volume proof.",
    );
    expect(evidence.warnings.some((warning) => warning.includes("load per-write readiness missed"))).toBe(true);

    const markdown = renderPushWakeLoadEvidenceMarkdown(evidence);
    expect(markdown).toContain("Verdict: **pass**");
    expect(markdown).toContain("Iterations/concurrency: 6/2");
    expect(markdown).toContain("Load readiness decision: accepted-burst-saturation-degradation");
  });

  it("fails warning-only load readiness misses without an explicit accepted decision", () => {
    const artifact = passingArtifact({
      loadReadinessDecision: null,
      loadSummary: {
        attempted: 12,
        evidenceProduced: 12,
        configErrors: 0,
        promoted: 0,
        readinessPassRate: 0,
        readyLatencyMs: { samples: 0, min: null, p50: null, p95: null, max: null },
      },
    });

    const evidence = buildPushWakeLoadEvidence({
      artifact,
      checkedAt: "2026-06-24T00:03:00.000Z",
      profile: "bounded-staging",
      budgetOverrides: {},
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.verdictReasons).toContain("load-readiness-slo-miss-without-accepted-decision");
  });

  it("fails representative evidence that is still only the bounded burst shape", () => {
    const evidence = buildPushWakeLoadEvidence({
      artifact: passingArtifact({
        loadPlan: { iterations: 6, concurrency: 2, bounded: true },
        loadSummary: {
          attempted: 6,
          evidenceProduced: 6,
          configErrors: 0,
          promoted: 0,
          readinessPassRate: 0,
          readyLatencyMs: { samples: 6, min: 10_001, p50: 12_000, p95: 14_000, max: 14_000 },
        },
      }),
      checkedAt: "2026-06-24T00:03:00.000Z",
      profile: "representative-volume",
      budgetOverrides: {},
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.verdictReasons).toEqual(
      expect.arrayContaining(["load-iteration-count-below-budget", "load-concurrency-below-budget"]),
    );
  });

  it("trusts explicit zero summary counts instead of deriving a false pass from raw iterations", () => {
    const evidence = buildPushWakeLoadEvidence({
      artifact: passingArtifact({
        loadSummary: {
          attempted: 6,
          evidenceProduced: 0,
          configErrors: 0,
          promoted: 0,
          readinessPassRate: 0,
          readyLatencyMs: { samples: 6, min: 0, p50: 0, p95: 0, max: 0 },
        },
        loadResults: [
          { exitCode: 0 },
          { exitCode: 0 },
          { exitCode: 0 },
          { exitCode: 0 },
          { exitCode: 0 },
          { exitCode: 0 },
        ],
      }),
      checkedAt: "2026-06-24T00:03:00.000Z",
      profile: "bounded-staging",
      budgetOverrides: {},
    });

    expect(evidence.observations.loadSummary.evidenceProduced).toBe(0);
    expect(evidence.verdictReasons).toContain("load-evidence-produced-rate-below-budget");
  });

  it("fails when durable convergence or wake-store backlog budgets miss", () => {
    const evidence = buildPushWakeLoadEvidence({
      artifact: passingArtifact({
        convergence: {
          converged: false,
          convergedAfterMs: null,
          sampleCount: 24,
          finalSamples: {
            checkout: {
              head: "50",
              relayCursorGap: "8",
              checkpointGaps: [{ checkpointKey: "checkout.session-projection:checkout:v1", gap: "0", converged: true }],
            },
          },
        },
        wakeStatusAfter: wakeStatusSnapshot({ failedCount: 1, oldestQueuedAgeMs: 90_000 }, [
          {
            priorityLane: "standard",
            origin: "relay",
            state: "queued",
            sourceContextName: "marketplace",
            targetContextName: "checkout",
            projectionName: "checkout-session-projection",
            checkpointKey: "checkout.checkout-session-projection:marketplace",
            intentCount: 3,
            oldestCreatedAt: "2026-06-24T00:01:00.000Z",
            oldestAgeMs: 90_000,
            maxAttemptCount: 1,
          },
          {
            priorityLane: "hot",
            origin: "api-wait",
            state: "completed",
            sourceContextName: "checkout",
            targetContextName: "checkout",
            projectionName: "checkout-session-projection",
            checkpointKey: "checkout.checkout-session-projection:checkout",
            intentCount: 1,
            oldestCreatedAt: "2026-06-24T00:02:00.000Z",
            oldestAgeMs: 1_000,
            maxAttemptCount: 1,
          },
        ]),
      }),
      checkedAt: "2026-06-24T00:03:00.000Z",
      profile: "representative-volume",
      budgetOverrides: {},
    });

    expect(evidence.verdictReasons).toEqual(
      expect.arrayContaining([
        "durable-positions-did-not-converge",
        "durable-convergence-exceeded-budget",
        "relay-cursor-gap-nonzero:checkout",
        "wake-failed-intents-after-load",
        "wake-queue-age-after-load-exceeded-budget",
      ]),
    );
    expect(evidence.observations.wakeStatus.after.oldestQueuedIntentGroups).toEqual([
      {
        priorityLane: "standard",
        origin: "relay",
        state: "queued",
        sourceContextName: "marketplace",
        targetContextName: "checkout",
        projectionName: "checkout-session-projection",
        checkpointKey: "checkout.checkout-session-projection:marketplace",
        intentCount: 3,
        oldestCreatedAt: "2026-06-24T00:01:00.000Z",
        oldestAgeMs: 90_000,
        maxAttemptCount: 1,
      },
    ]);
  });

  it("fails when the source drill records no wake runtime recovery after load", () => {
    const evidence = buildPushWakeLoadEvidence({
      artifact: passingArtifact({
        wakeRuntimeAfterLoad: wakeRuntimeReadiness({
          ready: false,
          readyAfterMs: null,
          sampleCount: 3,
          initial: {
            ready: false,
            activeWakeCapableWorkerCount: 0,
            relayLeaseState: "expired",
            relayOwnerId: "worker-old",
            reasons: ["no-active-wake-capable-workers", "relay-lease-not-active"],
          },
          final: {
            ready: false,
            activeWakeCapableWorkerCount: 0,
            relayLeaseState: "expired",
            relayOwnerId: "worker-old",
            reasons: ["no-active-wake-capable-workers", "relay-lease-not-active"],
          },
        }),
      }),
      checkedAt: "2026-06-24T00:03:00.000Z",
      profile: "representative-volume",
      budgetOverrides: {},
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.verdictReasons).toContain("wake-runtime-not-ready-after-load");
    expect(evidence.observations.wakeRuntime.afterLoad.final).toMatchObject({
      activeWakeCapableWorkerCount: 0,
      relayLeaseState: "expired",
    });
  });

  it("detects sensitive values without copying them into passing observations", () => {
    expect(assertNoSensitiveLoadEvidenceValues({ url: "postgresql://user:secret@example.com/db" })).toHaveLength(2);

    const evidence = buildPushWakeLoadEvidence({
      artifact: passingArtifact({ correlationPrefix: "Bearer secret.token" }),
      checkedAt: "2026-06-24T00:03:00.000Z",
      profile: "bounded-staging",
      budgetOverrides: {},
    });

    expect(evidence.verdict).toBe("fail");
    expect(evidence.verdictReasons).toContain("artifact-leaked-sensitive-values");
    expect(JSON.stringify(evidence)).not.toContain("secret.token");
    expect(evidence.sourceArtifact.correlationPrefix).toBe("[redacted-sensitive-value]");
  });

  it("parses CLI options and writes an evaluation record from the command line", () => {
    const directory = mkdtempSync(join(tmpdir(), "push-wake-load-evidence-"));
    const artifactPath = join(directory, "staging-wake-drill-load.json");
    const outPath = join(directory, "evaluation.json");
    writeFileSync(artifactPath, `${JSON.stringify(passingArtifact())}\n`);

    expect(
      parsePushWakeLoadEvidenceArgs([
        "--artifact",
        artifactPath,
        "--profile",
        "representative-volume",
        "--min-iterations",
        "10",
      ]),
    ).toMatchObject({
      artifactPath,
      profile: "representative-volume",
      budgetOverrides: { minimumIterations: 10 },
    });

    execFileSync(
      process.execPath,
      [
        "./scripts/push-wake-load-evidence.mjs",
        "--artifact",
        artifactPath,
        "--profile",
        "representative-volume",
        "--checked-at",
        "2026-06-24T00:03:00.000Z",
        "--out",
        outPath,
      ],
      { stdio: "pipe" },
    );

    const evidence = JSON.parse(readFileSync(outPath, "utf8"));
    expect(evidence.schemaVersion).toBe(PUSH_WAKE_LOAD_EVIDENCE_VERSION);
    expect(evidence.verdict).toBe("pass");
    expect(evidence.sourceArtifact.path).toBe(artifactPath);
  });
});
