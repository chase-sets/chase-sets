#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readEnv, readOption, readRepeatedOptions } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import {
  DEFAULT_MIN_AGE_HOURS,
  DEFAULT_RESTORE_POINT_PREFIX,
  listDatabaseClusters,
  selectRestorePointCleanupCandidates,
} from "./production-db-restore-point-cleanup.mjs";

const execFile = promisify(execFileCallback);

export const PRODUCTION_DB_RESTORE_POINT_VERSION = "production-db-restore-point/v1";
export const DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS = 75 * 60 * 1000;
export const DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_POLL_INTERVAL_MS = 30 * 1000;
export const DEFAULT_PRODUCTION_DB_RESTORE_POINT_REUSE_FRESHNESS_HOURS = 6;

const DATABASE_AVAILABLE_STATUSES = new Set(["online"]);
const DATABASE_FAILURE_STATUSES = new Set(["error", "errored", "failed"]);
const SAFE_DATABASE_SUMMARY_FORMAT = "ID,Name,Status,Created";
const DIGITALOCEAN_DATABASE_ID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const RESTORE_POINT_CLEANUP_WORKFLOW = ".github/workflows/platform-production-restore-point-cleanup.yml";
const RESTORE_POINT_CLEANUP_HELPER =
  "node ./scripts/production-db-restore-point-cleanup.mjs --out artifacts/release-health/production-db-restore-point-cleanup.json";

export function parseProductionDbRestorePointArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("PRODUCTION_DB_RESTORE_POINT_OUT", env),
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env),
    sourceClusterId: readOption(argv, "--source-cluster-id") ?? readEnv("PRODUCTION_DATABASE_CLUSTER_ID", env),
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    preMigrateStateKey:
      readOption(argv, "--pre-migrate-state-key") ??
      readEnv("PRODUCTION_DB_RESTORE_POINT_PRE_MIGRATE_STATE_KEY", env) ??
      readEnv("PRODUCTION_DB_RESTORE_POINT_STATE_KEY", env),
    workflowRunId: readOption(argv, "--workflow-run-id") ?? readEnv("GITHUB_RUN_ID", env),
    workflowRunAttempt: readOption(argv, "--workflow-run-attempt") ?? readEnv("GITHUB_RUN_ATTEMPT", env),
    releaseMode: readOption(argv, "--release-mode") ?? readEnv("RELEASE_MODE", env) ?? "normal",
    emergencyReference: readOption(argv, "--emergency-reference") ?? readEnv("EMERGENCY_RELEASE_REFERENCE", env),
    bypass: parseBoolean(
      readOption(argv, "--bypass") ?? readEnv("PRODUCTION_DB_RESTORE_POINT_BYPASS", env) ?? "false",
      "PRODUCTION_DB_RESTORE_POINT_BYPASS",
    ),
    skip: parseBoolean(
      readOption(argv, "--skip") ?? readEnv("PRODUCTION_DB_RESTORE_POINT_SKIP", env) ?? "false",
      "PRODUCTION_DB_RESTORE_POINT_SKIP",
    ),
    skipReason: readOption(argv, "--skip-reason") ?? readEnv("PRODUCTION_DB_RESTORE_POINT_SKIP_REASON", env),
    forkTimeoutMs: parsePositiveSecondsAsMs(
      readOption(argv, "--fork-timeout-seconds") ??
        readEnv("PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_SECONDS", env) ??
        String(DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS / 1000),
      "PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_SECONDS",
    ),
    forkPollIntervalMs: parsePositiveSecondsAsMs(
      readOption(argv, "--fork-poll-seconds") ??
        readEnv("PRODUCTION_DB_RESTORE_POINT_FORK_POLL_SECONDS", env) ??
        String(DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_POLL_INTERVAL_MS / 1000),
      "PRODUCTION_DB_RESTORE_POINT_FORK_POLL_SECONDS",
    ),
    doctlPath: readOption(argv, "--doctl") ?? readEnv("DOCTL_PATH", env) ?? "doctl",
    preflightPrefix:
      readOption(argv, "--preflight-prefix") ??
      readEnv("PRODUCTION_DB_RESTORE_POINT_PREFLIGHT_PREFIX", env) ??
      DEFAULT_RESTORE_POINT_PREFIX,
    preflightMinAgeHours: parseNumber(
      readOption(argv, "--preflight-min-age-hours") ??
        readEnv("PRODUCTION_DB_RESTORE_POINT_PREFLIGHT_MIN_AGE_HOURS", env) ??
        String(DEFAULT_MIN_AGE_HOURS),
      "PRODUCTION_DB_RESTORE_POINT_PREFLIGHT_MIN_AGE_HOURS",
    ),
    reuseFreshnessHours: parseNumber(
      readOption(argv, "--reuse-freshness-hours") ??
        readEnv("PRODUCTION_DB_RESTORE_POINT_REUSE_FRESHNESS_HOURS", env) ??
        String(DEFAULT_PRODUCTION_DB_RESTORE_POINT_REUSE_FRESHNESS_HOURS),
      "PRODUCTION_DB_RESTORE_POINT_REUSE_FRESHNESS_HOURS",
    ),
    preflightHoldNames: parseHoldNames([
      ...readRepeatedOptions(argv, "--preflight-hold-name"),
      readEnv("PRODUCTION_DB_RESTORE_POINT_PREFLIGHT_HOLD_NAMES", env),
      readEnv("PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES", env),
    ]),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export function buildRestorePointName(input) {
  const fingerprint = buildPreMigrateStateFingerprint(input.preMigrateStateKey ?? input.releaseCommit ?? "unknown");
  return `cs-prod-rp-${fingerprint}-${input.workflowRunId ?? "run"}-${input.workflowRunAttempt ?? "1"}`;
}

