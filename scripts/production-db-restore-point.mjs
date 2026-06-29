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
    doctlPath: readOption(argv, "--doctl") ?? readEnv("DOCTL_PATH", env) ?? "doctl",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export function buildRestorePointName(input) {
  const shortSha = String(input.releaseCommit ?? "unknown").slice(0, 8);
  return `cs-prod-rp-${shortSha}-${input.workflowRunId ?? "run"}-${input.workflowRunAttempt ?? "1"}`;
}

export async function runProductionDbRestorePoint(options, dependencies = {}) {
  const exec = dependencies.execFile ?? execFile;
  const result = await createProductionDbRestorePoint(options, exec);

  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }
  if (options.githubOutputPath) {
    await appendGitHubOutputs(options.githubOutputPath, githubOutputsForRecord(result.record));
  }

  return result;
}

export async function createProductionDbRestorePoint(options, exec) {
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

  const restorePointName = buildRestorePointName(options);
  const args = [
    "databases",
    "fork",
    restorePointName,
    "--restore-from-cluster-id",
    options.sourceClusterId,
    "--wait",
    "--output",
    "json",
  ];
  let stdout;
  try {
    ({ stdout } = await exec(options.doctlPath ?? "doctl", args, {
      maxBuffer: 1024 * 1024 * 4,
    }));
  } catch (error) {
    return {
      record: {
        ...baseRecord,
        restorePoint: {
          ...baseRecord.restorePoint,
          name: restorePointName,
          status: "create-failed",
        },
        errors: describeDoctlFailure(error),
      },
      passesRestorePointGate: false,
    };
  }
  const fork = parseDoctlForkOutput(stdout);
  const record = {
    ...baseRecord,
    restorePoint: {
      type: "digitalocean-database-fork",
      clusterId: readField(fork, "id", "ID") ?? null,
      name: readField(fork, "name", "Name") ?? restorePointName,
      status: readField(fork, "status", "Status") ?? null,
      createdAt: readField(fork, "created_at", "CreatedAt", "Created At") ?? null,
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

function describeDoctlFailure(error) {
  const details = ["doctl database fork failed before a restore-point cluster id was returned."];
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
  if (!options.bypass && !isNonEmptyString(options.sourceClusterId)) {
    errors.push("PRODUCTION_DATABASE_CLUSTER_ID is required.");
  }
  if (options.bypass && options.releaseMode !== "emergency") {
    errors.push("PRODUCTION_DB_RESTORE_POINT_BYPASS requires RELEASE_MODE=emergency.");
  }
  if (options.bypass && !isNonEmptyString(options.emergencyReference)) {
    errors.push("PRODUCTION_DB_RESTORE_POINT_BYPASS requires EMERGENCY_RELEASE_REFERENCE.");
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

  return value.replace(/\s+/g, " ").trim().slice(0, 1000);
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
