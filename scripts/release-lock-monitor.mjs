#!/usr/bin/env node
import { createHash } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { evaluateReleaseLock } from "./release-lock.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const RELEASE_LOCK_MONITOR_VERSION = "release-lock-monitor/v1";
export const RELEASE_LOCK_MONITOR_ISSUE_TITLE = "Production release lock incident (notify-production-deploy-incident)";
export const RELEASE_LOCK_MONITOR_IDENTITY_MARKER = "production-release-lock-identity";
export const RELEASE_LOCK_MONITOR_MAX_ISSUE_PAGES = 10;
export const RELEASE_LOCK_MONITOR_PAGE_SIZE = 100;

export function parseReleaseLockMonitorArgs(argv, env = process.env) {
  return {
    repository: readOption(argv, "--repository") ?? readEnv("GITHUB_REPOSITORY", env) ?? "",
    token: readOption(argv, "--token") ?? readEnv("GITHUB_TOKEN", env) ?? readEnv("GH_TOKEN", env) ?? "",
    apiUrl: readOption(argv, "--api-url") ?? readEnv("GITHUB_API_URL", env) ?? "https://api.github.com",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    lockValue: readOption(argv, "--locked") ?? env.PRODUCTION_RELEASE_LOCKED ?? "",
    reason: readOption(argv, "--reason") ?? env.PRODUCTION_RELEASE_LOCK_REASON ?? "",
    reference: readOption(argv, "--reference") ?? env.PRODUCTION_RELEASE_LOCK_REFERENCE ?? "",
    exitRoute: readOption(argv, "--exit-route") ?? env.PRODUCTION_RELEASE_LOCK_EXIT_ROUTE ?? "",
    deadline: readOption(argv, "--deadline") ?? env.PRODUCTION_RELEASE_LOCK_DEADLINE ?? "",
    runId: readOption(argv, "--run-id") ?? readEnv("GITHUB_RUN_ID", env) ?? "",
    runAttempt: readOption(argv, "--run-attempt") ?? readEnv("GITHUB_RUN_ATTEMPT", env) ?? "1",
    jobUrl: readOption(argv, "--job-url") ?? readEnv("GITHUB_JOB_URL", env) ?? "",
    checkRunId: readEnv("GITHUB_CHECK_RUN_ID", env) ?? "",
    outPath: readOption(argv, "--out") ?? "",
    hostTarget:
      readOption(argv, "--host-target") ?? readEnv("PRODUCTION_RELEASE_LOCK_HOST_TARGET", env) ?? "host/orchestrator",
    fetchImpl: globalThis.fetch,
  };
}

export function buildLockIdentity({ lockValue = "", reason = "", reference = "", exitRoute = "", deadline = "" }) {
  const tuple = [String(lockValue), String(reason), String(reference), String(exitRoute), String(deadline)];
  return {
    tuple,
    identity: createHash("sha256").update(JSON.stringify(tuple)).digest("hex"),
  };
}

export function evaluateLockMonitorDecision(options) {
  const identity = buildLockIdentity(options);
  const boolean = String(options.lockValue).trim().toLowerCase();
  if (!["true", "false"].includes(boolean))
    throw new Error("PRODUCTION_RELEASE_LOCKED is unknown: expected true or false.");
  if (boolean === "false") {
    return {
      schemaVersion: RELEASE_LOCK_MONITOR_VERSION,
      ...identity,
      state: "unlocked",
      shouldNotify: false,
      reason: null,
      reference: null,
      route: null,
      deadline: null,
    };
  }

  if (!Number.isFinite(Date.parse(options.checkedAt)))
    throw new Error("Monitor checkedAt must be a valid UTC observation.");
  const evaluated = evaluateReleaseLock({
    releaseLocked: "true",
    lockReason: options.reason,
    lockReference: options.reference,
    lockExitRoute: options.exitRoute,
    lockDeadline: options.deadline,
    checkedAt: options.checkedAt,
    emergencyBypass: "false",
  });
  const errors = evaluated.errors ?? [];

  return {
    ...identity,
    schemaVersion: RELEASE_LOCK_MONITOR_VERSION,
    state: evaluated.lockState,
    shouldNotify: errors.length > 0,
    errors,
    route: evaluated.lockExitRoute,
    deadline: evaluated.lockDeadline,
    overdue: evaluated.lockDeadlineOverdue,
  };
}

export async function monitorReleaseLock(options, dependencies = {}) {
  if (options.repository !== "chase-sets/chase-sets")
    throw new Error("GITHUB_REPOSITORY must be chase-sets/chase-sets.");
  if (!isNonEmptyString(options.token)) throw new Error("GITHUB_TOKEN is required.");
  const decision = {
    ...evaluateLockMonitorDecision(options),
    checkedAt: options.checkedAt,
    runId: options.runId,
    runAttempt: options.runAttempt,
    jobUrl: options.jobUrl,
    checkRunId: options.checkRunId,
    runUrl: buildRunUrl(options),
  };
  if (!decision.shouldNotify) return { ...decision, issue: null };

  const fetchImpl = dependencies.fetch ?? options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable for GitHub lock monitor delivery.");
  const client = createGitHubClient({ ...options, fetchImpl });
  const issues = await listMatchingIssues(client, options.repository);
  const marker = `${RELEASE_LOCK_MONITOR_IDENTITY_MARKER}:${decision.identity}`;
  const matches = issues.filter((issue) => issue.body.includes(`<!-- ${marker} -->`));
  if (matches.length > 1)
    throw new Error("Production release lock identity has multiple matching issues; host triage required.");
  const existing = matches[0];
  const body = buildIncidentBody(options, decision, marker);
  let issue;
  if (existing) {
    issue = existing;
    if (existing.state !== "open") {
      issue = await client.request(`/repos/${options.repository}/issues/${existing.number}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "open" }),
      });
    }
  } else {
    issue = await client.request(`/repos/${options.repository}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: RELEASE_LOCK_MONITOR_ISSUE_TITLE,
        body,
        labels: ["kind:ops", "area:infrastructure"],
      }),
    });
  }
  if (
    !Number.isInteger(issue.number) ||
    typeof issue.html_url !== "string" ||
    issue.state !== "open" ||
    !(Number.isInteger(issue.id) || typeof issue.node_id === "string")
  ) {
    throw new Error(
      "GitHub lock incident delivery returned no open issue receipt; verify the identity marker before retry.",
    );
  }
  return {
    ...decision,
    issue: { number: issue.number, id: issue.id ?? issue.node_id ?? null, url: issue.html_url, state: issue.state },
  };
}