export function buildPreMigrateStateFingerprint(preMigrateStateKey) {
  return createHash("sha256")
    .update(String(preMigrateStateKey ?? "").trim())
    .digest("hex")
    .slice(0, 16);
}

export async function createDigitalOceanDatabaseFork(options, exec) {
  const args = ["databases", "fork", options.forkName, "--restore-from-cluster-id", options.sourceClusterId];
  if (options.wait !== false) {
    args.push("--wait", "--output", "json");
  }
  const { stdout } = await exec(options.doctlPath ?? "doctl", args, {
    maxBuffer: 1024 * 1024 * 4,
  });
  if (options.wait === false) {
    return await readDigitalOceanDatabaseClusterByName(
      {
        doctlPath: options.doctlPath,
        forkName: options.forkName,
      },
      exec,
    );
  }
  const fork = parseDoctlDatabaseSummaryOutput(stdout);
  return summarizeDigitalOceanDatabase(fork, options.forkName);
}

export async function readDigitalOceanDatabaseCluster(options, exec) {
  const { stdout } = await exec(
    options.doctlPath ?? "doctl",
    ["databases", "get", options.clusterId, "--format", SAFE_DATABASE_SUMMARY_FORMAT, "--no-header"],
    {
      maxBuffer: 1024 * 1024 * 4,
    },
  );
  const summary = summarizeDigitalOceanDatabase(parseDoctlDatabaseSummaryOutput(stdout), options.forkName);
  return { ...summary, clusterId: summary.clusterId ?? options.clusterId };
}

export async function readDigitalOceanDatabaseClusterByName(options, exec) {
  const { stdout } = await exec(
    options.doctlPath ?? "doctl",
    ["databases", "list", "--format", SAFE_DATABASE_SUMMARY_FORMAT, "--no-header"],
    {
      maxBuffer: 1024 * 1024 * 4,
    },
  );
  const summaries = parseDoctlDatabaseSummaryListOutput(stdout).map((database) =>
    summarizeDigitalOceanDatabase(database, options.forkName),
  );
  return (
    summaries.find((database) => database.name === options.forkName) ?? {
      clusterId: null,
      name: options.forkName,
      status: null,
      createdAt: null,
    }
  );
}

export async function waitForDigitalOceanDatabaseForkAvailability(options, dependencies = {}) {
  const exec = dependencies.execFile ?? execFile;
  const now = dependencies.now ?? (() => Date.now());
  const delay = dependencies.sleep ?? sleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_POLL_INTERVAL_MS;
  const startedAtMs = now();
  const deadlineMs = startedAtMs + timeoutMs;
  let latest = options.initialFork ?? {
    clusterId: options.clusterId,
    name: options.forkName,
    status: null,
    createdAt: null,
  };
  let statusReadAttemptCount = 0;
  let statusReadFailure = null;

  const result = (outcome, completedAtMs) => ({
    outcome,
    fork: latest,
    elapsedMs: completedAtMs - startedAtMs,
    ...(statusReadFailure
      ? {
          statusReadFailure: {
            ...statusReadFailure,
            attemptCount: statusReadAttemptCount,
            elapsedMs: completedAtMs - startedAtMs,
          },
        }
      : {}),
  });

  if (isDatabaseAvailable(latest.status)) {
    return result("available", startedAtMs);
  }

  while (true) {
    const beforeReadMs = now();
    if (beforeReadMs >= deadlineMs) {
      return result("timeout", beforeReadMs);
    }

    statusReadAttemptCount += 1;
    try {
      latest = await readDigitalOceanDatabaseCluster(
        {
          doctlPath: options.doctlPath,
          clusterId: options.clusterId,
          forkName: options.forkName,
        },
        exec,
      );
    } catch (error) {
      if (typeof dependencies.classifyStatusReadFailure !== "function") {
        throw error;
      }
      const classified = dependencies.classifyStatusReadFailure(error);
      if (!classified || !["transient", "permanent", "unknown"].includes(classified.classification)) {
        throw error;
      }
      statusReadFailure = {
        ...classified,
        lastKnownStatus: latest.status ?? null,
      };
      const failedAtMs = now();
      if (classified.classification !== "transient") {
        return result("status-read-failed", failedAtMs);
      }
      const remainingAfterFailureMs = deadlineMs - failedAtMs;
      if (remainingAfterFailureMs <= 0) {
        return result("timeout", failedAtMs);
      }
      await delay(Math.min(pollIntervalMs, remainingAfterFailureMs));
      continue;
    }

    if (isDatabaseAvailable(latest.status)) {
      return result("available", now());
    }
    if (isDatabaseFailure(latest.status)) {
      return result("failed", now());
    }

    const afterReadMs = now();
    const remainingMs = deadlineMs - afterReadMs;
    if (remainingMs <= 0) {
      return result("timeout", afterReadMs);
    }

    await delay(Math.min(pollIntervalMs, remainingMs));
  }
}

