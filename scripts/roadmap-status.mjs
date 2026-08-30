import process from "node:process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { classified, isEpic as classifiedEpic, isTrackingOnly } from "./backlog-classify.mjs";
import { derivePullWindow, seriesIdentity } from "./dispatch-window.mjs";

// Generated status for the program roadmap issue. The contract this reports
// against lives in docs/contributing/backlog-model.md. Numbers are generated
// because a hand-maintained rollup drifted on 5 of 12 rows in two weeks.

export const START_MARKER = "<!-- roadmap-status:start -->";
export const END_MARKER = "<!-- roadmap-status:end -->";
export const REFINED_INVENTORY_CAP_SCHEMA_VERSION = "roadmap-refined-inventory-cap/v1";
export const REFINED_INVENTORY_PROBE_SCHEMA_VERSION = "roadmap-refined-inventory-authority-probe/v1";

const REFINED_INVENTORY_CAP_PREFIX = "<!-- roadmap-refined-inventory-cap:";
const REFINED_INVENTORY_CAP_SUFFIX = " -->";
const REFINED_INVENTORY_CAP_KEYS = [
  "schemaVersion",
  "generatedAt",
  "month",
  "windowStart",
  "windowEndExclusive",
  "mergedPrCount",
  "cap",
  "identitySha256",
];
const REFINED_INVENTORY_ATTEMPT_KEYS = ["attempt", "pages", "count", "digest"];
const REFINED_INVENTORY_PROBE_KEYS = [
  "schemaVersion",
  "repository",
  "workflow",
  "runId",
  "runAttempt",
  "jobId",
  "headSha",
  "nonce",
  "checkedAt",
  "query",
  "month",
  "windowStart",
  "windowEndExclusive",
  "attempts",
  "acceptedAttempts",
  "mergedPrCount",
  "cap",
  "identitySha256",
];
const REFINED_INVENTORY_QUERY_SENTINEL = "REFINED_INVENTORY_PRS_SENTINEL";
const REFINED_INVENTORY_SEARCH_LIMIT = 1_000;
const REFINED_INVENTORY_MAX_PAGES = 10;
const REFINED_INVENTORY_DIGEST = /^[0-9a-f]{64}$/;
const REFINED_INVENTORY_NONCE = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{40}$/;
const CANONICAL_REPOSITORY = "chase-sets/chase-sets";
const CANONICAL_WORKFLOW = "backlog-roadmap-status.yml";
const CANONICAL_ROADMAP_ISSUE = "4129";
const CANONICAL_PROBE_OUTPUT =
  "artifacts/roadmap-refined-inventory-authority/roadmap-refined-inventory-authority-probe.json";

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMELINE_CONCURRENCY = 8;
const EPIC_SUB_ISSUE_CAPACITY = 100;
const EPIC_SUB_ISSUE_WARNING_THRESHOLD = 90;
const NON_EXECUTABLE_MILESTONES = new Set(["Deferred / Incubation", "Operations"]);
const MILESTONE_EVENTS = new Set(["milestoned", "demilestoned"]);
const FORECAST_WINDOW_DAYS = 14;
const FORECAST_SCHEMA_VERSION = "roadmap-forecast-inputs/v1";
const FORECAST_RECORD_PREFIX = "<!-- roadmap-forecast-inputs:";
const FORECAST_RECORD_SUFFIX = " -->";
const THROUGHPUT_TITLE = /^(Wave|Mobile)\s+(\d+)\b/;
const FORECAST_RECORD_KEYS = [
  "schemaVersion",
  "generatedAt",
  "windowDays",
  "closures7",
  "closures14",
  "closureDays14",
  "milestones",
];
const FORECAST_MILESTONE_KEYS = [
  "number",
  "title",
  "state",
  "cumulativeOpen",
  "forecastDays",
  "openEligibleIssueNumbers",
  "closedEligibleIssueNumbers",
  "openIneligibleIssueNumbers",
  "closedIneligibleIssueNumbers",
];
const FORECAST_IDENTITY_KEYS = FORECAST_MILESTONE_KEYS.slice(5);
export const FORECAST_TABLE_HEADER =
  "| Outcome | Forecast | Drift | Slices | Done | Open | Refined | Parentless _(reported)_ | Tracking | Added (7d) | Epics done |";
export const FORECAST_TABLE_SEPARATOR = "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|";

function authorityError(code, message = code) {
  return new RoadmapIssueEnumerationError(code, message);
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).join("\0") === keys.join("\0")
  );
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseTimezoneInstant(value) {
  if (typeof value !== "string" || !/[Tt].*(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalInstant(value) {
  const parsed = parseTimezoneInstant(value);
  return parsed !== null && new Date(parsed).toISOString() === value ? parsed : null;
}

export function deriveMonthlyRefinedInventoryWindow(nowMs = Date.now(), repository = CANONICAL_REPOSITORY) {
  if (!Number.isFinite(nowMs)) throw authorityError("ROADMAP_REFINED_INVENTORY_TIME_INVALID");
  if (repository !== CANONICAL_REPOSITORY) throw authorityError("ROADMAP_REFINED_INVENTORY_REPOSITORY_INVALID");
  const now = new Date(nowMs);
  const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const windowStartMs = monthStartMs - 28 * DAY_MS;
  const month = new Date(monthStartMs).toISOString().slice(0, 7);
  const windowStart = new Date(windowStartMs).toISOString();
  const windowEndExclusive = new Date(monthStartMs).toISOString();
  const lastIncludedDay = new Date(monthStartMs - DAY_MS).toISOString().slice(0, 10);
  const query = `repo:${repository} is:pr is:merged base:main merged:${windowStart.slice(0, 10)}..${lastIncludedDay}`;
  return { month, windowStart, windowEndExclusive, query };
}

function refinedInventoryError(code, message = code) {
  return authorityError(code, message);
}

function validateRefinedInventorySearchPage(page, expectedTotal) {
  if (
    !hasExactKeys(page, ["issueCount", "pageInfo", "nodes"]) ||
    !isNonNegativeSafeInteger(page.issueCount) ||
    !hasExactKeys(page.pageInfo, ["hasNextPage", "endCursor"]) ||
    typeof page.pageInfo.hasNextPage !== "boolean" ||
    !(page.pageInfo.endCursor === null || (typeof page.pageInfo.endCursor === "string" && page.pageInfo.endCursor)) ||
    !Array.isArray(page.nodes) ||
    page.nodes.length > 100
  ) {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_PAGE_INVALID");
  }
  if (page.issueCount >= REFINED_INVENTORY_SEARCH_LIMIT) {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_SEARCH_LIMIT");
  }
  if (expectedTotal !== null && page.issueCount !== expectedTotal) {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_TOTAL_CHANGED");
  }
}

export async function collectMonthlyRefinedInventory({ loadPage, window }) {
  if (typeof loadPage !== "function" || !window) {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_COLLECTOR_INVALID");
  }
  const startMs = canonicalInstant(window.windowStart);
  const endMs = canonicalInstant(window.windowEndExclusive);
  if (startMs === null || endMs === null || endMs - startMs !== 28 * DAY_MS) {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_WINDOW_INVALID");
  }
  const rows = [];
  const identities = new Set();
  const cursors = new Set();
  let expectedTotal = null;
  let after = null;
  let pages = 0;
  while (true) {
    if (pages >= REFINED_INVENTORY_MAX_PAGES) {
      throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_PAGINATION_BOUNDED");
    }
    const page = await loadPage(after, window.query);
    validateRefinedInventorySearchPage(page, expectedTotal);
    expectedTotal ??= page.issueCount;
    pages += 1;
    const before = rows.length;
    for (const node of page.nodes) {
      if (!hasExactKeys(node, ["number", "mergedAt", "baseRefName"])) {
        throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_IDENTITY_INVALID");
      }
      const mergedAtMs = parseTimezoneInstant(node.mergedAt);
      if (
        !isPositiveSafeInteger(node.number) ||
        identities.has(node.number) ||
        mergedAtMs === null ||
        mergedAtMs < startMs ||
        mergedAtMs >= endMs ||
        node.baseRefName !== "main"
      ) {
        throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_IDENTITY_INVALID");
      }
      identities.add(node.number);
      rows.push({ number: node.number, mergedAt: new Date(mergedAtMs).toISOString(), baseRefName: "main" });
    }
    if (rows.length > expectedTotal) throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_COUNT_MISMATCH");
    if (!page.pageInfo.hasNextPage) break;
    const cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor) || rows.length === before || rows.length >= expectedTotal) {
      throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_CURSOR_INVALID");
    }
    cursors.add(cursor);
    after = cursor;
  }
  if (rows.length !== expectedTotal) throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_COUNT_MISMATCH");
  rows.sort((left, right) => left.number - right.number);
  const canonicalText = rows.map((row) => `${row.number}|${row.mergedAt}|${row.baseRefName}`).join("\n");
  const digest = createHash("sha256").update(Buffer.from(canonicalText, "utf8")).digest("hex");
  return { pages, count: rows.length, digest, rows, canonicalText };
}

export async function stabilizeMonthlyRefinedInventory(collectAttempt) {
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const collection = await collectAttempt(attempt);
    attempts.push({ attempt, ...collection });
    if (attempt >= 2 && attempts[attempt - 2].digest === collection.digest) {
      return {
        collection,
        attempts,
        acceptedAttempts: [attempt - 1, attempt],
      };
    }
  }
  throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_UNSTABLE");
}

function validateRefinedInventoryCapRecord(record) {
  if (
    !hasExactKeys(record, REFINED_INVENTORY_CAP_KEYS) ||
    record.schemaVersion !== REFINED_INVENTORY_CAP_SCHEMA_VERSION ||
    canonicalInstant(record.generatedAt) === null ||
    !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(record.month) ||
    record.generatedAt.slice(0, 7) !== record.month ||
    canonicalInstant(record.windowStart) === null ||
    canonicalInstant(record.windowEndExclusive) === null ||
    !isNonNegativeSafeInteger(record.mergedPrCount) ||
    record.cap !== 2 * record.mergedPrCount ||
    !REFINED_INVENTORY_DIGEST.test(record.identitySha256)
  ) {
    return false;
  }
  const expected = deriveMonthlyRefinedInventoryWindow(Date.parse(`${record.month}-15T00:00:00.000Z`));
  return record.windowStart === expected.windowStart && record.windowEndExclusive === expected.windowEndExclusive;
}

export function renderRefinedInventoryCapMarker(record) {
  return `${REFINED_INVENTORY_CAP_PREFIX}${JSON.stringify(record)}${REFINED_INVENTORY_CAP_SUFFIX}`;
}

export function reducePriorRefinedInventoryAuthority(body, nowMs = Date.now()) {
  const text = String(body ?? "");
  if (countOccurrences(text, START_MARKER) !== 1 || countOccurrences(text, END_MARKER) !== 1) {
    return { status: "invalid", code: "ROADMAP_MARKERS_INVALID" };
  }
  const blockStart = text.indexOf(START_MARKER);
  const blockEnd = text.indexOf(END_MARKER);
  if (blockEnd < blockStart) return { status: "invalid", code: "ROADMAP_MARKERS_INVALID" };
  const tokenCount = countOccurrences(text, "roadmap-refined-inventory-cap");
  const prefixCount = countOccurrences(text, REFINED_INVENTORY_CAP_PREFIX);
  if (tokenCount === 0 && prefixCount === 0) return { status: "absent", record: null, marker: null };
  if (prefixCount !== 1 || tokenCount !== 2) {
    return { status: "invalid", code: "ROADMAP_REFINED_INVENTORY_MARKER_INVALID" };
  }
  const markerStart = text.indexOf(REFINED_INVENTORY_CAP_PREFIX);
  const jsonStart = markerStart + REFINED_INVENTORY_CAP_PREFIX.length;
  const markerEnd = text.indexOf(REFINED_INVENTORY_CAP_SUFFIX, jsonStart);
  if (markerEnd < 0 || markerStart <= blockStart || markerEnd + REFINED_INVENTORY_CAP_SUFFIX.length > blockEnd) {
    return { status: "invalid", code: "ROADMAP_REFINED_INVENTORY_MARKER_INVALID" };
  }
  const encoded = text.slice(jsonStart, markerEnd);
  let record;
  try {
    record = JSON.parse(encoded);
  } catch {
    return { status: "invalid", code: "ROADMAP_REFINED_INVENTORY_MARKER_INVALID" };
  }
  const marker = text.slice(markerStart, markerEnd + REFINED_INVENTORY_CAP_SUFFIX.length);
  if (!validateRefinedInventoryCapRecord(record) || marker !== renderRefinedInventoryCapMarker(record)) {
    return { status: "invalid", code: "ROADMAP_REFINED_INVENTORY_MARKER_INVALID" };
  }
  const currentMonth = deriveMonthlyRefinedInventoryWindow(nowMs).month;
  if (record.month > currentMonth) return { status: "future", code: "ROADMAP_REFINED_INVENTORY_MARKER_FUTURE" };
  if (Date.parse(record.generatedAt) > nowMs) {
    return { status: "invalid", code: "ROADMAP_REFINED_INVENTORY_MARKER_INVALID" };
  }
  return { status: record.month === currentMonth ? "current" : "prior", record, marker };
}

