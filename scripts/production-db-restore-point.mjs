#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

const execFile = promisify(execFileCallback);

export const PRODUCTION_DB_RESTORE_POINT_VERSION = "production-db-restore-point/v1";
export const DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_POLL_INTERVAL_MS = 30 * 1000;

const DATABASE_AVAILABLE_STATUSES = new Set(["online"]);
const DATABASE_FAILURE_STATUSES = new Set(["error", "errored", "failed"]);
const SAFE_DATABASE_SUMMARY_FORMAT = "ID,Name,Status,Created";
const DIGITALOCEAN_DATABASE_ID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

export function parseProductionDbRestorePointArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("PRODUCTION_DB_RESTORE_POINT_OUT", env),
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env),
    sourceClusterId: readOption(argv, "--source-cluster-id") ?? readEnv("PRODUCTION_DATABASE_CLUSTER_ID", env),
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
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
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export function buildRestorePointName(input) {
  const shortSha = String(input.releaseCommit ?? "unknown").slice(0, 8);
  return `cs-prod-rp-${shortSha}-${input.workflowRunId ?? "run"}-${input.workflowRunAttempt ?? "1"}`;
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

  if (isDatabaseAvailable(latest.status)) {
    return { outcome: "available", fork: latest, elapsedMs: 0 };
  }

  while (true) {
    if (now() >= deadlineMs) {
      return { outcome: "timeout", fork: latest, elapsedMs: now() - startedAtMs };
    }

    latest = await readDigitalOceanDatabaseCluster(
      {
        doctlPath: options.doctlPath,
        clusterId: options.clusterId,
        forkName: options.forkName,
      },
      exec,
    );

    if (isDatabaseAvailable(latest.status)) {
      return { outcome: "available", fork: latest, elapsedMs: now() - startedAtMs };
    }
    if (isDatabaseFailure(latest.status)) {
      return { outcome: "failed", fork: latest, elapsedMs: now() - startedAtMs };
    }

    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      return { outcome: "timeout", fork: latest, elapsedMs: now() - startedAtMs };
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
  const baseRecord = {
    schemaVersion: PRODUCTION_DB_RESTORE_POINT_VERSION,
    checkedAt: options.checkedAt,
    environment: "production",
    releaseCommit: options.releaseCommit ?? "",
    workflowRunId: options.workflowRunId ?? "",
    workflowRunAttempt: options.workflowRunAttempt ?? "",
    sourceClusterId: options.sourceClusterId ?? "",
    restorePoint: {
      type: "digitalocean-database-fork",
      clusterId: null,
      name: null,
      status: null,
      createdAt: null,
    },
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

  const restorePointName = buildRestorePointName(options);
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
      const failure = restorePointFailure("restore-point-fork-timeout", {
        restorePointName,
        fork: discoveredFork,
        timeoutMs: options.forkTimeoutMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS,
        pollIntervalMs: options.forkPollIntervalMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_POLL_INTERVAL_MS,
        elapsedMs: null,
      });
      return {
        record: {
          ...baseRecord,
          restorePoint: {
            ...baseRecord.restorePoint,
            clusterId: discoveredFork.clusterId,
            name: discoveredFork.name ?? restorePointName,
            status: discoveredFork.status ?? "unknown",
            createdAt: discoveredFork.createdAt,
          },
          failure,
          errors: [
            ...describeDoctlFailure(error),
            `last observed cluster id: ${discoveredFork.clusterId ?? "unknown"}`,
            `last observed status: ${discoveredFork.status ?? "unknown"}`,
          ],
        },
        passesRestorePointGate: false,
      };
    }
    return {
      record: {
        ...baseRecord,
        restorePoint: {
          ...baseRecord.restorePoint,
          clusterId: discoveredFork.clusterId,
          name: discoveredFork.name ?? restorePointName,
          status: "create-failed",
          createdAt: discoveredFork.createdAt,
        },
        errors: describeDoctlFailure(error),
      },
      passesRestorePointGate: false,
    };
  }

  if (!fork.clusterId) {
    return {
      record: {
        ...baseRecord,
        restorePoint: {
          ...baseRecord.restorePoint,
          name: fork.name ?? restorePointName,
          status: fork.status ?? "create-failed",
        },
        errors: ["doctl database fork output did not include a forked cluster id."],
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
    return {
      record: {
        ...baseRecord,
        restorePoint: {
          type: "digitalocean-database-fork",
          clusterId: fork.clusterId,
          name: fork.name ?? restorePointName,
          status: "status-check-failed",
          createdAt: fork.createdAt,
        },
        errors: describeDoctlFailure(
          error,
          "doctl database fork status check failed before the restore-point cluster became available.",
        ),
      },
      passesRestorePointGate: false,
    };
  }

  if (availability.outcome === "timeout") {
    const latest = availability.fork ?? fork;
    const failure = restorePointFailure("restore-point-fork-timeout", {
      restorePointName,
      fork: latest,
      timeoutMs: options.forkTimeoutMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS,
      pollIntervalMs: options.forkPollIntervalMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_POLL_INTERVAL_MS,
      elapsedMs: availability.elapsedMs,
    });
    return {
      record: {
        ...baseRecord,
        restorePoint: {
          type: "digitalocean-database-fork",
          clusterId: latest.clusterId,
          name: latest.name ?? restorePointName,
          status: latest.status,
          createdAt: latest.createdAt,
        },
        failure,
        errors: [
          `Timed out waiting for restore-point fork '${restorePointName}' to become online.`,
          `last observed cluster id: ${latest.clusterId ?? "unknown"}`,
          `last observed status: ${latest.status ?? "unknown"}`,
        ],
      },
      passesRestorePointGate: false,
    };
  }

  if (availability.outcome === "failed") {
    const latest = availability.fork ?? fork;
    const failure = restorePointFailure("restore-point-fork-failed-status", {
      restorePointName,
      fork: latest,
      timeoutMs: options.forkTimeoutMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_TIMEOUT_MS,
      pollIntervalMs: options.forkPollIntervalMs ?? DEFAULT_PRODUCTION_DB_RESTORE_POINT_FORK_POLL_INTERVAL_MS,
      elapsedMs: availability.elapsedMs,
    });
    return {
      record: {
        ...baseRecord,
        restorePoint: {
          type: "digitalocean-database-fork",
          clusterId: latest.clusterId,
          name: latest.name ?? restorePointName,
          status: latest.status,
          createdAt: latest.createdAt,
        },
        failure,
        errors: [`Restore-point fork '${restorePointName}' entered failed status '${latest.status ?? "unknown"}'.`],
      },
      passesRestorePointGate: false,
    };
  }

  fork = availability.fork;
  const record = {
    ...baseRecord,
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
    restore_point_bypassed: String(record.bypass.allowed),
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