export async function runProductionDbRestorePoint(options, dependencies = {}) {
  const result = await createProductionDbRestorePoint(options, dependencies);

  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }
  if (options.githubOutputPath) {
    await appendGitHubOutputs(options.githubOutputPath, githubOutputsForRecord(result.record));
  }

  return result;
}

export async function createProductionDbRestorePoint(options, dependencies = {}) {
  const normalizedDependencies = normalizeDependencies(dependencies);
  const exec = normalizedDependencies.execFile;
  const errors = validateOptions(options);
  const preMigrateStateKey = emptyToNull(options.preMigrateStateKey);
  const preMigrateStateFingerprint = preMigrateStateKey ? buildPreMigrateStateFingerprint(preMigrateStateKey) : null;
  const baseRecord = {
    schemaVersion: PRODUCTION_DB_RESTORE_POINT_VERSION,
    checkedAt: options.checkedAt,
    environment: "production",
    releaseCommit: options.releaseCommit ?? "",
    workflowRunId: options.workflowRunId ?? "",
    workflowRunAttempt: options.workflowRunAttempt ?? "",
    sourceClusterId: options.sourceClusterId ?? "",
    preMigrateState: {
      key: preMigrateStateKey,
      fingerprint: preMigrateStateFingerprint,
    },
    restorePoint: {
      type: "digitalocean-database-fork",
      clusterId: null,
      name: null,
      status: null,
      createdAt: null,
    },
    restorePointReuse: restorePointReuseNotAttempted(options, preMigrateStateFingerprint),
    restorePointCleanup: restorePointCleanupNotRequired(),
    restorePointPreflight: restorePointPreflightNotAttempted(options),
    skip: {
      requested: Boolean(options.skip),
      reason: emptyToNull(options.skipReason),
    },
    bypass: {
      requested: Boolean(options.bypass),
      allowed: false,
      releaseMode: options.releaseMode ?? "normal",
      emergencyReference: emptyToNull(options.emergencyReference),
    },
    result: "failure",
    errors,
  };

  if (errors.length > 0) {
    return { record: baseRecord, passesRestorePointGate: false };
  }

  if (options.bypass) {
    const record = {
      ...baseRecord,
      bypass: {
        ...baseRecord.bypass,
        allowed: true,
      },
      result: "bypassed",
      errors: [],
    };
    return { record, passesRestorePointGate: true };
  }

  if (options.skip) {
    const record = {
      ...baseRecord,
      restorePoint: {
        ...baseRecord.restorePoint,
        type: "digitalocean-managed-pitr",
        status: "not-created",
      },
      result: "skipped",
      errors: [],
    };
    return { record, passesRestorePointGate: true };
  }

  const restorePointName = buildRestorePointName({ ...options, preMigrateStateKey });
  const reuse = await findReusableRestorePointFork(
    {
      doctlPath: options.doctlPath,
      prefix: options.preflightPrefix ?? DEFAULT_RESTORE_POINT_PREFIX,
      preMigrateStateFingerprint,
      checkedAt: options.checkedAt,
      freshnessHours: options.reuseFreshnessHours ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_REUSE_FRESHNESS_HOURS,
    },
    exec,
  );

  if (reuse.record.status === "failed") {
    return {
      record: {
        ...baseRecord,
        restorePoint: {
          ...baseRecord.restorePoint,
          name: restorePointName,
          status: "reuse-check-failed",
        },
        restorePointReuse: reuse.record,
        errors: reuse.record.errors,
      },
      passesRestorePointGate: false,
    };
  }

  if (reuse.fork) {
    return {
      record: {
        ...baseRecord,
        restorePoint: {
          type: "digitalocean-database-fork",
          clusterId: reuse.fork.id,
          name: reuse.fork.name,
          status: reuse.fork.status,
          createdAt: reuse.fork.createdAt,
        },
        restorePointReuse: reuse.record,
        result: "success",
        errors: [],
      },
      passesRestorePointGate: true,
    };
  }

  const restorePointBaseRecord = { ...baseRecord, restorePointReuse: reuse.record };
  const preflight = await preflightRestorePointForkLifecycle(options, exec);
  if (preflight.status !== "pass") {
    return {
      record: {
        ...restorePointBaseRecord,
        restorePoint: {
          ...baseRecord.restorePoint,
          name: restorePointName,
          status: "preflight-failed",
        },
        restorePointPreflight: preflight,
        remediation: restorePointCleanupRemediation(),
        errors:
          preflight.status === "cleanup-required"
            ? [
                `Restore-point preflight found ${preflight.cleanupCandidates.length} old ${preflight.prefix} fork(s) eligible for the default ${preflight.minAgeHours}-hour cleanup guard.`,
                restorePointCleanupRemediation().summary,
              ]
            : ["Restore-point preflight could not inspect existing restore-point forks.", ...preflight.errors],
      },
      passesRestorePointGate: false,
    };
  }

  let fork;
  try {
    fork = await createDigitalOceanDatabaseFork(
      {
        doctlPath: options.doctlPath,
        sourceClusterId: options.sourceClusterId,
        forkName: restorePointName,
        wait: false,
      },
      exec,
    );
  } catch (error) {
    const discoveredFork = await discoverForkFromCreateFailure(error, restorePointName, options.doctlPath, exec);
    if (isDoctlForkTimeoutFailure(error)) {
      const cleanup = await cleanupFailedRestorePointFork(
        {
          doctlPath: options.doctlPath,
          fork: discoveredFork,
          forkName: restorePointName,
        },
        exec,
      );
      const failure = restorePointFailure("restore-point-fork-timeout", {
        restorePointName,
        fork: discoveredFork,
        timeoutMs: options.forkTimeoutMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS,
        pollIntervalMs: options.forkPollIntervalMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_POLL_INTERVAL_MS,
        elapsedMs: null,
      });
      return {
        record: {
          ...restorePointBaseRecord,
          restorePointPreflight: preflight,
          restorePoint: {
            ...baseRecord.restorePoint,
            clusterId: discoveredFork.clusterId,
            name: discoveredFork.name ?? restorePointName,
            status: discoveredFork.status ?? "unknown",
            createdAt: discoveredFork.createdAt,
          },
          restorePointCleanup: cleanup,
          remediation: restorePointCleanupRemediation(),
          failure,
          errors: [
            ...describeDoctlFailure(error),
            `last observed cluster id: ${discoveredFork.clusterId ?? "unknown"}`,
            `last observed status: ${discoveredFork.status ?? "unknown"}`,
            ...cleanup.errors,
          ],
        },
        passesRestorePointGate: false,
      };
    }
    const quotaFailure = isLikelyDigitalOceanQuotaFailure(error);
    return {
      record: {
        ...restorePointBaseRecord,
        restorePointPreflight: preflight,
        restorePoint: {
          ...baseRecord.restorePoint,
          clusterId: discoveredFork.clusterId,
          name: discoveredFork.name ?? restorePointName,
          status: "create-failed",
          createdAt: discoveredFork.createdAt,
        },
        failure: quotaFailure
          ? {
              type: "restore-point-quota-limit",
              restorePointName,
              clusterId: discoveredFork.clusterId,
              status: "create-failed",
            }
          : undefined,
        remediation: quotaFailure ? restorePointCleanupRemediation() : undefined,
        errors: quotaFailure
          ? [...describeDoctlFailure(error), restorePointCleanupRemediation().summary]
          : describeDoctlFailure(error),
      },
      passesRestorePointGate: false,
    };
  }

  if (!fork.clusterId) {
    const cleanup = await cleanupFailedRestorePointFork(
      {
        doctlPath: options.doctlPath,
        fork,
        forkName: restorePointName,
      },
      exec,
    );
    return {
      record: {
        ...restorePointBaseRecord,
        restorePointPreflight: preflight,
        restorePoint: {
          ...baseRecord.restorePoint,
          name: fork.name ?? restorePointName,
          status: fork.status ?? "create-failed",
        },
        restorePointCleanup: cleanup,
        errors: ["doctl database fork output did not include a forked cluster id.", ...cleanup.errors],
      },
      passesRestorePointGate: false,
    };
  }

  let availability;
  try {
    availability = await waitForDigitalOceanDatabaseForkAvailability(
      {
        doctlPath: options.doctlPath,
        clusterId: fork.clusterId,
        forkName: restorePointName,
        initialFork: fork,
        timeoutMs: options.forkTimeoutMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS,
        pollIntervalMs: options.forkPollIntervalMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_POLL_INTERVAL_MS,
      },
      normalizedDependencies,
    );
  } catch (error) {
    const cleanup = await cleanupFailedRestorePointFork(
      {
        doctlPath: options.doctlPath,
        fork,
        forkName: restorePointName,
      },
      exec,
    );
    return {
      record: {
        ...restorePointBaseRecord,
        restorePointPreflight: preflight,
        restorePoint: {
          type: "digitalocean-database-fork",
          clusterId: fork.clusterId,
          name: fork.name ?? restorePointName,
          status: "status-check-failed",
          createdAt: fork.createdAt,
        },
        restorePointCleanup: cleanup,
        errors: describeDoctlFailure(
          error,
          "doctl database fork status check failed before the restore-point cluster became available.",
        ).concat(cleanup.errors),
      },
      passesRestorePointGate: false,
    };
  }

  if (availability.outcome === "timeout") {
    const latest = availability.fork ?? fork;
    const cleanup = await cleanupFailedRestorePointFork(
      {
        doctlPath: options.doctlPath,
        fork: latest,
        forkName: restorePointName,
      },
      exec,
    );
    const failure = restorePointFailure("restore-point-fork-timeout", {
      restorePointName,
      fork: latest,
      timeoutMs: options.forkTimeoutMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS,
      pollIntervalMs: options.forkPollIntervalMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_POLL_INTERVAL_MS,
      elapsedMs: availability.elapsedMs,
    });
    return {
      record: {
        ...restorePointBaseRecord,
        restorePointPreflight: preflight,
        restorePoint: {
          type: "digitalocean-database-fork",
          clusterId: latest.clusterId,
          name: latest.name ?? restorePointName,
          status: latest.status,
          createdAt: latest.createdAt,
        },
        restorePointCleanup: cleanup,
        failure,
        errors: [
          `Timed out waiting for restore-point fork '${restorePointName}' to become online.`,
          `last observed cluster id: ${latest.clusterId ?? "unknown"}`,
          `last observed status: ${latest.status ?? "unknown"}`,
          ...cleanup.errors,
        ],
      },
      passesRestorePointGate: false,
    };
  }

  if (availability.outcome === "failed") {
    const latest = availability.fork ?? fork;
    const cleanup = await cleanupFailedRestorePointFork(
      {
        doctlPath: options.doctlPath,
        fork: latest,
        forkName: restorePointName,
      },
      exec,
    );
    const failure = restorePointFailure("restore-point-fork-failed-status", {
      restorePointName,
      fork: latest,
      timeoutMs: options.forkTimeoutMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS,
      pollIntervalMs: options.forkPollIntervalMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_POLL_INTERVAL_MS,
      elapsedMs: availability.elapsedMs,
    });
    return {
      record: {
        ...restorePointBaseRecord,
        restorePointPreflight: preflight,
        restorePoint: {
          type: "digitalocean-database-fork",
          clusterId: latest.clusterId,
          name: latest.name ?? restorePointName,
          status: latest.status,
          createdAt: latest.createdAt,
        },
        restorePointCleanup: cleanup,
        failure,
        errors: [
          `Restore-point fork '${restorePointName}' entered failed status '${latest.status ?? "unknown"}'.`,
          ...cleanup.errors,
        ],
      },
      passesRestorePointGate: false,
    };
  }

  fork = availability.fork;
  const record = {
    ...restorePointBaseRecord,
    restorePointPreflight: preflight,
    restorePoint: {
      type: "digitalocean-database-fork",
      clusterId: fork.clusterId,
      name: fork.name,
      status: fork.status,
      createdAt: fork.createdAt,
    },
    result: "success",
    errors: [],
  };

  if (!record.restorePoint.clusterId) {
    record.result = "failure";
    record.errors = ["doctl database fork output did not include a forked cluster id."];
  }

  return { record, passesRestorePointGate: record.errors.length === 0 };
}