function capRecordFromCollection(collection, window, nowMs) {
  return {
    schemaVersion: REFINED_INVENTORY_CAP_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    month: window.month,
    windowStart: window.windowStart,
    windowEndExclusive: window.windowEndExclusive,
    mergedPrCount: collection.count,
    cap: 2 * collection.count,
    identitySha256: collection.digest,
  };
}

export function validateRefinedInventoryProbePayload(payload) {
  if (
    !hasExactKeys(payload, REFINED_INVENTORY_PROBE_KEYS) ||
    payload.schemaVersion !== REFINED_INVENTORY_PROBE_SCHEMA_VERSION ||
    payload.repository !== CANONICAL_REPOSITORY ||
    payload.workflow !== CANONICAL_WORKFLOW ||
    !isPositiveSafeInteger(payload.runId) ||
    !isPositiveSafeInteger(payload.runAttempt) ||
    !isPositiveSafeInteger(payload.jobId) ||
    !SHA.test(payload.headSha) ||
    !REFINED_INVENTORY_NONCE.test(payload.nonce) ||
    canonicalInstant(payload.checkedAt) === null ||
    !Array.isArray(payload.attempts) ||
    ![2, 3].includes(payload.attempts.length) ||
    !Array.isArray(payload.acceptedAttempts) ||
    payload.acceptedAttempts.length !== 2 ||
    !isNonNegativeSafeInteger(payload.mergedPrCount) ||
    payload.mergedPrCount >= REFINED_INVENTORY_SEARCH_LIMIT ||
    payload.cap !== 2 * payload.mergedPrCount ||
    !REFINED_INVENTORY_DIGEST.test(payload.identitySha256)
  ) {
    return false;
  }
  let window;
  try {
    window = deriveMonthlyRefinedInventoryWindow(Date.parse(`${payload.month}-15T00:00:00.000Z`), payload.repository);
  } catch {
    return false;
  }
  if (
    payload.month !== window.month ||
    payload.windowStart !== window.windowStart ||
    payload.windowEndExclusive !== window.windowEndExclusive ||
    payload.query !== window.query
  ) {
    return false;
  }
  for (let index = 0; index < payload.attempts.length; index += 1) {
    const attempt = payload.attempts[index];
    if (
      !hasExactKeys(attempt, REFINED_INVENTORY_ATTEMPT_KEYS) ||
      attempt.attempt !== index + 1 ||
      !Number.isSafeInteger(attempt.pages) ||
      attempt.pages < 1 ||
      attempt.pages > REFINED_INVENTORY_MAX_PAGES ||
      !isNonNegativeSafeInteger(attempt.count) ||
      attempt.count >= REFINED_INVENTORY_SEARCH_LIMIT ||
      !REFINED_INVENTORY_DIGEST.test(attempt.digest)
    ) {
      return false;
    }
  }
  const [left, right] = payload.acceptedAttempts;
  if (
    !Number.isSafeInteger(left) ||
    right !== left + 1 ||
    right !== payload.attempts.length ||
    left < 1 ||
    payload.attempts[left - 1].digest !== payload.attempts[right - 1].digest
  ) {
    return false;
  }
  const accepted = payload.attempts[right - 1];
  return (
    accepted.count === payload.mergedPrCount &&
    accepted.digest === payload.identitySha256 &&
    payload.attempts.every((attempt) => attempt.count === payload.mergedPrCount)
  );
}

export function canonicalRefinedInventoryProbeBytes(payload) {
  if (!validateRefinedInventoryProbePayload(payload)) {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_PROBE_INVALID");
  }
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}

function writeCanonicalFileAtomic(outPath, bytes) {
  const absolute = resolve(outPath);
  const directory = dirname(absolute);
  const relativeOutput = outPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (relativeOutput !== CANONICAL_PROBE_OUTPUT || absolute !== resolve(CANONICAL_PROBE_OUTPUT)) {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_OUTPUT_PATH_INVALID");
  }
  let ancestor = directory;
  while (ancestor !== resolve(ancestor, "..")) {
    if (existsSync(ancestor)) {
      const stats = lstatSync(ancestor);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_OUTPUT_PATH_INVALID");
      }
    }
    if (ancestor === resolve()) break;
    ancestor = resolve(ancestor, "..");
  }
  if (existsSync(absolute) || (existsSync(directory) && readdirSync(directory).length !== 0)) {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_OUTPUT_NOT_FRESH");
  }
  mkdirSync(directory, { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, absolute);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readCanonicalRefinedInventoryProbe(inputPath) {
  const absolute = resolve(inputPath);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_PROBE_FILE_INVALID");
  }
  const bytes = readFileSync(absolute);
  if (bytes.length < 2 || bytes.length > 512 * 1024 || bytes[0] === 0xef || bytes[1] === 0xbb || bytes[2] === 0xbf) {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_PROBE_FILE_INVALID");
  }
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_PROBE_FILE_INVALID");
  }
  const canonical = canonicalRefinedInventoryProbeBytes(payload);
  if (!bytes.equals(canonical)) throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_PROBE_FILE_NONCANONICAL");
  return payload;
}

async function collectCurrentAttemptJobs({ repository, runId, runAttempt, token, request }) {
  const jobs = [];
  const identities = new Set();
  let expectedTotal = null;
  for (let page = 1; page <= REFINED_INVENTORY_MAX_PAGES; page += 1) {
    const response = await gh(
      `/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`,
      token,
      {},
      request,
    );
    const payload = await response.json();
    if (!isNonNegativeSafeInteger(payload?.total_count) || !Array.isArray(payload?.jobs)) {
      throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_JOB_PAGE_INVALID");
    }
    if (payload.total_count >= REFINED_INVENTORY_SEARCH_LIMIT) {
      throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_JOB_LIMIT");
    }
    expectedTotal ??= payload.total_count;
    if (expectedTotal !== payload.total_count) {
      throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_JOB_TOTAL_CHANGED");
    }
    for (const job of payload.jobs) {
      if (!isPositiveSafeInteger(job?.id) || typeof job.name !== "string" || typeof job.status !== "string") {
        throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_JOB_INVALID");
      }
      if (identities.has(job.id)) throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_JOB_DUPLICATE");
      identities.add(job.id);
      jobs.push(job);
    }
    if (jobs.length > expectedTotal) throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_JOB_COUNT_MISMATCH");
    if (jobs.length === expectedTotal) return jobs;
    if (payload.jobs.length !== 100 || jobs.length >= 999) {
      throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_JOB_COUNT_MISMATCH");
    }
  }
  throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_JOB_PAGINATION_BOUNDED");
}

export async function resolveRefinedInventoryProbeJob({ env = process.env, request = globalThis.fetch } = {}) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw refinedInventoryError("ROADMAP_GITHUB_TOKEN_REQUIRED");
  const repository = env.GITHUB_REPOSITORY;
  const runId = Number(env.GITHUB_RUN_ID);
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (repository !== CANONICAL_REPOSITORY || !isPositiveSafeInteger(runId) || !isPositiveSafeInteger(runAttempt)) {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_RUN_IDENTITY_INVALID");
  }
  const jobs = await collectCurrentAttemptJobs({ repository, runId, runAttempt, token, request });
  const matches = jobs.filter((job) => job.name === "probe-authority" && job.status === "in_progress");
  if (matches.length !== 1) throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_PROBE_JOB_AMBIGUOUS");
  if (!env.GITHUB_OUTPUT) throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_OUTPUT_ENV_REQUIRED");
  appendFileSync(env.GITHUB_OUTPUT, `job_id=${matches[0].id}\n`, "utf8");
  return matches[0].id;
}

export async function produceRefinedInventoryProbe({
  env = process.env,
  request = globalThis.fetch,
  nowMs = Date.now(),
  outPath,
} = {}) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw refinedInventoryError("ROADMAP_GITHUB_TOKEN_REQUIRED");
  const repository = env.GITHUB_REPOSITORY;
  const workflow = env.ROADMAP_WORKFLOW;
  const runId = Number(env.GITHUB_RUN_ID);
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  const jobId = Number(env.ROADMAP_PROBE_JOB_ID);
  const headSha = env.GITHUB_SHA;
  const nonce = env.ROADMAP_AUTHORITY_NONCE;
  if (
    repository !== CANONICAL_REPOSITORY ||
    workflow !== CANONICAL_WORKFLOW ||
    !isPositiveSafeInteger(runId) ||
    !isPositiveSafeInteger(runAttempt) ||
    !isPositiveSafeInteger(jobId) ||
    !SHA.test(headSha ?? "") ||
    !REFINED_INVENTORY_NONCE.test(nonce ?? "") ||
    !outPath
  ) {
    throw refinedInventoryError("ROADMAP_REFINED_INVENTORY_PROBE_ENV_INVALID");
  }
  const acquisition = await collectLiveMonthlyRefinedInventory({ repository, token, request, nowMs });
  const payload = {
    schemaVersion: REFINED_INVENTORY_PROBE_SCHEMA_VERSION,
    repository,
    workflow,
    runId,
    runAttempt,
    jobId,
    headSha,
    nonce,
    checkedAt: new Date(nowMs).toISOString(),
    query: acquisition.window.query,
    month: acquisition.window.month,
    windowStart: acquisition.window.windowStart,
    windowEndExclusive: acquisition.window.windowEndExclusive,
    attempts: acquisition.attempts.map(({ attempt, pages, count, digest }) => ({ attempt, pages, count, digest })),
    acceptedAttempts: acquisition.acceptedAttempts,
    mergedPrCount: acquisition.collection.count,
    cap: 2 * acquisition.collection.count,
    identitySha256: acquisition.collection.digest,
  };
  writeCanonicalFileAtomic(outPath, canonicalRefinedInventoryProbeBytes(payload));
  return payload;
}

function throughputIdentity(title) {
  if (typeof title !== "string") return null;
  const match = THROUGHPUT_TITLE.exec(title);
  if (!match) return null;
  const ordinal = Number(match[2]);
  return Number.isSafeInteger(ordinal) ? { family: match[1], ordinal } : null;
}

function validateOpenMilestoneShapes(milestones) {
  for (const milestone of milestones) {
    const dueMs =
      Object.hasOwn(milestone ?? {}, "due_on") && milestone.due_on !== null
        ? parseTimezoneInstant(milestone.due_on)
        : null;
    if (
      !milestone ||
      !isPositiveSafeInteger(milestone.number) ||
      typeof milestone.title !== "string" ||
      milestone.title.length === 0 ||
      !Object.hasOwn(milestone, "state") ||
      milestone.state !== "open" ||
      !Object.hasOwn(milestone, "due_on") ||
      (milestone.due_on !== null && dueMs === null)
    ) {
      throw authorityError("OPEN_MILESTONE_SHAPE_INVALID", "Open milestone authority has an invalid base shape.");
    }
  }
}

function validateOpenMilestoneDueDates(milestones) {
  if (milestones.some((milestone) => milestone.due_on !== null)) {
    throw authorityError(
      "OPEN_MILESTONE_DUE_DATE_PROHIBITED",
      "Open milestones are gate-bound and must not carry due dates.",
    );
  }
}

