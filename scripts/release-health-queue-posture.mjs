#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const RELEASE_HEALTH_QUEUE_POSTURE_VERSION = "release-health-queue-posture/v1";

// Single source of truth for the expected GitHub native merge queue posture on
// `main`. These values mirror the policy table in
// docs/runbooks/release-process-evolution.md, "Required GitHub native merge
// queue settings for `main`", which the release process treats as canonical.
// This is a read-only posture check: it never mutates repository ruleset state.
export const MERGE_QUEUE_POLICY = Object.freeze({
  mergeQueue: Object.freeze({
    // Maximum pull requests to build = 2.
    max_entries_to_build: 2,
    // Maximum pull requests to merge = 2.
    max_entries_to_merge: 2,
    // Merge method SQUASH.
    merge_method: "SQUASH",
    // Grouping strategy ALLGREEN.
    grouping_strategy: "ALLGREEN",
    // Minimum pull requests to merge = 1.
    min_entries_to_merge: 1,
    // Wait 0 (minimum entries wait time in minutes).
    min_entries_to_merge_wait_minutes: 0,
    // Check response timeout 60 minutes.
    check_response_timeout_minutes: 60,
  }),
  // Required status check context on merge groups and pull request heads.
  requiredCheck: "PR Required",
});

// Human-readable labels keep drift reports legible without leaking the raw
// GitHub parameter grammar to operators.
const MERGE_QUEUE_PARAMETER_LABELS = Object.freeze({
  max_entries_to_build: "maximum pull requests to build",
  max_entries_to_merge: "maximum pull requests to merge",
  merge_method: "merge method",
  grouping_strategy: "grouping strategy",
  min_entries_to_merge: "minimum pull requests to merge",
  min_entries_to_merge_wait_minutes: "merge wait minutes",
  check_response_timeout_minutes: "check response timeout minutes",
});

const REQUIRED_CHECK_PARAMETER = "required_status_check";

export function parseQueuePostureArgs(argv, env = process.env) {
  return {
    repository: readOption(argv, "--repository") ?? readEnv("GITHUB_REPOSITORY", env) ?? "chase-sets/chase-sets",
    branch: readOption(argv, "--branch") ?? readEnv("MERGE_QUEUE_BRANCH", env) ?? "main",
    token: readOption(argv, "--token") ?? readEnv("GH_TOKEN", env) ?? readEnv("GITHUB_TOKEN", env),
    outPath: readOption(argv, "--out") ?? readEnv("RELEASE_HEALTH_QUEUE_POSTURE_OUT", env),
    format: readOption(argv, "--format") ?? "text",
  };
}

/**
 * Compare the live branch rules returned by
 * `GET /repos/{owner}/{repo}/rules/branches/{branch}` with the documented merge
 * queue policy. Pure and side-effect free: it reports drift and never mutates
 * GitHub state.
 */
export function evaluateMergeQueuePosture(branchRules, policy = MERGE_QUEUE_POLICY) {
  const rules = Array.isArray(branchRules) ? branchRules : [];
  const mergeQueueRule = rules.find((rule) => rule?.type === "merge_queue") ?? null;
  const requiredChecksRule = rules.find((rule) => rule?.type === "required_status_checks") ?? null;
  const liveParameters = mergeQueueRule?.parameters ?? null;

  const checks = [];

  for (const [parameter, expected] of Object.entries(policy.mergeQueue)) {
    const present = liveParameters !== null && Object.hasOwn(liveParameters, parameter);
    const actual = present ? liveParameters[parameter] : null;
    checks.push({
      parameter,
      label: MERGE_QUEUE_PARAMETER_LABELS[parameter] ?? parameter,
      expected,
      actual,
      present,
      drifted: !present || actual !== expected,
    });
  }

  const liveCheckContexts = extractRequiredCheckContexts(requiredChecksRule);
  const requiredCheckPresent = liveCheckContexts.includes(policy.requiredCheck);
  checks.push({
    parameter: REQUIRED_CHECK_PARAMETER,
    label: "required status check",
    expected: policy.requiredCheck,
    actual: requiredCheckPresent ? policy.requiredCheck : liveCheckContexts.length > 0 ? liveCheckContexts : null,
    present: requiredChecksRule !== null,
    drifted: !requiredCheckPresent,
  });

  const driftedChecks = checks.filter((check) => check.drifted);
  const drifted = driftedChecks.length > 0;

  return {
    schemaVersion: RELEASE_HEALTH_QUEUE_POSTURE_VERSION,
    drifted,
    mergeQueueRulePresent: mergeQueueRule !== null,
    requiredChecksRulePresent: requiredChecksRule !== null,
    driftedParameters: driftedChecks.map((check) => check.parameter),
    checks,
    summary: summarizePosture(drifted, driftedChecks),
  };
}

export async function collectMergeQueuePosture(options, dependencies = {}) {
  if (!options.repository) {
    throw new Error("GITHUB_REPOSITORY or --repository is required.");
  }

  const request = createGitHubRequest({
    repository: options.repository,
    token: options.token,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
  });

  const branch = options.branch ?? "main";
  const branchRules = await request(`/rules/branches/${encodeURIComponent(branch)}?per_page=100`);

  return {
    repository: options.repository,
    branch,
    checkedAt: options.checkedAt ?? new Date().toISOString(),
    ...evaluateMergeQueuePosture(branchRules),
  };
}

export function formatQueuePostureText(report) {
  const header = report.drifted
    ? `Merge queue ruleset DRIFT detected on ${report.repository ?? "repository"}#${report.branch ?? "main"}.`
    : `Merge queue ruleset posture matches policy on ${report.repository ?? "repository"}#${report.branch ?? "main"}.`;
  const lines = report.checks.map((check) => {
    const status = check.drifted ? "DRIFT" : "ok";
    const actual = check.present ? formatValue(check.actual) : "missing";
    return `  [${status}] ${check.label} (${check.parameter}): expected ${formatValue(check.expected)}, live ${actual}`;
  });
  return [header, ...lines].join("\n");
}

function summarizePosture(drifted, driftedChecks) {
  if (!drifted) {
    return "Live merge queue ruleset matches the documented policy.";
  }
  const details = driftedChecks
    .map((check) => `${check.parameter}=${formatValue(check.actual)} (expected ${formatValue(check.expected)})`)
    .join(", ");
  return `Merge queue ruleset drift: ${details}.`;
}

function extractRequiredCheckContexts(requiredChecksRule) {
  const entries = requiredChecksRule?.parameters?.required_status_checks;
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .map((entry) => (typeof entry === "string" ? entry : entry?.context))
    .filter((context) => Boolean(context));
}

function formatValue(value) {
  if (value === null || value === undefined) {
    return "none";
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "none";
  }
  return String(value);
}

function createGitHubRequest({ repository, token, fetchImpl }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }
  return async (path) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API request failed for ${path}: ${response.status}`);
    }
    return response.json();
  };
}

async function main(argv, env = process.env) {
  try {
    const options = parseQueuePostureArgs(argv, env);
    const report = await collectMergeQueuePosture(options);
    if (options.outPath) {
      await writeJsonRecord(options.outPath, report);
    }
    if (options.format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(`${formatQueuePostureText(report)}\n`);
    }
    // Read-only posture check: report drift with a non-zero exit code so
    // operators and CI notice, but never mutate GitHub ruleset state.
    return report.drifted ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