function describeDoctlFailure(
  error,
  summary = "doctl database fork failed before a restore-point cluster id was returned.",
) {
  const details = [summary];
  const code = readErrorField(error, "code");
  const signal = readErrorField(error, "signal");
  const stderr = diagnosticSnippet(readErrorField(error, "stderr"));
  const stdout = diagnosticSnippet(readErrorField(error, "stdout"));

  if (code !== null) {
    details.push(`exit code: ${code}`);
  }
  if (signal !== null) {
    details.push(`signal: ${signal}`);
  }
  if (stderr) {
    details.push(`stderr: ${stderr}`);
  }
  if (stdout) {
    details.push(`stdout: ${stdout}`);
  }

  return details;
}

async function preflightRestorePointForkLifecycle(options, exec) {
  const prefix = options.preflightPrefix ?? DEFAULT_RESTORE_POINT_PREFIX;
  const minAgeHours = options.preflightMinAgeHours ?? DEFAULT_MIN_AGE_HOURS;
  const base = {
    attempted: true,
    status: "unknown",
    prefix,
    minAgeHours,
    cutoff: null,
    observed: [],
    held: [],
    cleanupCandidates: [],
    remediation: restorePointCleanupRemediation(),
    errors: [],
  };

  if (!isNonEmptyString(prefix)) {
    return {
      ...base,
      status: "failed",
      errors: ["PRODUCTION_DB_RESTORE_POINT_PREFLIGHT_PREFIX is required."],
    };
  }
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
    return {
      ...base,
      status: "failed",
      errors: ["PRODUCTION_DB_RESTORE_POINT_PREFLIGHT_MIN_AGE_HOURS must be zero or greater."],
    };
  }

  try {
    const cutoff = new Date(new Date(options.checkedAt).getTime() - minAgeHours * 60 * 60 * 1000);
    const observed = (await listDatabaseClusters(options.doctlPath, exec)).filter((cluster) =>
      cluster.name.startsWith(prefix),
    );
    const holdNames = options.preflightHoldNames ?? [];
    const holds = new Set(holdNames);
    const held = observed.filter((cluster) => holds.has(cluster.id) || holds.has(cluster.name));
    const cleanupCandidates = selectRestorePointCleanupCandidates(observed, {
      prefix,
      cutoff,
      holdNames,
    });
    return {
      ...base,
      status: cleanupCandidates.length > 0 ? "cleanup-required" : "pass",
      cutoff: cutoff.toISOString(),
      observed: observed.map(toRestorePointSummary),
      held: held.map(toRestorePointSummary),
      cleanupCandidates: cleanupCandidates.map(toRestorePointSummary),
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      errors: describeDoctlFailure(error, "doctl database list failed during restore-point preflight."),
    };
  }
}