function assertCatalogOrder(catalog) {
  const numbers = new Set();
  const titles = new Set();
  const previousOrdinal = new Map();
  for (const milestone of catalog) {
    const identity = throughputIdentity(milestone.title);
    if (!identity || numbers.has(milestone.number) || titles.has(milestone.title)) {
      throw authorityError("MILESTONE_CATALOG_DRIFT", "Wave/Mobile milestone catalog identity drifted.");
    }
    const previous = previousOrdinal.get(identity.family);
    if (previous !== undefined && identity.ordinal <= previous) {
      throw authorityError("MILESTONE_CATALOG_DRIFT", "Wave/Mobile milestone ordinals are not strictly increasing.");
    }
    numbers.add(milestone.number);
    titles.add(milestone.title);
    previousOrdinal.set(identity.family, identity.ordinal);
  }
}

export function buildForecastMilestoneCatalog(openMilestones, closedMilestones) {
  for (const milestone of closedMilestones) {
    if (
      !milestone ||
      !isPositiveSafeInteger(milestone.number) ||
      typeof milestone.title !== "string" ||
      milestone.title.length === 0 ||
      !Object.hasOwn(milestone, "state") ||
      milestone.state !== "closed"
    ) {
      throw authorityError("MILESTONE_CATALOG_DRIFT", "Closed milestone authority has an invalid base shape.");
    }
  }
  const catalog = [...openMilestones, ...closedMilestones]
    .filter((milestone) => throughputIdentity(milestone.title) !== null)
    .map(({ number, title, state }) => ({ number, title, state }))
    .sort((left, right) => left.number - right.number);
  assertCatalogOrder(catalog);
  return catalog;
}

export function reconcileForecastIssueSources(restIssues, issueFacts) {
  const restNumbers = restIssues.map((issue) => issue?.number);
  const graphNumbers = Array.isArray(issueFacts?.sourceNumbers) ? issueFacts.sourceNumbers : [...issueFacts.keys()];
  const isClosedSet = (numbers) => numbers.every(isPositiveSafeInteger) && new Set(numbers).size === numbers.length;
  const restSet = new Set(restNumbers);
  const graphSet = new Set(graphNumbers);
  if (
    !isClosedSet(restNumbers) ||
    !isClosedSet(graphNumbers) ||
    restNumbers.length !== graphNumbers.length ||
    restSet.size !== graphSet.size ||
    [...restSet].some((number) => !graphSet.has(number)) ||
    [...graphSet].some((number) => !restSet.has(number))
  ) {
    throw authorityError(
      "ROADMAP_ISSUE_SOURCE_COUNT_MISMATCH",
      `REST and GraphQL issue identities did not reconcile exactly (${restNumbers.length} REST, ${graphNumbers.length} GraphQL).`,
    );
  }
}

export function normalizeForecastIssue(issue, catalogByNumber, nowMs) {
  const labels = Array.isArray(issue?.labels)
    ? issue.labels.map((label) => (typeof label === "string" ? label : label?.name))
    : null;
  const type = issue?.issueTypeName;
  const state = issue?.state;
  const createdAtMs = parseTimezoneInstant(issue?.created_at);
  const closedAtMs = issue?.closed_at === null ? null : parseTimezoneInstant(issue?.closed_at);
  const rawMilestone = issue?.milestone;
  let milestone = null;
  if (rawMilestone !== null) {
    if (
      !rawMilestone ||
      !isPositiveSafeInteger(rawMilestone.number) ||
      typeof rawMilestone.title !== "string" ||
      rawMilestone.title.length === 0 ||
      (rawMilestone.state !== "open" && rawMilestone.state !== "closed")
    ) {
      throw authorityError(
        "FORECAST_ISSUE_AUTHORITY_INVALID",
        `Issue #${issue?.number ?? "?"} has an invalid milestone.`,
      );
    }
    milestone = { number: rawMilestone.number, title: rawMilestone.title, state: rawMilestone.state };
  }
  const catalogMilestone = milestone ? catalogByNumber.get(milestone.number) : null;
  if (
    !isPositiveSafeInteger(issue?.number) ||
    (state !== "open" && state !== "closed") ||
    !(type === null || (typeof type === "string" && type.length > 0)) ||
    labels === null ||
    labels.some((label) => typeof label !== "string" || label.length === 0) ||
    new Set(labels).size !== labels.length ||
    createdAtMs === null ||
    createdAtMs > nowMs ||
    (state === "open" && issue.closed_at !== null) ||
    (state === "closed" && (closedAtMs === null || closedAtMs < createdAtMs || closedAtMs > nowMs)) ||
    (catalogMilestone && (catalogMilestone.title !== milestone.title || catalogMilestone.state !== milestone.state))
  ) {
    throw authorityError(
      "FORECAST_ISSUE_AUTHORITY_INVALID",
      `Issue #${issue?.number ?? "?"} has invalid forecast authority.`,
    );
  }
  const normalized = {
    number: issue.number,
    state,
    type,
    labels,
    milestone,
    created_at: issue.created_at,
    closed_at: issue.closed_at,
  };
  return { issue: normalized, eligible: type !== "Epic" && !labels.includes("status:tracking-only") };
}

export function evaluateForecastEstimator(closureDays14) {
  const closures14 = closureDays14.reduce((sum, day) => sum + day.count, 0);
  const closures7 = closureDays14.slice(-7).reduce((sum, day) => sum + day.count, 0);
  const activeDays = closureDays14.filter((day) => day.count > 0).length;
  const maxDaily = Math.max(0, ...closureDays14.map((day) => day.count));
  const diagnostics = [];
  if (closures14 < 14) diagnostics.push("FORECAST_SAMPLE_BELOW_14");
  if (activeDays < 7) diagnostics.push("FORECAST_ACTIVE_DAYS_BELOW_7");
  if (maxDaily * 4 > closures14) diagnostics.push("FORECAST_DAY_SHARE_ABOVE_25_PERCENT");
  if (Math.abs(2 * closures7 - closures14) * 4 > closures14) {
    diagnostics.push("FORECAST_7D_14D_RATE_DISAGREEMENT_ABOVE_25_PERCENT");
  }
  return {
    admissible: diagnostics.length === 0,
    diagnostics,
    closures7,
    closures14,
    activeDays,
    maxDaily,
    ratePerDay: diagnostics.length === 0 ? closures14 / FORECAST_WINDOW_DAYS : null,
  };
}

function ascendingUniquePositiveIntegers(value) {
  return (
    Array.isArray(value) &&
    value.every(isPositiveSafeInteger) &&
    value.every((number, index) => index === 0 || value[index - 1] < number)
  );
}

function utcDayStart(nowMs) {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function deriveForecastInputs({ catalog, normalizedIssues, nowMs }) {
  const todayUtcMs = utcDayStart(nowMs);
  const catalogByNumber = new Map(catalog.map((milestone) => [milestone.number, milestone]));
  const identitiesByMilestone = new Map(
    catalog.map((milestone) => [milestone.number, Object.fromEntries(FORECAST_IDENTITY_KEYS.map((key) => [key, []]))]),
  );
  const closureDays14 = Array.from({ length: FORECAST_WINDOW_DAYS }, (_, index) => ({
    date: new Date(todayUtcMs - (FORECAST_WINDOW_DAYS - index) * DAY_MS).toISOString().slice(0, 10),
    count: 0,
  }));

  for (const entry of normalizedIssues) {
    const issue = entry.issue;
    const catalogMilestone = issue.milestone ? catalogByNumber.get(issue.milestone.number) : null;
    if (!catalogMilestone) continue;
    const identityKey = `${issue.state}${entry.eligible ? "Eligible" : "Ineligible"}IssueNumbers`;
    identitiesByMilestone.get(catalogMilestone.number)[identityKey].push(issue.number);
    if (entry.eligible && issue.state === "closed") {
      const closedAtMs = Date.parse(issue.closed_at);
      const index = Math.floor((closedAtMs - (todayUtcMs - FORECAST_WINDOW_DAYS * DAY_MS)) / DAY_MS);
      if (index >= 0 && index < FORECAST_WINDOW_DAYS) closureDays14[index].count += 1;
    }
  }
  for (const identities of identitiesByMilestone.values()) {
    for (const key of FORECAST_IDENTITY_KEYS) identities[key].sort((left, right) => left - right);
  }

  const estimator = evaluateForecastEstimator(closureDays14);
  let cumulativeOpen = 0;
  const milestones = catalog.map((milestone) => {
    const identities = identitiesByMilestone.get(milestone.number);
    if (milestone.state === "closed") {
      return { ...milestone, cumulativeOpen: null, forecastDays: null, ...identities };
    }
    cumulativeOpen += identities.openEligibleIssueNumbers.length;
    const forecastDays =
      cumulativeOpen === 0 ? 0 : estimator.admissible ? Math.ceil(cumulativeOpen / estimator.ratePerDay) : null;
    return { ...milestone, cumulativeOpen, forecastDays, ...identities };
  });
  const record = {
    schemaVersion: FORECAST_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    windowDays: FORECAST_WINDOW_DAYS,
    closures7: estimator.closures7,
    closures14: estimator.closures14,
    closureDays14,
    milestones,
  };
  return { record, estimator };
}

function validateForecastRecord(record, nowMs) {
  if (!hasExactKeys(record, FORECAST_RECORD_KEYS) || record.schemaVersion !== FORECAST_SCHEMA_VERSION) return false;
  const generatedAtMs = parseTimezoneInstant(record.generatedAt);
  if (
    generatedAtMs === null ||
    new Date(generatedAtMs).toISOString() !== record.generatedAt ||
    generatedAtMs > nowMs ||
    record.windowDays !== FORECAST_WINDOW_DAYS ||
    !isNonNegativeSafeInteger(record.closures7) ||
    !isNonNegativeSafeInteger(record.closures14) ||
    !Array.isArray(record.closureDays14) ||
    record.closureDays14.length !== FORECAST_WINDOW_DAYS ||
    !Array.isArray(record.milestones)
  )
    return false;
  const priorTodayUtcMs = utcDayStart(generatedAtMs);
  for (let index = 0; index < record.closureDays14.length; index += 1) {
    const day = record.closureDays14[index];
    if (
      !hasExactKeys(day, ["date", "count"]) ||
      day.date !== new Date(priorTodayUtcMs - (FORECAST_WINDOW_DAYS - index) * DAY_MS).toISOString().slice(0, 10) ||
      !isNonNegativeSafeInteger(day.count)
    )
      return false;
  }
  const estimator = evaluateForecastEstimator(record.closureDays14);
  if (record.closures14 !== estimator.closures14 || record.closures7 !== estimator.closures7) return false;

  const allIdentities = new Set();
  const catalog = [];
  let previousNumber = 0;
  let cumulativeOpen = 0;
  for (const milestone of record.milestones) {
    if (
      !hasExactKeys(milestone, FORECAST_MILESTONE_KEYS) ||
      !isPositiveSafeInteger(milestone.number) ||
      milestone.number <= previousNumber ||
      typeof milestone.title !== "string" ||
      milestone.title.length === 0 ||
      (milestone.state !== "open" && milestone.state !== "closed") ||
      FORECAST_IDENTITY_KEYS.some((key) => !ascendingUniquePositiveIntegers(milestone[key]))
    )
      return false;
    previousNumber = milestone.number;
    catalog.push({ number: milestone.number, title: milestone.title, state: milestone.state });
    for (const key of FORECAST_IDENTITY_KEYS) {
      for (const number of milestone[key]) {
        if (allIdentities.has(number)) return false;
        allIdentities.add(number);
      }
    }
    if (milestone.state === "closed") {
      if (milestone.cumulativeOpen !== null || milestone.forecastDays !== null) return false;
    } else {
      cumulativeOpen += milestone.openEligibleIssueNumbers.length;
      const expectedForecast =
        cumulativeOpen === 0 ? 0 : estimator.admissible ? Math.ceil(cumulativeOpen / estimator.ratePerDay) : null;
      if (milestone.cumulativeOpen !== cumulativeOpen || milestone.forecastDays !== expectedForecast) return false;
    }
  }
  try {
    assertCatalogOrder(catalog);
  } catch {
    return false;
  }
  return true;
}

export function readPriorForecastRecord(body, nowMs) {
  const text = String(body ?? "");
  const starts = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf(FORECAST_RECORD_PREFIX, cursor);
    if (index === -1) break;
    starts.push(index);
    cursor = index + FORECAST_RECORD_PREFIX.length;
  }
  if (starts.length === 0) return { status: "absent", record: null };
  if (starts.length !== 1) return { status: "invalid", record: null };
  const jsonStart = starts[0] + FORECAST_RECORD_PREFIX.length;
  const end = text.indexOf(FORECAST_RECORD_SUFFIX, jsonStart);
  if (end === -1) return { status: "invalid", record: null };
  const encoded = text.slice(jsonStart, end);
  if (encoded.includes("-->")) return { status: "invalid", record: null };
  try {
    const record = JSON.parse(encoded);
    return validateForecastRecord(record, nowMs) ? { status: "valid", record } : { status: "invalid", record: null };
  } catch {
    return { status: "invalid", record: null };
  }
}

