#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const RELEASE_HEALTH_VERSION = "release-health/v1";

export function parseReleaseHealthArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("RELEASE_HEALTH_OUT", env),
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    workflowRunId: readOption(argv, "--workflow-run-id") ?? readEnv("GITHUB_RUN_ID", env),
    workflowRunAttempt: readOption(argv, "--workflow-run-attempt") ?? readEnv("GITHUB_RUN_ATTEMPT", env),
    releaseMode: readOption(argv, "--release-mode") ?? readEnv("RELEASE_MODE", env) ?? "normal",
    queueQueuedAt: readOption(argv, "--queue-queued-at") ?? readEnv("QUEUE_QUEUED_AT", env) ?? null,
    queueMergedAt: readOption(argv, "--queue-merged-at") ?? readEnv("QUEUE_MERGED_AT", env) ?? null,
    releaseCommitCommittedAt:
      readOption(argv, "--release-commit-committed-at") ?? readEnv("RELEASE_COMMIT_COMMITTED_AT", env) ?? null,
    deploymentRequired: normalizeBoolean(
      readOption(argv, "--deployment-required") ?? readEnv("DEPLOYMENT_REQUIRED", env) ?? "true",
    ),
    stagingResult: readOption(argv, "--staging-result") ?? readEnv("STAGING_RESULT", env) ?? "unknown",
    stagingStartedAt: readOption(argv, "--staging-started-at") ?? readEnv("STAGING_STARTED_AT", env) ?? null,
    stagingCompletedAt: readOption(argv, "--staging-completed-at") ?? readEnv("STAGING_COMPLETED_AT", env) ?? null,
    canaryResult: readOption(argv, "--canary-result") ?? readEnv("CANARY_RESULT", env) ?? "skipped",
    canaryStartedAt: readOption(argv, "--canary-started-at") ?? readEnv("CANARY_STARTED_AT", env) ?? null,
    canaryCompletedAt: readOption(argv, "--canary-completed-at") ?? readEnv("CANARY_COMPLETED_AT", env) ?? null,
    productionResult: readOption(argv, "--production-result") ?? readEnv("PRODUCTION_RESULT", env) ?? "unknown",
    productionStartedAt: readOption(argv, "--production-started-at") ?? readEnv("PRODUCTION_STARTED_AT", env) ?? null,
    productionCompletedAt:
      readOption(argv, "--production-completed-at") ?? readEnv("PRODUCTION_COMPLETED_AT", env) ?? null,
    mainToProductionDriftCommits: normalizeInteger(
      readOption(argv, "--main-to-production-drift-commits") ?? readEnv("MAIN_TO_PRODUCTION_DRIFT_COMMITS", env) ?? "0",
      "MAIN_TO_PRODUCTION_DRIFT_COMMITS",
    ),
    mainToProductionDriftSeconds: normalizeInteger(
      readOption(argv, "--main-to-production-drift-seconds") ?? readEnv("MAIN_TO_PRODUCTION_DRIFT_SECONDS", env) ?? "0",
      "MAIN_TO_PRODUCTION_DRIFT_SECONDS",
    ),
    releaseLocked: normalizeBoolean(
      readOption(argv, "--release-locked") ?? readEnv("PRODUCTION_RELEASE_LOCKED", env) ?? "false",
    ),
    releaseLockReference:
      readOption(argv, "--release-lock-reference") ?? readEnv("PRODUCTION_RELEASE_LOCK_REFERENCE", env) ?? null,
    emergencyReference:
      readOption(argv, "--emergency-reference") ?? readEnv("EMERGENCY_RELEASE_REFERENCE", env) ?? null,
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export function buildReleaseHealthRecord(input) {
  const errors = [];

  if (!isCommitSha(input.releaseCommit)) {
    errors.push("releaseCommit must be a 40-character Git commit SHA.");
  }
  if (!isNonEmptyString(input.workflowRunId)) {
    errors.push("workflowRunId is required.");
  }
  if (!["normal", "emergency"].includes(input.releaseMode)) {
    errors.push("releaseMode must be normal or emergency.");
  }
  validateOptionalIsoInstant("queueQueuedAt", input.queueQueuedAt, errors);
  validateOptionalIsoInstant("queueMergedAt", input.queueMergedAt, errors);
  validateOptionalIsoInstant("releaseCommitCommittedAt", input.releaseCommitCommittedAt, errors);
  validateOptionalIsoInstant("stagingStartedAt", input.stagingStartedAt, errors);
  validateOptionalIsoInstant("stagingCompletedAt", input.stagingCompletedAt, errors);
  validateOptionalIsoInstant("canaryStartedAt", input.canaryStartedAt, errors);
  validateOptionalIsoInstant("canaryCompletedAt", input.canaryCompletedAt, errors);
  validateOptionalIsoInstant("productionStartedAt", input.productionStartedAt, errors);
  validateOptionalIsoInstant("productionCompletedAt", input.productionCompletedAt, errors);

  const record = {
    schemaVersion: RELEASE_HEALTH_VERSION,
    releaseCommit: input.releaseCommit ?? "",
    workflowRunId: input.workflowRunId ?? "",
    workflowRunAttempt: input.workflowRunAttempt ?? "",
    checkedAt: input.checkedAt,
    releaseMode: input.releaseMode,
    deploymentRequired: input.deploymentRequired,
    mainToProductionDrift: {
      commits: input.mainToProductionDriftCommits,
      seconds: input.mainToProductionDriftSeconds,
    },
    queue: {
      batchSize: 1,
      queuedAt: emptyToNull(input.queueQueuedAt),
      mergedAt: emptyToNull(input.queueMergedAt),
      releaseCommitCommittedAt: emptyToNull(input.releaseCommitCommittedAt),
    },
    staging: {
      startedAt: emptyToNull(input.stagingStartedAt),
      completedAt: emptyToNull(input.stagingCompletedAt),
      result: normalizeResult(input.stagingResult),
    },
    canary: {
      startedAt: emptyToNull(input.canaryStartedAt),
      completedAt: emptyToNull(input.canaryCompletedAt),
      result: normalizeResult(input.canaryResult),
    },
    production: {
      startedAt: emptyToNull(input.productionStartedAt),
      completedAt: emptyToNull(input.productionCompletedAt),
      result: normalizeResult(input.productionResult),
    },
    releaseLock: {
      locked: input.releaseLocked,
      bypassed: input.releaseMode === "emergency",
      reference: emptyToNull(input.releaseLockReference),
      emergencyReference: emptyToNull(input.emergencyReference),
    },
    verification: {
      platformSmoke: normalizeResult(input.productionResult) === "success" ? "success" : "unknown",
      criticalFlows: normalizeResult(input.stagingResult) === "success" ? "success" : "unknown",
      moneySmoke: normalizeResult(input.stagingResult) === "success" ? "success" : "unknown",
    },
  };

  return {
    record,
    errors,
    passesReleaseHealthGate: errors.length === 0,
  };
}

export async function writeReleaseHealthRecord(options) {
  const result = buildReleaseHealthRecord(options);
  if (!isNonEmptyString(options.outPath)) {
    throw new Error("RELEASE_HEALTH_OUT or --out is required.");
  }

  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, `${JSON.stringify(result.record, null, 2)}\n`);
  return result;
}

async function main(argv, env = process.env) {
  let options;
  try {
    options = parseReleaseHealthArgs(argv, env);
    const result = await writeReleaseHealthRecord(options);
    console.log(JSON.stringify(result.record, null, 2));
    if (!result.passesReleaseHealthGate) {
      for (const error of result.errors) {
        console.error(error);
      }
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function normalizeResult(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["success", "failure", "cancelled", "skipped", "unknown"].includes(normalized) ? normalized : "unknown";
}

function normalizeBoolean(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error("Boolean release-health inputs must be true or false.");
}

function normalizeInteger(value, name) {
  const normalized = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return normalized;
}

function validateOptionalIsoInstant(name, value, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    errors.push(`${name} must be an ISO timestamp when provided.`);
  }
}

function readEnv(name, env) {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function emptyToNull(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