export function parseDoctlForkOutput(stdout) {
  const parsed = JSON.parse(stdout || "{}");
  if (Array.isArray(parsed)) {
    return parsed[0] ?? {};
  }
  if (Array.isArray(parsed.databases)) {
    return parsed.databases[0] ?? {};
  }
  if (parsed.database && typeof parsed.database === "object") {
    return parsed.database;
  }
  return parsed;
}

export function parseDoctlDatabaseSummaryOutput(stdout) {
  return parseDoctlDatabaseSummaryListOutput(stdout)[0] ?? {};
}

export function parseDoctlDatabaseSummaryListOutput(stdout) {
  const value = String(stdout ?? "").trim();
  if (!value) {
    return [];
  }
  if (value.startsWith("{") || value.startsWith("[")) {
    const parsed = JSON.parse(value || "{}");
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (Array.isArray(parsed.databases)) {
      return parsed.databases;
    }
    if (parsed.database && typeof parsed.database === "object") {
      return [parsed.database];
    }
    return [parsed];
  }

  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseDoctlDatabaseSummaryLine)
    .filter((entry) => Object.keys(entry).length > 0);
}

function parseDoctlDatabaseSummaryLine(line) {
  if (!line) {
    return {};
  }

  const tabParts = line.split(/\t+/);
  if (tabParts.length >= 4) {
    return {
      id: tabParts[0],
      name: tabParts[1],
      status: tabParts[2],
      created_at: tabParts.slice(3).join(" "),
    };
  }

  const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
  if (!match) {
    return {};
  }
  return {
    id: match[1],
    name: match[2],
    status: match[3],
    created_at: match[4],
  };
}