function identityMap(record) {
  const identities = new Map();
  for (const milestone of record.milestones) {
    for (const key of FORECAST_IDENTITY_KEYS) {
      const eligible = key.includes("Eligible");
      const state = key.startsWith("open") ? "open" : "closed";
      for (const number of milestone[key])
        identities.set(number, { number, state, eligible, milestoneNumber: milestone.number });
    }
  }
  return identities;
}

function currentCatalogMilestone(issue, currentByNumber) {
  return issue.milestone && currentByNumber.has(issue.milestone.number)
    ? currentByNumber.get(issue.milestone.number)
    : null;
}

export function classifyForecastDrift({ current, priorAuthority, normalizedIssues, nowMs }) {
  const currentRows = current.record.milestones.filter((milestone) => milestone.state === "open");
  const rowResults = new Map();
  let unavailableRows = 0;
  const alerts = [];
  let priorDiagnostic = null;
  let unobservableIdentityCount = 0;
  if (priorAuthority.status !== "valid") {
    priorDiagnostic =
      priorAuthority.status === "invalid" ? "FORECAST_PRIOR_RECORD_INVALID" : "FORECAST_PRIOR_RECORD_ABSENT";
    for (const row of currentRows) {
      if (row.cumulativeOpen === 0)
        rowResults.set(row.number, { driftCell: "—", driftDays: null, transitionClass: null });
      else {
        unavailableRows += 1;
        rowResults.set(row.number, { driftCell: "?", driftDays: null, transitionClass: null });
      }
    }
    return { rowResults, alerts, unavailableRows, unobservableIdentityCount, priorDiagnostic };
  }

  const prior = priorAuthority.record;
  const currentByNumber = new Map(current.record.milestones.map((milestone) => [milestone.number, milestone]));
  const priorByNumber = new Map(prior.milestones.map((milestone) => [milestone.number, milestone]));
  for (const priorMilestone of prior.milestones) {
    const currentMilestone = currentByNumber.get(priorMilestone.number);
    if (!currentMilestone || currentMilestone.title !== priorMilestone.title) {
      throw authorityError("MILESTONE_CATALOG_DRIFT", "A retained Wave/Mobile milestone changed title or disappeared.");
    }
  }
  const completionInputChanged = JSON.stringify(prior.closureDays14) !== JSON.stringify(current.record.closureDays14);
  const scopeThresholds = new Set();
  const unknownThresholds = new Map();
  const priorIdentities = identityMap(prior);
  const currentIssues = new Map(normalizedIssues.map((entry) => [entry.issue.number, entry]));

  for (const [number, priorIdentity] of priorIdentities) {
    const currentEntry = currentIssues.get(number);
    if (!currentEntry) {
      unknownThresholds.set(number, priorIdentity.milestoneNumber);
      continue;
    }
    const currentMilestone = currentCatalogMilestone(currentEntry.issue, currentByNumber);
    const priorThreshold = priorIdentity.milestoneNumber;
    const currentThreshold = currentMilestone?.number ?? null;
    if (
      priorIdentity.eligible !== currentEntry.eligible ||
      currentThreshold === null ||
      currentThreshold !== priorThreshold
    ) {
      scopeThresholds.add(priorThreshold);
      if (currentThreshold !== null) scopeThresholds.add(currentThreshold);
    }
  }
  for (const entry of normalizedIssues) {
    if (priorIdentities.has(entry.issue.number)) continue;
    const currentMilestone = currentCatalogMilestone(entry.issue, currentByNumber);
    if (!currentMilestone) continue;
    if (Date.parse(entry.issue.created_at) < Date.parse(prior.generatedAt)) {
      unknownThresholds.set(entry.issue.number, currentMilestone.number);
    } else if (entry.issue.state === "open") {
      scopeThresholds.add(currentMilestone.number);
    }
  }
  for (const priorMilestone of prior.milestones) {
    const currentMilestone = currentByNumber.get(priorMilestone.number);
    if (
      priorMilestone.state === "open" &&
      currentMilestone.state === "closed" &&
      priorMilestone.openEligibleIssueNumbers.length > 0
    )
      scopeThresholds.add(priorMilestone.number);
    if (
      priorMilestone.state === "closed" &&
      currentMilestone.state === "open" &&
      currentMilestone.openEligibleIssueNumbers.length > 0
    )
      scopeThresholds.add(currentMilestone.number);
  }
  const reachedUnknownIdentities = new Set();
  for (const row of currentRows) {
    if (row.cumulativeOpen === 0) {
      rowResults.set(row.number, { driftCell: "—", driftDays: null, transitionClass: null });
      continue;
    }
    const priorRow = priorByNumber.get(row.number);
    const reachedUnknown = [...unknownThresholds].filter(([, threshold]) => threshold <= row.number);
    if (reachedUnknown.length > 0) {
      reachedUnknown.forEach(([number]) => reachedUnknownIdentities.add(number));
      unavailableRows += 1;
      rowResults.set(row.number, { driftCell: "?", driftDays: null, transitionClass: null });
      continue;
    }
    if (!Number.isSafeInteger(priorRow?.forecastDays) || !Number.isSafeInteger(row.forecastDays)) {
      unavailableRows += 1;
      rowResults.set(row.number, { driftCell: "?", driftDays: null, transitionClass: null });
      continue;
    }
    const scopeChanged = [...scopeThresholds].some((threshold) => threshold <= row.number);
    const transitionClass = completionInputChanged
      ? scopeChanged
        ? "scope+completion"
        : "completion"
      : scopeChanged
        ? "scope"
        : "no-transition";
    const driftDays = row.forecastDays - priorRow.forecastDays;
    const sign = driftDays > 0 ? "+" : "";
    const driftCell = `${sign}${driftDays}d · ${transitionClass}`;
    rowResults.set(row.number, { driftCell, driftDays, transitionClass });
    if (Math.abs(driftDays) >= 7) alerts.push({ title: row.title, driftCell });
  }
  unobservableIdentityCount = reachedUnknownIdentities.size;
  return { rowResults, alerts, unavailableRows, unobservableIdentityCount, priorDiagnostic };
}

export function createForecastPresentation({ current, drift, nowMs }) {
  const rows = new Map();
  for (const milestone of current.record.milestones.filter((item) => item.state === "open")) {
    const forecastCell =
      milestone.cumulativeOpen === 0
        ? "—"
        : milestone.forecastDays === null
          ? "?"
          : new Date(nowMs + milestone.forecastDays * DAY_MS).toISOString().slice(0, 10);
    rows.set(milestone.title, {
      number: milestone.number,
      forecastCell,
      driftCell: drift.rowResults.get(milestone.number)?.driftCell ?? "?",
    });
  }
  const json = JSON.stringify(current.record).replaceAll("-->", "--\\u003e");
  return {
    ...drift,
    rows,
    estimator: current.estimator,
    retainedComment: `${FORECAST_RECORD_PREFIX}${json}${FORECAST_RECORD_SUFFIX}`,
  };
}

export class RoadmapIssueEnumerationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoadmapIssueEnumerationError";
    this.code = code;
  }
}

const WINDOW_AUTHORITY_VERSION = "roadmap-dispatch-window-authority/v1";
const WINDOW_AUTHORITY_MAX_PAGES = 100;
const WINDOW_AUTHORITY_MAX_ITEMS = 10_000;

function windowAuthorityError(code, message = code) {
  return new RoadmapIssueEnumerationError(code, message);
}

function hasOnlyKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function requiredString(value) {
  return typeof value === "string" && value.length > 0;
}

function validateWindowPage(page, code) {
  if (
    !hasOnlyKeys(page, ["totalCount", "pageInfo", "nodes"]) ||
    !isNonNegativeSafeInteger(page.totalCount) ||
    !Array.isArray(page.nodes) ||
    !hasOnlyKeys(page.pageInfo, ["hasNextPage", "endCursor"]) ||
    typeof page.pageInfo.hasNextPage !== "boolean" ||
    !(page.pageInfo.endCursor === null || requiredString(page.pageInfo.endCursor)) ||
    (page.pageInfo.hasNextPage && !requiredString(page.pageInfo.endCursor))
  ) {
    throw windowAuthorityError(code, "Roadmap pull-window authority returned an invalid connection page.");
  }
}

async function collectWindowConnection({ loadPage, firstPage = null, validateNode, identity, code }) {
  const nodes = [];
  const identities = new Set();
  const cursors = new Set();
  let expectedTotal = null;
  let after = null;
  let pageFromRoot = firstPage;
  let pages = 0;
  do {
    if (pages >= WINDOW_AUTHORITY_MAX_PAGES || nodes.length >= WINDOW_AUTHORITY_MAX_ITEMS) {
      throw windowAuthorityError("ROADMAP_DISPATCH_WINDOW_AUTHORITY_BOUNDED");
    }
    const page = pageFromRoot ?? (await loadPage(after));
    pageFromRoot = null;
    const nodesBeforePage = nodes.length;
    validateWindowPage(page, code);
    pages += 1;
    if (expectedTotal === null) expectedTotal = page.totalCount;
    if (expectedTotal > WINDOW_AUTHORITY_MAX_ITEMS) {
      throw windowAuthorityError("ROADMAP_DISPATCH_WINDOW_AUTHORITY_BOUNDED");
    }
    if (page.totalCount !== expectedTotal) {
      throw windowAuthorityError("ROADMAP_DISPATCH_WINDOW_AUTHORITY_TOTAL_CHANGED");
    }
    for (const node of page.nodes) {
      const valid = validateNode(node);
      if (!valid) throw windowAuthorityError("ROADMAP_DISPATCH_WINDOW_AUTHORITY_SCHEMA_INVALID");
      const key = identity(node);
      if (identities.has(key)) throw windowAuthorityError("ROADMAP_DISPATCH_WINDOW_AUTHORITY_DUPLICATE_IDENTITY");
      identities.add(key);
      nodes.push(node);
    }
    if (page.pageInfo.hasNextPage) {
      if (nodes.length === nodesBeforePage || nodes.length >= expectedTotal) {
        throw windowAuthorityError("ROADMAP_DISPATCH_WINDOW_AUTHORITY_COUNT_MISMATCH");
      }
      if (cursors.has(page.pageInfo.endCursor)) {
        throw windowAuthorityError("ROADMAP_DISPATCH_WINDOW_AUTHORITY_CURSOR_REPEATED");
      }
      cursors.add(page.pageInfo.endCursor);
      after = page.pageInfo.endCursor;
    } else {
      after = null;
    }
  } while (after !== null);
  if (expectedTotal === null || nodes.length !== expectedTotal) {
    throw windowAuthorityError("ROADMAP_DISPATCH_WINDOW_AUTHORITY_COUNT_MISMATCH");
  }
  return { totalCount: expectedTotal, nodes };
}

function validMilestone(node) {
  return (
    hasOnlyKeys(node, ["id", "number", "title", "state"]) &&
    requiredString(node.id) &&
    isPositiveSafeInteger(node.number) &&
    requiredString(node.title) &&
    node.state === "OPEN"
  );
}

function validLabel(node) {
  return hasOnlyKeys(node, ["id", "name"]) && requiredString(node.id) && requiredString(node.name);
}

function validBlockedBy(node) {
  return (
    hasOnlyKeys(node, ["id", "number", "state", "repository"]) &&
    requiredString(node.id) &&
    isPositiveSafeInteger(node.number) &&
    (node.state === "OPEN" || node.state === "CLOSED") &&
    hasOnlyKeys(node.repository, ["nameWithOwner"]) &&
    requiredString(node.repository.nameWithOwner)
  );
}