export function buildIncidentBody(
  options,
  decision,
  marker = `${RELEASE_LOCK_MONITOR_IDENTITY_MARKER}:${decision.identity}`,
) {
  const route = options.exitRoute || "invalid/unavailable";
  const runUrl = buildRunUrl(options);
  return [
    `<!-- ${marker} -->`,
    `Event: notify-production-deploy-incident`,
    `Production release lock requires host escalation (${decision.state}).`,
    `Reason: ${options.reason || "missing"}`,
    `Reference: ${options.reference || "missing"}`,
    `Exit route: ${route}`,
    `Deadline: ${decision.deadline ?? (options.deadline || "missing")}`,
    `Observed UTC: ${options.checkedAt}`,
    `Age/status: ${decision.overdue ? `${Math.floor((Date.parse(options.checkedAt) - Date.parse(decision.deadline)) / 1000)} seconds past deadline` : decision.state}`,
    `Safe failure: no unlock, bypass, deployment, or production mutation was attempted.`,
    `Host target: ${options.hostTarget}`,
    `Run: ${runUrl || "unavailable"}`,
    `Job: ${options.jobUrl || "unavailable"}`,
    `Attempt: ${options.runAttempt || "1"}`,
    decision.errors?.length ? `Validation: ${decision.errors.join("; ")}` : "Validation: deadline escalation",
  ].join("\n");
}

async function listMatchingIssues(client, repository) {
  const issues = [];
  let totalCount;
  const seen = new Set();
  for (let page = 1; page <= RELEASE_LOCK_MONITOR_MAX_ISSUE_PAGES; page += 1) {
    const values = await client.request(
      `/search/issues?q=${encodeURIComponent(`repo:${repository} is:issue "Production release lock" in:title`)}&per_page=${RELEASE_LOCK_MONITOR_PAGE_SIZE}&page=${page}`,
    );
    if (
      !Number.isInteger(values.total_count) ||
      values.total_count > 1000 ||
      values.incomplete_results !== false ||
      !Array.isArray(values.items)
    ) {
      throw new Error("Production release lock issue lookup is incomplete or unknown; refusing blind creation.");
    }
    totalCount ??= values.total_count;
    if (totalCount !== values.total_count)
      throw new Error("Production release lock issue lookup changed during pagination.");
    const pageItems = values.items;
    if (pageItems.some((issue) => !Number.isInteger(issue.number) || !["open", "closed"].includes(issue.state))) {
      throw new Error("Production release lock issue lookup contains invalid issue metadata.");
    }
    const normalizedPageItems = pageItems.map((issue) => ({
      ...issue,
      body: typeof issue.body === "string" ? issue.body : "",
    }));
    for (const issue of normalizedPageItems) {
      if (seen.has(issue.number))
        throw new Error("Production release lock issue lookup repeated an issue during pagination.");
      seen.add(issue.number);
    }
    issues.push(...normalizedPageItems);
    if (issues.length === values.total_count) return issues;
    if (pageItems.length < RELEASE_LOCK_MONITOR_PAGE_SIZE)
      throw new Error("Production release lock issue lookup is truncated.");
  }
  throw new Error(`Production release lock issue lookup exceeded ${RELEASE_LOCK_MONITOR_MAX_ISSUE_PAGES} pages.`);
}

function createGitHubClient({ apiUrl = "https://api.github.com", token, fetchImpl }) {
  const base = String(apiUrl).replace(/\/+$/, "");
  return {
    async request(path, init = {}) {
      const response = await fetchImpl(`${base}${path}`, {
        signal: AbortSignal.timeout(30_000),
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          ...(init.headers ?? {}),
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`GitHub lock monitor request failed with status ${response.status}.`);
      return payload;
    },
  };
}

function buildRunUrl(options) {
  return isNonEmptyString(options.repository) && isNonEmptyString(options.runId)
    ? `https://github.com/${options.repository}/actions/runs/${options.runId}/attempts/${options.runAttempt || "1"}`
    : "";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function main(argv, env = process.env) {
  const options = parseReleaseLockMonitorArgs(argv, env);
  try {
    const result = await monitorReleaseLock(options);
    if (options.outPath) await writeJsonRecord(options.outPath, result);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.outPath)
      await writeJsonRecord(options.outPath, {
        schemaVersion: RELEASE_LOCK_MONITOR_VERSION,
        ...buildLockIdentity(options),
        checkedAt: options.checkedAt,
        runId: options.runId,
        runAttempt: options.runAttempt,
        checkRunId: options.checkRunId,
        jobUrl: options.jobUrl,
        delivery: "failed",
        error: message,
      });
    console.error(`Production release lock monitor delivery failed; lock remains closed. ${message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await main(process.argv.slice(2));