function validateOptions(options) {
  const errors = [];
  if (!isCommitSha(options.releaseCommit)) {
    errors.push("RELEASE_COMMIT must be a 40-character Git commit SHA.");
  }
  if (!isNonEmptyString(options.workflowRunId)) {
    errors.push("GITHUB_RUN_ID is required.");
  }
  if (!isNonEmptyString(options.workflowRunAttempt)) {
    errors.push("GITHUB_RUN_ATTEMPT is required.");
  }
  if (!options.bypass && !options.skip && !isNonEmptyString(options.sourceClusterId)) {
    errors.push("PRODUCTION_DATABASE_CLUSTER_ID is required.");
  }
  if (!options.bypass && !options.skip && !isNonEmptyString(options.preMigrateStateKey)) {
    errors.push("PRODUCTION_DB_RESTORE_POINT_PRE_MIGRATE_STATE_KEY is required.");
  }
  if (options.bypass && options.skip) {
    errors.push("PRODUCTION_DB_RESTORE_POINT_BYPASS and PRODUCTION_DB_RESTORE_POINT_SKIP cannot both be true.");
  }
  if (options.bypass && options.releaseMode !== "emergency") {
    errors.push("PRODUCTION_DB_RESTORE_POINT_BYPASS requires RELEASE_MODE=emergency.");
  }
  if (options.bypass && !isNonEmptyString(options.emergencyReference)) {
    errors.push("PRODUCTION_DB_RESTORE_POINT_BYPASS requires EMERGENCY_RELEASE_REFERENCE.");
  }
  if (options.skip && !isNonEmptyString(options.skipReason)) {
    errors.push("PRODUCTION_DB_RESTORE_POINT_SKIP requires PRODUCTION_DB_RESTORE_POINT_SKIP_REASON.");
  }
  if (!isPositiveNumber(options.forkTimeoutMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS)) {
    errors.push("PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_SECONDS must be greater than zero.");
  }
  if (!isPositiveNumber(options.forkPollIntervalMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_POLL_INTERVAL_MS)) {
    errors.push("PRODUCTION_DB_RESTORE_POINT_FORK_POLL_SECONDS must be greater than zero.");
  }
  const reuseFreshnessHours = options.reuseFreshnessHours ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_REUSE_FRESHNESS_HOURS;
  if (!Number.isFinite(reuseFreshnessHours) || reuseFreshnessHours < 0) {
    errors.push("PRODUCTION_DB_RESTORE_POINT_REUSE_FRESHNESS_HOURS must be zero or greater.");
  }
  return errors;
}

