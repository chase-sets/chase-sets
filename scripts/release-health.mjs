#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const RELEASE_HEALTH_VERSION = "release-health/v1";

export function parseReleaseHealthArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("RELEASE_HEALTH_OUT", env),
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    workflowRunId: readOption(argv, "--workflow-run-id") ?? readEnv("GITHUB_RUN_ID", env),
    workflowRunAttempt: readOption(argv, "--workflow-run-attempt") ?? readEnv("GITHUB_RUN_ATTEMPT", env),
    releaseMode: readOption(argv, "--release-mode") ?? readEnv("RELEASE_MODE", env) ?? "normal",
    prOpenedAt: readOption(argv, "--pr-opened-at") ?? readEnv("PR_OPENED_AT", env) ?? null,
    prReadyForReviewAt: readOption(argv, "--pr-ready-for-review-at") ?? readEnv("PR_READY_FOR_REVIEW_AT", env) ?? null,
    prApprovedAt: readOption(argv, "--pr-approved-at") ?? readEnv("PR_APPROVED_AT", env) ?? null,
    queueBatchSize: normalizeInteger(
      readOption(argv, "--queue-batch-size") ?? readEnv("QUEUE_BATCH_SIZE", env) ?? "1",
      "QUEUE_BATCH_SIZE",
    ),
    queueQueuedAt: readOption(argv, "--queue-queued-at") ?? readEnv("QUEUE_QUEUED_AT", env) ?? null,
    queueMergeGroupStartedAt:
      readOption(argv, "--queue-merge-group-started-at") ?? readEnv("QUEUE_MERGE_GROUP_STARTED_AT", env) ?? null,
    queueMergedAt: readOption(argv, "--queue-merged-at") ?? readEnv("QUEUE_MERGED_AT", env) ?? null,
    queueDequeuedAt: readOption(argv, "--queue-dequeued-at") ?? readEnv("QUEUE_DEQUEUED_AT", env) ?? null,
    queueFailureReason: readOption(argv, "--queue-failure-reason") ?? readEnv("QUEUE_FAILURE_REASON", env) ?? null,
    mergeSha: readOption(argv, "--merge-sha") ?? readEnv("MERGE_SHA", env) ?? null,
    releaseCommitCommittedAt:
      readOption(argv, "--release-commit-committed-at") ?? readEnv("RELEASE_COMMIT_COMMITTED_AT", env) ?? null,
    releaseCategory: readOption(argv, "--release-category") ?? readEnv("RELEASE_CATEGORY", env) ?? "ordinary-deploy",
    exposurePostureCategories: parseCategoryList(
      readOption(argv, "--exposure-posture-categories") ?? readEnv("EXPOSURE_POSTURE_CATEGORIES", env) ?? "",
    ),
    deploymentRequired: normalizeBoolean(
      readOption(argv, "--deployment-required") ?? readEnv("DEPLOYMENT_REQUIRED", env) ?? "true",
    ),
    stagingResult: readOption(argv, "--staging-result") ?? readEnv("STAGING_RESULT", env) ?? "unknown",
    stagingStartedAt: readOption(argv, "--staging-started-at") ?? readEnv("STAGING_STARTED_AT", env) ?? null,
    stagingCompletedAt: readOption(argv, "--staging-completed-at") ?? readEnv("STAGING_COMPLETED_AT", env) ?? null,
    canaryResult: readOption(argv, "--canary-result") ?? readEnv("CANARY_RESULT", env) ?? "skipped",
    canaryStartedAt: readOption(argv, "--canary-started-at") ?? readEnv("CANARY_STARTED_AT", env) ?? null,
    canaryCompletedAt: readOption(argv, "--canary-completed-at") ?? readEnv("CANARY_COMPLETED_AT", env) ?? null,
    canarySkippedReason: readOption(argv, "--canary-skipped-reason") ?? readEnv("CANARY_SKIPPED_REASON", env) ?? null,
    canaryCohortSubjectType:
      readOption(argv, "--canary-cohort-subject-type") ?? readEnv("CANARY_COHORT_SUBJECT_TYPE", env) ?? null,
    canaryCohortSize: normalizeOptionalInteger(
      readOption(argv, "--canary-cohort-size") ?? readEnv("CANARY_COHORT_SIZE", env),
      "CANARY_COHORT_SIZE",
    ),
    canaryPromotionDecision:
      readOption(argv, "--canary-promotion-decision") ?? readEnv("CANARY_PROMOTION_DECISION", env) ?? null,
    productionResult: readOption(argv, "--production-result") ?? readEnv("PRODUCTION_RESULT", env) ?? "unknown",
    productionStartedAt: readOption(argv, "--production-started-at") ?? readEnv("PRODUCTION_STARTED_AT", env) ?? null,
    productionCompletedAt:
      readOption(argv, "--production-completed-at") ?? readEnv("PRODUCTION_COMPLETED_AT", env) ?? null,
    releaseAttemptResult:
      readOption(argv, "--release-attempt-result") ?? readEnv("RELEASE_ATTEMPT_RESULT", env) ?? null,
    releaseAttemptPhase: readOption(argv, "--release-attempt-phase") ?? readEnv("RELEASE_ATTEMPT_PHASE", env) ?? null,
    releaseAttemptReason:
      readOption(argv, "--release-attempt-reason") ?? readEnv("RELEASE_ATTEMPT_REASON", env) ?? null,
    releaseAttemptWorkflowUrl:
      readOption(argv, "--release-attempt-workflow-url") ?? readEnv("RELEASE_ATTEMPT_WORKFLOW_URL", env) ?? null,
    ciRetryCount: normalizeOptionalInteger(
      readOption(argv, "--ci-retry-count") ?? readEnv("CI_RETRY_COUNT", env),
      "CI_RETRY_COUNT",
    ),
    ciFlakyFailureCount: normalizeOptionalInteger(
      readOption(argv, "--ci-flaky-failure-count") ?? readEnv("CI_FLAKY_FAILURE_COUNT", env),
      "CI_FLAKY_FAILURE_COUNT",
    ),
    ciTopFlakyJobs: parseJsonList(readOption(argv, "--ci-top-flaky-jobs") ?? readEnv("CI_TOP_FLAKY_JOBS", env) ?? "[]"),
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
    recoveryMode: readOption(argv, "--recovery-mode") ?? readEnv("RECOVERY_MODE", env) ?? "none",
    recoveryReference: readOption(argv, "--recovery-reference") ?? readEnv("RECOVERY_REFERENCE", env) ?? null,
    recoveryTargetCommit:
      readOption(argv, "--recovery-target-commit") ?? readEnv("RECOVERY_TARGET_COMMIT", env) ?? null,
    rollbackReadinessResult:
      readOption(argv, "--rollback-readiness-result") ?? readEnv("ROLLBACK_READINESS_RESULT", env) ?? "unknown",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export function buildReleaseHealthRecord(input) {
  const errors = [];
  const releaseMode = input.releaseMode ?? "normal";
  const recoveryMode = input.recoveryMode ?? "none";
  const queueBatchSize = Number.isInteger(input.queueBatchSize) ? input.queueBatchSize : 1;
  const releaseCategory = input.releaseCategory ?? "ordinary-deploy";
  const exposurePostureCategories = Array.isArray(input.exposurePostureCategories)
    ? [...input.exposurePostureCategories].sort()
    : [];
  const canaryCohortSize = Number.isInteger(input.canaryCohortSize) ? input.canaryCohortSize : null;

  if (!isCommitSha(input.releaseCommit)) {
    errors.push("releaseCommit must be a 40-character Git commit SHA.");
  }
  if (!isNonEmptyString(input.workflowRunId)) {
    errors.push("workflowRunId is required.");
  }
  if (!["normal", "emergency"].includes(releaseMode)) {
    errors.push("releaseMode must be normal or emergency.");
  }
  validateOptionalIsoInstant("prOpenedAt", input.prOpenedAt, errors);
  validateOptionalIsoInstant("prReadyForReviewAt", input.prReadyForReviewAt, errors);
  validateOptionalIsoInstant("prApprovedAt", input.prApprovedAt, errors);
  validateOptionalIsoInstant("queueQueuedAt", input.queueQueuedAt, errors);
  validateOptionalIsoInstant("queueMergeGroupStartedAt", input.queueMergeGroupStartedAt, errors);
  validateOptionalIsoInstant("queueMergedAt", input.queueMergedAt, errors);
  validateOptionalIsoInstant("queueDequeuedAt", input.queueDequeuedAt, errors);
  validateOptionalIsoInstant("releaseCommitCommittedAt", input.releaseCommitCommittedAt, errors);
  validateOptionalIsoInstant("stagingStartedAt", input.stagingStartedAt, errors);
  validateOptionalIsoInstant("stagingCompletedAt", input.stagingCompletedAt, errors);
  validateOptionalIsoInstant("canaryStartedAt", input.canaryStartedAt, errors);
  validateOptionalIsoInstant("canaryCompletedAt", input.canaryCompletedAt, errors);
  validateOptionalIsoInstant("productionStartedAt", input.productionStartedAt, errors);
  validateOptionalIsoInstant("productionCompletedAt", input.productionCompletedAt, errors);
  if (isNonEmptyString(input.mergeSha) && !isCommitSha(input.mergeSha)) {
    errors.push("mergeSha must be a 40-character Git commit SHA when provided.");
  }
  if (!["none", "readiness", "rollback", "fix-forward"].includes(recoveryMode)) {
    errors.push("recoveryMode must be none, readiness, rollback, or fix-forward.");
  }
  if (isNonEmptyString(input.recoveryTargetCommit) && !isCommitSha(input.recoveryTargetCommit)) {
    errors.push("recoveryTargetCommit must be a 40-character Git commit SHA when provided.");
  }
  if (
    isNonEmptyString(input.releaseAttemptPhase) &&
    !["queue", "staging", "canary", "production", "review"].includes(input.releaseAttemptPhase.trim())
  ) {
    errors.push("releaseAttemptPhase must be queue, staging, canary, production, or review when provided.");
  }

  const record = {
    schemaVersion: RELEASE_HEALTH_VERSION,
    releaseCommit: input.releaseCommit ?? "",
    workflowRunId: input.workflowRunId ?? "",
    workflowRunAttempt: input.workflowRunAttempt ?? "",
    checkedAt: input.checkedAt,
    releaseMode,
    deploymentRequired: input.deploymentRequired,
    pullRequest: {
      openedAt: emptyToNull(input.prOpenedAt),
      readyForReviewAt: emptyToNull(input.prReadyForReviewAt),
      approvedAt: emptyToNull(input.prApprovedAt),
    },
    mainToProductionDrift: {
      commits: input.mainToProductionDriftCommits,
      seconds: input.mainToProductionDriftSeconds,
    },
    queue: {
      batchSize: queueBatchSize,
      queuedAt: emptyToNull(input.queueQueuedAt),
      mergeGroupStartedAt: emptyToNull(input.queueMergeGroupStartedAt),
      mergedAt: emptyToNull(input.queueMergedAt),
      dequeuedAt: emptyToNull(input.queueDequeuedAt),
      failureReason: emptyToNull(input.queueFailureReason),
      mergeSha: emptyToNull(input.mergeSha),
      releaseCommitCommittedAt: emptyToNull(input.releaseCommitCommittedAt),
    },
    releaseCategory: {
      primary: releaseCategory,
      exposurePostureCategories,
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
      skippedReason: emptyToNull(input.canarySkippedReason),
      cohort: {
        subjectType: emptyToNull(input.canaryCohortSubjectType),
        size: canaryCohortSize,
      },
      promotionDecision: emptyToNull(input.canaryPromotionDecision),
    },
    production: {
      startedAt: emptyToNull(input.productionStartedAt),
      completedAt: emptyToNull(input.productionCompletedAt),
      result: normalizeResult(input.productionResult),
    },
    releaseLock: {
      locked: input.releaseLocked,
      bypassed: releaseMode === "emergency",
      reference: emptyToNull(input.releaseLockReference),
      emergencyReference: emptyToNull(input.emergencyReference),
    },
    verification: {
      platformSmoke: normalizeResult(input.productionResult) === "success" ? "success" : "unknown",
      criticalFlows: normalizeResult(input.stagingResult) === "success" ? "success" : "unknown",
      moneySmoke: normalizeResult(input.stagingResult) === "success" ? "success" : "unknown",
    },
    recovery: {
      mode: recoveryMode,
      reference: emptyToNull(input.recoveryReference ?? input.emergencyReference),
      targetCommit: emptyToNull(input.recoveryTargetCommit),
      rollbackReadinessResult: normalizeResult(input.rollbackReadinessResult),
    },
  };

  if (
    isNonEmptyString(input.releaseAttemptResult) ||
    isNonEmptyString(input.releaseAttemptPhase) ||
    isNonEmptyString(input.releaseAttemptReason) ||
    isNonEmptyString(input.releaseAttemptWorkflowUrl)
  ) {
    record.attempt = {
      result: normalizeResult(input.releaseAttemptResult),
      phase: emptyToNull(input.releaseAttemptPhase),
      reason: emptyToNull(input.releaseAttemptReason),
      workflowUrl: emptyToNull(input.releaseAttemptWorkflowUrl),
    };
  }

  if (
    Number.isInteger(input.ciRetryCount) ||
    Number.isInteger(input.ciFlakyFailureCount) ||
    (Array.isArray(input.ciTopFlakyJobs) && input.ciTopFlakyJobs.length > 0)
  ) {
    record.ci = {
      retryCount: input.ciRetryCount ?? 0,
      flakyFailureCount: input.ciFlakyFailureCount ?? 0,
      topFlakyJobs: normalizeTopFlakyJobs(input.ciTopFlakyJobs),
    };
  }

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

  await writeJsonRecord(options.outPath, result.record);
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

function normalizeOptionalInteger(value, name) {
  if (!isNonEmptyString(value)) {
    return null;
  }
  return normalizeInteger(value, name);
}

function parseCategoryList(value) {
  if (!isNonEmptyString(value)) {
    return [];
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("EXPOSURE_POSTURE_CATEGORIES JSON must be an array.");
    }
    return parsed
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .sort();
  }
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
}

function parseJsonList(value) {
  if (!isNonEmptyString(value)) {
    return [];
  }
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("JSON list input must be an array.");
  }
  return parsed;
}

function normalizeTopFlakyJobs(value) {
  return (Array.isArray(value) ? value : []).map((job) => ({
    name: isNonEmptyString(job?.name) ? job.name.trim() : "unknown",
    retryCount: Number.isInteger(job?.retryCount) && job.retryCount > 0 ? job.retryCount : 0,
    flakyFailureCount:
      Number.isInteger(job?.flakyFailureCount) && job.flakyFailureCount > 0 ? job.flakyFailureCount : 0,
  }));
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

function emptyToNull(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