function validNullableIssueType(value) {
  return (
    value === null ||
    (hasOnlyKeys(value, ["id", "name", "isEnabled"]) &&
      requiredString(value.id) &&
      requiredString(value.name) &&
      typeof value.isEnabled === "boolean")
  );
}

function validNullableMilestone(value) {
  return (
    value === null ||
    (hasOnlyKeys(value, ["id", "number", "title", "state"]) &&
      requiredString(value.id) &&
      isPositiveSafeInteger(value.number) &&
      requiredString(value.title) &&
      (value.state === "OPEN" || value.state === "CLOSED"))
  );
}

function validWindowIssue(node) {
  const validBase =
    hasOnlyKeys(node, [
      "id",
      "number",
      "state",
      "issueType",
      "milestone",
      "issueDependenciesSummary",
      "labels",
      "blockedBy",
    ]) &&
    requiredString(node.id) &&
    isPositiveSafeInteger(node.number) &&
    node.state === "OPEN" &&
    validNullableIssueType(node.issueType) &&
    validNullableMilestone(node.milestone) &&
    hasOnlyKeys(node.issueDependenciesSummary, ["blockedBy", "totalBlockedBy"]) &&
    isNonNegativeSafeInteger(node.issueDependenciesSummary.blockedBy) &&
    isNonNegativeSafeInteger(node.issueDependenciesSummary.totalBlockedBy);
  if (!validBase) return false;
  return true;
}

function canonicalWindowAuthority({ milestones, issues }) {
  return {
    version: WINDOW_AUTHORITY_VERSION,
    milestones: {
      totalCount: milestones.totalCount,
      nodes: milestones.nodes
        .map((node) => ({ id: node.id, number: node.number, title: node.title, state: node.state }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
    issues: {
      totalCount: issues.totalCount,
      nodes: issues.nodes
        .map((issue) => ({
          id: issue.id,
          number: issue.number,
          state: issue.state,
          issueType:
            issue.issueType === null
              ? null
              : {
                  id: issue.issueType.id,
                  name: issue.issueType.name,
                  isEnabled: issue.issueType.isEnabled,
                },
          milestone:
            issue.milestone === null
              ? null
              : {
                  id: issue.milestone.id,
                  number: issue.milestone.number,
                  title: issue.milestone.title,
                  state: issue.milestone.state,
                },
          issueDependenciesSummary: {
            blockedBy: issue.issueDependenciesSummary.blockedBy,
            totalBlockedBy: issue.issueDependenciesSummary.totalBlockedBy,
          },
          labels: issue.labels,
          blockedBy: issue.blockedBy,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
}

function digestWindowAuthority(authority) {
  const serialized = JSON.stringify(authority);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export async function collectRoadmapWindowAuthority({ loadMilestones, loadIssues, loadLabels, loadBlockedBy }) {
  const milestones = await collectWindowConnection({
    loadPage: loadMilestones,
    validateNode: validMilestone,
    identity: (node) => node.id,
    code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_MILESTONE_PAGE_INVALID",
  });
  const roots = await collectWindowConnection({
    loadPage: loadIssues,
    validateNode: validWindowIssue,
    identity: (node) => node.id,
    code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_ISSUE_PAGE_INVALID",
  });
  const openMilestonesById = new Map(milestones.nodes.map((milestone) => [milestone.id, milestone]));
  const issues = [];
  for (const root of roots.nodes) {
    if (root.milestone?.state === "OPEN") {
      const known = openMilestonesById.get(root.milestone.id);
      if (
        !known ||
        known.number !== root.milestone.number ||
        known.title !== root.milestone.title ||
        known.state !== root.milestone.state
      ) {
        throw windowAuthorityError("ROADMAP_DISPATCH_WINDOW_AUTHORITY_MILESTONE_REFERENCE_INVALID");
      }
    }
    const labels = await collectWindowConnection({
      loadPage: (after) => loadLabels(root.id, after),
      firstPage: root.labels,
      validateNode: validLabel,
      identity: (node) => `${node.id}\0${node.name}`,
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_LABEL_PAGE_INVALID",
    });
    const blockedBy = await collectWindowConnection({
      loadPage: (after) => loadBlockedBy(root.id, after),
      firstPage: root.blockedBy,
      validateNode: validBlockedBy,
      identity: (node) => `${node.repository.nameWithOwner}\0${node.id}\0${node.number}`,
      code: "ROADMAP_DISPATCH_WINDOW_AUTHORITY_BLOCKED_BY_PAGE_INVALID",
    });
    issues.push({
      ...root,
      labels: {
        totalCount: labels.totalCount,
        nodes: labels.nodes.sort((left, right) =>
          `${left.id}\0${left.name}`.localeCompare(`${right.id}\0${right.name}`),
        ),
      },
      blockedBy: {
        totalCount: blockedBy.totalCount,
        nodes: blockedBy.nodes.sort((left, right) =>
          `${left.repository.nameWithOwner}\0${left.id}\0${left.number}`.localeCompare(
            `${right.repository.nameWithOwner}\0${right.id}\0${right.number}`,
          ),
        ),
      },
    });
  }
  const authority = canonicalWindowAuthority({ milestones, issues: { totalCount: roots.totalCount, nodes: issues } });
  return { authority, digest: digestWindowAuthority(authority) };
}

export async function stabilizeRoadmapWindowAuthority(collectAttempt) {
  const first = await collectAttempt();
  const second = await collectAttempt();
  if (first.digest === second.digest) return second;
  const third = await collectAttempt();
  if (second.digest === third.digest) return third;
  throw windowAuthorityError("ROADMAP_DISPATCH_WINDOW_AUTHORITY_UNSTABLE");
}

function authorityFacts(authority) {
  return {
    milestones: authority.milestones.nodes.map((milestone) => ({
      ...milestone,
      state: milestone.state.toLowerCase(),
    })),
    issues: authority.issues.nodes.map((issue) => ({
      id: issue.id,
      number: issue.number,
      state: issue.state.toLowerCase(),
      issueTypeName: issue.issueType?.name ?? null,
      issueTypeIsEnabled: issue.issueType?.isEnabled ?? null,
      milestone: issue.milestone && { ...issue.milestone, state: issue.milestone.state.toLowerCase() },
      labels: issue.labels.nodes,
      blockedBy: issue.blockedBy.nodes.map((node) => ({ ...node, state: node.state.toLowerCase() })),
    })),
  };
}

export function summarizePrioritizationHygiene(authority) {
  const facts = authorityFacts(authority);
  const selected = derivePullWindow(facts);
  const selectedByFamily = new Map(selected.map((milestone) => [seriesIdentity(milestone.title).family, milestone.id]));
  const noWindowFamilies = facts.milestones
    .map((milestone) => seriesIdentity(milestone.title)?.family)
    .filter((family) => family && !selectedByFamily.has(family));
  const candidates = [];
  for (const issue of facts.issues) {
    const series = seriesIdentity(issue.milestone?.title);
    if (!series || issue.milestone?.state !== "open") continue;
    const labels = issue.labels.map((label) => label.name);
    const priorityLabels = labels.filter((label) => label === "priority:p0" || label === "priority:p1");
    const input = {
      number: issue.number,
      state: issue.state,
      labels,
      issueTypeName: issue.issueTypeName,
      milestoneTitle: issue.milestone.title,
      blockedByCount: issue.blockedBy.filter((node) => node.state === "open").length,
      hasParent: false,
    };
    if (classifiedEpic(input) || priorityLabels.length !== 1) continue;
    const selectedMilestoneId = selectedByFamily.get(series.family);
    if (!selectedMilestoneId) {
      continue;
    }
    if (selectedMilestoneId !== issue.milestone.id) {
      candidates.push({ number: issue.number, priority: priorityLabels[0], milestone: issue.milestone.title });
    }
  }
  candidates.sort((left, right) => left.number - right.number);
  const byPriority = {
    p0: candidates.filter((candidate) => candidate.priority === "priority:p0"),
    p1: candidates.filter((candidate) => candidate.priority === "priority:p1"),
  };
  return { selected, candidates, byPriority, noWindowFamilies: [...new Set(noWindowFamilies)].sort() };
}

export function summarizeClassificationGapsFromAuthority(authority) {
  const facts = authorityFacts(authority);
  const rows = new Map();
  for (const milestone of facts.milestones) {
    if (!THROUGHPUT_TITLE.test(milestone.title)) continue;
    const numbers = [];
    for (const issue of facts.issues.filter((entry) => entry.milestone?.id === milestone.id)) {
      const input = {
        number: issue.number,
        state: issue.state,
        labels: issue.labels.map((label) => label.name),
        issueTypeName: issue.issueTypeName,
        milestoneTitle: issue.milestone.title,
        blockedByCount: issue.blockedBy.filter((node) => node.state === "open").length,
        hasParent: false,
      };
      if (classifiedEpic(input) || isTrackingOnly(input)) continue;
      if (!classified(input) || issue.issueTypeName === null || issue.issueTypeIsEnabled !== true)
        numbers.push(issue.number);
    }
    rows.set(
      milestone.title,
      numbers.sort((left, right) => left - right),
    );
  }
  return rows;
}

export function toBacklogInput(issue) {
  return {
    number: issue.number,
    state: typeof issue.state === "string" ? issue.state.toLowerCase() : issue.state,
    labels: Array.isArray(issue.labels) ? issue.labels.map((label) => label.name ?? label) : issue.labels,
    issueTypeName: Object.hasOwn(issue, "issueTypeName")
      ? issue.issueTypeName
      : (issue.type?.name ?? issue.issueType?.name ?? null),
    milestoneTitle: issue.milestone?.title ?? null,
    blockedByCount: issue.blockedByCount,
    hasParent: issue.hasParent,
  };
}

// Kept as a caller-facing compatibility seam; the decision itself lives in
// backlog-classify.mjs.
export function isEpic(issue) {
  return classifiedEpic(toBacklogInput(issue));
}

export async function collectRoadmapIssueFacts(loadPage) {
  const byNumber = new Map();
  const sourceNumbers = [];
  let after = null;
  let expectedTotal = null;
  let collectedCount = 0;
  let pages = 0;
  const seenCursors = new Set();

  do {
    if (pages >= WINDOW_AUTHORITY_MAX_PAGES || collectedCount >= WINDOW_AUTHORITY_MAX_ITEMS) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_ISSUE_COLLECTION_BOUNDED",
        "Repository issue enumeration exceeded its ceiling.",
      );
    }
    const page = await loadPage(after);
    if (
      !page ||
      !Number.isInteger(page.totalCount) ||
      page.totalCount < 0 ||
      !Array.isArray(page.nodes) ||
      typeof page.pageInfo?.hasNextPage !== "boolean"
    ) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_ISSUE_PAGE_INVALID",
        "Repository issue enumeration returned an invalid page.",
      );
    }
    pages += 1;
    if (expectedTotal === null) expectedTotal = page.totalCount;
    if (expectedTotal > WINDOW_AUTHORITY_MAX_ITEMS) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_ISSUE_COLLECTION_BOUNDED",
        "Repository issue total exceeded its ceiling.",
      );
    }
    if (page.totalCount !== expectedTotal) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_ISSUE_TOTAL_CHANGED",
        `Repository issue total changed during enumeration (${expectedTotal} -> ${page.totalCount}).`,
      );
    }

    for (const node of page.nodes) {
      if (
        !Object.hasOwn(node ?? {}, "number") ||
        !Object.hasOwn(node, "state") ||
        !Object.hasOwn(node, "issueType") ||
        !Object.hasOwn(node, "parent") ||
        !Object.hasOwn(node, "issueDependenciesSummary")
      ) {
        throw new RoadmapIssueEnumerationError(
          "ROADMAP_ISSUE_NODE_INVALID",
          "Repository issue enumeration returned an issue with missing classification facts.",
        );
      }
      collectedCount += 1;
      if (byNumber.has(node.number)) {
        throw new RoadmapIssueEnumerationError(
          "ROADMAP_ISSUE_IDENTITY_DUPLICATE",
          `Repository issue enumeration repeated #${node.number}.`,
        );
      }
      sourceNumbers.push(node.number);
      byNumber.set(node.number, {
        state: typeof node.state === "string" ? node.state.toLowerCase() : node.state,
        issueTypeName: node.issueType?.name ?? null,
        issueTypeIsEnabled:
          node.issueType === null
            ? null
            : typeof node.issueType?.isEnabled === "boolean"
              ? node.issueType.isEnabled
              : undefined,
        blockedByCount: node.issueDependenciesSummary?.blockedBy,
        hasParent: node.parent !== null,
      });
    }

    if (
      page.pageInfo.hasNextPage &&
      (typeof page.pageInfo.endCursor !== "string" ||
        page.pageInfo.endCursor.length === 0 ||
        page.pageInfo.endCursor.length > 1024)
    ) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_ISSUE_PAGINATION_INCOMPLETE",
        "Repository issue enumeration has another page but no end cursor.",
      );
    }
    if (page.pageInfo.hasNextPage && seenCursors.has(page.pageInfo.endCursor)) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_ISSUE_CURSOR_REPEATED",
        "Repository issue enumeration repeated a cursor.",
      );
    }
    if (page.pageInfo.hasNextPage) seenCursors.add(page.pageInfo.endCursor);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  if (expectedTotal === null || collectedCount !== expectedTotal) {
    throw new RoadmapIssueEnumerationError(
      "ROADMAP_ISSUE_COUNT_MISMATCH",
      `Repository issue enumeration collected ${collectedCount} rows but reported ${expectedTotal}.`,
    );
  }

  Object.defineProperty(byNumber, "sourceNumbers", { value: sourceNumbers, enumerable: false });
  return byNumber;
}

