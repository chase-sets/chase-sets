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
  "cancelled",
  "refused",
]);

export function parseTimingRecord(line) {
  if (typeof line !== "string" || line.length > 2048 || !line.startsWith(RECORD_PREFIX)) return null;
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
  if (record.elapsedMs !== Date.parse(record.endedAt) - Date.parse(record.startedAt)) return false;
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

export function consumeTimingRecords(lines, { headSha, owningJob } = {}) {
  const steps = Array.isArray(owningJob?.steps)
    ? owningJob.steps.filter((step) => step?.name === "Install provider browser boundary")
    : [];
  if (
    !/^[a-f0-9]{40}$/.test(headSha ?? "") ||
    !Array.isArray(lines) ||
    owningJob?.head_sha !== headSha ||
    steps?.length !== 1 ||
    steps[0].status !== "completed" ||
    !["success", "failure"].includes(steps[0].conclusion) ||
    !isIso(steps[0].started_at) ||
    !isIso(steps[0].completed_at) ||
    Date.parse(steps[0].completed_at) < Date.parse(steps[0].started_at)
  )
    return [];
  const records = lines
    .filter((line) => typeof line === "string" && line.startsWith(RECORD_PREFIX))
    .map(parseTimingRecord);
  if (
    records.some(
      (record) =>
        !isValidTimingRecord(record, { headSha }) ||
        record.runId !== String(owningJob.run_id) ||
        record.jobId !== String(owningJob.id) ||
        record.runAttempt !== owningJob.run_attempt ||
        Date.parse(record.startedAt) < Date.parse(steps[0].started_at) ||
        Date.parse(record.endedAt) >= Date.parse(steps[0].completed_at) + 1000,
    )
  )
    return [];
  return records.length === 1 ? records : [];
}

export const TIMING_RECORD_PREFIX = RECORD_PREFIX;
