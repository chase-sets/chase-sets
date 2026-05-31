#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
  const summary = {
    releaseCount: records.length,
    successCount: records.filter((record) => record.production?.result === "success").length,
    failureCount: records.filter((record) => ["failure", "cancelled"].includes(record.production?.result)).length,
    emergencyCount: records.filter((record) => record.releaseMode === "emergency").length,
    lockedCount: records.filter((record) => record.releaseLock?.locked).length,
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
    `- Production successes: ${summary.successCount}`,
    `- Production failures/cancellations: ${summary.failureCount}`,
    `- Emergency releases: ${summary.emergencyCount}`,
    `- Releases with lock active: ${summary.lockedCount}`,
    "",
    "## Releases",
    "",
    "| Commit | Mode | Staging | Canary | Production | Drift | Queue to prod | Lock |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...records.map(formatReleaseRow),
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
    record.releaseMode ?? "unknown",
    record.staging?.result ?? "unknown",
    record.canary?.result ?? "unknown",
    record.production?.result ?? "unknown",
    formatDrift(record.mainToProductionDrift),
    formatDuration(record.queue?.queuedAt ?? record.queue?.mergedAt, record.production?.completedAt),
    formatLock(record.releaseLock),
  ]
    .map(escapeMarkdownCell)
    .join(" | ")
    .replace(/^/, "| ")
    .replace(/$/, " |");
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
  const startTime = Date.parse(start ?? "");
  const endTime = Date.parse(end ?? "");
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime < startTime) {
    return "unknown";
  }
  return formatSeconds(Math.round((endTime - startTime) / 1000));
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

function escapeMarkdownCell(value) {
  return String(value).replaceAll("|", "\\|");
}

function readRepeatedOptions(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      values.push(argv[index + 1]);
      index += 1;
    }
  }
  return values;
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
