const RECORD_PREFIX = "provider-browser-install-timing/v1 ";

const phases = new Set(["runner-identity", "browser-download", "native-dependencies", "boundary-install", "terminal"]);
const sources = new Set(["provider-download", "cache"]);
const caches = new Set(["hit", "miss", "not-applicable"]);
const outcomes = new Set([
  "success",
  "timeout",
  "partial-download",
  "checksum-failure",
  "cache-restore-failure",
  "cleanup-failure",
  "refused",
]);

export function parseTimingRecord(line) {
  if (typeof line !== "string" || !line.startsWith(RECORD_PREFIX)) return null;
  try {
    return JSON.parse(line.slice(RECORD_PREFIX.length));
  } catch {
    return null;
  }
}

export function isValidTimingRecord(record, { headSha } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const fields = [
    "runId",
    "jobId",
    "runAttempt",
    "elapsedMs",
    "step",
    "headSha",
    "startedAt",
    "endedAt",
    "phase",
    "source",
    "cache",
    "retryCount",
    "terminalOutcome",
  ];
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field)))
    return false;
  if (
    typeof record.runId !== "string" ||
    typeof record.jobId !== "string" ||
    !/^\d{1,20}$/.test(record.runId) ||
    !/^\d{1,20}$/.test(record.jobId)
  )
    return false;
  if (!Number.isSafeInteger(record.runAttempt) || record.runAttempt < 0) return false;
  if (!Number.isSafeInteger(record.elapsedMs) || record.elapsedMs < 0) return false;
  if (record.step !== "Install provider browser boundary") return false;
  if (
    typeof record.headSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(record.headSha) ||
    (headSha && record.headSha !== headSha)
  )
    return false;
  if (!isIso(record.startedAt) || !isIso(record.endedAt) || Date.parse(record.endedAt) < Date.parse(record.startedAt))
    return false;
  if (!phases.has(record.phase) || !sources.has(record.source) || !caches.has(record.cache)) return false;
  if ((record.source === "cache") !== (record.cache === "hit")) return false;
  if (record.retryCount !== 0 || !outcomes.has(record.terminalOutcome)) return false;
  return true;
}

function isIso(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z")
  );
}

export function timingRecordLine(record) {
  if (!isValidTimingRecord(record)) throw new Error("Invalid provider-browser-install-timing/v1 record");
  return `${RECORD_PREFIX}${JSON.stringify(record)}`;
}

export function consumeTimingRecords(lines, { headSha, stepExecuted = false } = {}) {
  if (!stepExecuted || !/^[a-f0-9]{40}$/.test(headSha ?? "") || !Array.isArray(lines)) return [];
  const records = lines
    .map(parseTimingRecord)
    .filter(Boolean)
    .filter((record) => isValidTimingRecord(record, { headSha }));
  const unique = new Map();
  const duplicates = new Set();
  for (const record of records) {
    const key = `${record.runId}/${record.runAttempt}/${record.jobId}/${record.step}`;
    if (unique.has(key)) duplicates.add(key);
    else unique.set(key, record);
  }
  return [...unique.entries()].filter(([key]) => !duplicates.has(key)).map(([, record]) => record);
}

export const TIMING_RECORD_PREFIX = RECORD_PREFIX;