function githubOutputsForRecord(record) {
  return {
    restore_point_result: record.result,
    restore_point_type: record.restorePoint.type,
    restore_point_cluster_id: record.restorePoint.clusterId ?? "",
    restore_point_name: record.restorePoint.name ?? "",
    restore_point_status: record.restorePoint.status ?? "",
    restore_point_created_at: record.restorePoint.createdAt ?? "",
    restore_point_cleanup_status: record.restorePointCleanup?.status ?? "",
    restore_point_preflight_status: record.restorePointPreflight?.status ?? "",
    restore_point_remediation: record.remediation?.summary ?? record.restorePointPreflight?.remediation?.summary ?? "",
    restore_point_bypassed: String(record.bypass.allowed),
    restore_point_pre_migrate_state_key: record.preMigrateState?.key ?? "",
    restore_point_pre_migrate_state_fingerprint: record.preMigrateState?.fingerprint ?? "",
    restore_point_reused: String(Boolean(record.restorePointReuse?.reused)),
    restore_point_reused_cluster_id: record.restorePointReuse?.reusedClusterId ?? "",
  };
}

async function appendGitHubOutputs(path, values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value ?? "")}`);
  await appendFile(path, `${lines.join("\n")}\n`);
}

function readField(record, ...names) {
  for (const name of names) {
    const value = record?.[name];
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }
  return null;
}

function summarizeDigitalOceanDatabase(database, fallbackName) {
  return {
    clusterId: readField(database, "id", "ID") ?? null,
    name: readField(database, "name", "Name") ?? fallbackName,
    status: readField(database, "status", "Status") ?? null,
    createdAt: readField(database, "created_at", "createdAt", "CreatedAt", "Created At") ?? null,
  };
}

async function cleanupFailedRestorePointFork(options, exec) {
  const clusterId = options.fork?.clusterId ?? null;
  const name = options.fork?.name ?? options.forkName ?? null;
  if (!isNonEmptyString(clusterId)) {
    return {
      attempted: false,
      clusterId: null,
      name,
      status: "not-attempted",
      errors: ["restore-point cleanup skipped because no fork cluster id was available."],
    };
  }

  try {
    await exec(options.doctlPath ?? "doctl", ["databases", "delete", clusterId, "--force"], {
      maxBuffer: 1024 * 1024,
    });
    return {
      attempted: true,
      clusterId,
      name,
      status: "deleted",
      errors: [],
    };
  } catch (error) {
    return {
      attempted: true,
      clusterId,
      name,
      status: "delete-failed",
      errors: describeDoctlFailure(error, "doctl database delete failed for the failed restore-point fork."),
    };
  }
}

function restorePointCleanupNotRequired() {
  return {
    attempted: false,
    clusterId: null,
    name: null,
    status: "not-required",
    errors: [],
  };
}

function restorePointPreflightNotAttempted(options = {}) {
  return {
    attempted: false,
    status: "not-attempted",
    prefix: options.preflightPrefix ?? DEFAULT_RESTORE_POINT_PREFIX,
    minAgeHours: options.preflightMinAgeHours ?? DEFAULT_MIN_AGE_HOURS,
    cutoff: null,
    observed: [],
    held: [],
    cleanupCandidates: [],
    remediation: restorePointCleanupRemediation(),
    errors: [],
  };
}

function restorePointReuseNotAttempted(options = {}, preMigrateStateFingerprint = null) {
  return {
    attempted: false,
    status: "not-attempted",
    reused: false,
    reusedClusterId: null,
    prefix: options.preflightPrefix ?? DEFAULT_RESTORE_POINT_PREFIX,
    preMigrateStateFingerprint,
    freshnessHours: options.reuseFreshnessHours ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_REUSE_FRESHNESS_HOURS,
    cutoff: null,
    candidates: [],
    errors: [],
  };
}

function restorePointCleanupRemediation() {
  return {
    summary:
      "Run the Platform Production Restore Point Cleanup workflow or dry-run/apply scripts before retrying production deploy; the cleanup helper keeps the default 6-hour guard unless an operator explicitly overrides it.",
    workflow: RESTORE_POINT_CLEANUP_WORKFLOW,
    helper: RESTORE_POINT_CLEANUP_HELPER,
    applyHelper:
      "node ./scripts/production-db-restore-point-cleanup.mjs --min-age-hours 6 --apply --out artifacts/release-health/production-db-restore-point-cleanup.json",
  };
}

async function findReusableRestorePointFork(options, exec) {
  const base = {
    attempted: true,
    status: "unknown",
    reused: false,
    reusedClusterId: null,
    prefix: options.prefix,
    preMigrateStateFingerprint: options.preMigrateStateFingerprint,
    freshnessHours: options.freshnessHours,
    cutoff: null,
    candidates: [],
    errors: [],
  };

  if (!isNonEmptyString(options.preMigrateStateFingerprint)) {
    return {
      record: {
        ...base,
        status: "failed",
        errors: ["Restore-point reuse requires a pre-migrate state fingerprint."],
      },
      fork: null,
    };
  }

  try {
    const cutoff = new Date(new Date(options.checkedAt).getTime() - options.freshnessHours * 60 * 60 * 1000);
    const namePrefix = `${options.prefix}${options.preMigrateStateFingerprint}-`;
    const candidates = (await listDatabaseClusters(options.doctlPath, exec))
      .filter((cluster) => cluster.name.startsWith(namePrefix))
      .filter((cluster) => isDatabaseAvailable(cluster.status))
      .filter((cluster) => {
        const createdAt = Date.parse(cluster.createdAt);
        return Number.isFinite(createdAt) && createdAt >= cutoff.getTime();
      })
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const fork = candidates[0] ?? null;
    return {
      record: {
        ...base,
        status: fork ? "reused" : "none",
        reused: Boolean(fork),
        reusedClusterId: fork?.id ?? null,
        cutoff: cutoff.toISOString(),
        candidates: candidates.map(toRestorePointSummary),
      },
      fork,
    };
  } catch (error) {
    return {
      record: {
        ...base,
        status: "failed",
        errors: describeDoctlFailure(error, "doctl database list failed during restore-point reuse lookup."),
      },
      fork: null,
    };
  }
}

function toRestorePointSummary(cluster) {
  return {
    id: cluster.id,
    name: cluster.name,
    status: cluster.status ?? null,
    createdAt: cluster.createdAt ?? null,
  };
}

function readErrorField(error, fieldName) {
  if (typeof error === "object" && error !== null && fieldName in error) {
    const value = error[fieldName];
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }
  return null;
}

function diagnosticSnippet(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }

  return redactDiagnostic(value).replace(/\s+/g, " ").trim().slice(0, 1000);
}

async function discoverForkFromCreateFailure(error, forkName, doctlPath, exec) {
  const text = [
    readErrorField(error, "stdout"),
    readErrorField(error, "stderr"),
    error instanceof Error ? error.message : "",
  ]
    .filter(isNonEmptyString)
    .join("\n");
  const clusterId = DIGITALOCEAN_DATABASE_ID_PATTERN.exec(text)?.[0] ?? null;
  const discovered = {
    clusterId,
    name: forkName,
    status: inferDatabaseStatus(text),
    createdAt: null,
  };
  if (!clusterId) {
    return discovered;
  }

  try {
    return await readDigitalOceanDatabaseCluster({ doctlPath, clusterId, forkName }, exec);
  } catch {
    return discovered;
  }
}

function isDoctlForkTimeoutFailure(error) {
  const text = [
    readErrorField(error, "stdout"),
    readErrorField(error, "stderr"),
    error instanceof Error ? error.message : "",
  ]
    .filter(isNonEmptyString)
    .join("\n");
  return /timeout waiting for database/i.test(text) || /couldn'?t enter the online state/i.test(text);
}

function isLikelyDigitalOceanQuotaFailure(error) {
  const text = [
    readErrorField(error, "stdout"),
    readErrorField(error, "stderr"),
    error instanceof Error ? error.message : "",
  ]
    .filter(isNonEmptyString)
    .join("\n")
    .toLowerCase();
  return /\b412\b/.test(text) || /reached their limit/.test(text) || /quota/.test(text);
}

function inferDatabaseStatus(text) {
  const normalized = String(text ?? "").toLowerCase();
  if (/\bforking\b/.test(normalized)) {
    return "forking";
  }
  if (/\bcreating\b/.test(normalized)) {
    return "creating";
  }
  if (/\bonline\b/.test(normalized)) {
    return "online";
  }
  return null;
}

function parseBoolean(value, name) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function parsePositiveSecondsAsMs(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be greater than zero.`);
  }
  return parsed * 1000;
}

function parseNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number.`);
  }
  return parsed;
}

function parseHoldNames(values) {
  return Array.from(
    new Set(
      values
        .filter(isNonEmptyString)
        .flatMap((value) => value.split(/[,\n]/g))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeDependencies(dependencies) {
  if (typeof dependencies === "function") {
    return {
      execFile: dependencies,
      now: () => Date.now(),
      sleep,
    };
  }
  return {
    execFile: dependencies.execFile ?? execFile,
    now: dependencies.now ?? (() => Date.now()),
    sleep: dependencies.sleep ?? sleep,
  };
}

function restorePointFailure(type, input) {
  return {
    type,
    restorePointName: input.restorePointName,
    clusterId: input.fork?.clusterId ?? null,
    status: input.fork?.status ?? null,
    timeoutMs: input.timeoutMs,
    pollIntervalMs: input.pollIntervalMs,
    elapsedMs: input.elapsedMs,
  };
}

function isDatabaseAvailable(status) {
  return DATABASE_AVAILABLE_STATUSES.has(
    String(status ?? "")
      .trim()
      .toLowerCase(),
  );
}

function isDatabaseFailure(status) {
  return DATABASE_FAILURE_STATUSES.has(
    String(status ?? "")
      .trim()
      .toLowerCase(),
  );
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function redactDiagnostic(value) {
  return String(value)
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+(@)/gi, "$1[redacted]$2")
    .replace(/([?&](?:password|pass|token|access_token|secret|api_key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/("(?:password|token|secret|access_token|api_key)"\s*:\s*")[^"]+"/gi, '$1[redacted]"')
    .replace(/\b(password|token|secret|access[_-]?token|api[_-]?key)\b\s*[:=]\s*[^\s,}]+/gi, "$1=[redacted]");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function emptyToNull(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function main(argv, env = process.env) {
  try {
    const result = await runProductionDbRestorePoint(parseProductionDbRestorePointArgs(argv, env));
    console.log(JSON.stringify(result.record, null, 2));
    return result.passesRestorePointGate ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
