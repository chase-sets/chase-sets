import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const DB_DURATION_BASELINE_PATH = "scripts/db-duration-baseline-v1.json";
export const DB_DURATION_BASELINE_VERSION = "db-duration-baseline/v1";
export const RECOMPUTE_SAMPLE_SIZE = 20;

export function driftBound(durationMs) {
  return durationMs + Math.max(Math.ceil(durationMs / 4), 60_000);
}

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} must contain exactly ${keys.join(", ")}.`);
  }
}

export function parseBaselineInstant(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new Error("Expected a timezone-bearing instant.");
  }
  const local = value.slice(0, 19);
  const localTime = Date.parse(`${local}Z`);
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(localTime) ||
    new Date(localTime).toISOString().slice(0, 19) !== local
  ) {
    throw new Error("Malformed instant.");
  }
  return time;
}

function duration(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
    throw new Error(`${label} must be a positive integer duration at most 86400000 ms.`);
  }
}

export function validateDbDurationBaseline(record, previousRecord) {
  exactKeys(record, ["schemaVersion", "recomputes"], "DB duration baseline");
  if (record.schemaVersion !== DB_DURATION_BASELINE_VERSION || !Array.isArray(record.recomputes)) {
    throw new Error("Invalid DB duration baseline schemaVersion or recomputes.");
  }
  let previous;
  for (const entry of record.recomputes) {
    exactKeys(entry, ["recomputedAt", "sampleJobIds", "workspaces", "jobWallMs", "cause"], "Recompute");
    const at = parseBaselineInstant(entry.recomputedAt);
    if (previous && at <= parseBaselineInstant(previous.recomputedAt))
      throw new Error("Recompute instants must increase.");
    if (
      !Array.isArray(entry.sampleJobIds) ||
      entry.sampleJobIds.length !== RECOMPUTE_SAMPLE_SIZE ||
      new Set(entry.sampleJobIds).size !== RECOMPUTE_SAMPLE_SIZE ||
      entry.sampleJobIds.some((id) => !Number.isSafeInteger(id) || id < 1)
    ) {
      throw new Error("Recompute requires exactly 20 unique positive integer job IDs.");
    }
    if (
      entry.cause !== null &&
      (typeof entry.cause !== "string" || entry.cause.length > 1024 || !/#[1-9]\d*\b/.test(entry.cause))
    ) {
      throw new Error("Recompute cause must be null or name an issue (#<n>).");
    }
    if (
      !entry.workspaces ||
      typeof entry.workspaces !== "object" ||
      Array.isArray(entry.workspaces) ||
      Object.keys(entry.workspaces).length < 1 ||
      Object.keys(entry.workspaces).length > 256
    ) {
      throw new Error("Recompute workspaces must contain 1 through 256 workspace durations.");
    }
    for (const [name, ms] of Object.entries(entry.workspaces)) {
      if (name.length > 128 || !/^@chase-sets\/[a-z0-9-]+$/.test(name)) throw new Error("Invalid workspace name.");
      duration(ms, name);
      if (
        previous &&
        Object.hasOwn(previous.workspaces, name) &&
        ms > driftBound(previous.workspaces[name]) &&
        !entry.cause
      ) {
        throw new Error(`Uncaused step-up for ${name}.`);
      }
    }
    duration(entry.jobWallMs, "jobWallMs");
    if (previous && entry.jobWallMs > driftBound(previous.jobWallMs) && !entry.cause)
      throw new Error("Uncaused step-up for jobWall.");
    previous = entry;
  }
  if (previousRecord) {
    validateDbDurationBaseline(previousRecord);
    if (
      record.recomputes.length < previousRecord.recomputes.length ||
      previousRecord.recomputes.some(
        (entry, index) => JSON.stringify(entry) !== JSON.stringify(record.recomputes[index]),
      )
    )
      throw new Error("DB duration baseline history must be append-only.");
  }
  return record;
}

export function checkDbDurationBaseline({ repoRoot, read = readFileSync, git = execFileSync }) {
  try {
    const record = JSON.parse(read(path.join(repoRoot, DB_DURATION_BASELINE_PATH), "utf8"));
    const tracked = git("git", ["ls-tree", "--name-only", "origin/main", "--", DB_DURATION_BASELINE_PATH], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const previous = tracked
      ? JSON.parse(
          git("git", ["show", `origin/main:${DB_DURATION_BASELINE_PATH}`], { cwd: repoRoot, encoding: "utf8" }),
        )
      : undefined;
    validateDbDurationBaseline(record, previous);
    return [];
  } catch (error) {
    return [{ file: DB_DURATION_BASELINE_PATH, message: error.message }];
  }
}
