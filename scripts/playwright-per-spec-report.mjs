#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXPECTED_STATUSES = new Set(["passed", "failed", "timedOut", "skipped", "interrupted"]);
const RESULT_STATUSES = new Set(["passed", "failed", "timedOut", "skipped", "interrupted"]);
const TEST_OUTCOMES = new Set(["skipped", "expected", "unexpected", "flaky"]);

const REPORT_KEYS = new Set(["suites"]);
const SUITE_KEYS = new Set(["title", "specs", "suites"]);
const SPEC_KEYS = new Set(["title", "tests"]);
const TEST_KEYS = new Set(["expectedStatus", "projectName", "results", "status"]);
const RESULT_KEYS = new Set(["retry", "status"]);

/**
 * Projects Playwright 1.60's JSON reporter output into the deliberately small,
 * closed playwright-per-spec-flake/v1 artifact contract.
 */
export function normalizePlaywrightPerSpecReport(report) {
  if (!isRecord(report) || !Array.isArray(report.suites)) {
    throw new Error("Playwright JSON reporter output must contain a suites array.");
  }
  return validatePlaywrightPerSpecReport({ suites: report.suites.map(normalizeSuite) });
}

export function validatePlaywrightPerSpecReport(report) {
  requireClosedRecord(report, REPORT_KEYS, "Playwright per-spec report");
  if (!Array.isArray(report.suites)) throw new Error("Playwright per-spec report suites must be an array.");
  for (const suite of report.suites) validateSuite(suite);
  return report;
}

export function classifyPlaywrightTest(test) {
  validateTest(test);
  if (test.results.length === 0) return null;
  const terminal = test.results.at(-1);

  // Playwright deliberately excludes interrupted attempts from its aggregate
  // outcome calculation, so retain the more specific operational signal here.
  if (terminal.status === "interrupted") return "interrupted";

  if (test.status === "skipped") return "skipped";
  if (test.status === "unexpected") return terminal.status === "timedOut" ? "timedOut" : "failed";

  if (test.status === "expected") {
    if (test.expectedStatus === "passed") return "passed";
    if (test.expectedStatus === "skipped") return "skipped";
    return "expected";
  }

  // A flaky test must finish with an expected attempt; Playwright stops after
  // that recovery. Reject fabricated histories that merely reproduce the
  // aggregate label while putting an unexpected result last.
  if (terminal.status !== test.expectedStatus) {
    throw new Error("Playwright flaky outcome must finish with the expected status.");
  }
  if (test.expectedStatus === "passed") return "passed";
  if (test.expectedStatus === "skipped") return "skipped";
  return "expected";
}

function normalizeSuite(suite) {
  if (!isRecord(suite) || typeof suite.title !== "string" || !Array.isArray(suite.specs)) {
    throw new Error("Playwright JSON reporter suite is malformed.");
  }
  if (suite.suites !== undefined && !Array.isArray(suite.suites)) {
    throw new Error("Playwright JSON reporter child suites are malformed.");
  }
  return {
    title: suite.title,
    specs: suite.specs.map(normalizeSpec),
    suites: (suite.suites ?? []).map(normalizeSuite),
  };
}

function normalizeSpec(spec) {
  if (!isRecord(spec) || typeof spec.title !== "string" || !Array.isArray(spec.tests)) {
    throw new Error("Playwright JSON reporter spec is malformed.");
  }
  return { title: spec.title, tests: spec.tests.map(normalizeTest) };
}

function normalizeTest(test) {
  if (
    !isRecord(test) ||
    !EXPECTED_STATUSES.has(test.expectedStatus) ||
    !TEST_OUTCOMES.has(test.status) ||
    typeof test.projectName !== "string" ||
    !Array.isArray(test.results)
  ) {
    throw new Error("Playwright JSON reporter test is malformed.");
  }
  const normalized = {
    expectedStatus: test.expectedStatus,
    projectName: test.projectName,
    results: test.results.map((result) => {
      if (
        !isRecord(result) ||
        !Number.isInteger(result.retry) ||
        result.retry < 0 ||
        !RESULT_STATUSES.has(result.status)
      ) {
        throw new Error("Playwright JSON reporter result is malformed.");
      }
      return { retry: result.retry, status: result.status };
    }),
    status: test.status,
  };
  validateTest(normalized);
  return normalized;
}

function validateSuite(suite) {
  requireClosedRecord(suite, SUITE_KEYS, "Playwright per-spec suite");
  if (typeof suite.title !== "string" || !Array.isArray(suite.specs) || !Array.isArray(suite.suites)) {
    throw new Error("Playwright per-spec suite is malformed.");
  }
  for (const spec of suite.specs) validateSpec(spec);
  for (const child of suite.suites) validateSuite(child);
}

function validateSpec(spec) {
  requireClosedRecord(spec, SPEC_KEYS, "Playwright per-spec spec");
  if (typeof spec.title !== "string" || !Array.isArray(spec.tests)) {
    throw new Error("Playwright per-spec spec is malformed.");
  }
  for (const test of spec.tests) validateTest(test);
}

function validateTest(test) {
  requireClosedRecord(test, TEST_KEYS, "Playwright per-spec test");
  if (
    !EXPECTED_STATUSES.has(test.expectedStatus) ||
    !TEST_OUTCOMES.has(test.status) ||
    typeof test.projectName !== "string" ||
    !Array.isArray(test.results)
  ) {
    throw new Error("Playwright per-spec test is malformed.");
  }
  for (const [index, result] of test.results.entries()) {
    requireClosedRecord(result, RESULT_KEYS, "Playwright per-spec result");
    if (!Number.isInteger(result.retry) || result.retry !== index || !RESULT_STATUSES.has(result.status)) {
      throw new Error("Playwright per-spec result is malformed.");
    }
  }
  const computed = computePlaywrightOutcome(test.expectedStatus, test.results);
  if (test.status !== computed) {
    throw new Error(`Playwright test outcome ${test.status} does not match its result history (${computed}).`);
  }
}

function computePlaywrightOutcome(expectedStatus, results) {
  let skipped = 0;
  let expected = 0;
  let unexpected = 0;
  for (const result of results) {
    if (result.status === "interrupted") continue;
    if (result.status === "skipped" && expectedStatus === "skipped") skipped += 1;
    else if (result.status === "skipped") continue;
    else if (result.status === expectedStatus) expected += 1;
    else unexpected += 1;
  }
  if (expected === 0 && unexpected === 0) return "skipped";
  if (unexpected === 0) return "expected";
  if (expected === 0 && skipped === 0) return "unexpected";
  return "flaky";
}

function requireClosedRecord(value, allowedKeys, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const keys = Object.keys(value);
  if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} has missing or unknown fields.`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main(argv) {
  if (argv.length !== 2) {
    console.error("Usage: node scripts/playwright-per-spec-report.mjs <input-json> <output-json>");
    return 2;
  }
  try {
    const report = normalizePlaywrightPerSpecReport(JSON.parse(await readFile(argv[0], "utf8")));
    await mkdir(dirname(argv[1]), { recursive: true });
    await writeFile(argv[1], `${JSON.stringify(report)}\n`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
