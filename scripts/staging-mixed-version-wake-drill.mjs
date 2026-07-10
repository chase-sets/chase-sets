#!/usr/bin/env node
// Redacted evaluator for the mixed-version wake envelope proof.
//
// This script intentionally composes existing evidence instead of deploying
// anything itself: Platform Deploy owns staging rollout, Platform Staging Wake
// Drills owns synthetic wake traffic, and this evaluator fails unless those
// windows overlap with distinct baseline/candidate commits.
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, normalizeString, readOption, readRepeatedOptions } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { assertRedactedDrillEvidence } from "./staging-wake-drills.mjs";

export const STAGING_MIXED_VERSION_WAKE_DRILL_VERSION = "staging-mixed-version-wake-drill/v1";

export function parseStagingMixedVersionWakeDrillArgs(argv) {
  return {
    deployRunJsonPath: readOption(argv, "--deploy-run-json"),
    wakeDrillJsonPaths: readRepeatedOptions(argv, "--wake-drill-json"),
    loadEvaluationJsonPaths: readRepeatedOptions(argv, "--load-evaluation-json"),
    baselineCommit: readOption(argv, "--baseline-commit"),
    candidateCommit: readOption(argv, "--candidate-commit"),
    outPath: readOption(argv, "--out") ?? "artifacts/wake-drills/staging-mixed-version-wake-drill-evidence.json",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export function validateStagingMixedVersionWakeDrillOptions(options) {
  const errors = [];
  if (!normalizeString(options.deployRunJsonPath)) {
    errors.push("--deploy-run-json is required.");
  }
  if (!Array.isArray(options.wakeDrillJsonPaths) || options.wakeDrillJsonPaths.length === 0) {
    errors.push("At least one --wake-drill-json path is required.");
  }
  if (!isCommitSha(options.baselineCommit)) {
    errors.push("--baseline-commit must be a 40-character commit SHA.");
  }
  if (options.candidateCommit && !isCommitSha(options.candidateCommit)) {
    errors.push("--candidate-commit must be a 40-character commit SHA when provided.");
  }
  return errors;
}

export async function loadStagingMixedVersionInputs(options) {
  const [deployRun, wakeDrills, loadEvaluations] = await Promise.all([
    readJson(options.deployRunJsonPath),
    Promise.all(options.wakeDrillJsonPaths.map((path) => readJson(path))),
    Promise.all((options.loadEvaluationJsonPaths ?? []).map((path) => readJson(path))),
  ]);

  return { deployRun, wakeDrills, loadEvaluations };
}

export function buildStagingMixedVersionWakeDrillEvidence(input) {
  const deployRun = input.deployRun ?? {};
  const wakeDrills = Array.isArray(input.wakeDrills) ? input.wakeDrills : [];
  const loadEvaluations = Array.isArray(input.loadEvaluations) ? input.loadEvaluations : [];
  const baselineCommit = normalizeCommit(input.baselineCommit);
  const candidateCommit = normalizeCommit(input.candidateCommit) ?? normalizeCommit(deployRun.headSha);
  const deployWindow = deploymentWindow(deployRun);
  const trafficWindow = wakeTrafficWindow(wakeDrills);
  const verdictReasons = [];

  if (!baselineCommit) {
    verdictReasons.push("baseline-commit-missing-or-invalid");
  }
  if (!candidateCommit) {
    verdictReasons.push("candidate-commit-missing-or-invalid");
  }
  if (baselineCommit && candidateCommit && baselineCommit === candidateCommit) {
    verdictReasons.push("baseline-and-candidate-commit-match");
  }
  if (deployRun.status !== "completed" || deployRun.conclusion !== "success") {
    verdictReasons.push("platform-deploy-run-not-successful");
  }
  if (!deployWindow.startedAt || !deployWindow.completedAt) {
    verdictReasons.push("staging-deploy-window-missing");
  }
  if (!trafficWindow.startedAt || !trafficWindow.completedAt) {
    verdictReasons.push("wake-traffic-window-missing");
  }
  if (deployWindow.startedAt && deployWindow.completedAt && trafficWindow.startedAt && trafficWindow.completedAt) {
    if (!windowsOverlap(deployWindow, trafficWindow)) {
      verdictReasons.push("wake-traffic-did-not-overlap-staging-deploy");
    }
  }

  const wakeSummaries = wakeDrills.map(summarizeWakeDrill);
  const failedWakeDrills = wakeSummaries.filter((summary) => summary.verdict !== "pass");
  if (failedWakeDrills.length > 0) {
    verdictReasons.push("wake-drill-verdict-not-pass");
  }
  const failedEvaluations = loadEvaluations.filter(
    (evaluation) => evaluation?.verdict && evaluation.verdict !== "pass",
  );
  if (failedEvaluations.length > 0) {
    verdictReasons.push("load-evaluator-verdict-not-pass");
  }

  const evidence = {
    schemaVersion: STAGING_MIXED_VERSION_WAKE_DRILL_VERSION,
    issueNumbers: [1365],
    environment: "staging",
    checkedAt: normalizeIso(input.checkedAt) ?? new Date().toISOString(),
    baseline: {
      commit: baselineCommit,
    },
    candidate: {
      commit: candidateCommit,
      platformDeployRunId: normalizeRunId(deployRun.databaseId ?? deployRun.runId),
      platformDeployUrl: normalizeString(deployRun.url),
    },
    deployWindow,
    trafficWindow,
    wakeDrills: wakeSummaries,
    loadEvaluations: loadEvaluations.map(summarizeLoadEvaluation),
    envelopeOutcomeCounts: summarizeEnvelopeOutcomes(wakeSummaries, loadEvaluations),
    durableConvergence: summarizeDurableConvergence(wakeSummaries),
    redaction: {
      databaseUrls: "never-recorded",
      adminCredentials: "never-recorded",
      sessionTokens: "never-recorded",
      guestEmails: "never-recorded",
      rawLogs: "never-recorded",
      leakMatchCount: 0,
    },
    verdict: verdictReasons.length === 0 ? "pass" : "fail",
    verdictReasons,
  };

  const leaks = assertRedactedDrillEvidence(evidence);
  if (leaks.length > 0) {
    throw new Error(`Mixed-version wake evidence leaked sensitive values: ${leaks.join(", ")}`);
  }
  return evidence;
}

export function renderMixedVersionStepSummary(evidence) {
  const lines = [
    "## Staging mixed-version wake drill",
    "",
    `- Verdict: **${evidence.verdict}**${
      evidence.verdictReasons.length > 0 ? ` (${evidence.verdictReasons.join(", ")})` : ""
    }`,
    `- Baseline: ${shortSha(evidence.baseline.commit)}`,
    `- Candidate: ${shortSha(evidence.candidate.commit)}`,
    `- Deploy window: ${evidence.deployWindow.startedAt ?? "unknown"} to ${
      evidence.deployWindow.completedAt ?? "unknown"
    }`,
    `- Traffic window: ${evidence.trafficWindow.startedAt ?? "unknown"} to ${
      evidence.trafficWindow.completedAt ?? "unknown"
    }`,
    "",
    "| Drill | Verdict | Attempts | Promoted | Durable convergence | Checkout relay gap | Max checkpoint gap |",
    "| --- | --- | ---: | ---: | --- | ---: | ---: |",
  ];
  for (const drill of evidence.wakeDrills) {
    lines.push(
      `| ${drill.drillKind} | ${drill.verdict} | ${drill.attempted} | ${drill.promoted} | ${
        drill.durableConverged ? "yes" : "no"
      } | ${drill.checkoutRelayCursorGap ?? "n/a"} | ${drill.checkoutMaxCheckpointGap ?? "n/a"} |`,
    );
  }
  lines.push("", "Evidence schema: `staging-mixed-version-wake-drill/v1`.");
  return `${lines.join("\n")}\n`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function deploymentWindow(run) {
  const jobs = Array.isArray(run.jobs) ? run.jobs : [];
  const stagingJob =
    jobs.find((job) => job?.name === "Deploy Staging") ??
    jobs.find((job) => /deploy staging/i.test(String(job?.name ?? "")));
  return {
    startedAt: normalizeIso(stagingJob?.startedAt) ?? null,
    completedAt: normalizeIso(stagingJob?.completedAt) ?? null,
    jobName: stagingJob?.name ?? null,
    jobUrl: normalizeString(stagingJob?.url),
    conclusion: normalizeString(stagingJob?.conclusion),
  };
}

function wakeTrafficWindow(wakeDrills) {
  const starts = wakeDrills
    .map((drill) => normalizeIso(drill?.checkedAt))
    .filter(Boolean)
    .sort();
  const completions = wakeDrills
    .map((drill) => normalizeIso(drill?.completedAt))
    .filter(Boolean)
    .sort();
  return {
    startedAt: starts.at(0) ?? null,
    completedAt: completions.at(-1) ?? null,
    drillCount: wakeDrills.length,
  };
}

function windowsOverlap(left, right) {
  return (
    Date.parse(left.startedAt) <= Date.parse(right.completedAt) &&
    Date.parse(right.startedAt) <= Date.parse(left.completedAt)
  );
}

function summarizeWakeDrill(drill) {
  const loadSummary = drill?.loadSummary ?? null;
  const singleWrite = drill?.canaryWrite?.attempted ? drill.canaryWrite : null;
  const attempted = toNumber(loadSummary?.attempted) ?? (singleWrite ? 1 : 0);
  const promoted = toNumber(loadSummary?.promoted) ?? (singleWrite?.promotionDecision === "promote" ? 1 : 0);
  const checkoutConvergence = drill?.convergence?.finalSamples?.checkout ?? null;
  const checkpointGaps = Array.isArray(checkoutConvergence?.checkpointGaps) ? checkoutConvergence.checkpointGaps : [];
  const readyLatency =
    loadSummary?.readyLatencyMs ?? (singleWrite ? summarizeSingleLatency(singleWrite.readyLatencyMs) : null);

  return {
    schemaVersion: drill?.schemaVersion ?? null,
    drillKind: drill?.drillKind ?? null,
    verdict: drill?.verdict ?? null,
    checkedAt: normalizeIso(drill?.checkedAt),
    completedAt: normalizeIso(drill?.completedAt),
    correlationPrefix: normalizeString(drill?.correlationPrefix),
    attempted,
    promoted,
    readinessPassRate: toNumber(loadSummary?.readinessPassRate) ?? (attempted > 0 ? promoted / attempted : null),
    readyLatencyMs: readyLatency,
    durableConverged: drill?.convergence?.converged === true,
    durableConvergedAfterMs: toNumber(drill?.convergence?.convergedAfterMs),
    checkoutRelayCursorGap: checkoutConvergence?.relayCursorGap ?? null,
    checkoutMaxCheckpointGap: maxNumber(checkpointGaps.map((entry) => entry?.gap)),
    laggingCheckpointCount: checkpointGaps.filter((entry) => entry?.converged === false).length,
    wakeFailedCountAfter: toNumber(drill?.wakeStatusAfter?.wakeStore?.intentSummary?.failedCount),
    wakeStaleClaimCountAfter: toNumber(drill?.wakeStatusAfter?.wakeStore?.intentSummary?.staleClaimCount),
    wakeQueuedCountAfter: toNumber(drill?.wakeStatusAfter?.wakeStore?.intentSummary?.queuedCount),
    activeWakeCapableWorkersAfter:
      toNumber(drill?.wakeRuntimeAfterLoad?.final?.activeWakeCapableWorkerCount) ??
      toNumber(drill?.wakeRuntimeAfterDrill?.activeWakeCapableWorkerCount),
    redaction: drill?.redaction ?? null,
  };
}

function summarizeSingleLatency(value) {
  const latency = toNumber(value);
  return {
    samples: latency === null ? 0 : 1,
    min: latency,
    p50: latency,
    p95: latency,
    max: latency,
  };
}

function summarizeLoadEvaluation(evaluation) {
  return {
    schemaVersion: evaluation?.schemaVersion ?? null,
    verdict: evaluation?.verdict ?? null,
    profile: evaluation?.profile ?? evaluation?.input?.profile ?? null,
    verdictReasons: Array.isArray(evaluation?.verdictReasons) ? evaluation.verdictReasons : [],
    redaction: evaluation?.redaction ?? null,
  };
}

function summarizeEnvelopeOutcomes(wakeSummaries, loadEvaluations) {
  return {
    source: "staging wake drill artifacts plus no-secret load evaluator",
    syntheticWakeAttempts: sum(wakeSummaries.map((summary) => summary.attempted)),
    promotedWakeAttempts: sum(wakeSummaries.map((summary) => summary.promoted)),
    passedWakeDrills: wakeSummaries.filter((summary) => summary.verdict === "pass").length,
    failedWakeDrills: wakeSummaries.filter((summary) => summary.verdict !== "pass").length,
    passedLoadEvaluations: loadEvaluations.filter((evaluation) => evaluation?.verdict === "pass").length,
    failedLoadEvaluations: loadEvaluations.filter((evaluation) => evaluation?.verdict && evaluation.verdict !== "pass")
      .length,
    rejectedEnvelopeCount: "not-recorded-in-artifact",
    ignoredEnvelopeCount: "not-recorded-in-artifact",
    rawLogCountSource: "not-used",
  };
}

function summarizeDurableConvergence(wakeSummaries) {
  return {
    allWakeDrillsConverged: wakeSummaries.every((summary) => summary.durableConverged),
    maxConvergedAfterMs: maxNumber(wakeSummaries.map((summary) => summary.durableConvergedAfterMs)),
    maxCheckoutRelayCursorGap: maxNumber(wakeSummaries.map((summary) => summary.checkoutRelayCursorGap)),
    maxCheckoutCheckpointGap: maxNumber(wakeSummaries.map((summary) => summary.checkoutMaxCheckpointGap)),
    maxLaggingCheckpointCount: maxNumber(wakeSummaries.map((summary) => summary.laggingCheckpointCount)),
    maxWakeFailedCountAfter: maxNumber(wakeSummaries.map((summary) => summary.wakeFailedCountAfter)),
    maxWakeStaleClaimCountAfter: maxNumber(wakeSummaries.map((summary) => summary.wakeStaleClaimCountAfter)),
    maxWakeQueuedCountAfter: maxNumber(wakeSummaries.map((summary) => summary.wakeQueuedCountAfter)),
  };
}

function normalizeCommit(value) {
  const normalized = normalizeString(value);
  return isCommitSha(normalized) ? normalized.toLowerCase() : null;
}

function normalizeRunId(value) {
  const normalized = normalizeString(String(value ?? ""));
  return normalized && /^\d+$/.test(normalized) ? normalized : null;
}

function normalizeIso(value) {
  const normalized = normalizeString(value);
  return normalized && !Number.isNaN(Date.parse(normalized)) ? normalized : null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function maxNumber(values) {
  const numbers = values.map(toNumber).filter((value) => value !== null);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function sum(values) {
  return values
    .map(toNumber)
    .filter((value) => value !== null)
    .reduce((total, value) => total + value, 0);
}

function shortSha(value) {
  return value ? value.slice(0, 8) : "unknown";
}

async function main(argv) {
  try {
    const options = parseStagingMixedVersionWakeDrillArgs(argv);
    const errors = validateStagingMixedVersionWakeDrillOptions(options);
    if (errors.length > 0) {
      console.error(errors.join(" "));
      return 2;
    }
    const inputs = await loadStagingMixedVersionInputs(options);
    const evidence = buildStagingMixedVersionWakeDrillEvidence({
      ...inputs,
      baselineCommit: options.baselineCommit,
      candidateCommit: options.candidateCommit,
      checkedAt: options.checkedAt,
    });
    await writeJsonRecord(options.outPath, evidence);
    console.log(JSON.stringify(evidence, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(process.env.GITHUB_STEP_SUMMARY, renderMixedVersionStepSummary(evidence));
    }
    return evidence.verdict === "pass" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