export function mergeRoadmapIssueFacts(issue, issueFacts) {
  if (!issueFacts) {
    throw new RoadmapIssueEnumerationError(
      "ROADMAP_ISSUE_FACT_MISSING",
      `Repository issue enumeration omitted #${issue.number}.`,
    );
  }
  return { ...issue, ...issueFacts };
}

function pct(part, total) {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}

function isExecutableMilestone(title) {
  return typeof title === "string" && title.length > 0 && !NON_EXECUTABLE_MILESTONES.has(title);
}

function isGrowthScopeIssue(issue) {
  const input = toBacklogInput(issue);
  return !classifiedEpic(input) && !isTrackingOnly(input) && isExecutableMilestone(input.milestoneTitle);
}

export function timelineFetchRequired(issue, cutoffMs) {
  if (!isGrowthScopeIssue(issue)) return false;
  const createdAtMs = Date.parse(issue.created_at);
  const updatedAtMs = Date.parse(issue.updated_at);
  return (
    Number.isFinite(createdAtMs) && Number.isFinite(updatedAtMs) && createdAtMs < cutoffMs && updatedAtMs >= cutoffMs
  );
}

export function selectTimelineIssues({ issues, nowMs, windowDays = 7 }) {
  const cutoffMs = nowMs - windowDays * DAY_MS;
  return issues.filter((issue) => timelineFetchRequired(issue, cutoffMs));
}

function knownEntry(enteredAtMs, source) {
  return { status: "known", enteredAtMs, source };
}

function unknownEntry(reason) {
  return { status: "unknown", reason };
}

export function resolveCurrentMilestoneEntry(issue, timeline) {
  const currentTitle = issue.milestone?.title;
  const milestoneEvents = timeline.filter((event) => MILESTONE_EVENTS.has(event?.event));
  const matchingEntries = milestoneEvents.filter(
    (event) => event.event === "milestoned" && event.milestone?.title === currentTitle,
  );

  if (matchingEntries.length > 0) {
    const timestamps = matchingEntries.map((event) => Date.parse(event.created_at));
    if (timestamps.some((timestamp) => !Number.isFinite(timestamp))) {
      return unknownEntry("matching milestone entry has an invalid timestamp");
    }
    return knownEntry(Math.max(...timestamps), "latest-milestoned-event");
  }

  if (milestoneEvents.length > 0) {
    return unknownEntry(`milestone history has no entry titled "${currentTitle}"`);
  }

  const createdAtMs = Date.parse(issue.created_at);
  return Number.isFinite(createdAtMs)
    ? knownEntry(createdAtMs, "created-at-with-zero-milestone-events")
    : unknownEntry("zero milestone events and an invalid issue creation timestamp");
}

async function mapConcurrent(items, concurrency, task) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}

export async function collectScopeGrowth({
  issues,
  nowMs,
  windowDays = 7,
  loadTimeline,
  concurrency = TIMELINE_CONCURRENCY,
}) {
  const cutoffMs = nowMs - windowDays * DAY_MS;
  const byIssue = new Map();
  const selectedIssues = selectTimelineIssues({ issues, nowMs, windowDays });
  const selectedNumbers = new Set(selectedIssues.map((issue) => issue.number));

  for (const issue of issues.filter(isGrowthScopeIssue)) {
    const createdAtMs = Date.parse(issue.created_at);
    const updatedAtMs = Date.parse(issue.updated_at);
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs)) {
      byIssue.set(issue.number, unknownEntry("issue creation or update timestamp is invalid"));
    } else if (createdAtMs >= cutoffMs) {
      // A current member created inside the window necessarily entered its
      // current scope inside the window, so D4 does not spend a timeline fetch.
      byIssue.set(issue.number, knownEntry(createdAtMs, "created-in-window"));
    } else if (!selectedNumbers.has(issue.number)) {
      // Milestone changes update the issue. An older updated_at proves that
      // this issue could not have entered its current scope inside the window.
      byIssue.set(issue.number, knownEntry(null, "not-updated-in-window"));
    }
  }

  if (selectedIssues.length > 0 && typeof loadTimeline !== "function") {
    throw new TypeError("loadTimeline is required when the D4 predicate selects an issue.");
  }

  await mapConcurrent(selectedIssues, concurrency, async (issue) => {
    const timeline = await loadTimeline(issue);
    if (!Array.isArray(timeline)) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_TIMELINE_INVALID",
        `Timeline for issue #${issue.number} did not return an array.`,
      );
    }
    byIssue.set(issue.number, resolveCurrentMilestoneEntry(issue, timeline));
  });

  return { byIssue, selectedIssues };
}

export function reconcileEpicChildren(epic, children) {
  const expectedTotal = epic.sub_issues_summary?.total;
  if (!isNonNegativeSafeInteger(expectedTotal) || expectedTotal > EPIC_SUB_ISSUE_CAPACITY) {
    throw new RoadmapIssueEnumerationError(
      "ROADMAP_EPIC_CHILD_TOTAL_INVALID",
      `Epic #${epic.number} has no valid sub_issues_summary.total.`,
    );
  }
  if (!Array.isArray(children) || children.some((child) => !isPositiveSafeInteger(child?.number))) {
    throw new RoadmapIssueEnumerationError(
      "ROADMAP_EPIC_CHILD_PAGE_INVALID",
      `Epic #${epic.number} returned an invalid sub-issue collection.`,
    );
  }

  const uniqueCount = new Set(children.map((child) => child.number)).size;
  if (children.length !== expectedTotal || uniqueCount !== expectedTotal) {
    throw new RoadmapIssueEnumerationError(
      "ROADMAP_EPIC_CHILD_COUNT_MISMATCH",
      `Epic #${epic.number} collected ${children.length} children (${uniqueCount} unique) but sub_issues_summary.total reported ${expectedTotal}.`,
    );
  }
  return children;
}

function classifyEpicCapacity(childCount) {
  if (childCount >= EPIC_SUB_ISSUE_CAPACITY) {
    return { state: "saturated", count: childCount };
  }
  if (childCount >= EPIC_SUB_ISSUE_WARNING_THRESHOLD) {
    return { state: "warning", count: childCount, remaining: EPIC_SUB_ISSUE_CAPACITY - childCount };
  }
  return { state: "normal", count: childCount };
}

export async function collectEpicChildren({ epics, loadChildren, concurrency = TIMELINE_CONCURRENCY }) {
  const byEpic = new Map();
  await mapConcurrent(epics, concurrency, async (epic) => {
    const children = reconcileEpicChildren(epic, await loadChildren(epic));
    byEpic.set(epic.number, {
      children: children.map((child) => ({ number: child.number, state: child.state, milestone: child.milestone })),
      capacity: classifyEpicCapacity(children.length),
    });
  });
  return byEpic;
}

/**
 * @param issues all repository issues (open and closed), excluding pull requests
 * @param epicChildren Map<epicNumber, {children: Array<{number, state, milestone}>, capacity: {state, count, remaining?}}>
 * @param scopeGrowthByIssue Map<issueNumber, known-or-unknown milestone entry>
 * @param nowMs timestamp used for the "added recently" window
 */
export function summarizeWaves({
  milestones,
  issues,
  epicChildren = new Map(),
  scopeGrowthByIssue,
  nowMs,
  windowDays = 7,
}) {
  if (!(scopeGrowthByIssue instanceof Map)) {
    throw new TypeError("scopeGrowthByIssue must be a Map produced by collectScopeGrowth.");
  }

  const entries = issues.map((issue) => ({ issue, input: toBacklogInput(issue) }));
  const slices = entries.filter(({ input }) => !classifiedEpic(input));
  const epics = entries.filter(({ input }) => classifiedEpic(input));
  const cutoff = nowMs - windowDays * DAY_MS;

  // An epic's wave is the earliest-dated wave among its children: epics are
  // unmilestoned by contract, so they have no wave of their own.
  const milestoneOrder = new Map(milestones.map((milestone, index) => [milestone.title, index]));
  const epicWave = new Map();
  for (const { issue: epic } of epics) {
    const children = epicChildren.get(epic.number)?.children ?? [];
    let best = null;
    for (const child of children) {
      const title = child.milestone?.title;
      if (!title || !milestoneOrder.has(title)) continue;
      if (best === null || milestoneOrder.get(title) < milestoneOrder.get(best)) best = title;
    }
    if (best) epicWave.set(epic.number, best);
  }

  const rows = milestones.map((milestone) => {
    const waveSlices = slices.filter(({ issue }) => issue.milestone?.title === milestone.title);
    const tracking = waveSlices.filter(({ input }) => isTrackingOnly(input));
    const mine = waveSlices.filter(({ input }) => !isTrackingOnly(input));
    const closed = mine.filter(({ input }) => input.state === "closed");
    const open = mine.filter(({ input }) => input.state === "open");
    const executable = isExecutableMilestone(milestone.title);
    let addedRecently = 0;
    let growthUnknown = 0;

    if (executable) {
      for (const { issue } of mine) {
        const entry = scopeGrowthByIssue.get(issue.number);
        if (!entry || entry.status !== "known") {
          growthUnknown += 1;
        } else if (entry.enteredAtMs !== null && entry.enteredAtMs >= cutoff) {
          addedRecently += 1;
        }
      }
    }

    const classifiedOpen = open.filter(({ input }) => classified(input));
    let classificationGapNumbers = [];
    let classificationGapsKnown = true;
    if (executable) {
      for (const { issue, input } of open) {
        try {
          if (classifiedEpic(input) || isTrackingOnly(input)) continue;
          if (typeof issue.issueTypeIsEnabled !== "boolean" && issue.issueTypeName !== null) {
            classificationGapsKnown = false;
            classificationGapNumbers = [];
            break;
          }
          if (!classified(input) || issue.issueTypeName === null || issue.issueTypeIsEnabled !== true) {
            classificationGapNumbers.push(issue.number);
          }
        } catch {
          classificationGapsKnown = false;
          classificationGapNumbers = [];
          break;
        }
      }
      classificationGapNumbers.sort((left, right) => left - right);
    }
    const waveEpics = epics.filter(({ issue: epic }) => epicWave.get(epic.number) === milestone.title);
    const completeEpics = waveEpics.filter(({ issue: epic }) => {
      const collection = epicChildren.get(epic.number);
      const children = collection?.children ?? [];
      if (collection?.capacity?.state === "saturated") return false;
      return children.length > 0 && children.every((child) => child.state === "closed");
    });
    const epicsBoundedUnknown = waveEpics.some(
      ({ issue: epic }) => epicChildren.get(epic.number)?.capacity?.state === "saturated",
    );

    return {
      title: milestone.title,
      dueOn: milestone.due_on ? milestone.due_on.slice(0, 10) : "—",
      executable,
      total: mine.length,
      closed: closed.length,
      open: open.length,
      percent: pct(closed.length, mine.length),
      addedRecently,
      growthUnknown,
      refinedOpen: classifiedOpen.length,
      classificationGapsKnown,
      classificationGapNumbers,
      parentlessClassified: classifiedOpen.filter(({ input }) => !input.hasParent).length,
      tracking: tracking.length,
      epicsTotal: waveEpics.length,
      epicsComplete: completeEpics.length,
      epicsBoundedUnknown,
    };
  });

  const epicCapacities = epics
    .map(({ issue: epic }) => ({ number: epic.number, ...(epicChildren.get(epic.number)?.capacity ?? {}) }))
    .filter(({ state }) => state === "warning" || state === "saturated")
    .sort((left, right) => left.number - right.number);

  return { rows, windowDays, epicCapacities };
}

