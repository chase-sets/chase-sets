#!/usr/bin/env node
// No-secret evaluator for captured push-wake load evidence.
//
// This script reads an already-captured staging wake drill artifact and checks
// it against explicit load/convergence/wake-store budgets. It does not contact
// staging, production, databases, Terraform, GitHub, or secret-backed services.
import { readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const PUSH_WAKE_LOAD_EVIDENCE_VERSION = "push-wake-load-evidence/v1";

export const LOAD_EVIDENCE_PROFILES = Object.freeze({
  "bounded-staging": Object.freeze({
    minimumIterations: 6,
    minimumConcurrency: 2,
    minimumEvidenceProducedRate: 1,
    maxConfigErrors: 0,
    maxDurableConvergenceMs: 120_000,
    requiredSourceContexts: Object.freeze(["checkout"]),
    requireWakeStatusSnapshots: false,
    requireWakeStoreAvailable: false,
    minimumActiveWakeCapableWorkers: 0,
    maxWakeFailedCountAfter: 0,
    allowInheritedWakeFailedIntents: true,
    maxWakeStaleClaimCountAfter: 0,
    maxWakeOldestQueuedAgeMsAfter: 60_000,
  }),
  "representative-volume": Object.freeze({
    minimumIterations: 12,
    minimumConcurrency: 4,
    minimumEvidenceProducedRate: 1,
    maxConfigErrors: 0,
    maxDurableConvergenceMs: 120_000,
    requiredSourceContexts: Object.freeze(["checkout"]),
    requireWakeStatusSnapshots: true,
    requireWakeStoreAvailable: true,
    minimumActiveWakeCapableWorkers: 1,
    maxWakeFailedCountAfter: 0,
    allowInheritedWakeFailedIntents: false,
    maxWakeStaleClaimCountAfter: 0,
    maxWakeOldestQueuedAgeMsAfter: 30_000,
  }),
});

const DEFAULT_PROFILE = "bounded-staging";
const DEFAULT_OUT_PATH = "artifacts/release-health/push-wake-load-evidence.json";
const STAGING_WAKE_DRILLS_VERSION = "staging-wake-drills/v1";
const POSTGRES_URL_PATTERN = /postgres(?:ql)?:\/\/[^"'\s]+/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/g;
const SESSION_TOKEN_FIELD_PATTERN = /"sessionToken"/g;

export function parsePushWakeLoadEvidenceArgs(argv, env = process.env) {
  return {
    artifactPath: readOption(argv, "--artifact") ?? readEnv("PUSH_WAKE_LOAD_ARTIFACT", env),
    outPath: readOption(argv, "--out") ?? readEnv("PUSH_WAKE_LOAD_EVIDENCE_OUT", env) ?? DEFAULT_OUT_PATH,
    profile: readOption(argv, "--profile") ?? readEnv("PUSH_WAKE_LOAD_EVIDENCE_PROFILE", env) ?? DEFAULT_PROFILE,
    format: readOption(argv, "--format") ?? readEnv("PUSH_WAKE_LOAD_EVIDENCE_FORMAT", env) ?? "json",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    budgetOverrides: {
      minimumIterations: readIntegerOption(argv, "--min-iterations"),
      minimumConcurrency: readIntegerOption(argv, "--min-concurrency"),
      maxDurableConvergenceMs: readIntegerOption(argv, "--max-durable-convergence-ms"),
      maxWakeOldestQueuedAgeMsAfter: readIntegerOption(argv, "--max-wake-oldest-queued-age-ms-after"),
    },
  };
}

export async function loadCapturedWakeArtifact(artifactPath) {
  return JSON.parse(await readFile(artifactPath, "utf8"));
}

export function buildPushWakeLoadEvidence(input) {
  const profile = LOAD_EVIDENCE_PROFILES[input.profile];
  if (!profile) {
    throw new Error(`Unknown push-wake load evidence profile '${input.profile}'.`);
  }

  const budgets = applyBudgetOverrides(profile, input.budgetOverrides);
  const artifact = isRecord(input.artifact) ? input.artifact : {};
  const leakMatches = assertNoSensitiveLoadEvidenceValues(artifact);
  const loadPlan = isRecord(artifact.loadPlan) ? artifact.loadPlan : {};
  const loadSummary = normalizeLoadSummary(artifact.loadSummary, artifact.loadResults);
  const loadReadinessDecision = normalizeLoadReadinessDecision(artifact.loadReadinessDecision);
  const convergence = normalizeConvergence(artifact.convergence);
  const wakeStatusBefore = normalizeWakeStatus(artifact.wakeStatusBefore);
  const wakeStatusAfter = normalizeWakeStatus(artifact.wakeStatusAfter);
  const wakePressure = normalizeWakePressure(wakeStatusBefore, wakeStatusAfter);
  const wakeFailedIntentDelta = Math.max(
    0,
    wakeStatusAfter.intentSummary.failedCount - wakeStatusBefore.intentSummary.failedCount,
  );
  const wakeRuntimeAfterLoad = normalizeWakeRuntimeReadiness(artifact.wakeRuntimeAfterLoad);
  const sourceContexts = readStringArray(artifact.sourceContexts);
  const verdictReasons = [];
  const warnings = [];

  if (leakMatches.length > 0) {
    verdictReasons.push("artifact-leaked-sensitive-values");
  }
  if (artifact.schemaVersion !== STAGING_WAKE_DRILLS_VERSION) {
    verdictReasons.push("unsupported-artifact-schema");
  }
  if (artifact.drillKind !== "load") {
    verdictReasons.push("load-drill-artifact-required");
  }
  if (artifact.verdict !== "pass") {
    verdictReasons.push("source-artifact-verdict-not-pass");
  }
  if (toFiniteNumber(loadPlan.iterations) < budgets.minimumIterations) {
    verdictReasons.push("load-iteration-count-below-budget");
  }
  if (toFiniteNumber(loadPlan.concurrency) < budgets.minimumConcurrency) {
    verdictReasons.push("load-concurrency-below-budget");
  }
  if (loadSummary.configErrors > budgets.maxConfigErrors) {
    verdictReasons.push("load-iteration-config-errors");
  }
  if (loadSummary.evidenceProducedRate < budgets.minimumEvidenceProducedRate) {
    verdictReasons.push("load-evidence-produced-rate-below-budget");
  }
  if (!convergence.converged) {
    verdictReasons.push("durable-positions-did-not-converge");
  }
  if (convergence.convergedAfterMs === null || convergence.convergedAfterMs > budgets.maxDurableConvergenceMs) {
    verdictReasons.push("durable-convergence-exceeded-budget");
  }
  if (loadSummary.attempted > 0 && loadSummary.promoted < loadSummary.attempted) {
    if (loadReadinessDecision.status !== "accepted-burst-saturation-degradation") {
      verdictReasons.push("load-readiness-slo-miss-without-accepted-decision");
    } else {
      warnings.push(
        `load per-write readiness missed the ${loadReadinessDecision.readySloMs ?? "configured"} ms budget; accepted by ${loadReadinessDecision.acceptedBy ?? "the recorded burst/saturation decision"}.`,
      );
    }
  }

  for (const contextName of budgets.requiredSourceContexts) {
    if (!sourceContexts.includes(contextName)) {
      verdictReasons.push(`missing-source-context:${contextName}`);
    }
    const sample = convergence.finalSamples[contextName];
    if (!sample) {
      verdictReasons.push(`missing-convergence-sample:${contextName}`);
    } else if (sample.relayCursorGap !== "0") {
      verdictReasons.push(`relay-cursor-gap-nonzero:${contextName}`);
    } else if ((sample.laggingCheckpointCount ?? 0) > 0) {
      verdictReasons.push(`projection-checkpoint-gap-nonzero:${contextName}`);
    }
  }

  if (budgets.requireWakeStatusSnapshots && (!wakeStatusBefore.present || !wakeStatusAfter.present)) {
    verdictReasons.push("wake-status-snapshots-required");
  } else if (!wakeStatusBefore.present || !wakeStatusAfter.present) {
    warnings.push("wake-status snapshots were not captured; wake-store backlog budgets are only partially evaluated.");
  }

  if (budgets.requireWakeStoreAvailable && !wakeStatusAfter.wakeStoreAvailable) {
    verdictReasons.push("wake-store-status-unavailable-after-load");
  }
  if (wakeStatusAfter.intentSummary.failedCount > budgets.maxWakeFailedCountAfter) {
    if (budgets.allowInheritedWakeFailedIntents === true && wakeStatusBefore.present && wakeStatusAfter.present) {
      if (wakeFailedIntentDelta > budgets.maxWakeFailedCountAfter) {
        verdictReasons.push("wake-failed-intents-increased-after-load");
      } else {
        warnings.push(
          `wake failed intents were inherited before the load window (${wakeStatusBefore.intentSummary.failedCount} before, ${wakeStatusAfter.intentSummary.failedCount} after).`,
        );
      }
    } else {
      verdictReasons.push("wake-failed-intents-after-load");
    }
  }
  if (wakeStatusAfter.intentSummary.staleClaimCount > budgets.maxWakeStaleClaimCountAfter) {
    verdictReasons.push("wake-stale-claims-after-load");
  }
  if (
    wakeStatusAfter.intentSummary.oldestQueuedAgeMs !== null &&
    wakeStatusAfter.intentSummary.oldestQueuedAgeMs > budgets.maxWakeOldestQueuedAgeMsAfter
  ) {
    verdictReasons.push("wake-queue-age-after-load-exceeded-budget");
  }
  if (wakeStatusAfter.activeWakeCapableWorkerCount < budgets.minimumActiveWakeCapableWorkers) {
    verdictReasons.push("active-wake-capable-worker-count-below-budget");
  }
  if (wakeRuntimeAfterLoad.attempted && wakeRuntimeAfterLoad.ready === false) {
    verdictReasons.push("wake-runtime-not-ready-after-load");
  }

  if (input.profile === "bounded-staging") {
    warnings.push(
      "bounded-staging validates the existing drill artifact shape; it is not production-like volume proof.",
    );
  }

  return {
    schemaVersion: PUSH_WAKE_LOAD_EVIDENCE_VERSION,
    checkedAt: input.checkedAt,
    issueNumbers: [1363, 2515],
    sourceArtifact: {
      path: input.artifactPath ? sanitizeEvidenceString(input.artifactPath) : null,
      schemaVersion: sanitizeEvidenceString(artifact.schemaVersion),
      drillKind: sanitizeEvidenceString(artifact.drillKind),
      environment: sanitizeEvidenceString(artifact.environment),
      checkedAt: sanitizeEvidenceString(artifact.checkedAt),
      completedAt: sanitizeEvidenceString(artifact.completedAt),
      verdict: sanitizeEvidenceString(artifact.verdict),
      verdictReasons: readStringArray(artifact.verdictReasons).map(sanitizeEvidenceString),
      correlationPrefix: sanitizeEvidenceString(artifact.correlationPrefix),
    },
    profile: input.profile,
    budgets,
    observations: {
      sourceContexts,
      loadPlan: {
        iterations: toFiniteNumber(loadPlan.iterations),
        concurrency: toFiniteNumber(loadPlan.concurrency),
        bounded: loadPlan.bounded === true,
      },
      loadSummary,
      loadReadinessDecision,
      durableConvergence: {
        converged: convergence.converged,
        convergedAfterMs: convergence.convergedAfterMs,
        sampleCount: convergence.sampleCount,
        sourceContexts: convergence.finalSamples,
      },
      wakeStatus: {
        before: wakeStatusBefore.summary,
        after: wakeStatusAfter.summary,
        failedIntentDelta: wakeFailedIntentDelta,
      },
      wakePressure,
      wakeRuntime: {
        afterLoad: wakeRuntimeAfterLoad.summary,
      },
    },
    verdict: verdictReasons.length === 0 ? "pass" : "fail",
    verdictReasons,
    warnings,
    redaction: {
      sourceArtifactStored: "not-copied",
      sensitiveValues: leakMatches.length === 0 ? "not-detected" : "detected",
      leakMatchCount: leakMatches.length,
      liveEnvironmentAccess: "not-used",
    },
  };
}

export function renderPushWakeLoadEvidenceMarkdown(evidence) {
  const load = evidence.observations.loadSummary;
  const convergence = evidence.observations.durableConvergence;
  const wakePressure = evidence.observations.wakePressure?.afterLoad;
  return [
    "# Push-Wake Load Evidence",
    "",
    `Schema: \`${evidence.schemaVersion}\``,
    `Profile: \`${evidence.profile}\``,
    `Verdict: **${evidence.verdict}**${
      evidence.verdictReasons.length > 0 ? ` (${evidence.verdictReasons.join(", ")})` : ""
    }`,
    `Source artifact: \`${evidence.sourceArtifact.path ?? "not recorded"}\``,
    "",
    "## Load",
    "",
    `- Iterations/concurrency: ${evidence.observations.loadPlan.iterations}/${evidence.observations.loadPlan.concurrency}`,
    `- Evidence produced: ${load.evidenceProduced}/${load.attempted} (${load.evidenceProducedRate})`,
    `- Config errors: ${load.configErrors}`,
    `- Ready latency p95: ${load.readyLatencyMs.p95 ?? "not measured"} ms`,
    `- Load readiness decision: ${evidence.observations.loadReadinessDecision.status ?? "not recorded"}`,
    "",
    "## Durable Convergence",
    "",
    `- Converged: ${convergence.converged}`,
    `- Converged after: ${convergence.convergedAfterMs ?? "not measured"} ms`,
    "",
    "## Wake Pressure",
    "",
    `- Attribution: ${wakePressure?.attribution.status ?? "not recorded"} (${wakePressure?.attribution.confidence ?? "unknown"} confidence)`,
    `- Queued intents after load: ${wakePressure?.queuedIntentCount ?? "not measured"} total; ${wakePressure?.hotLaneQueuedCount ?? "not measured"} hot-lane; ${wakePressure?.nonHotQueuedCount ?? "not measured"} non-hot`,
    `- Oldest queued age: hot ${wakePressure?.oldestHotQueuedAgeMs ?? "not measured"} ms; non-hot ${wakePressure?.oldestNonHotQueuedAgeMs ?? "not measured"} ms`,
    "",
    ...evidence.warnings.map((warning) => `> ${warning}`),
    "",
  ].join("\n");
}

export function assertNoSensitiveLoadEvidenceValues(value) {
  const serialized = JSON.stringify(value);
  const leaks = [];
  for (const pattern of [POSTGRES_URL_PATTERN, EMAIL_PATTERN, BEARER_PATTERN, SESSION_TOKEN_FIELD_PATTERN]) {
    pattern.lastIndex = 0;
    const matches = serialized.match(pattern);
    if (matches) {
      leaks.push(...matches);
    }
  }
  return [...new Set(leaks)];
}

function applyBudgetOverrides(profile, overrides = {}) {
  return Object.fromEntries(
    Object.entries({ ...profile, ...dropNullish(overrides) }).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
}

function dropNullish(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function normalizeLoadSummary(summaryValue, loadResultsValue) {
  const summary = isRecord(summaryValue) ? summaryValue : {};
  const loadResults = Array.isArray(loadResultsValue) ? loadResultsValue : [];
  const attempted = toNullableNumber(summary.attempted) ?? loadResults.length;
  const evidenceProduced =
    toNullableNumber(summary.evidenceProduced) ??
    loadResults.filter((result) => {
      const exitCode = toFiniteNumber(isRecord(result) ? result.exitCode : null);
      return exitCode === 0 || exitCode === 1;
    }).length;
  const configErrors =
    toNullableNumber(summary.configErrors) ??
    loadResults.filter((result) => {
      const exitCode = toFiniteNumber(isRecord(result) ? result.exitCode : null);
      return exitCode === 2 || exitCode === null;
    }).length;

  return {
    attempted,
    evidenceProduced,
    evidenceProducedRate: attempted === 0 ? 0 : Number((evidenceProduced / attempted).toFixed(4)),
    configErrors,
    promoted: toFiniteNumber(summary.promoted),
    readinessPassRate: toNullableNumber(summary.readinessPassRate),
    readyLatencyMs: normalizeNumberSummary(summary.readyLatencyMs),
  };
}

function normalizeLoadReadinessDecision(value) {
  const decision = isRecord(value) ? value : {};
  return {
    status: sanitizeEvidenceString(decision.status),
    decision: sanitizeEvidenceString(decision.decision),
    reason: sanitizeEvidenceString(decision.reason),
    acceptedBy: sanitizeEvidenceString(decision.acceptedBy),
    readySloMs: toNullableNumber(decision.readySloMs),
    readinessPassRate: toNullableNumber(decision.readinessPassRate),
    durableConvergenceStatus: sanitizeEvidenceString(decision.durableConvergenceStatus),
  };
}

function normalizeConvergence(value) {
  const convergence = isRecord(value) ? value : {};
  return {
    converged: convergence.converged === true,
    convergedAfterMs: toNullableNumber(convergence.convergedAfterMs),
    sampleCount: toFiniteNumber(convergence.sampleCount),
    finalSamples: Object.fromEntries(
      Object.entries(isRecord(convergence.finalSamples) ? convergence.finalSamples : {}).map(
        ([contextName, sample]) => [contextName, normalizeConvergenceSample(sample)],
      ),
    ),
  };
}

function normalizeConvergenceSample(value) {
  const sample = isRecord(value) ? value : {};
  const checkpointGaps = Array.isArray(sample.checkpointGaps) ? sample.checkpointGaps : [];
  return {
    head: readString(sample.head),
    relayCursorGap: sample.relayCursorGap === null ? null : readString(sample.relayCursorGap),
    checkpointScope: normalizeCheckpointScope(sample.checkpointScope),
    laggingCheckpointCount: checkpointGaps.filter((checkpoint) => isRecord(checkpoint) && checkpoint.converged !== true)
      .length,
    maxCheckpointGap: maxBigIntString(
      checkpointGaps.map((checkpoint) => (isRecord(checkpoint) ? checkpoint.gap : "0")),
    ),
  };
}

function normalizeCheckpointScope(value) {
  const scope = isRecord(value) ? value : {};
  return {
    mode: sanitizeEvidenceString(scope.mode),
    projectionNames: readStringArray(scope.projectionNames).map(sanitizeEvidenceString),
    missingProjectionNames: readStringArray(scope.missingProjectionNames).map(sanitizeEvidenceString),
    excludedCheckpointCount: toFiniteNumber(scope.excludedCheckpointCount),
    excludedLaggingCheckpointCount: toFiniteNumber(scope.excludedLaggingCheckpointCount),
    excludedMaxCheckpointGap:
      scope.excludedMaxCheckpointGap === null ? null : readString(scope.excludedMaxCheckpointGap),
  };
}

function normalizeWakeStatus(value) {
  const snapshot = isRecord(value) ? value : {};
  const wakeStore = isRecord(snapshot.wakeStore) ? snapshot.wakeStore : {};
  const intentSummary = isRecord(wakeStore.intentSummary) ? wakeStore.intentSummary : {};
  const schedulers = isRecord(snapshot.schedulers) ? snapshot.schedulers : {};
  const intentBreakdown = normalizeWakeIntentBreakdown(wakeStore.intentBreakdown);
  const normalized = {
    present: isRecord(value),
    wakeStoreAvailable: wakeStore.available === true,
    activeWakeCapableWorkerCount: toFiniteNumber(schedulers.activeWakeCapableWorkerCount),
    intentSummary: {
      queuedCount: toFiniteNumber(intentSummary.queuedCount),
      claimedCount: toFiniteNumber(intentSummary.claimedCount),
      failedCount: toFiniteNumber(intentSummary.failedCount),
      expiredCount: toFiniteNumber(intentSummary.expiredCount),
      staleClaimCount: toFiniteNumber(intentSummary.staleClaimCount),
      oldestQueuedAgeMs: toNullableNumber(intentSummary.oldestQueuedAgeMs),
    },
    intentBreakdown,
  };

  return {
    ...normalized,
    summary: {
      present: normalized.present,
      wakeStoreAvailable: normalized.wakeStoreAvailable,
      activeWakeCapableWorkerCount: normalized.activeWakeCapableWorkerCount,
      intentSummary: normalized.intentSummary,
      oldestQueuedIntentGroups: normalizeOldestQueuedIntentGroups(intentBreakdown),
    },
  };
}

function normalizeWakeIntentBreakdown(value) {
  return (Array.isArray(value) ? value : []).map((entry) => {
    const row = isRecord(entry) ? entry : {};
    return {
      priorityLane: sanitizeEvidenceString(row.priorityLane),
      origin: sanitizeEvidenceString(row.origin),
      state: sanitizeEvidenceString(row.state),
      sourceContextName: sanitizeEvidenceString(row.sourceContextName),
      targetContextName: sanitizeEvidenceString(row.targetContextName),
      projectionName: sanitizeEvidenceString(row.projectionName),
      checkpointKey: sanitizeEvidenceString(row.checkpointKey),
      intentCount: toFiniteNumber(row.intentCount),
      oldestCreatedAt: row.oldestCreatedAt === null ? null : sanitizeEvidenceString(row.oldestCreatedAt),
      oldestAgeMs: toNullableNumber(row.oldestAgeMs),
      maxAttemptCount: toFiniteNumber(row.maxAttemptCount),
    };
  });
}

function normalizeWakePressure(before, after) {
  return {
    beforeLoad: summarizeWakeIntentPressure(before),
    afterLoad: summarizeWakeIntentPressure(after),
  };
}

function summarizeWakeIntentPressure(snapshot) {
  if (!snapshot.present) {
    return emptyWakePressureSummary("insufficient-wake-status", "low", ["wake-status snapshot was not captured"]);
  }

  const queuedRows = snapshot.intentBreakdown.filter((entry) => entry.state === "queued");
  const summaryQueuedCount = snapshot.intentSummary.queuedCount;
  if (queuedRows.length === 0 && summaryQueuedCount > 0) {
    return {
      ...emptyWakePressureSummary("insufficient-wake-breakdown", "low", [
        "wake-status summary reported queued intents without lane breakdown rows",
      ]),
      queuedIntentCount: summaryQueuedCount,
    };
  }
  if (queuedRows.length === 0) {
    return emptyWakePressureSummary("no-queued-intents", "high", ["no queued wake intents were present"]);
  }

  const queuedByLane = {};
  const queuedByOrigin = {};
  const groupByLaneAndOrigin = new Map();
  let queuedIntentCount = 0;
  let hotLaneQueuedCount = 0;
  let nonHotQueuedCount = 0;
  let oldestHotQueuedAgeMs = null;
  let oldestNonHotQueuedAgeMs = null;

  for (const row of queuedRows) {
    const priorityLane = normalizePressureDimension(row.priorityLane);
    const origin = normalizePressureDimension(row.origin);
    const intentCount = row.intentCount;
    queuedIntentCount += intentCount;
    queuedByLane[priorityLane] = (queuedByLane[priorityLane] ?? 0) + intentCount;
    queuedByOrigin[origin] = (queuedByOrigin[origin] ?? 0) + intentCount;

    const groupKey = `${priorityLane}\u0000${origin}`;
    const group = groupByLaneAndOrigin.get(groupKey) ?? {
      priorityLane,
      origin,
      intentCount: 0,
      oldestAgeMs: null,
    };
    group.intentCount += intentCount;
    group.oldestAgeMs = maxNullableNumber(group.oldestAgeMs, row.oldestAgeMs);
    groupByLaneAndOrigin.set(groupKey, group);

    if (priorityLane === "hot") {
      hotLaneQueuedCount += intentCount;
      oldestHotQueuedAgeMs = maxNullableNumber(oldestHotQueuedAgeMs, row.oldestAgeMs);
    } else {
      nonHotQueuedCount += intentCount;
      oldestNonHotQueuedAgeMs = maxNullableNumber(oldestNonHotQueuedAgeMs, row.oldestAgeMs);
    }
  }

  return {
    queuedIntentCount,
    hotLaneQueuedCount,
    nonHotQueuedCount,
    oldestHotQueuedAgeMs,
    oldestNonHotQueuedAgeMs,
    queuedByLane: sortCountMap(queuedByLane),
    queuedByOrigin: sortCountMap(queuedByOrigin),
    queuedByLaneAndOrigin: [...groupByLaneAndOrigin.values()].sort(compareWakePressureGroups),
    attribution: classifyWakePressureAttribution(hotLaneQueuedCount, nonHotQueuedCount),
  };
}

function emptyWakePressureSummary(status, confidence, reasons) {
  return {
    queuedIntentCount: 0,
    hotLaneQueuedCount: 0,
    nonHotQueuedCount: 0,
    oldestHotQueuedAgeMs: null,
    oldestNonHotQueuedAgeMs: null,
    queuedByLane: {},
    queuedByOrigin: {},
    queuedByLaneAndOrigin: [],
    attribution: {
      status,
      confidence,
      reasons,
    },
  };
}

function normalizePressureDimension(value) {
  const normalized = sanitizeEvidenceString(value).trim().toLowerCase();
  return normalized || "unknown";
}

function classifyWakePressureAttribution(hotLaneQueuedCount, nonHotQueuedCount) {
  if (hotLaneQueuedCount > 0 && nonHotQueuedCount > 0) {
    return {
      status: "mixed-pressure",
      confidence: "high",
      reasons: ["hot-lane and non-hot wake intents remained queued after load"],
    };
  }
  if (hotLaneQueuedCount > 0) {
    return {
      status: "hot-lane-pressure",
      confidence: "high",
      reasons: ["hot-lane wake intents remained queued after load"],
    };
  }
  return {
    status: "background-lane-pressure",
    confidence: "high",
    reasons: ["queued wake intents were isolated to standard, bulk, or unknown lanes"],
  };
}

function sortCountMap(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function compareWakePressureGroups(left, right) {
  if (right.intentCount !== left.intentCount) {
    return right.intentCount - left.intentCount;
  }
  const rightAge = right.oldestAgeMs ?? -1;
  const leftAge = left.oldestAgeMs ?? -1;
  if (rightAge !== leftAge) {
    return rightAge - leftAge;
  }
  return `${left.priorityLane}:${left.origin}`.localeCompare(`${right.priorityLane}:${right.origin}`);
}

function maxNullableNumber(left, right) {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.max(left, right);
}

function normalizeOldestQueuedIntentGroups(intentBreakdown) {
  return intentBreakdown
    .filter((entry) => entry.state === "queued")
    .sort((left, right) => {
      const leftAge = left.oldestAgeMs ?? -1;
      const rightAge = right.oldestAgeMs ?? -1;
      return rightAge - leftAge;
    })
    .slice(0, 10);
}

function normalizeWakeRuntimeReadiness(value) {
  const readiness = isRecord(value) ? value : {};
  const initial = normalizeWakeRuntimeEvaluation(readiness.initial);
  const final = normalizeWakeRuntimeEvaluation(readiness.final);
  const normalized = {
    attempted: readiness.attempted === true,
    ready: typeof readiness.ready === "boolean" ? readiness.ready : null,
    readyAfterMs: toNullableNumber(readiness.readyAfterMs),
    sampleCount: toFiniteNumber(readiness.sampleCount),
    initial,
    final,
  };

  return {
    ...normalized,
    summary: normalized,
  };
}

function normalizeWakeRuntimeEvaluation(value) {
  const evaluation = isRecord(value) ? value : {};
  return {
    ready: typeof evaluation.ready === "boolean" ? evaluation.ready : null,
    activeWakeCapableWorkerCount: toFiniteNumber(evaluation.activeWakeCapableWorkerCount),
    relayLeaseState: sanitizeEvidenceString(evaluation.relayLeaseState),
    relayOwnerId: sanitizeEvidenceString(evaluation.relayOwnerId),
    reasons: readStringArray(evaluation.reasons).map(sanitizeEvidenceString),
  };
}

function normalizeNumberSummary(value) {
  const summary = isRecord(value) ? value : {};
  return {
    samples: toFiniteNumber(summary.samples),
    min: toNullableNumber(summary.min),
    p50: toNullableNumber(summary.p50),
    p95: toNullableNumber(summary.p95),
    max: toNullableNumber(summary.max),
  };
}

function readIntegerOption(argv, name) {
  const value = readOption(argv, name);
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function readStringArray(value) {
  return Array.isArray(value) ? value.map(readString).filter(Boolean) : [];
}

function readString(value) {
  return typeof value === "string" ? value : String(value ?? "");
}

function sanitizeEvidenceString(value) {
  const normalized = readString(value);
  return assertNoSensitiveLoadEvidenceValues(normalized).length > 0 ? "[redacted-sensitive-value]" : normalized;
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function maxBigIntString(values = []) {
  let max = null;
  for (const value of values) {
    let parsed = 0n;
    try {
      parsed = BigInt(String(value ?? "0"));
    } catch {
      parsed = 0n;
    }
    if (max === null || parsed > max) {
      max = parsed;
    }
  }
  return max === null ? null : max.toString();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(argv, env = process.env) {
  const options = parsePushWakeLoadEvidenceArgs(argv, env);
  if (!options.artifactPath) {
    console.error("--artifact or PUSH_WAKE_LOAD_ARTIFACT is required.");
    return 2;
  }
  if (!["json", "markdown"].includes(options.format)) {
    console.error("--format must be 'json' or 'markdown'.");
    return 2;
  }

  try {
    const artifact = await loadCapturedWakeArtifact(options.artifactPath);
    const evidence = buildPushWakeLoadEvidence({
      artifact,
      artifactPath: options.artifactPath,
      checkedAt: options.checkedAt,
      profile: options.profile,
      budgetOverrides: options.budgetOverrides,
    });

    if (options.format === "markdown") {
      console.log(renderPushWakeLoadEvidenceMarkdown(evidence));
    } else {
      await writeJsonRecord(options.outPath, evidence);
      console.log(`Wrote push-wake load evidence evaluation to ${options.outPath}`);
    }

    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, renderPushWakeLoadEvidenceMarkdown(evidence));
    }

    return evidence.verdict === "pass" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
