#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const PRODUCTION_RECOVERY_MODE_VERSION = "production-recovery-mode/v1";

const PRECREATED_FORK_RULES = [
  {
    id: "live-money-provider",
    pattern: /^bounded-contexts\/(?:checkout|ordering|payments|settlement)\//,
    reason: "Money movement, payment/provider idempotency, ordering, checkout, or settlement code changed.",
  },
  {
    id: "canonical-schema-migration",
    pattern: /(?:^|\/)(?:migrations?|schema|sql)\/.*\.(?:sql|ts|js|mjs)$/i,
    reason: "Database schema or migration code changed.",
  },
  {
    id: "event-store-contract",
    pattern: /(?:event-store|eventstore|upcaster|event-upcaster|stored-events?)/i,
    reason: "Event-store format, stored-event handling, or upcaster code changed.",
  },
  {
    id: "production-database-topology",
    pattern: /^infrastructure\/digitalocean\/platform\/.*(?:database|postgres|pool|grant|schema)/i,
    reason: "Production database topology or access control infrastructure changed.",
  },
  {
    id: "restore-point-helper",
    pattern: /^scripts\/production-db-restore-point\.mjs$/,
    reason: "Restore-point creation helper changed.",
  },
];

export function parseProductionRecoveryModeArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("PRODUCTION_RECOVERY_MODE_OUT", env),
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env),
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    changedFilesJson: resolveChangedFilesJson(argv, env),
    forceRestorePoint: parseBoolean(
      readOption(argv, "--force-restore-point") ?? readEnv("FORCE_RESTORE_POINT", env) ?? "false",
      "FORCE_RESTORE_POINT",
    ),
    recoveryReason: readOption(argv, "--recovery-reason") ?? readEnv("RECOVERY_REASON", env) ?? "",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

// The release diff can list thousands of files (for example a cold-start
// production deploy whose base is a stale production branch). Passing that JSON
// inline as a single CLI argument exceeds the operating-system per-argument
// length limit, so the workflow hands it over through a file. An explicit
// --changed-files-json still wins for direct callers and tests.
function resolveChangedFilesJson(argv, env) {
  const inline = readOption(argv, "--changed-files-json");
  if (inline !== null) {
    return inline;
  }
  const filePath = readOption(argv, "--changed-files-file") ?? readEnv("CHANGED_FILES_FILE", env);
  if (filePath) {
    return readChangedFilesFile(filePath);
  }
  return readEnv("CHANGED_FILES_JSON", env) ?? "[]";
}

function readChangedFilesFile(filePath) {
  try {
    return readFileSync(filePath, "utf8").trim() || "[]";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read --changed-files-file "${filePath}": ${detail}`);
  }
}

export async function runProductionRecoveryMode(options) {
  const result = classifyProductionRecoveryMode(options);
  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }
  if (options.githubOutputPath) {
    await appendGitHubOutputs(options.githubOutputPath, githubOutputsForRecord(result.record));
  }
  return result;
}

export function classifyProductionRecoveryMode(options) {
  const errors = validateOptions(options);
  const changedFiles = errors.length === 0 ? parseChangedFiles(options.changedFilesJson) : [];
  const matches = changedFiles.flatMap((filePath) =>
    PRECREATED_FORK_RULES.filter((rule) => rule.pattern.test(filePath)).map((rule) => ({
      filePath,
      ruleId: rule.id,
      reason: rule.reason,
    })),
  );

  let mode = "pitr";
  let reason =
    "Routine deploy can rely on DigitalOcean managed Postgres PITR/backups plus event-sourced projection replay.";
  if (matches.length > 0) {
    mode = "precreated-fork";
    reason = matches[0].reason;
  }
  if (options.forceRestorePoint) {
    mode = "manual-hold";
    reason = options.recoveryReason.trim() || "Operator requested a precreated production restore-point fork.";
  }

  const record = {
    schemaVersion: PRODUCTION_RECOVERY_MODE_VERSION,
    checkedAt: options.checkedAt,
    releaseCommit: options.releaseCommit ?? "",
    mode,
    reason,
    changedFiles,
    matchedRules: matches,
    restorePointRequired: mode === "precreated-fork" || mode === "manual-hold",
    fallbackRestoreProcedure:
      mode === "pitr"
        ? "Use DigitalOcean managed Postgres PITR/backups to create a new cluster, then replay projections from the event store."
        : "Use the precreated restore-point fork recorded in release health during the rollback/fix-forward window.",
    result: errors.length > 0 ? "failure" : "success",
    errors,
  };

  return { record, passesRecoveryModeGate: errors.length === 0 };
}

function validateOptions(options) {
  const errors = [];
  if (!isCommitSha(options.releaseCommit)) {
    errors.push("RELEASE_COMMIT must be a 40-character Git commit SHA.");
  }
  try {
    parseChangedFiles(options.changedFilesJson);
  } catch {
    errors.push("CHANGED_FILES_JSON must be a JSON array of file paths.");
  }
  if (options.forceRestorePoint && !options.recoveryReason.trim()) {
    errors.push("RECOVERY_REASON is required when FORCE_RESTORE_POINT is true.");
  }
  if (!Number.isFinite(Date.parse(options.checkedAt))) {
    errors.push("--checked-at must be an ISO-8601 timestamp.");
  }
  return errors;
}

function parseChangedFiles(value) {
  const parsed = JSON.parse(value || "[]");
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("changed files must be strings");
  }
  return parsed.map((entry) => entry.trim()).filter(Boolean);
}

function githubOutputsForRecord(record) {
  return {
    production_recovery_mode: record.mode,
    production_recovery_reason: record.reason,
    production_restore_point_required: String(record.restorePointRequired),
    production_recovery_record_result: record.result,
  };
}

async function appendGitHubOutputs(path, values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value ?? "")}`);
  await appendFile(path, `${lines.join("\n")}\n`);
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

async function main(argv, env = process.env) {
  try {
    const result = await runProductionRecoveryMode(parseProductionRecoveryModeArgs(argv, env));
    console.log(JSON.stringify(result.record, null, 2));
    return result.passesRecoveryModeGate ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