export function renderRoadmapStatus(summary) {
  const forecast = summary.forecast ?? {
    rows: new Map(),
    estimator: evaluateForecastEstimator(
      Array.from({ length: FORECAST_WINDOW_DAYS }, (_, index) => ({ date: String(index), count: 0 })),
    ),
    alerts: [],
    unavailableRows: 0,
    unobservableIdentityCount: 0,
    priorDiagnostic: "FORECAST_PRIOR_RECORD_ABSENT",
    retainedComment: null,
  };
  const lines = [
    START_MARKER,
    "",
    "## Generated status",
    "",
    "Generated by `scripts/roadmap-status.mjs`. Do not edit by hand — edits are overwritten.",
    "Contract: [`docs/contributing/backlog-model.md`](../blob/main/docs/contributing/backlog-model.md).",
    "",
    FORECAST_TABLE_HEADER,
    FORECAST_TABLE_SEPARATOR,
  ];

  for (const row of summary.rows) {
    const label = row.executable ? row.title : `${row.title} _(not executable)_`;
    const refinedRatio = row.executable ? `${row.refinedOpen}/${row.open}` : "—";
    const parentless = row.executable ? String(row.parentlessClassified) : "—";
    const epics =
      row.epicsTotal === 0
        ? "—"
        : row.epicsBoundedUnknown
          ? `?/${row.epicsTotal}`
          : `${row.epicsComplete}/${row.epicsTotal}`;
    const growth = !row.executable
      ? "—"
      : row.growthUnknown > 0
        ? "?"
        : row.addedRecently > 0
          ? `+${row.addedRecently}`
          : "0";
    const forecastRow = forecast.rows.get(row.title);
    const forecastCell = forecastRow?.forecastCell ?? "—";
    const driftCell = forecastRow?.driftCell ?? "—";
    lines.push(
      `| ${label} | ${forecastCell} | ${driftCell} | ${row.total} | ${row.closed} (${row.percent}%) | ${row.open} | ${refinedRatio} | ${parentless} | ${row.tracking} | ${growth} | ${epics} |`,
    );
  }

  const estimatorLine = forecast.estimator.admissible
    ? `Forecast estimator: 14 completed UTC days; closures14=${forecast.estimator.closures14}; closures7=${forecast.estimator.closures7}; activeDays14=${forecast.estimator.activeDays}; maxDaily=${forecast.estimator.maxDaily}; maxSharePercent=${((forecast.estimator.maxDaily * 100) / forecast.estimator.closures14).toFixed(1)}%; ratePerDay=${forecast.estimator.ratePerDay.toFixed(2)}. Derived forecast, not commitment; milestone exit gates remain closure authority.`
    : `Forecast estimator: ? (${forecast.estimator.diagnostics.join(", ")}). Derived forecast, not commitment; milestone exit gates remain closure authority.`;
  const alertLine =
    forecast.alerts.length > 0
      ? `Drift alert (≥7d): ${forecast.alerts.map((alert) => `${alert.title}: ${alert.driftCell}`).join("; ")}.`
      : "Drift alert (≥7d): none.";
  lines.push(
    "",
    estimatorLine,
    "",
    alertLine,
    "",
    `Drift unavailable: **${forecast.unavailableRows} row(s)**; **${forecast.unobservableIdentityCount} unobservable identity transition(s)**.`,
  );
  if (forecast.priorDiagnostic) lines.push("", `Drift diagnostics: ${forecast.priorDiagnostic}.`);

  lines.push("", renderClassificationGapReport(summary.rows));

  const hygiene = summary.prioritizationHygiene;
  if (hygiene) {
    lines.push(
      "",
      "## Prioritization hygiene",
      "",
      `Pull window: ${hygiene.selected.length > 0 ? hygiene.selected.map((milestone) => milestone.title).join("; ") : "none"}.`,
      `Stale preemption/tie claims: **${hygiene.candidates.length} total** — **${hygiene.byPriority.p0.length} p0**, **${hygiene.byPriority.p1.length} p1**.`,
    );
    if (hygiene.candidates.length === 0) lines.push("none");
    else {
      for (const candidate of hygiene.candidates) {
        lines.push(`- #${candidate.number} ${candidate.priority} — ${candidate.milestone}`);
      }
    }
    if (hygiene.noWindowFamilies.length > 0) {
      lines.push(
        "",
        `Pull-window diagnostics: ${hygiene.noWindowFamilies.map((family) => `${family}: no runnable refined milestone`).join("; ")}.`,
      );
    }
  }

  const executable = summary.rows.filter((row) => row.executable);
  const totalOpen = executable.reduce((sum, row) => sum + row.open, 0);
  const totalRefined = executable.reduce((sum, row) => sum + row.refinedOpen, 0);
  const totalParentless = executable.reduce((sum, row) => sum + row.parentlessClassified, 0);
  const totalAdded = executable.reduce((sum, row) => sum + row.addedRecently, 0);
  const totalGrowthUnknown = executable.reduce((sum, row) => sum + row.growthUnknown, 0);
  const totalTracking = summary.rows.reduce((sum, row) => sum + row.tracking, 0);
  const growthSummary =
    totalGrowthUnknown > 0
      ? `scope growth is **?** (${totalGrowthUnknown} issue${totalGrowthUnknown === 1 ? " has" : "s have"} bounded-unknown entry history)`
      : `${totalAdded} entered current scope in the last ${summary.windowDays} days`;

  lines.push(
    "",
    `Executable backlog: **${totalOpen} open slices**, ${totalRefined} refined (${pct(totalRefined, totalOpen)}%), ${growthSummary}.`,
    "",
    `Parent attachment (reported, not gating): **${totalParentless} classified slices have no parent**. ` +
      `${totalTracking} tracking-only records are shown separately.`,
  );

  const refinedInventory = summary.refinedInventoryAuthority;
  if (refinedInventory) {
    const { record, currentRefined } = refinedInventory;
    lines.push(
      "",
      `Refined inventory: ${currentRefined} / cap ${record.cap} (authority ${record.month}; merged-PR window ${record.windowStart}..${record.windowEndExclusive})`,
    );
  }

  const epicCapacities = summary.epicCapacities ?? [];
  if (epicCapacities.length > 0) {
    lines.push("", "Epic sub-issue capacity:");
    for (const capacity of epicCapacities) {
      lines.push(
        capacity.state === "saturated"
          ? `#${capacity.number} 100/100 (saturated; child inventory bounded unknown)`
          : `#${capacity.number} ${capacity.count}/100 (${capacity.remaining} remaining)`,
      );
    }
  }

  lines.push("", "**Added (7d)** = entered current scope within the window.");

  const unknownRows = executable.filter((row) => row.growthUnknown > 0);
  if (unknownRows.length > 0) {
    lines.push(
      "",
      `Scope-growth diagnostics (bounded unknown): ${unknownRows
        .map((row) => `${row.title}: ${row.growthUnknown} issue${row.growthUnknown === 1 ? "" : "s"}`)
        .join("; ")}.`,
    );
  }

  lines.push(
    "",
    "**Refined ≡ classified** = open, non-Epic, executable milestone + `priority:*` + `area:*` + `kind:*`, excluding `status:tracking-only`. Unrefined far-horizon work is expected, not a defect.",
  );
  if (refinedInventory) lines.push("", renderRefinedInventoryCapMarker(refinedInventory.record));
  if (forecast.retainedComment) lines.push("", forecast.retainedComment, END_MARKER);
  else lines.push("", END_MARKER);

  return lines.join("\n");
}

export function renderClassificationGapReport(rows) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  const lines = ["## Classification gaps", ""];
  const waveRows = rows.filter(
    (row) => row?.executable === true && typeof row.title === "string" && THROUGHPUT_TITLE.test(row.title),
  );
  if (waveRows.length === 0) return `${lines.join("\n")}none`;
  for (const row of waveRows) {
    if (row.classificationGapsKnown !== true || !Array.isArray(row.classificationGapNumbers)) {
      lines.push(`- ${row.title}: **?** (bounded unknown; incomplete classification authority)`);
      continue;
    }
    const numbers = row.classificationGapNumbers;
    const suffix = numbers.length === 0 ? "none" : numbers.map((number) => `#${number}`).join(", ");
    lines.push(`- ${row.title}: **${numbers.length}** — ${suffix}`);
  }
  return lines.join("\n");
}

function countOccurrences(text, marker) {
  let count = 0;
  let cursor = 0;
  while (cursor <= text.length - marker.length) {
    const index = text.indexOf(marker, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + marker.length;
  }
  return count;
}

export function spliceIntoBody(body, block) {
  const text = String(body ?? "");
  if (countOccurrences(text, START_MARKER) !== 1 || countOccurrences(text, END_MARKER) !== 1) {
    return null;
  }
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER);
  if (end < start) return null;
  return `${text.slice(0, start)}${block}${text.slice(end + END_MARKER.length)}`;
}

