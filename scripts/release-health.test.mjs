import { describe, expect, it } from "vitest";
import { buildReleaseHealthRecord, parseReleaseHealthArgs } from "./release-health.mjs";

describe("release health summary", () => {
  it("builds a production release health record", () => {
    const result = buildReleaseHealthRecord({
      releaseCommit: "a".repeat(40),
      workflowRunId: "123456",
      workflowRunAttempt: "2",
      checkedAt: "2026-05-31T12:00:00.000Z",
      releaseMode: "normal",
      queueQueuedAt: "2026-05-31T11:50:00.000Z",
      queueMergedAt: "2026-05-31T11:55:00.000Z",
      releaseCommitCommittedAt: "2026-05-31T11:54:30.000Z",
      deploymentRequired: true,
      stagingResult: "success",
      stagingStartedAt: "2026-05-31T11:56:00.000Z",
      stagingCompletedAt: "2026-05-31T12:05:00.000Z",
      canaryResult: "skipped",
      canaryStartedAt: "",
      canaryCompletedAt: "",
      productionResult: "success",
      productionStartedAt: "2026-05-31T12:06:00.000Z",
      productionCompletedAt: "2026-05-31T12:12:00.000Z",
      mainToProductionDriftCommits: 1,
      mainToProductionDriftSeconds: 1080,
      releaseLocked: false,
      releaseLockReference: "",
      emergencyReference: "",
    });

    expect(result.passesReleaseHealthGate).toBe(true);
    expect(result.record).toMatchObject({
      schemaVersion: "release-health/v1",
      releaseCommit: "a".repeat(40),
      workflowRunId: "123456",
      releaseMode: "normal",
      mainToProductionDrift: { commits: 1, seconds: 1080 },
      queue: {
        batchSize: 1,
        queuedAt: "2026-05-31T11:50:00.000Z",
        mergedAt: "2026-05-31T11:55:00.000Z",
        releaseCommitCommittedAt: "2026-05-31T11:54:30.000Z",
      },
      staging: {
        startedAt: "2026-05-31T11:56:00.000Z",
        completedAt: "2026-05-31T12:05:00.000Z",
        result: "success",
      },
      canary: { startedAt: null, completedAt: null, result: "skipped" },
      production: {
        startedAt: "2026-05-31T12:06:00.000Z",
        completedAt: "2026-05-31T12:12:00.000Z",
        result: "success",
      },
      releaseLock: { locked: false, bypassed: false, reference: null },
    });
  });

  it("records emergency lock bypass evidence", () => {
    const result = buildReleaseHealthRecord({
      releaseCommit: "b".repeat(40),
      workflowRunId: "789",
      workflowRunAttempt: "1",
      checkedAt: "2026-05-31T12:00:00.000Z",
      releaseMode: "emergency",
      queueQueuedAt: null,
      queueMergedAt: null,
      releaseCommitCommittedAt: null,
      deploymentRequired: true,
      stagingResult: "success",
      stagingStartedAt: null,
      stagingCompletedAt: null,
      canaryResult: "skipped",
      canaryStartedAt: null,
      canaryCompletedAt: null,
      productionResult: "failure",
      productionStartedAt: null,
      productionCompletedAt: null,
      mainToProductionDriftCommits: 0,
      mainToProductionDriftSeconds: 0,
      releaseLocked: true,
      releaseLockReference: "INC-2026-05-31-001",
      emergencyReference: "FIX-FORWARD-PR-123",
    });

    expect(result.record.releaseLock).toMatchObject({
      locked: true,
      bypassed: true,
      reference: "INC-2026-05-31-001",
      emergencyReference: "FIX-FORWARD-PR-123",
    });
    expect(result.record.production.result).toBe("failure");
  });

  it("fails validation when the release commit is not concrete", () => {
    const result = buildReleaseHealthRecord({
      releaseCommit: "main",
      workflowRunId: "123",
      workflowRunAttempt: "1",
      checkedAt: "2026-05-31T12:00:00.000Z",
      releaseMode: "normal",
      queueQueuedAt: null,
      queueMergedAt: null,
      releaseCommitCommittedAt: null,
      deploymentRequired: true,
      stagingResult: "success",
      stagingStartedAt: null,
      stagingCompletedAt: null,
      canaryResult: "skipped",
      canaryStartedAt: null,
      canaryCompletedAt: null,
      productionResult: "success",
      productionStartedAt: null,
      productionCompletedAt: null,
      mainToProductionDriftCommits: 0,
      mainToProductionDriftSeconds: 0,
      releaseLocked: false,
      releaseLockReference: "",
      emergencyReference: "",
    });

    expect(result.passesReleaseHealthGate).toBe(false);
    expect(result.errors).toContain("releaseCommit must be a 40-character Git commit SHA.");
  });

  it("parses GitHub workflow environment values", () => {
    const options = parseReleaseHealthArgs([], {
      RELEASE_HEALTH_OUT: "artifacts/release-health/release.json",
      RELEASE_COMMIT: "c".repeat(40),
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "3",
      RELEASE_MODE: "emergency",
      QUEUE_QUEUED_AT: "2026-05-31T11:00:00.000Z",
      QUEUE_MERGED_AT: "2026-05-31T11:10:00.000Z",
      RELEASE_COMMIT_COMMITTED_AT: "2026-05-31T11:09:30.000Z",
      DEPLOYMENT_REQUIRED: "true",
      STAGING_RESULT: "success",
      STAGING_STARTED_AT: "2026-05-31T11:11:00.000Z",
      STAGING_COMPLETED_AT: "2026-05-31T11:20:00.000Z",
      CANARY_RESULT: "skipped",
      PRODUCTION_RESULT: "cancelled",
      PRODUCTION_STARTED_AT: "2026-05-31T11:21:00.000Z",
      PRODUCTION_COMPLETED_AT: "2026-05-31T11:24:00.000Z",
      MAIN_TO_PRODUCTION_DRIFT_COMMITS: "2",
      MAIN_TO_PRODUCTION_DRIFT_SECONDS: "900",
      PRODUCTION_RELEASE_LOCKED: "true",
      PRODUCTION_RELEASE_LOCK_REFERENCE: "INC-1",
      EMERGENCY_RELEASE_REFERENCE: "REVERT-1",
    });

    expect(options).toMatchObject({
      outPath: "artifacts/release-health/release.json",
      releaseCommit: "c".repeat(40),
      workflowRunId: "456",
      workflowRunAttempt: "3",
      releaseMode: "emergency",
      queueQueuedAt: "2026-05-31T11:00:00.000Z",
      queueMergedAt: "2026-05-31T11:10:00.000Z",
      releaseCommitCommittedAt: "2026-05-31T11:09:30.000Z",
      deploymentRequired: true,
      stagingStartedAt: "2026-05-31T11:11:00.000Z",
      stagingCompletedAt: "2026-05-31T11:20:00.000Z",
      productionStartedAt: "2026-05-31T11:21:00.000Z",
      productionCompletedAt: "2026-05-31T11:24:00.000Z",
      mainToProductionDriftCommits: 2,
      mainToProductionDriftSeconds: 900,
      releaseLocked: true,
      releaseLockReference: "INC-1",
      emergencyReference: "REVERT-1",
    });
  });

  it("validates optional timing fields", () => {
    const result = buildReleaseHealthRecord({
      releaseCommit: "d".repeat(40),
      workflowRunId: "123",
      workflowRunAttempt: "1",
      checkedAt: "2026-05-31T12:00:00.000Z",
      releaseMode: "normal",
      queueQueuedAt: "not-a-date",
      queueMergedAt: null,
      releaseCommitCommittedAt: null,
      deploymentRequired: true,
      stagingResult: "success",
      stagingStartedAt: null,
      stagingCompletedAt: null,
      canaryResult: "skipped",
      canaryStartedAt: null,
      canaryCompletedAt: null,
      productionResult: "success",
      productionStartedAt: null,
      productionCompletedAt: null,
      mainToProductionDriftCommits: 0,
      mainToProductionDriftSeconds: 0,
      releaseLocked: false,
      releaseLockReference: "",
      emergencyReference: "",
    });

    expect(result.passesReleaseHealthGate).toBe(false);
    expect(result.errors).toContain("queueQueuedAt must be an ISO timestamp when provided.");
  });
});
