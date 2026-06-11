#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption, readRepeatedOptions } from "./lib/cli-options.mjs";

export const RELEASE_HEALTH_REPORT_VERSION = "release-health-report/v1";

export function parseReleaseHealthReportArgs(argv, env = process.env) {
  return {
    files: readRepeatedOptions(argv, "--file"),
    dir: readOption(argv, "--dir") ?? readEnv("RELEASE_HEALTH_DIR", env) ?? "",
    outPath: readOption(argv, "--out") ?? readEnv("RELEASE_HEALTH_REPORT_OUT", env) ?? "",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function runReleaseHealthReport(options) {
  const files = [...options.files, ...(options.dir ? await findJsonFiles(options.dir) : [])];
  const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
  const report = buildReleaseHealthReport({ ...options, records });

  if (options.outPath) {
    await writeFile(options.outPath, report.markdown);
  }

  return report;
}

export function buildReleaseHealthReport(input) {
  const records = [...input.records].sort(compareReleaseRecords);
  const timing = summarizeTimings(records);
  const slo = evaluateReleaseSloPosture(records, timing);
  const deployableRecords = records.filter((record) => record.deploymentRequired !== false);
  const ci = summarizeCiPosture(records);
  const summary = {
    releaseCount: records.length,
    deployableReleaseCount: deployableRecords.length,
    successCount: records.filter((record) => record.production?.result === "success").length,
    failureCount: records.filter((record) => ["failure", "cancelled"].includes(record.production?.result)).length,
    stagingAbortCount: deployableRecords.filter(isStagingAbort).length,
    staleSkipCount: deployableRecords.filter(isStaleStagingSkip).length,
    emergencyCount: records.filter((record) => record.releaseMode === "emergency").length,
    lockedCount: records.filter((record) => record.releaseLock?.locked).length,
    rollbackCount: records.filter((record) => ["rollback", "fix-forward"].includes(record.recovery?.mode)).length,
    canaryAbortCount: records.filter((record) => record.canary?.result === "failure").length,
    ci,
    timing,
    slo,
  };

  const lines = [
    "# Release Health Report",
    "",
    `Schema: \`${RELEASE_HEALTH_REPORT_VERSION}\``,
    `Checked at: \`${input.checkedAt}\``,
    "",
    "## Summary",
    "",
    `- Releases: ${summary.releaseCount}`,
    `- Deployable release attempts: ${summary.deployableReleaseCount}`,
    `- Production successes: ${summary.successCount}`,
    `- Production failures/cancellations: ${summary.failureCount}`,
    `- Staging aborts: ${summary.stagingAbortCount}`,
    `- Stale staging skips: ${summary.staleSkipCount}`,
    `- Emergency releases: ${summary.emergencyCount}`,
    `- Releases with lock active: ${summary.lockedCount}`,
    `- Rollback/fix-forward releases: ${summary.rollbackCount}`,
    `- Canary aborts: ${summary.canaryAbortCount}`,
    `- Average queue wait: ${formatOptionalSeconds(summary.timing.averageQueueWaitSeconds)}`,
    `- Average merge to staging start: ${formatOptionalSeconds(summary.timing.averageMergeToStagingSeconds)}`,
    `- Batch-size posture: ${summary.slo.batchSizeRecommendation}`,
    `- Batch-size reason: ${summary.slo.batchSizeReason}`,
    "",
    "## CI Flake Posture",
    "",
    `- Releases with CI telemetry: ${summary.ci.releaseCountWithTelemetry}`,
    `- Releases affected by CI retries or flakes: ${summary.ci.affectedReleaseCount}`,
    `- Total CI retries: ${summary.ci.retryCount}`,
    `- Total flaky CI failures: ${summary.ci.flakyFailureCount}`,
    "",
    "| Job | Retries | Flaky failures |",
    "| --- | --- | --- |",
    ...formatCiRows(summary.ci),
    "",
    "## Release Process Review Checklist",
    "",
    "- Review staging aborts and stale skips before tuning merge queue rules.",
    "- Increase merge queue batch size only when the SLO posture recommends `increase-to-2`.",
    "- Keep batch size unchanged when sample size, queue timing, or CI flake data is missing or inconclusive.",
    "- Record any developer or operator friction that is not visible in release-health artifacts.",
    "- Open follow-up issues for recurring abort reasons, canary gaps, or rollback-readiness gaps.",
    "",
    "## Image Group Decision Inputs",
    "",
    `- Average staging duration: ${formatOptionalSeconds(summary.timing.averageStagingDurationSeconds)}`,
    `- Average production duration: ${formatOptionalSeconds(summary.timing.averageProductionDurationSeconds)}`,
    "- Split deployable image groups only when release-health evidence shows repeated wait, build, or rollback cost concentrated in one deployable boundary.",
    "- Keep the shared image when the expected operator cost of another image, dashboard, rollback path, and release gate is higher than the measured release delay.",
    "",
    "## Releases",
    "",
    "| Commit | Category | Mode | Staging | Canary | Production | Drift | Queue wait | Merge to staging | Recovery | Lock |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...records.map(formatReleaseRow),
    "",
    "## SLO Posture",
    "",
    "| Signal | Threshold | Current | Status |",
    "| --- | --- | --- | --- |",
    ...formatSloRows(summary.slo),
    "",
  ];

  return {
    schemaVersion: RELEASE_HEALTH_REPORT_VERSION,
    checkedAt: input.checkedAt,
    summary,
    markdown: `${lines.join("\n")}\n`,
  };
}

function formatReleaseRow(record) {
  return [
    shortCommit(record.releaseCommit),
    record.releaseCategory?.primary ?? "unknown",
    record.releaseMode ?? "unknown",
    record.staging?.result ?? "unknown",
    record.canary?.result ?? "unknown",
    record.production?.result ?? "unknown",
    formatDrift(record.mainToProductionDrift),
    formatDuration(record.queue?.queuedAt, record.queue?.mergedAt),
    formatDuration(record.queue?.mergedAt, record.staging?.startedAt),
    formatRecovery(record.recovery),
    formatLock(record.releaseLock),
  ]
    .map(escapeMarkdownCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
}

export function evaluateReleaseSloPosture(records, timing = summarizeTimings(records)) {
  const releaseCount = records.length;
  const deployedRecords = records.filter((record) => record.deploymentRequired !== false);
  const ci = summarizeCiPosture(records);
  const productionFailureRate = rate(
    deployedRecords.filter((record) => ["failure", "cancelled"].includes(record.production?.result)).length,
    deployedRecords.length,
  );
  const stagingFailureRate = rate(deployedRecords.filter(isStagingAbort).length, deployedRecords.length);
  const recoveryRate = rate(
    records.filter((record) => ["rollback", "fix-forward"].includes(record.recovery?.mode)).length,
    releaseCount,
  );
  const canaryAbortRate = rate(records.filter((record) => record.canary?.result === "failure").length, releaseCount);
  const maxDriftCommits = Math.max(0, ...records.map((record) => record.mainToProductionDrift?.commits ?? 0));
  const p95QueueWaitSeconds = percentile(timing.queueWaitSeconds, 0.95);
  const ciAffectedRate =
    ci.releaseCountWithTelemetry === 0 ? null : rate(ci.affectedReleaseCount, ci.releaseCountWithTelemetry);

  const signals = {
    deployableSampleSize: {
      threshold: ">= 10 deployable attempts",
      current: String(deployedRecords.length),
      passes: deployedRecords.length >= 10,
    },
    stagingFailureRate: {
      threshold: "<= 5%",
      current: formatPercent(stagingFailureRate),
      passes: stagingFailureRate <= 0.05,
    },
    productionFailureRate: {
      threshold: "<= 2%",
      current: formatPercent(productionFailureRate),
      passes: productionFailureRate <= 0.02,
    },
    recoveryRate: {
      threshold: "<= 2%",
      current: formatPercent(recoveryRate),
      passes: recoveryRate <= 0.02,
    },
    maxDriftCommits: {
      threshold: "<= 3 commits",
      current: String(maxDriftCommits),
      passes: maxDriftCommits <= 3,
    },
    p95QueueWait: {
      threshold: "<= 30m",
      current: formatOptionalSeconds(p95QueueWaitSeconds),
      passes: p95QueueWaitSeconds !== null && p95QueueWaitSeconds <= 1800,
    },
    canaryAbortRate: {
      threshold: "<= 5%",
      current: formatPercent(canaryAbortRate),
      passes: canaryAbortRate <= 0.05,
    },
    ciRetryOrFlakeRate: {
      threshold: "<= 5% when telemetry is present",
      current: ciAffectedRate === null ? "unknown" : formatPercent(ciAffectedRate),
      passes: ciAffectedRate === null || ciAffectedRate <= 0.05,
    },
  };
  const hardFailure = [
    signals.stagingFailureRate,
    signals.productionFailureRate,
    signals.recoveryRate,
    signals.maxDriftCommits,
    signals.canaryAbortRate,
    signals.ciRetryOrFlakeRate,
  ].some((signal) => !signal.passes);
  const missingTuningData = !signals.deployableSampleSize.passes || !signals.p95QueueWait.passes;
  const passes = Object.values(signals).every((signal) => signal.passes);

  return {
    signals,
    batchSizeRecommendation: hardFailure ? "decrease-or-hold" : missingTuningData ? "hold" : "increase-to-2",
    batchSizeReason: hardFailure
      ? "One or more release-health signals exceeds the release process SLO threshold."
      : missingTuningData
        ? "At least 10 deployable attempts and known p95 queue wait are required before increasing batch size."
        : passes
          ? "Release-health evidence supports testing a merge queue batch size of 2."
          : "Hold batch size until release-health evidence is complete.",
  };
}

function summarizeTimings(records) {
  const queueWaitSeconds = records
    .map((record) => durationSeconds(record.queue?.queuedAt, record.queue?.mergedAt))
    .filter((seconds) => seconds !== null);
  const mergeToStagingSeconds = records
    .map((record) => durationSeconds(record.queue?.mergedAt, record.staging?.startedAt))
    .filter((seconds) => seconds !== null);
  const stagingDurationSeconds = records
    .map((record) => durationSeconds(record.staging?.startedAt, record.staging?.completedAt))
    .filter((seconds) => seconds !== null);
  const productionDurationSeconds = records
    .map((record) => durationSeconds(record.production?.startedAt, record.production?.completedAt))
    .filter((seconds) => seconds !== null);

  return {
    queueWaitSeconds,
    mergeToStagingSeconds,
    stagingDurationSeconds,
    productionDurationSeconds,
    averageQueueWaitSeconds: average(queueWaitSeconds),
    averageMergeToStagingSeconds: average(mergeToStagingSeconds),
    averageStagingDurationSeconds: average(stagingDurationSeconds),
    averageProductionDurationSeconds: average(productionDurationSeconds),
  };
}

async function findJsonFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(entry.parentPath ?? dir, entry.name));
}

function compareReleaseRecords(a, b) {
  const aTime = Date.parse(a.production?.completedAt ?? a.checkedAt ?? a.queue?.mergedAt ?? "");
  const bTime = Date.parse(b.production?.completedAt ?? b.checkedAt ?? b.queue?.mergedAt ?? "");
  return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
}

function shortCommit(value) {
  return typeof value === "string" && value.length >= 8 ? value.slice(0, 8) : "unknown";
}

function formatDrift(value) {
  const commits = Number.isInteger(value?.commits) ? value.commits : 0;
  const seconds = Number.isInteger(value?.seconds) ? value.seconds : 0;
  return `${commits} commits / ${formatSeconds(seconds)}`;
}

function formatDuration(start, end) {
  const seconds = durationSeconds(start, end);
  return seconds === null ? "unknown" : formatSeconds(seconds);
}

function durationSeconds(start, end) {
  const startTime = Date.parse(start ?? "");
  const endTime = Date.parse(end ?? "");
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime < startTime) {
    return null;
  }
  return Math.round((endTime - startTime) / 1000);
}