async function gh(pathname, token, init = {}, request = globalThis.fetch) {
  const url = pathname.startsWith("http") ? pathname : `https://api.github.com${pathname}`;
  const response = await request(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${pathname} ${await response.text()}`);
  }
  return response;
}

function nextPageUrl(response) {
  const link = response.headers.get("link") ?? "";
  const next = link.split(",").find((part) => part.includes('rel="next"'));
  if (!next) return null;
  const value = next.slice(next.indexOf("<") + 1, next.indexOf(">"));
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RoadmapIssueEnumerationError("ROADMAP_PAGINATION_LINK_INVALID", `Invalid next-page link: ${value}`);
  }
  if (url.protocol !== "https:" || url.hostname !== "api.github.com") {
    throw new RoadmapIssueEnumerationError("ROADMAP_PAGINATION_LINK_INVALID", `Unsafe next-page link: ${value}`);
  }
  return url.href;
}

export async function paginate(pathname, token, request = globalThis.fetch) {
  const items = [];
  let url = pathname;
  while (url) {
    const response = await gh(url, token, {}, request);
    const page = await response.json();
    if (!Array.isArray(page)) {
      throw new RoadmapIssueEnumerationError(
        "ROADMAP_PAGINATION_PAGE_INVALID",
        `Paginated GitHub request did not return an array: ${url}`,
      );
    }
    items.push(...page);
    url = nextPageUrl(response);
  }
  return items;
}

const ISSUE_FACTS_QUERY = `
query($owner:String!, $name:String!, $after:String) {
  repository(owner:$owner, name:$name) {
    issues(first:100, after:$after, states:[OPEN,CLOSED]) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        state
        issueType { name isEnabled }
        parent { number }
        issueDependenciesSummary { blockedBy }
      }
    }
  }
}`;

const REFINED_INVENTORY_PRS_QUERY = `
# ${REFINED_INVENTORY_QUERY_SENTINEL}
query($query:String!, $after:String) {
  search(query:$query, type:ISSUE, first:100, after:$after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest { number mergedAt baseRefName }
    }
  }
}`;

const WINDOW_MILESTONES_QUERY = `
# WINDOW_MILESTONES_SENTINEL
query($owner:String!, $name:String!, $after:String) {
  repository(owner:$owner, name:$name) {
    milestones(first:100, after:$after, states:[OPEN]) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { id number title state }
    }
  }
}`;

const WINDOW_ISSUES_QUERY = `
# WINDOW_ISSUES_SENTINEL
query($owner:String!, $name:String!, $after:String) {
  repository(owner:$owner, name:$name) {
    issues(first:100, after:$after, states:[OPEN]) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        number
        state
        issueType { id name isEnabled }
        milestone { id number title state }
        issueDependenciesSummary { blockedBy totalBlockedBy }
        labels(first:100) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { id name }
        }
        blockedBy(first:100) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { id number state repository { nameWithOwner } }
        }
      }
    }
  }
}`;

const WINDOW_LABELS_QUERY = `
# WINDOW_LABELS_SENTINEL
query($id:ID!, $after:String) {
  node(id:$id) {
    ... on Issue {
      labels(first:100, after:$after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id name }
      }
    }
  }
}`;

const WINDOW_BLOCKED_BY_QUERY = `
# WINDOW_BLOCKED_BY_SENTINEL
query($id:ID!, $after:String) {
  node(id:$id) {
    ... on Issue {
      blockedBy(first:100, after:$after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id number state repository { nameWithOwner } }
      }
    }
  }
}`;

async function graphql(query, variables, token, request) {
  const response = await gh(
    "https://api.github.com/graphql",
    token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
    request,
  );
  const payload = await response.json();
  if (payload.errors) throw new Error(`GraphQL failed: ${JSON.stringify(payload.errors)}`);
  return payload.data;
}

async function collectLiveRoadmapWindowAuthority({ owner, name, token, request }) {
  const load = async (query, variables, path) => {
    const data = await graphql(query, variables, token, request);
    return path(data);
  };
  return stabilizeRoadmapWindowAuthority(() =>
    collectRoadmapWindowAuthority({
      loadMilestones: (after) =>
        load(WINDOW_MILESTONES_QUERY, { owner, name, after }, (data) => data.repository?.milestones),
      loadIssues: (after) => load(WINDOW_ISSUES_QUERY, { owner, name, after }, (data) => data.repository?.issues),
      loadLabels: (id, after) => load(WINDOW_LABELS_QUERY, { id, after }, (data) => data.node?.labels),
      loadBlockedBy: (id, after) => load(WINDOW_BLOCKED_BY_QUERY, { id, after }, (data) => data.node?.blockedBy),
    }),
  );
}

export async function collectLiveMonthlyRefinedInventory({ repository, token, request, nowMs = Date.now() }) {
  const window = deriveMonthlyRefinedInventoryWindow(nowMs, repository);
  const stabilized = await stabilizeMonthlyRefinedInventory(async () =>
    collectMonthlyRefinedInventory({
      window,
      loadPage: async (after, query) => {
        const data = await graphql(REFINED_INVENTORY_PRS_QUERY, { query, after }, token, request);
        return data.search;
      },
    }),
  );
  return { window, ...stabilized };
}

async function appendStepSummary(env, block) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const { appendFileSync } = await import("node:fs");
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${block}\n`);
}

export async function main({
  env = process.env,
  request = globalThis.fetch,
  nowMs = Date.now(),
  dryRun = false,
  outPath = null,
  writeOutput = (message) => console.log(message),
  writeError = (message) => console.error(message),
  appendSummary = appendStepSummary,
} = {}) {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const roadmapIssue = env.ROADMAP_ISSUE;
  if (!token) {
    writeError("ROADMAP_GITHUB_TOKEN_REQUIRED: GITHUB_TOKEN is required before provider or issue actions.");
    return 2;
  }
  if (!repo) {
    writeError("ROADMAP_ENV_REQUIRED: GITHUB_REPOSITORY is required.");
    return 2;
  }
  if (repo !== CANONICAL_REPOSITORY || (roadmapIssue && roadmapIssue !== CANONICAL_ROADMAP_ISSUE)) {
    writeError("ROADMAP_SOURCE_TARGET_INVALID: writer source and target must be chase-sets/chase-sets#4129.");
    return 2;
  }

  const openMilestones = await paginate(`/repos/${repo}/milestones?state=open&per_page=100`, token, request);
  const closedMilestones = await paginate(`/repos/${repo}/milestones?state=closed&per_page=100`, token, request);
  const milestones = openMilestones.slice().sort((a, b) => {
    if (!a.due_on) return 1;
    if (!b.due_on) return -1;
    return a.due_on.localeCompare(b.due_on);
  });
  const raw = await paginate(`/repos/${repo}/issues?state=all&per_page=100`, token, request);
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra) {
    throw new RoadmapIssueEnumerationError("ROADMAP_REPOSITORY_INVALID", `Invalid GITHUB_REPOSITORY: ${repo}`);
  }
  const issueFacts = await collectRoadmapIssueFacts(async (after) => {
    const data = await graphql(ISSUE_FACTS_QUERY, { owner, name, after }, token, request);
    return data.repository?.issues;
  });
  const restIssues = raw.filter((issue) => !issue.pull_request);
  reconcileForecastIssueSources(restIssues, issueFacts);
  const issues = restIssues.map((issue) => mergeRoadmapIssueFacts(issue, issueFacts.get(issue.number)));
  let currentRoadmap = null;
  let priorRefinedInventory = null;
  if (roadmapIssue) {
    currentRoadmap = await (await gh(`/repos/${repo}/issues/${roadmapIssue}`, token, {}, request)).json();
    priorRefinedInventory = reducePriorRefinedInventoryAuthority(currentRoadmap?.body ?? "", nowMs);
    if (["invalid", "future"].includes(priorRefinedInventory.status)) {
      writeError(
        `${priorRefinedInventory.code}: Issue #${roadmapIssue} refined-inventory authority is unsafe; leaving the body untouched.`,
      );
      return 1;
    }
  }

  const collectionSafeIssues = issues.filter((issue) => {
    try {
      isEpic(issue);
      return true;
    } catch {
      return false;
    }
  });
  const epics = collectionSafeIssues.filter(isEpic);
  const epicChildren = await collectEpicChildren({
    epics,
    loadChildren: (epic) => paginate(`/repos/${repo}/issues/${epic.number}/sub_issues?per_page=100`, token, request),
  });
  const scopeGrowth = await collectScopeGrowth({
    issues: collectionSafeIssues,
    nowMs,
    loadTimeline: (issue) => paginate(`/repos/${repo}/issues/${issue.number}/timeline?per_page=100`, token, request),
  });

  let catalog;
  let normalizedIssues;
  try {
    validateOpenMilestoneShapes(openMilestones);
    validateOpenMilestoneDueDates(openMilestones);
    catalog = buildForecastMilestoneCatalog(openMilestones, closedMilestones);
    const catalogByNumber = new Map(catalog.map((milestone) => [milestone.number, milestone]));
    normalizedIssues = issues.map((issue) => normalizeForecastIssue(issue, catalogByNumber, nowMs));
  } catch (error) {
    if (!(error instanceof RoadmapIssueEnumerationError)) throw error;
    writeError(`${error.code}: ${error.message}`);
    return 1;
  }
  const summary = summarizeWaves({
    milestones,
    issues,
    epicChildren,
    scopeGrowthByIssue: scopeGrowth.byIssue,
    nowMs,
  });
  const currentForecast = deriveForecastInputs({ catalog, normalizedIssues, nowMs });
  const priorAuthority = readPriorForecastRecord(currentRoadmap?.body ?? "", nowMs);
  let drift;
  try {
    drift = classifyForecastDrift({ current: currentForecast, priorAuthority, normalizedIssues, nowMs });
  } catch (error) {
    if (!(error instanceof RoadmapIssueEnumerationError)) throw error;
    writeError(`${error.code}: ${error.message}`);
    return 1;
  }
  let windowAuthority;
  try {
    windowAuthority = await collectLiveRoadmapWindowAuthority({ owner, name, token, request });
  } catch (error) {
    if (!(error instanceof RoadmapIssueEnumerationError)) throw error;
    writeError(`${error.code}: ${error.message}`);
    return 1;
  }
  summary.prioritizationHygiene = summarizePrioritizationHygiene(windowAuthority.authority);
  const authoritativeGaps = summarizeClassificationGapsFromAuthority(windowAuthority.authority);
  for (const row of summary.rows) {
    if (!row.executable || !THROUGHPUT_TITLE.test(row.title)) continue;
    const numbers = authoritativeGaps.get(row.title);
    row.classificationGapsKnown = Array.isArray(numbers);
    row.classificationGapNumbers = numbers ?? [];
  }
  summary.forecast = createForecastPresentation({ current: currentForecast, drift, nowMs });
  if (roadmapIssue) {
    let record = priorRefinedInventory.record;
    if (priorRefinedInventory.status !== "current") {
      try {
        const acquisition = await collectLiveMonthlyRefinedInventory({ repository: repo, token, request, nowMs });
        record = capRecordFromCollection(acquisition.collection, acquisition.window, nowMs);
      } catch (error) {
        if (!(error instanceof RoadmapIssueEnumerationError)) throw error;
        writeError(`${error.code}: ${error.message}`);
        return 1;
      }
    }
    let currentRefined = 0;
    try {
      currentRefined = issues.filter((issue) => classified(toBacklogInput(issue))).length;
    } catch (error) {
      writeError(`ROADMAP_REFINED_INVENTORY_CLASSIFICATION_INVALID: ${error.message}`);
      return 1;
    }
    summary.refinedInventoryAuthority = { record, currentRefined };
  }
  const block = renderRoadmapStatus(summary);
  writeOutput(block);
  await appendSummary(env, block);
  if (outPath) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outPath, `${block}\n`, "utf8");
  }

  if (roadmapIssue && !dryRun) {
    const next = spliceIntoBody(currentRoadmap.body, block);
    if (next === null) {
      writeError(
        `ROADMAP_MARKERS_INVALID: Issue #${roadmapIssue} must contain exactly one ordered roadmap-status marker pair; leaving the body untouched.`,
      );
      return 1;
    }
    if (next !== currentRoadmap.body) {
      await gh(
        `/repos/${repo}/issues/${roadmapIssue}`,
        token,
        {
          method: "PATCH",
          body: JSON.stringify({ body: next }),
        },
        request,
      );
    }
  }

  return 0;
}

export async function runRoadmapStatus(run = main, writeError = (message) => console.error(message)) {
  try {
    return await run();
  } catch (error) {
    writeError(`${error.code ?? error.name}: ${error.message}`);
    return 1;
  }
}

function optionValue(argv, name) {
  const equals = argv.find((value) => value.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function runCli(argv = process.argv.slice(2)) {
  try {
    if (argv.includes("--resolve-probe-job")) {
      if (argv.length !== 1) {
        console.error("ROADMAP_ARGUMENT_INVALID: --resolve-probe-job does not accept additional arguments.");
        return 2;
      }
      await resolveRefinedInventoryProbeJob();
      return 0;
    }
    if (argv.includes("--probe-authority")) {
      const outPath = optionValue(argv, "--out");
      if (!outPath || argv.length !== 3 || argv[0] !== "--probe-authority" || argv[1] !== "--out") {
        console.error("ROADMAP_ARGUMENT_INVALID: --probe-authority requires exactly one --out path.");
        return 2;
      }
      await produceRefinedInventoryProbe({ outPath });
      return 0;
    }
    if (argv.includes("--validate-probe-authority")) {
      const inputPath = optionValue(argv, "--input");
      if (!inputPath || argv.length !== 3 || argv[0] !== "--validate-probe-authority" || argv[1] !== "--input") {
        console.error("ROADMAP_ARGUMENT_INVALID: --validate-probe-authority requires exactly one --input path.");
        return 2;
      }
      readCanonicalRefinedInventoryProbe(inputPath);
      return 0;
    }

    let dryRun = false;
    let outPath = null;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === "--dry-run" && !dryRun) {
        dryRun = true;
        continue;
      }
      if (argv[index] === "--out" && outPath === null && argv[index + 1] && !argv[index + 1].startsWith("--")) {
        outPath = argv[index + 1];
        index += 1;
        continue;
      }
      console.error(`ROADMAP_ARGUMENT_INVALID: Unsupported or duplicate argument ${argv[index]}.`);
      return 2;
    }
    if (outPath !== null && !dryRun) {
      console.error("ROADMAP_ARGUMENT_INVALID: --out is available only with --dry-run.");
      return 2;
    }
    return await runRoadmapStatus(() => main({ dryRun, outPath }));
  } catch (error) {
    console.error(`${error.code ?? error.name}: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("roadmap-status.mjs")) {
  process.exitCode = await runCli();
}
