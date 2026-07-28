#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const RELEASE_HEALTH_VERSION = "release-health/v1";

export function parseReleaseHealthArgs(argv, env = process.env) {
  const stagingResult = readOption(argv, "--staging-result") ?? readEnv("STAGING_RESULT", env) ?? "unknown";
  return {
    outPath: readOption(argv, "--out") ?? readEnv("RELEASE_HEALTH_OUT", env),
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    workflowRunId: readOption(argv, "--workflow-run-id") ?? readEnv("GITHUB_RUN_ID", env),
    workflowRunAttempt: readOption(argv, "--workflow-run-attempt") ?? readEnv("GITHUB_RUN_ATTEMPT", env),
    dispatchSource: readOption(argv, "--dispatch-source") ?? readEnv("DISPATCH_SOURCE", env) ?? "manual",
    dispatchRunId: readOption(argv, "--dispatch-run-id") ?? readEnv("DISPATCH_RUN_ID", env) ?? null,
    dispatchAttempt: readOption(argv, "--dispatch-attempt") ?? readEnv("DISPATCH_ATTEMPT", env) ?? null,
    dispatchReason: readOption(argv, "--dispatch-reason") ?? readEnv("DISPATCH_REASON", env) ?? null,
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
    stagingResult,
    stagingApplied: normalizeBoolean(
      readOption(argv, "--staging-applied") ??
        readEnv("STAGING_APPLIED", env) ??
        (normalizeResult(stagingResult) === "success" ? "true" : "false"),
    ),
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
    // account-cart-post-write-consistency, a required migrated canary
    // alongside the Buy Now canary above. Unlike Buy Now, this probe is a
    // doc-backed observation rather than a self-driving browser flow: it
    // only blocks promotion when a redacted observation was configured for
    // the release; otherwise it is a documented advisory coverage gap.
    accountCartCanaryResult:
      readOption(argv, "--account-cart-canary-result") ?? readEnv("ACCOUNT_CART_CANARY_RESULT", env) ?? "skipped",
    accountCartCanaryStartedAt:
      readOption(argv, "--account-cart-canary-started-at") ?? readEnv("ACCOUNT_CART_CANARY_STARTED_AT", env) ?? null,
    accountCartCanaryCompletedAt:
      readOption(argv, "--account-cart-canary-completed-at") ??
      readEnv("ACCOUNT_CART_CANARY_COMPLETED_AT", env) ??
      null,
    accountCartCanaryPromotionDecision:
      readOption(argv, "--account-cart-canary-promotion-decision") ??
      readEnv("ACCOUNT_CART_CANARY_PROMOTION_DECISION", env) ??
      null,
    accountCartCanaryConfigured: normalizeBoolean(
      readOption(argv, "--account-cart-canary-configured") ?? readEnv("ACCOUNT_CART_CANARY_CONFIGURED", env) ?? "false",
    ),
    productionReadinessGateOutcome:
      readOption(argv, "--production-readiness-gate-outcome") ??
      readEnv("PRODUCTION_READINESS_GATE_OUTCOME", env) ??
      null,
    productionResult: readOption(argv, "--production-result") ?? readEnv("PRODUCTION_RESULT", env) ?? "unknown",
    productionStartedAt: readOption(argv, "--production-started-at") ?? readEnv("PRODUCTION_STARTED_AT", env) ?? null,
    productionCompletedAt:
      readOption(argv, "--production-completed-at") ?? readEnv("PRODUCTION_COMPLETED_AT", env) ?? null,
    releaseAttemptResult:
      readOption(argv, "--release-attempt-result") ?? readEnv("RELEASE_ATTEMPT_RESULT", env) ?? null,
    releaseAttemptPhase: readOption(argv, "--release-attempt-phase") ?? readEnv("RELEASE_ATTEMPT_PHASE", env) ?? null,
    releaseAttemptReason:
      readOption(argv, "--release-attempt-reason") ?? readEnv("RELEASE_ATTEMPT_REASON", env) ?? null,
    releaseAttemptSupersededByCommit:
      readOption(argv, "--release-attempt-superseded-by-commit") ??
      readEnv("RELEASE_ATTEMPT_SUPERSEDED_BY_COMMIT", env) ??
      null,
    releaseAttemptWorkflowUrl:
      readOption(argv, "--release-attempt-workflow-url") ?? readEnv("RELEASE_ATTEMPT_WORKFLOW_URL", env) ?? null,
    releaseStateTransitions: parseJsonList(
      readOption(argv, "--release-state-transitions") ?? readEnv("RELEASE_STATE_TRANSITIONS", env) ?? "[]",
    ),
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
    rollbackSourceRevision: normalizeOptionalInteger(
      readOption(argv, "--rollback-source-revision") ?? readEnv("ROLLBACK_SOURCE_REVISION", env),
      "ROLLBACK_SOURCE_REVISION",
    ),
    rollbackResultingRevision: normalizeOptionalInteger(
      readOption(argv, "--rollback-resulting-revision") ?? readEnv("ROLLBACK_RESULTING_REVISION", env),
      "ROLLBACK_RESULTING_REVISION",
    ),
    rollbackObservedTag: readOption(argv, "--rollback-observed-tag") ?? readEnv("ROLLBACK_OBSERVED_TAG", env) ?? null,
    rollbackObservedDigest:
      readOption(argv, "--rollback-observed-digest") ?? readEnv("ROLLBACK_OBSERVED_DIGEST", env) ?? null,
    rollbackWorkloadIdentities: parseJsonList(
      readOption(argv, "--rollback-workload-identities") ?? readEnv("ROLLBACK_WORKLOAD_IDENTITIES", env) ?? "[]",
    ),
    productionRecoveryMode:
      readOption(argv, "--production-recovery-mode") ?? readEnv("PRODUCTION_RECOVERY_MODE", env) ?? "unknown",
    productionRecoveryReason:
      readOption(argv, "--production-recovery-reason") ?? readEnv("PRODUCTION_RECOVERY_REASON", env) ?? null,
    rollbackReadinessResult:
      readOption(argv, "--rollback-readiness-result") ?? readEnv("ROLLBACK_READINESS_RESULT", env) ?? "unknown",
    productionRestorePointResult:
      readOption(argv, "--production-restore-point-result") ??
      readEnv("PRODUCTION_RESTORE_POINT_RESULT", env) ??
      "unknown",
    productionRestorePointType:
      readOption(argv, "--production-restore-point-type") ?? readEnv("PRODUCTION_RESTORE_POINT_TYPE", env) ?? null,
    productionRestorePointClusterId:
      readOption(argv, "--production-restore-point-cluster-id") ??
      readEnv("PRODUCTION_RESTORE_POINT_CLUSTER_ID", env) ??
      null,
    productionRestorePointName:
      readOption(argv, "--production-restore-point-name") ?? readEnv("PRODUCTION_RESTORE_POINT_NAME", env) ?? null,
    productionRestorePointStatus:
      readOption(argv, "--production-restore-point-status") ?? readEnv("PRODUCTION_RESTORE_POINT_STATUS", env) ?? null,
    productionRestorePointCreatedAt:
      readOption(argv, "--production-restore-point-created-at") ??
      readEnv("PRODUCTION_RESTORE_POINT_CREATED_AT", env) ??
      null,
    productionRestorePointBypassed: normalizeBoolean(
      readOption(argv, "--production-restore-point-bypassed") ??
        readEnv("PRODUCTION_RESTORE_POINT_BYPASSED", env) ??
        "false",
    ),
    productionRestorePointRemediation:
      readOption(argv, "--production-restore-point-remediation") ??
      readEnv("PRODUCTION_RESTORE_POINT_REMEDIATION", env) ??
      null,
    productionRestorePointPreMigrateStateKey:
      readOption(argv, "--production-restore-point-pre-migrate-state-key") ??
      readEnv("PRODUCTION_RESTORE_POINT_PRE_MIGRATE_STATE_KEY", env) ??
      null,
    productionRestorePointPreMigrateStateFingerprint:
      readOption(argv, "--production-restore-point-pre-migrate-state-fingerprint") ??
      readEnv("PRODUCTION_RESTORE_POINT_PRE_MIGRATE_STATE_FINGERPRINT", env) ??
      null,
    productionRestorePointReused: normalizeBoolean(
      readOption(argv, "--production-restore-point-reused") ??
        readEnv("PRODUCTION_RESTORE_POINT_REUSED", env) ??
        "false",
    ),
    productionRestorePointReusedClusterId:
      readOption(argv, "--production-restore-point-reused-cluster-id") ??
      readEnv("PRODUCTION_RESTORE_POINT_REUSED_CLUSTER_ID", env) ??
      null,
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export function buildReleaseHealthRecord(input) {
  const errors = [];
  const releaseMode = input.releaseMode ?? "normal";
  const dispatchSource = input.dispatchSource ?? (releaseMode === "emergency" ? "emergency" : "manual");
  const recoveryMode = input.recoveryMode ?? "none";
  const queueBatchSize = Number.isInteger(input.queueBatchSize) ? input.queueBatchSize : 1;
  const releaseCategory = input.releaseCategory ?? "ordinary-deploy";
  const exposurePostureCategories = Array.isArray(input.exposurePostureCategories)
    ? [...input.exposurePostureCategories].sort()
    : [];
  const canaryCohortSize = Number.isInteger(input.canaryCohortSize) ? input.canaryCohortSize : null;
  const stagingApplied =
    typeof input.stagingApplied === "boolean"
      ? input.stagingApplied
      : normalizeResult(input.stagingResult) === "success";

  if (!isCommitSha(input.releaseCommit)) {
    errors.push("releaseCommit must be a 40-character Git commit SHA.");
  }
  if (!isNonEmptyString(input.workflowRunId)) {
    errors.push("workflowRunId is required.");
  }
  if (!["normal", "emergency"].includes(releaseMode)) {
    errors.push("releaseMode must be normal or emergency.");
  }
  if (!["automatic", "manual", "recovery", "emergency"].includes(dispatchSource)) {
    errors.push("dispatchSource must be automatic, manual, recovery, or emergency.");
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
  validateOptionalIsoInstant("accountCartCanaryStartedAt", input.accountCartCanaryStartedAt, errors);
  validateOptionalIsoInstant("accountCartCanaryCompletedAt", input.accountCartCanaryCompletedAt, errors);
  validateOptionalIsoInstant("productionStartedAt", input.productionStartedAt, errors);
  validateOptionalIsoInstant("productionCompletedAt", input.productionCompletedAt, errors);
  validateOptionalIsoInstant("productionRestorePointCreatedAt", input.productionRestorePointCreatedAt, errors);
  if (isNonEmptyString(input.mergeSha) && !isCommitSha(input.mergeSha)) {
    errors.push("mergeSha must be a 40-character Git commit SHA when provided.");
  }
  if (!["none", "readiness", "rollback", "fix-forward"].includes(recoveryMode)) {
    errors.push("recoveryMode must be none, readiness, rollback, or fix-forward.");
  }
  if (!["pitr", "precreated-fork", "manual-hold", "unknown"].includes(input.productionRecoveryMode ?? "unknown")) {
    errors.push("productionRecoveryMode must be pitr, precreated-fork, manual-hold, or unknown.");
  }
  if (isNonEmptyString(input.recoveryTargetCommit) && !isCommitSha(input.recoveryTargetCommit)) {
    errors.push("recoveryTargetCommit must be a 40-character Git commit SHA when provided.");
  }
  validateRollbackIdentity(input, recoveryMode, errors);
  if (
    isNonEmptyString(input.releaseAttemptPhase) &&
    !["queue", "staging", "canary", "production", "review"].includes(input.releaseAttemptPhase.trim())
  ) {
    errors.push("releaseAttemptPhase must be queue, staging, canary, production, or review when provided.");
  }
  if (
    isNonEmptyString(input.releaseAttemptSupersededByCommit) &&
    !isCommitSha(input.releaseAttemptSupersededByCommit)
  ) {
    errors.push("releaseAttemptSupersededByCommit must be a 40-character Git commit SHA when provided.");
  }
  validateReleaseStateTransitions(input.releaseStateTransitions ?? [], errors);

  const record = {
    schemaVersion: RELEASE_HEALTH_VERSION,
    releaseCommit: input.releaseCommit ?? "",
    workflowRunId: input.workflowRunId ?? "",
    workflowRunAttempt: input.workflowRunAttempt ?? "",
    checkedAt: input.checkedAt,
    releaseMode,
    dispatch: {
      source: dispatchSource,
      runId: emptyToNull(input.dispatchRunId),
      attempt: emptyToNull(input.dispatchAttempt),
      reason: emptyToNull(input.dispatchReason),
    },
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
      applied: stagingApplied,
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
    // Required critical migrated canary, kept separate from the Buy Now
    // `canary` block above so its blocking/advisory posture can be evaluated
    // on its own budget rather than folded into the Buy Now decision.
    accountCartCanary: {
      startedAt: emptyToNull(input.accountCartCanaryStartedAt),
      completedAt: emptyToNull(input.accountCartCanaryCompletedAt),
      result: normalizeResult(input.accountCartCanaryResult),
      configured: Boolean(input.accountCartCanaryConfigured),
      promotionDecision: emptyToNull(input.accountCartCanaryPromotionDecision),
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
      rollbackIdentity:
        recoveryMode === "rollback"
          ? {
              sourceRevision: input.rollbackSourceRevision ?? null,
              resultingRevision: input.rollbackResultingRevision ?? null,
              observedTag: emptyToNull(input.rollbackObservedTag),
              observedDigest: emptyToNull(input.rollbackObservedDigest),
              workloadIdentities: normalizeRollbackWorkloadIdentities(input.rollbackWorkloadIdentities),
            }
          : null,
      productionRecoveryMode: input.productionRecoveryMode ?? "unknown",
      productionRecoveryReason: emptyToNull(input.productionRecoveryReason),
      rollbackReadinessResult: normalizeResult(input.rollbackReadinessResult),
      productionRestorePoint: {
        result: normalizeResult(input.productionRestorePointResult),
        type: emptyToNull(input.productionRestorePointType),
        clusterId: emptyToNull(input.productionRestorePointClusterId),
        name: emptyToNull(input.productionRestorePointName),
        status: emptyToNull(input.productionRestorePointStatus),
        createdAt: emptyToNull(input.productionRestorePointCreatedAt),
        bypassed: Boolean(input.productionRestorePointBypassed),
        remediation: emptyToNull(input.productionRestorePointRemediation),
        preMigrateStateKey: emptyToNull(input.productionRestorePointPreMigrateStateKey),
        preMigrateStateFingerprint: emptyToNull(input.productionRestorePointPreMigrateStateFingerprint),
        reused: Boolean(input.productionRestorePointReused),
        reusedClusterId: emptyToNull(input.productionRestorePointReusedClusterId),
      },
    },
  };

  if (
    isNonEmptyString(input.releaseAttemptResult) ||
    isNonEmptyString(input.releaseAttemptPhase) ||
    isNonEmptyString(input.releaseAttemptReason) ||
    isNonEmptyString(input.releaseAttemptSupersededByCommit) ||
    isNonEmptyString(input.releaseAttemptWorkflowUrl)
  ) {
    record.attempt = {
      result: normalizeResult(input.releaseAttemptResult),
      phase: emptyToNull(input.releaseAttemptPhase),
      reason: emptyToNull(input.releaseAttemptReason),
      supersededByCommit: emptyToNull(input.releaseAttemptSupersededByCommit),
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

  if (Array.isArray(input.releaseStateTransitions) && input.releaseStateTransitions.length > 0) {
    record.releaseState = {
      transitions: input.releaseStateTransitions.map(normalizeReleaseStateTransition),
      coalescedCount: input.releaseStateTransitions
        .filter((transition) => transition?.type === "coalesced")
        .reduce((total, transition) => total + (Number.isInteger(transition.count) ? transition.count : 1), 0),
      terminalOutcome:
        [...input.releaseStateTransitions]
          .reverse()
          .find((transition) => ["promoted", "failed", "rolled-back", "superseded"].includes(transition?.type))?.type ??
        null,
    };
  }

  record.gates = buildGateResults(record, input);
  record.gateSummary = summarizeGateResults(record.gates);

  return {
    record,
    errors,
    passesReleaseHealthGate: errors.length === 0,
  };
}

export function buildGateResults(record, input = {}) {
  const deploymentRequired = record.deploymentRequired !== false;
  const releaseMode = record.releaseMode ?? "normal";
  const exposureCategories = record.releaseCategory?.exposurePostureCategories ?? [];
  const productionRecoveryMode = record.recovery?.productionRecoveryMode ?? "unknown";
  const restorePoint = record.recovery?.productionRestorePoint ?? {};
  const rollbackReadinessResult = record.recovery?.rollbackReadinessResult ?? "unknown";
  const recoveryMode = record.recovery?.mode ?? "none";
  const canaryPromotionDecision = record.canary?.promotionDecision ?? null;
  const accountCartCanaryConfigured = Boolean(record.accountCartCanary?.configured);
  const readinessOutcome = normalizeGateLabel(input.productionReadinessGateOutcome ?? "not-run");

  return [
    gateResult({
      id: "deployment-required",
      phase: "queue",
      owner: "ops",
      severity: deploymentRequired ? "blocking" : "not-applicable",
      status: deploymentRequired ? "pass" : "skipped",
      reason: deploymentRequired ? "release changes deployable surfaces" : "release does not require deployment",
    }),
    gateResult({
      id: "staging-deploy-and-smoke",
      phase: "staging",
      owner: "ops",
      severity: deploymentRequired ? "blocking" : "not-applicable",
      status: deploymentRequired ? statusForBlockingResult(record.staging?.result) : "skipped",
      reason: `staging result: ${record.staging?.result ?? "unknown"}`,
    }),
    gateResult({
      id: "production-recovery-mode",
      phase: "production-preflight",
      owner: "ops",
      severity: recoveryModeSeverity(productionRecoveryMode, deploymentRequired),
      status: deploymentRequired ? statusForRecoveryMode(productionRecoveryMode) : "skipped",
      reason: record.recovery?.productionRecoveryReason ?? `recovery mode: ${productionRecoveryMode}`,
    }),
    gateResult({
      id: "production-restore-point",
      phase: "production-preflight",
      owner: "ops",
      severity: restorePointRequired(productionRecoveryMode, deploymentRequired) ? "blocking" : "not-applicable",
      status: statusForRestorePoint(productionRecoveryMode, restorePoint, releaseMode, deploymentRequired),
      reason: restorePointReason(productionRecoveryMode, restorePoint, releaseMode, deploymentRequired),
    }),
    gateResult({
      id: "rollback-readiness",
      phase: "production-preflight",
      owner: "ops",
      severity: ["rollback", "fix-forward"].includes(recoveryMode) ? "blocking" : "not-applicable",
      status: ["rollback", "fix-forward"].includes(recoveryMode)
        ? statusForBlockingResult(rollbackReadinessResult)
        : "skipped",
      reason: `recovery mode: ${recoveryMode}; rollback readiness: ${rollbackReadinessResult}`,
    }),
    gateResult({
      id: "post-deploy-projection-readiness",
      phase: "production",
      owner: "platform-runtime",
      severity: readinessGateSeverity(readinessOutcome, deploymentRequired),
      status: statusForReadinessGate(readinessOutcome, deploymentRequired),
      reason: `readiness outcome: ${readinessOutcome}`,
    }),
    gateResult({
      id: "stage-1-production-canary",
      phase: "production",
      owner: "ops",
      severity: deploymentRequired ? "blocking" : "not-applicable",
      status: deploymentRequired ? statusForCanary(record.canary?.result, canaryPromotionDecision) : "skipped",
      reason: `canary result: ${record.canary?.result ?? "unknown"}; promotion decision: ${canaryPromotionDecision ?? "unknown"}`,
    }),
    // account-cart-post-write-consistency as a required critical migrated
    // canary. It blocks staging promotion when a redacted observation was
    // configured for the release and the probe did not promote. When no
    // observation was configured, the milestone policy is to warn explicitly
    // (advisory) rather than block every release on instrumentation the
    // runtime/UI owner has not wired up yet, and rather than silently
    // reporting green.
    gateResult({
      id: "account-cart-critical-canary",
      phase: "staging",
      owner: "platform-runtime",
      severity: accountCartCanarySeverity(accountCartCanaryConfigured, deploymentRequired),
      status: accountCartCanaryStatus(
        accountCartCanaryConfigured,
        record.accountCartCanary?.result,
        record.accountCartCanary?.promotionDecision,
        deploymentRequired,
      ),
      reason: accountCartCanaryReason(
        accountCartCanaryConfigured,
        record.accountCartCanary?.result,
        record.accountCartCanary?.promotionDecision,
        deploymentRequired,
      ),
    }),
    gateResult({
      id: "production-smoke-and-marker",
      phase: "production",
      owner: "ops",
      severity: deploymentRequired ? "blocking" : "not-applicable",
      status: deploymentRequired ? statusForBlockingResult(record.production?.result) : "skipped",
      reason: `production result: ${record.production?.result ?? "unknown"}`,
    }),
    gateResult({
      id: "exposure-posture-proof",
      phase: "capability-expansion",
      owner: "ops",
      severity: exposureCategories.length > 0 ? "deferred-proof" : "not-applicable",
      status: exposureCategories.length > 0 ? "pass" : "skipped",
      reason:
        exposureCategories.length > 0
          ? `exposure posture categories: ${exposureCategories.join(",")}`
          : "no exposure posture category changed",
    }),
  ];
}

function gateResult({ id, phase, owner, severity, status, reason }) {
  return {
    id,
    phase,
    owner,
    severity,
    status,
    reason,
  };
}

function summarizeGateResults(gates) {
  return {
    total: gates.length,
    blockingFailures: gates.filter((gate) => gate.severity === "blocking" && gate.status === "fail").length,
    advisoryWarnings: gates.filter((gate) => gate.severity === "advisory" && gate.status === "warn").length,
    deferredProof: gates.filter((gate) => gate.severity === "deferred-proof").length,
    notApplicable: gates.filter((gate) => gate.severity === "not-applicable").length,
  };
}

function recoveryModeSeverity(mode, deploymentRequired) {
  if (!deploymentRequired) {
    return "not-applicable";
  }
  if (mode === "precreated-fork" || mode === "manual-hold") {
    return "blocking";
  }
  if (mode === "pitr") {
    return "advisory";
  }
  return "blocking";
}

function statusForRecoveryMode(mode) {
  if (mode === "pitr" || mode === "precreated-fork" || mode === "manual-hold") {
    return "pass";
  }
  return "fail";
}

function restorePointRequired(mode, deploymentRequired) {
  return deploymentRequired && (mode === "precreated-fork" || mode === "manual-hold");
}

function statusForRestorePoint(mode, restorePoint, releaseMode, deploymentRequired) {
  if (!restorePointRequired(mode, deploymentRequired)) {
    return "skipped";
  }
  if (restorePoint.result === "success") {
    return "pass";
  }
  if (restorePoint.result === "bypassed" && releaseMode === "emergency" && restorePoint.bypassed) {
    return "pass";
  }
  return "fail";
}

function restorePointReason(mode, restorePoint, releaseMode, deploymentRequired) {
  if (!restorePointRequired(mode, deploymentRequired)) {
    return `restore point not required for recovery mode: ${mode}`;
  }
  if (restorePoint.result === "bypassed" && releaseMode === "emergency" && restorePoint.bypassed) {
    return "restore point bypassed by audited emergency release";
  }
  return `restore point result: ${restorePoint.result ?? "unknown"}`;
}

function readinessGateSeverity(outcome, deploymentRequired) {
  if (!deploymentRequired || outcome === "not-run" || outcome === "skipped" || outcome === "unknown") {
    return "not-applicable";
  }
  return outcome === "error" ? "blocking" : "advisory";
}

function statusForReadinessGate(outcome, deploymentRequired) {
  if (!deploymentRequired || outcome === "not-run" || outcome === "skipped" || outcome === "unknown") {
    return "skipped";
  }
  if (outcome === "ready") {
    return "pass";
  }
  if (outcome === "budget-expired") {
    return "warn";
  }
  return "fail";
}

function statusForCanary(result, promotionDecision) {
  const normalizedResult = normalizeResult(result);
  const normalizedDecision = normalizeGateLabel(promotionDecision);
  if (normalizedResult === "success" || normalizedDecision === "promote") {
    return "pass";
  }
  if (normalizedResult === "skipped" || normalizedResult === "bypassed") {
    return "skipped";
  }
  return "fail";
}

function accountCartCanarySeverity(configured, deploymentRequired) {
  if (!deploymentRequired) {
    return "not-applicable";
  }
  return configured ? "blocking" : "advisory";
}

function accountCartCanaryStatus(configured, result, promotionDecision, deploymentRequired) {
  if (!deploymentRequired) {
    return "skipped";
  }
  if (!configured) {
    return "warn";
  }
  return statusForCanary(result, promotionDecision);
}

function accountCartCanaryReason(configured, result, promotionDecision, deploymentRequired) {
  if (!deploymentRequired) {
    return "release does not require deployment";
  }
  if (!configured) {
    return "account-cart post-write consistency observation not configured for this release; documented coverage gap pending fixture-owned automation (issue #2516)";
  }
  return `account-cart canary result: ${result ?? "unknown"}; promotion decision: ${promotionDecision ?? "unknown"}`;
}

function statusForBlockingResult(result) {
  const normalized = normalizeResult(result);
  if (normalized === "success") {
    return "pass";
  }
  if (normalized === "skipped" || normalized === "bypassed") {
    return "skipped";
  }
  return "fail";
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
  return ["success", "failure", "cancelled", "skipped", "bypassed", "unknown"].includes(normalized)
    ? normalized
    : "unknown";
}

function normalizeGateLabel(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "unknown";
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

function validateReleaseStateTransitions(transitions, errors) {
  if (!Array.isArray(transitions)) {
    errors.push("releaseStateTransitions must be an array.");
    return;
  }
  const allowed = new Set([
    "candidate",
    "active",
    "pending",
    "coalesced",
    "promoted",
    "failed",
    "rolled-back",
    "superseded",
  ]);
  for (const [index, transition] of transitions.entries()) {
    if (!transition || !allowed.has(transition.type)) {
      errors.push(`releaseStateTransitions[${index}].type is invalid.`);
    }
    for (const field of ["commit", "supersededByCommit"]) {
      if (isNonEmptyString(transition?.[field]) && !isCommitSha(transition[field])) {
        errors.push(`releaseStateTransitions[${index}].${field} must be a 40-character Git commit SHA.`);
      }
    }
    if (isNonEmptyString(transition?.imageDigest) && !/^sha256:[0-9a-f]{64}$/i.test(transition.imageDigest.trim())) {
      errors.push(`releaseStateTransitions[${index}].imageDigest must be a sha256 digest.`);
    }
    if (transition?.count !== undefined && (!Number.isInteger(transition.count) || transition.count < 1)) {
      errors.push(`releaseStateTransitions[${index}].count must be a positive integer.`);
    }
  }
}

function validateRollbackIdentity(input, recoveryMode, errors) {
  if (recoveryMode !== "rollback") {
    return;
  }
  if (!isCommitSha(input.recoveryTargetCommit)) {
    errors.push("recoveryTargetCommit is required for rollback recovery.");
  }
  if (!Number.isInteger(input.rollbackSourceRevision) || input.rollbackSourceRevision < 1) {
    errors.push("rollbackSourceRevision must be a positive Helm revision for rollback recovery.");
  }
  if (!Number.isInteger(input.rollbackResultingRevision) || input.rollbackResultingRevision < 1) {
    errors.push("rollbackResultingRevision must be a positive Helm revision for rollback recovery.");
  } else if (
    Number.isInteger(input.rollbackSourceRevision) &&
    input.rollbackResultingRevision <= input.rollbackSourceRevision
  ) {
    errors.push("rollbackResultingRevision must be newer than rollbackSourceRevision.");
  }
  if (!isNonEmptyString(input.rollbackObservedTag)) {
    errors.push("rollbackObservedTag is required for rollback recovery.");
  } else if (
    isCommitSha(input.recoveryTargetCommit) &&
    input.rollbackObservedTag.trim() !== input.recoveryTargetCommit.trim()
  ) {
    errors.push("rollbackObservedTag must match recoveryTargetCommit for rollback recovery.");
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(input.rollbackObservedDigest ?? ""))) {
    errors.push("rollbackObservedDigest must be a sha256 digest for rollback recovery.");
  }
  if (!Array.isArray(input.rollbackWorkloadIdentities) || input.rollbackWorkloadIdentities.length === 0) {
    errors.push("rollbackWorkloadIdentities must contain every application workload for rollback recovery.");
    return;
  }
  const keys = new Set();
  for (const [index, workload] of input.rollbackWorkloadIdentities.entries()) {
    if (
      !isNonEmptyString(workload?.kind) ||
      !isNonEmptyString(workload?.name) ||
      !isNonEmptyString(workload?.component)
    ) {
      errors.push(`rollbackWorkloadIdentities[${index}] must identify kind, name, and component.`);
      continue;
    }
    const key = `${workload.kind.trim()}/${workload.name.trim()}`;
    if (keys.has(key)) {
      errors.push(`rollbackWorkloadIdentities contains duplicate ${key}.`);
    }
    keys.add(key);
    if (!Array.isArray(workload.images) || workload.images.length === 0) {
      errors.push(`rollbackWorkloadIdentities[${index}].images must not be empty.`);
      continue;
    }
    let matchingPrimaryImages = 0;
    for (const [imageIndex, image] of workload.images.entries()) {
      if (
        !isNonEmptyString(image?.container) ||
        !["application", "init"].includes(image?.containerType) ||
        !isNonEmptyString(image?.image)
      ) {
        errors.push(
          `rollbackWorkloadIdentities[${index}].images[${imageIndex}] must identify container, containerType, and image.`,
        );
        continue;
      }
      if (image.containerType === "application" && image.container.trim() === workload.component.trim()) {
        matchingPrimaryImages += 1;
        if (!image.image.trim().endsWith(`@${input.rollbackObservedDigest}`)) {
          errors.push(
            `rollbackWorkloadIdentities[${index}].images[${imageIndex}] does not match rollbackObservedDigest.`,
          );
        }
      }
    }
    if (matchingPrimaryImages !== 1) {
      errors.push(
        `rollbackWorkloadIdentities[${index}] must contain exactly one canonical component application image.`,
      );
    }
  }
}

function normalizeRollbackWorkloadIdentities(value) {
  return (Array.isArray(value) ? value : []).map((workload) => ({
    kind: String(workload.kind).trim(),
    name: String(workload.name).trim(),
    component: String(workload.component).trim(),
    images: (Array.isArray(workload.images) ? workload.images : []).map((image) => ({
      container: String(image.container).trim(),
      containerType: image.containerType,
      image: String(image.image).trim(),
    })),
  }));
}

function normalizeReleaseStateTransition(transition) {
  return {
    type: transition.type,
    ...(isNonEmptyString(transition.commit) ? { commit: transition.commit.trim() } : {}),
    ...(isNonEmptyString(transition.imageDigest) ? { imageDigest: transition.imageDigest.trim() } : {}),
    ...(isNonEmptyString(transition.mode) ? { mode: transition.mode.trim() } : {}),
    ...(isNonEmptyString(transition.supersededByCommit)
      ? { supersededByCommit: transition.supersededByCommit.trim() }
      : {}),
    ...(Number.isInteger(transition.count) ? { count: transition.count } : {}),
  };
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
