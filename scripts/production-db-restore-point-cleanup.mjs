#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption, readRepeatedOptions } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

const execFile = promisify(execFileCallback);

export const PRODUCTION_DB_RESTORE_POINT_CLEANUP_VERSION = "production-db-restore-point-cleanup/v1";
export const DEFAULT_RESTORE_POINT_PREFIX = "cs-prod-rp-";
export const DEFAULT_MIN_AGE_HOURS = 24;

export function parseProductionDbRestorePointCleanupArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("PRODUCTION_DB_RESTORE_POINT_CLEANUP_OUT", env),
    doctlPath: readOption(argv, "--doctl") ?? readEnv("DOCTL_PATH", env) ?? "doctl",
    prefix:
      readOption(argv, "--prefix") ??
      readEnv("PRODUCTION_DB_RESTORE_POINT_CLEANUP_PREFIX", env) ??
      DEFAULT_RESTORE_POINT_PREFIX,
    minAgeHours: parseNumber(
      readOption(argv, "--min-age-hours") ??
        readEnv("PRODUCTION_DB_RESTORE_POINT_CLEANUP_MIN_AGE_HOURS", env) ??
        String(DEFAULT_MIN_AGE_HOURS),
      "PRODUCTION_DB_RESTORE_POINT_CLEANUP_MIN_AGE_HOURS",
    ),
    apply:
      argv.includes("--apply") || parseBoolean(readEnv("PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY", env) ?? "false"),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    holdNames: parseHoldNames([
      ...readRepeatedOptions(argv, "--hold-name"),
      readEnv("PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES", env),
    ]),
  };
}

export async function runProductionDbRestorePointCleanup(options, dependencies = {}) {
  const exec = dependencies.execFile ?? execFile;
  const result = await cleanupProductionDbRestorePoints(options, exec);

  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }

  return result;
}

export async function cleanupProductionDbRestorePoints(options, exec) {
  const errors = validateOptions(options);
  const baseRecord = {
    schemaVersion: PRODUCTION_DB_RESTORE_POINT_CLEANUP_VERSION,
    checkedAt: options.checkedAt,
    mode: options.apply ? "apply" : "dry-run",
    prefix: options.prefix,
    minAgeHours: options.minAgeHours,
    cutoff: null,
    restorePoints: {
      observed: [],
      held: [],
      candidates: [],
      deleted: [],
      failed: [],
    },
    result: "failure",
    errors,
  };

  if (errors.length > 0) {
    return { record: baseRecord, passesCleanupGate: false };
  }

  const cutoff = new Date(new Date(options.checkedAt).getTime() - options.minAgeHours * 60 * 60 * 1000);
  const observed = await listDatabaseClusters(options.doctlPath, exec);
  const held = selectHeldRestorePoints(observed, options.holdNames ?? []);
  const candidates = selectRestorePointCleanupCandidates(observed, {
    prefix: options.prefix,
    cutoff,
    holdNames: options.holdNames ?? [],
  });
  const record = {
    ...baseRecord,
    cutoff: cutoff.toISOString(),
    restorePoints: {
      ...baseRecord.restorePoints,
      observed: observed.map(toRestorePointSummary),
      held: held.map(toRestorePointSummary),
      candidates: candidates.map(toRestorePointSummary),
    },
    result: "success",
    errors: [],
  };

  if (!options.apply) {
    return { record, passesCleanupGate: true };
  }

  for (const candidate of candidates) {
    try {
      await exec(options.doctlPath ?? "doctl", ["databases", "delete", candidate.id, "--force"], {
        maxBuffer: 1024 * 1024,
      });
      record.restorePoints.deleted.push(toRestorePointSummary(candidate));
    } catch (error) {
      record.restorePoints.failed.push({
        ...toRestorePointSummary(candidate),
        errors: describeDoctlFailure(error),
      });
    }
  }

  if (record.restorePoints.failed.length > 0) {
    record.result = "failure";
    record.errors = ["One or more restore-point database forks could not be deleted."];
  }

  return { record, passesCleanupGate: record.errors.length === 0 };
}

export async function listDatabaseClusters(doctlPath, exec) {
  const { stdout } = await exec(doctlPath ?? "doctl", ["databases", "list", "--output", "json"], {
    maxBuffer: 1024 * 1024 * 4,
  });
  return parseDoctlDatabaseListOutput(stdout);
}

export function parseDoctlDatabaseListOutput(stdout) {
  const parsed = JSON.parse(stdout || "[]");
  if (Array.isArray(parsed)) {
    return parsed.map(normalizeDatabaseCluster).filter(Boolean);
  }
  if (Array.isArray(parsed.databases)) {
    return parsed.databases.map(normalizeDatabaseCluster).filter(Boolean);
  }
  return [];
}

export function selectRestorePointCleanupCandidates(clusters, options) {
  const holds = new Set(options.holdNames ?? []);
  return clusters.filter((cluster) => {
    if (!cluster.name.startsWith(options.prefix)) {
      return false;
    }
    if (holds.has(cluster.name) || holds.has(cluster.id)) {
      return false;
    }
    const createdAt = Date.parse(cluster.createdAt);
    return Number.isFinite(createdAt) && createdAt <= options.cutoff.getTime();
  });
}

export function selectHeldRestorePoints(clusters, holdNames) {
  const holds = new Set(holdNames);
  if (holds.size === 0) {
    return [];
  }
  return clusters.filter((cluster) => holds.has(cluster.name) || holds.has(cluster.id));
}

function normalizeDatabaseCluster(record) {
  const id = readField(record, "id", "ID");
  const name = readField(record, "name", "Name");
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    status: readField(record, "status", "Status"),
    createdAt: readField(record, "createdAt", "created_at", "CreatedAt", "Created At"),
  };
}

function toRestorePointSummary(cluster) {
  return {
    id: cluster.id,
    name: cluster.name,
    status: cluster.status ?? null,
    createdAt: cluster.createdAt ?? null,
  };
}

function validateOptions(options) {
  const errors = [];
  if (!isNonEmptyString(options.prefix)) {
    errors.push("PRODUCTION_DB_RESTORE_POINT_CLEANUP_PREFIX is required.");
  }
  if (!Number.isFinite(options.minAgeHours) || options.minAgeHours < 0) {
    errors.push("PRODUCTION_DB_RESTORE_POINT_CLEANUP_MIN_AGE_HOURS must be zero or greater.");
  }
  if (!Number.isFinite(Date.parse(options.checkedAt))) {
    errors.push("--checked-at must be an ISO-8601 timestamp.");
  }
  return errors;
}

function describeDoctlFailure(error) {
  const details = ["doctl database delete failed for a restore-point fork."];
  const code = readErrorField(error, "code");
  const stderr = diagnosticSnippet(readErrorField(error, "stderr"));
  if (code !== null) {
    details.push(`exit code: ${code}`);
  }
  if (stderr) {
    details.push(`stderr: ${stderr}`);
  }
  return details;
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

function parseBoolean(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error("PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY must be true or false.");
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function main(argv, env = process.env) {
  try {
    const result = await runProductionDbRestorePointCleanup(parseProductionDbRestorePointCleanupArgs(argv, env));
    console.log(JSON.stringify(result.record, null, 2));
    return result.passesCleanupGate ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