function formatSeconds(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function formatLock(lock) {
  if (!lock?.locked) {
    return "clear";
  }
  return lock.bypassed ? `bypassed ${lock.emergencyReference ?? ""}`.trim() : `locked ${lock.reference ?? ""}`.trim();
}

function formatRecovery(recovery) {
  if (!recovery || recovery.mode === "none") {
    return "none";
  }
  return `${recovery.mode} ${recovery.reference ?? ""}`.trim();
}

function formatSloRows(slo) {
  return Object.entries(slo.signals).map(([name, signal]) =>
    [name, signal.threshold, signal.current, signal.passes ? "pass" : "fail"]
      .map(escapeMarkdownCell)
      .join(" | ")
      .replace(/^/, "| ")
      .replace(/$/, " |"),
  );
}

function summarizeCiPosture(records) {
  const ciRecords = records.filter((record) => record.ci && typeof record.ci === "object");
  const jobs = new Map();
  let retryCount = 0;
  let flakyFailureCount = 0;
  let affectedReleaseCount = 0;

  for (const record of ciRecords) {
    const ci = record.ci ?? {};
    const recordRetryCount = nonNegativeInteger(ci.retryCount);
    const recordFlakyFailureCount = nonNegativeInteger(ci.flakyFailureCount);
    retryCount += recordRetryCount;
    flakyFailureCount += recordFlakyFailureCount;
    if (recordRetryCount > 0 || recordFlakyFailureCount > 0) {
      affectedReleaseCount += 1;
    }

    for (const job of Array.isArray(ci.topFlakyJobs) ? ci.topFlakyJobs : []) {
      const name = typeof job.name === "string" && job.name.trim() ? job.name.trim() : "unknown";
      const previous = jobs.get(name) ?? { name, retryCount: 0, flakyFailureCount: 0 };
      previous.retryCount += nonNegativeInteger(job.retryCount);
      previous.flakyFailureCount += nonNegativeInteger(job.flakyFailureCount);
      jobs.set(name, previous);
    }
  }

  const topFlakyJobs = [...jobs.values()]
    .sort((a, b) => b.retryCount + b.flakyFailureCount - (a.retryCount + a.flakyFailureCount))
    .slice(0, 5);

  return {
    releaseCountWithTelemetry: ciRecords.length,
    affectedReleaseCount,
    retryCount,
    flakyFailureCount,
    topFlakyJobs,
  };
}

function formatCiRows(ci) {
  if (ci.topFlakyJobs.length === 0) {
    return ["| none | 0 | 0 |"];
  }
  return ci.topFlakyJobs.map((job) =>
    [job.name, String(job.retryCount), String(job.flakyFailureCount)]
      .map(escapeMarkdownCell)
      .join(" | ")
      .replace(/^/, "| ")
      .replace(/$/, " |"),
  );
}

function isStagingAbort(record) {
  return (
    ["failure", "cancelled"].includes(record.staging?.result) ||
    (record.attempt?.phase === "staging" && ["failure", "cancelled"].includes(record.attempt?.result))
  );
}

function isStaleStagingSkip(record) {
  return (
    record.attempt?.phase === "staging" &&
    record.staging?.result === "skipped" &&
    ["stale-release", "staging-not-deployed"].includes(record.attempt?.reason)
  );
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function average(values) {
  if (values.length === 0) {
    return null;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index];
}

function rate(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function formatPercent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatOptionalSeconds(seconds) {
  return seconds === null ? "unknown" : formatSeconds(seconds);
}

function escapeMarkdownCell(value) {
  return String(value).replaceAll("|", "\\|");
}

async function main(argv, env = process.env) {
  const options = parseReleaseHealthReportArgs(argv, env);
  if (options.files.length === 0 && !options.dir) {
    console.error("Pass at least one --file or a RELEASE_HEALTH_DIR/--dir.");
    return 2;
  }

  const report = await runReleaseHealthReport(options);
  console.log(report.markdown);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
