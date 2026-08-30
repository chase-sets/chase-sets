#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { parseCircuitMarker } from "./release-health-merge-group-failure-signatures.mjs";

export const RELEASE_HEALTH_FLAKE_DIGEST_VERSION = "release-health-flake-digest/v1";
export const CI_FLAKE_DIGEST_MARKER_VERSION = "ci-flake-digest-breach/v1";
export const CI_FLAKE_DIGEST_DISPOSITION_VERSION = "ci-flake-digest-legacy-disposition/v1";
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_RETRY_THRESHOLD = 3;
export const DEFAULT_FLAKY_FAILURE_THRESHOLD = 1;

const API_BASE_URL = "https://api.github.com";
const WORKFLOW_FILE = "platform-ci-flake-digest.yml";
const CANONICAL_ISSUE_NUMBER = 7442;
const CANONICAL_ISSUE_NODE_ID = "I_kwDORKgVcc8AAAABOB_AcQ";
const CANONICAL_ISSUE_TITLE = "CI flake digest aggregate signal";
const LEGACY_CANONICAL_TITLE = "CI flake digest breach: 2026-08-17 to 2026-08-24";
const LEGACY_CANONICAL_BODY_SHA256 = "e989dc35c239232f5238c93f386ba725932d54d014cea52d9420b04a8b6135ab";
const ACTIONS_RESULT_CAP = 1_000;
const PAGE_SIZE = 100;
const MAX_SHARD_DEPTH = 32;
const LEGACY_ISSUES = Object.freeze([
  { number: 5815, nodeId: "I_kwDORKgVcc8AAAABJeck5g" },
  { number: 6215, nodeId: "I_kwDORKgVcc8AAAABKXIaoA" },
  { number: 6504, nodeId: "I_kwDORKgVcc8AAAABLSRIeQ" },
  { number: 6715, nodeId: "I_kwDORKgVcc8AAAABMLGzwQ" },
  { number: CANONICAL_ISSUE_NUMBER, nodeId: CANONICAL_ISSUE_NODE_ID },
]);

export function parseReleaseHealthFlakeDigestArgs(argv, env = process.env) {
  return {
    repository: readOption(argv, "--repository") ?? readEnv("GITHUB_REPOSITORY", env),
    token: readOption(argv, "--token") ?? readEnv("GH_TOKEN", env) ?? readEnv("GITHUB_TOKEN", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    windowDays: positiveInteger(readOption(argv, "--window-days"), DEFAULT_WINDOW_DAYS),
    retryThreshold: positiveInteger(readOption(argv, "--retry-threshold"), DEFAULT_RETRY_THRESHOLD),
    flakyFailureThreshold: positiveInteger(
      readOption(argv, "--flaky-failure-threshold"),
      DEFAULT_FLAKY_FAILURE_THRESHOLD,
    ),
    outPath: readOption(argv, "--out") ?? readEnv("RELEASE_HEALTH_FLAKE_DIGEST_OUT", env),
    markdownOutPath: readOption(argv, "--markdown-out") ?? readEnv("RELEASE_HEALTH_FLAKE_DIGEST_MARKDOWN_OUT", env),
    issueBodyOutPath:
      readOption(argv, "--issue-body-out") ?? readEnv("RELEASE_HEALTH_FLAKE_DIGEST_ISSUE_BODY_OUT", env),
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env),
    validatePayloads: parseBoolean(readOption(argv, "--validate-payloads") ?? "false"),
    publishIssues: parseBoolean(readOption(argv, "--publish-issues") ?? "false"),
    artifactId: readOption(argv, "--artifact-id") ?? readEnv("FLAKE_DIGEST_ARTIFACT_ID", env),
    artifactDigest: readOption(argv, "--artifact-digest") ?? readEnv("FLAKE_DIGEST_ARTIFACT_DIGEST", env),
    artifactProducerOutcome:
      readOption(argv, "--artifact-producer-outcome") ?? readEnv("FLAKE_DIGEST_ARTIFACT_PRODUCER_OUTCOME", env),
    producerWorkflow: readOption(argv, "--producer-workflow") ?? readEnv("FLAKE_DIGEST_PRODUCER_WORKFLOW", env),
    producerJob: readOption(argv, "--producer-job") ?? readEnv("FLAKE_DIGEST_PRODUCER_JOB", env),
    producerStep: readOption(argv, "--producer-step") ?? readEnv("FLAKE_DIGEST_PRODUCER_STEP", env),
    runId: readOption(argv, "--run-id") ?? readEnv("GITHUB_RUN_ID", env),
    runAttempt: positiveInteger(readOption(argv, "--run-attempt") ?? readEnv("GITHUB_RUN_ATTEMPT", env), 0),
    headSha: readOption(argv, "--head-sha") ?? readEnv("GITHUB_SHA", env),
    fetchImpl: globalThis.fetch,
  };
}

export async function collectReleaseHealthFlakeDigest(options) {
  validateCollectorOptions(options);
  const windows = buildDigestWindows(options.checkedAt, options.windowDays);
  const sources = await Promise.all([
    collectSource("actions-current", () => fetchWorkflowRunsForWindow(options, windows.current)),
    collectSource("actions-previous", () => fetchWorkflowRunsForWindow(options, windows.previous)),
    collectSource("delivery-signatures", () => fetchDeliverySignatureFlakes(options, windows.current)),
  ]);
  const [currentSource, previousSource, signatureSource] = sources;
  const reasons = sources.flatMap((source) =>
    source.status === "complete" ? [] : source.reasons.map((reason) => `${source.source}:${reason}`),
  );
  return buildFlakeDigest({
    checkedAt: options.checkedAt,
    repository: options.repository,
    windows,
    thresholds: { retryCount: options.retryThreshold, flakyFailureCount: options.flakyFailureThreshold },
    currentRuns: currentSource.values,
    previousRuns: previousSource.values,
    signatureFlakes: signatureSource.values,
    collection: {
      status: reasons.length === 0 ? "complete" : "unknown",
      reasons,
      sources: Object.fromEntries(sources.map((source) => [source.source, source.authority])),
    },
  });
}

export function buildDigestWindows(checkedAt, windowDays = DEFAULT_WINDOW_DAYS) {
  const end = new Date(checkedAt);
  if (Number.isNaN(end.getTime())) throw new Error("checkedAt must be an ISO date.");
  const windowMs = Math.max(1, Math.floor(windowDays)) * 24 * 60 * 60 * 1000;
  const currentStart = new Date(end.getTime() - windowMs);
  const previousStart = new Date(currentStart.getTime() - windowMs);
  return {
    current: { start: currentStart.toISOString(), end: end.toISOString() },
    previous: { start: previousStart.toISOString(), end: currentStart.toISOString() },
  };
}

export function buildFlakeDigest(input) {
  const current = summarizeWorkflowRuns(input.currentRuns);
  const previous = summarizeWorkflowRuns(input.previousRuns);
  const jobs = [...new Set([...current.jobs.keys(), ...previous.jobs.keys()])]
    .map((name) => {
      const currentJob = current.jobs.get(name) ?? emptyJob(name);
      const previousJob = previous.jobs.get(name) ?? emptyJob(name);
      const breached =
        currentJob.retryCount >= input.thresholds.retryCount ||
        currentJob.flakyFailureCount >= input.thresholds.flakyFailureCount;
      return {
        name,
        retryCount: currentJob.retryCount,
        flakyFailureCount: currentJob.flakyFailureCount,
        previousRetryCount: previousJob.retryCount,
        previousFlakyFailureCount: previousJob.flakyFailureCount,
        retryTrend: currentJob.retryCount - previousJob.retryCount,
        flakyFailureTrend: currentJob.flakyFailureCount - previousJob.flakyFailureCount,
        breached,
      };
    })
    .filter((job) => job.retryCount > 0 || job.previousRetryCount > 0)
    .sort(
      (a, b) =>
        Number(b.breached) - Number(a.breached) ||
        b.retryCount + b.flakyFailureCount - (a.retryCount + a.flakyFailureCount) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 10);
  const collection = input.collection ?? { status: "complete", reasons: [], sources: {} };
  const breaches = jobs.filter((job) => job.breached);
  const classification = collection.status === "complete" ? (breaches.length > 0 ? "breaching" : "clear") : "unknown";
  const digest = {
    schemaVersion: RELEASE_HEALTH_FLAKE_DIGEST_VERSION,
    checkedAt: input.checkedAt,
    repository: input.repository,
    window: input.windows,
    thresholds: input.thresholds,
    collection,
    classification,
    retryCount: current.retryCount,
    flakyFailureCount: current.flakyFailureCount,
    previousRetryCount: previous.retryCount,
    previousFlakyFailureCount: previous.flakyFailureCount,
    breachCount: breaches.length,
    topFlakyJobs: jobs,
    signatureFlakeCount: (input.signatureFlakes ?? []).length,
    deliverySignatureFlakes: input.signatureFlakes ?? [],
    issueTitle: CANONICAL_ISSUE_TITLE,
  };
  const markdown = renderFlakeDigestMarkdown(digest);
  const withMarkdown = { ...digest, markdown };
  return { ...withMarkdown, issueBody: renderFlakeDigestIssueBody(withMarkdown) };
}

export function summarizeWorkflowRuns(runs) {
  const jobs = new Map();
  let retryCount = 0;
  let flakyFailureCount = 0;
  for (const run of runs ?? []) {
    const attempts = positiveInteger(run?.run_attempt, 0);
    const retries = Math.max(0, attempts - 1);
    if (retries === 0) continue;
    const name = typeof run?.name === "string" && run.name.trim() ? run.name.trim() : "unknown";
    const previous = jobs.get(name) ?? emptyJob(name);
    previous.retryCount += retries;
    retryCount += retries;
    if (run?.conclusion === "success") {
      previous.flakyFailureCount += retries;
      flakyFailureCount += retries;
    }
    jobs.set(name, previous);
  }
  return { jobs, retryCount, flakyFailureCount };
}

export function renderFlakeDigestMarkdown(digest) {
  const lines = [
    "## CI flake digest",
    "",
    `Window: ${digest.window.current.start} to ${digest.window.current.end}.`,
    `Collection: ${digest.collection?.status ?? "complete"}.`,
  ];
  if (digest.collection?.status === "unknown") {
    lines.push(
      `Bounded reasons: ${(digest.collection.reasons ?? []).join(", ") || "completeness-not-proven"}.`,
      "No breach lifecycle decision is authorized from this artifact.",
      "",
    );
  }
  lines.push(
    `Retries: ${digest.retryCount} (${formatSignedDelta(digest.retryCount - digest.previousRetryCount)} vs previous window). Flaky successful retries: ${digest.flakyFailureCount} (${formatSignedDelta(digest.flakyFailureCount - digest.previousFlakyFailureCount)}).`,
    `Thresholds: job retries >= ${digest.thresholds.retryCount}; job flaky successful retries >= ${digest.thresholds.flakyFailureCount}.`,
    `Delivery signature retry-pass evidence: ${digest.signatureFlakeCount ?? 0}.`,
    "",
  );
  if (digest.topFlakyJobs.length === 0) {
    lines.push("Clean: no retried workflow runs in the current or previous window.");
    return lines.join("\n");
  }
  lines.push("| Job | Retries | Trend | Flaky successful retries | Trend | Breach |");
  lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
  for (const job of digest.topFlakyJobs) {
    lines.push(
      `| ${escapeMarkdownCell(job.name)} | ${job.retryCount} | ${formatSignedDelta(job.retryTrend)} | ${job.flakyFailureCount} | ${formatSignedDelta(job.flakyFailureTrend)} | ${job.breached ? "yes" : "no"} |`,
    );
  }
  if (digest.collection?.status === "unknown") {
    lines.push("", "Unknown: the partial observations above do not authorize issue mutation.");
  } else if (digest.breachCount > 0) {
    lines.push("", "### Actionable work item", "", `Update canonical signal: #${CANONICAL_ISSUE_NUMBER}`);
  } else {
    lines.push("", "Clean: no job crossed the configured flake threshold.");
  }
  return lines.join("\n");
}

export function renderFlakeDigestIssueBody(digest) {
  return [
    "## CI flake digest aggregate",
    "",
    `State: **${digest.classification}**.`,
    "",
    digest.markdown,
    "",
    "## Follow-up policy",
    "",
    "- Identify whether the top breached job should be fixed immediately or quarantined out of the blocking lane.",
    "- Link the fixing PR or the quarantine decision back to this issue.",
    "- This signal closes only after a later complete digest is clear; unknown evidence never changes issue state.",
    "",
    "Generated by `.github/workflows/platform-ci-flake-digest.yml` from GitHub Actions retry telemetry.",
    "",
    "Part of #4024 and epic #4016.",
  ].join("\n");
}

export function summarizeDeliverySignatureFlakes(issues, window) {
  return (issues ?? [])
    .map((issue) => ({ issue, record: parseCircuitMarker(issue?.body) }))
    .filter(({ record }) => {
      const recovered = Date.parse(record?.recoveredAt);
      return (
        record?.state === "recovered" &&
        /retry-pass/i.test(record?.recoveryReason ?? "") &&
        Number.isFinite(recovered) &&
        recovered >= Date.parse(window.start) &&
        recovered <= Date.parse(window.end)
      );
    })
    .map(({ issue, record }) => ({
      issueNumber: issue.number,
      signature: record.signature,
      lane: record.lane,
      job: record.job,
      recoveredAt: record.recoveredAt,
      recoveryReason: record.recoveryReason,
    }));
}

export async function writeReleaseHealthFlakeDigest(options) {
  const digest = await collectReleaseHealthFlakeDigest(options);
  if (options.outPath) await writeJson(options.outPath, digest);
  if (options.markdownOutPath) await writeText(options.markdownOutPath, `${digest.markdown}\n`);
  if (options.issueBodyOutPath) await writeText(options.issueBodyOutPath, `${digest.issueBody}\n`);
  if (options.githubOutputPath) {
    await writeText(
      options.githubOutputPath,
      [
        `breach_count=${digest.breachCount}`,
        `classification=${digest.classification}`,
        `collection_status=${digest.collection.status}`,
        "",
      ].join("\n"),
      { append: true },
    );
  }
  return digest;
}

async function fetchWorkflowRunsForWindow(options, window) {
  const root = await collectActionsShard(options, window, 0);
  if (root.status !== "complete") {
    const collected = uniqueByIdentity(root.values, "actions-run");
    return {
      ...root,
      values: collected.values,
      authority: {
        window,
        ...root.authority,
        uniqueCollectedCount: collected.values.length,
        sourceRunIds: collected.values.map((run) => String(run.id)).sort(numericStringCompare),
      },
    };
  }
  const unique = uniqueByIdentity(root.values, "actions-run");
  if (unique.error) return unknownSource(unique.error, root.authority, unique.values);
  const malformed = unique.values.find((run) => !validActionRun(run, window));
  if (malformed) {
    return unknownSource(`actions-run-malformed-or-outside-window:${malformed.id}`, root.authority, unique.values);
  }
  if (unique.values.length !== root.authority.reportedTotal) {
    return unknownSource(
      `union-count-mismatch:${unique.values.length}/${root.authority.reportedTotal}`,
      { ...root.authority, uniqueCollectedCount: unique.values.length },
      unique.values,
    );
  }
  return {
    status: "complete",
    reasons: [],
    values: unique.values,
    authority: {
      ...root.authority,
      uniqueCollectedCount: unique.values.length,
      sourceRunIds: unique.values.map((run) => String(run.id)).sort(numericStringCompare),
      status: "complete",
    },
  };
}

async function collectActionsShard(options, window, depth) {
  const firstUrl = actionsRunsUrl(options.repository, window, 1);
  const first = await fetchJsonResponse(options, firstUrl, "workflow-runs");
  if (first.status !== "complete") return first;
  const payload = first.payload;
  if (!Number.isInteger(payload?.total_count) || payload.total_count < 0 || !Array.isArray(payload.workflow_runs)) {
    return unknownSource("payload-missing-completeness", shardAuthority(window, null, 1));
  }
  const reportedTotal = payload.total_count;
  if (reportedTotal > ACTIONS_RESULT_CAP) {
    const rootSample = uniqueByIdentity(payload.workflow_runs, "actions-run");
    if (rootSample.error) return unknownSource(rootSample.error, shardAuthority(window, reportedTotal, 1));
    const startMs = Date.parse(window.start);
    const endMs = Date.parse(window.end);
    if (depth >= MAX_SHARD_DEPTH || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs - startMs <= 1) {
      return unknownSource("provider-cap-unsplittable", shardAuthority(window, reportedTotal, 1));
    }
    const midpoint = new Date(startMs + Math.floor((endMs - startMs) / 2)).toISOString();
    const children = await Promise.all([
      collectActionsShard(options, { start: window.start, end: midpoint }, depth + 1),
      collectActionsShard(options, { start: midpoint, end: window.end }, depth + 1),
    ]);
    const failed = children.find((child) => child.status !== "complete");
    const authority = {
      window,
      reportedTotal,
      pageCount: 1 + children.reduce((sum, child) => sum + (child.authority?.pageCount ?? 0), 0),
      capHit: true,
      shards: children.flatMap((child) => child.authority?.shards ?? [child.authority]).filter(Boolean),
    };
    const childValues = children.flatMap((child) => child.values ?? []);
    if (failed) return unknownSource(failed.reasons[0] ?? "shard-incomplete", authority, childValues);
    const merged = uniqueByIdentity(childValues, "actions-run");
    if (merged.error) return unknownSource(merged.error, authority, merged.values);
    const mergedById = new Map(merged.values.map((run) => [String(run.id), run]));
    const movedSample = rootSample.values.find(
      (run) => JSON.stringify(mergedById.get(String(run.id))) !== JSON.stringify(run),
    );
    if (movedSample) {
      return unknownSource(`moving-snapshot-sample:${movedSample.id}`, authority, merged.values);
    }
    if (merged.values.length !== reportedTotal) {
      return unknownSource(`moving-snapshot:${merged.values.length}/${reportedTotal}`, authority, merged.values);
    }
    return { status: "complete", reasons: [], values: merged.values, authority };
  }
  return collectActionsLeaf(options, window, first, reportedTotal);
}

async function collectActionsLeaf(options, window, first, reportedTotal) {
  const values = [];
  let result = first;
  let page = 1;
  while (true) {
    const payload = result.payload;
    if (
      !Number.isInteger(payload?.total_count) ||
      payload.total_count !== reportedTotal ||
      !Array.isArray(payload.workflow_runs)
    ) {
      return unknownSource("moving-or-malformed-page", shardAuthority(window, reportedTotal, page), values);
    }
    values.push(...payload.workflow_runs);
    const unique = uniqueByIdentity(values, "actions-run");
    if (unique.error) return unknownSource(unique.error, shardAuthority(window, reportedTotal, page), unique.values);
    const malformed = unique.values.find((run) => !validActionRun(run, window));
    if (malformed) {
      return unknownSource(
        `actions-run-malformed-or-outside-shard:${malformed.id}`,
        shardAuthority(window, reportedTotal, page),
        unique.values,
      );
    }
    const repositoryIds = [
      ...new Set(unique.values.map((run) => run?.repository?.id).filter((id) => Number.isInteger(id) && id > 0)),
    ];
    if (repositoryIds.length > 1) {
      return unknownSource(
        "actions-run-repository-conflict",
        shardAuthority(window, reportedTotal, page),
        unique.values,
      );
    }
    const canonicalPath = repositoryIds.length === 1 ? `/repositories/${repositoryIds[0]}/actions/runs` : null;
    const next = safeNextLink(result.response, actionsRunsUrl(options.repository, window, page), page, canonicalPath);
    if (next.error) return unknownSource(next.error, shardAuthority(window, reportedTotal, page), unique.values);
    if (unique.values.length >= reportedTotal) {
      if (next.url)
        return unknownSource("unexpected-next-link", shardAuthority(window, reportedTotal, page), unique.values);
      if (unique.values.length !== reportedTotal) {
        return unknownSource(
          `count-mismatch:${unique.values.length}/${reportedTotal}`,
          shardAuthority(window, reportedTotal, page),
          unique.values,
        );
      }
      const leaf = { ...shardAuthority(window, reportedTotal, page), uniqueCollectedCount: unique.values.length };
      return {
        status: "complete",
        reasons: [],
        values: unique.values,
        authority: { ...leaf, status: "complete", shards: [leaf] },
      };
    }
    if (!next.url) {
      return unknownSource(
        `missing-next-link:${unique.values.length}/${reportedTotal}`,
        shardAuthority(window, reportedTotal, page),
        unique.values,
      );
    }
    page += 1;
    if (page > Math.ceil(ACTIONS_RESULT_CAP / PAGE_SIZE)) {
      return unknownSource("provider-cap-hit", shardAuthority(window, reportedTotal, page - 1), unique.values);
    }
    result = await fetchJsonResponse(options, next.url, "workflow-runs");
    if (result.status !== "complete") {
      return unknownSource(result.reasons[0], shardAuthority(window, reportedTotal, page - 1), unique.values);
    }
  }
}

async function fetchDeliverySignatureFlakes(options, window) {
  const query = `repo:${options.repository} is:issue \"delivery-failure-signature/v1\" in:body`;
  let url = searchIssuesUrl(query, 1);
  let page = 1;
  let reportedTotal = null;
  const issues = [];
  while (true) {
    const result = await fetchJsonResponse(options, url, "delivery-signatures");
    if (result.status !== "complete") {
      return {
        ...result,
        authority: { ...searchAuthority(null, page - 1, issues.length), ...result.authority },
      };
    }
    const payload = result.payload;
    if (
      !Number.isInteger(payload?.total_count) ||
      payload.total_count < 0 ||
      payload.incomplete_results !== false ||
      !Array.isArray(payload.items)
    ) {
      return unknownSource(
        payload?.incomplete_results === true ? "incomplete-search-results" : "payload-missing-completeness",
        searchAuthority(reportedTotal, page, issues.length),
        summarizeDeliverySignatureFlakes(issues, window),
      );
    }
    reportedTotal ??= payload.total_count;
    if (payload.total_count !== reportedTotal) {
      return unknownSource("moving-search-snapshot", searchAuthority(reportedTotal, page, issues.length));
    }
    if (reportedTotal > ACTIONS_RESULT_CAP) {
      return unknownSource("search-provider-cap-hit", searchAuthority(reportedTotal, page, issues.length));
    }
    issues.push(...payload.items.filter((issue) => !issue.pull_request));
    const unique = uniqueByIdentity(issues, "issue");
    if (unique.error) return unknownSource(unique.error, searchAuthority(reportedTotal, page, unique.values.length));
    const next = safeNextLink(result.response, searchIssuesUrl(query, page), page);
    if (next.error) return unknownSource(next.error, searchAuthority(reportedTotal, page, unique.values.length));
    if (unique.values.length >= reportedTotal) {
      if (next.url)
        return unknownSource("unexpected-next-link", searchAuthority(reportedTotal, page, unique.values.length));
      if (unique.values.length !== reportedTotal) {
        return unknownSource(
          `count-mismatch:${unique.values.length}/${reportedTotal}`,
          searchAuthority(reportedTotal, page, unique.values.length),
        );
      }
      return {
        status: "complete",
        reasons: [],
        values: summarizeDeliverySignatureFlakes(unique.values, window),
        authority: { ...searchAuthority(reportedTotal, page, unique.values.length), status: "complete" },
      };
    }
    if (!next.url) {
      return unknownSource(
        `missing-next-link:${unique.values.length}/${reportedTotal}`,
        searchAuthority(reportedTotal, page, unique.values.length),
      );
    }
    page += 1;
    url = next.url;
  }
}

function actionsRunsUrl(repository, window, page) {
  const url = new URL(`${API_BASE_URL}/repos/${repository}/actions/runs`);
  url.searchParams.set("per_page", String(PAGE_SIZE));
  url.searchParams.set("page", String(page));
  url.searchParams.set("created", `${window.start}..${window.end}`);
  return url;
}

function searchIssuesUrl(query, page) {
  const url = new URL(`${API_BASE_URL}/search/issues`);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(PAGE_SIZE));
  url.searchParams.set("page", String(page));
  return url;
}

async function fetchJsonResponse(options, url, source) {
  try {
    const response = await options.fetchImpl(url, { headers: githubHeaders(options.token) });
    if (!response?.ok) {
      const rateLimited =
        response?.status === 429 ||
        (response?.status === 403 && Number(response?.headers?.get?.("x-ratelimit-remaining")) === 0);
      return unknownSource(rateLimited ? "rate-limit-exhausted" : `github-${response?.status ?? "unavailable"}`, {
        source,
      });
    }
    return {
      status: "complete",
      reasons: [],
      values: [],
      payload: await response.json(),
      response,
      authority: { source },
    };
  } catch (error) {
    return unknownSource(`github-unavailable:${boundedReason(error)}`, { source });
  }
}

function safeNextLink(response, expectedUrl, page, canonicalPath = null) {
  const parts = String(response?.headers?.get?.("link") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const nextParts = parts.filter((part) => /;\s*rel="next"(?:\s*;|$)/.test(part));
  if (nextParts.length === 0) return { url: null, error: null };
  if (nextParts.length !== 1) return { url: null, error: "ambiguous-next-link" };
  const match = nextParts[0].match(/^<([^>]+)>/);
  if (!match) return { url: null, error: "unsafe-next-link" };
  let next;
  try {
    next = new URL(match[1]);
  } catch {
    return { url: null, error: "unsafe-next-link" };
  }
  const expected = new URL(expectedUrl);
  const allowedPaths = new Set([expected.pathname, ...(canonicalPath ? [canonicalPath] : [])]);
  if (
    next.origin !== API_BASE_URL ||
    !allowedPaths.has(next.pathname) ||
    Number(next.searchParams.get("page")) !== page + 1
  ) {
    return { url: null, error: "unsafe-next-link" };
  }
  const withoutPage = (value) => {
    const copy = new URL(value);
    copy.pathname = expected.pathname;
    copy.searchParams.delete("page");
    copy.searchParams.sort();
    return copy.toString();
  };
  if (withoutPage(next) !== withoutPage(expected)) return { url: null, error: "unsafe-next-link" };
  return { url: next, error: null };
}

function uniqueByIdentity(values, source) {
  const byId = new Map();
  for (const value of values ?? []) {
    const identity = value?.id;
    if ((typeof identity !== "number" && typeof identity !== "string") || String(identity).trim() === "") {
      return { values: [...byId.values()], error: `${source}-identity-missing` };
    }
    const key = String(identity);
    const existing = byId.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) {
      return { values: [...byId.values()], error: `${source}-identity-conflict:${key}` };
    }
    byId.set(key, value);
  }
  return { values: [...byId.values()], error: null };
}

function shardAuthority(window, reportedTotal, pageCount) {
  return { window, reportedTotal, pageCount, uniqueCollectedCount: 0, capHit: false };
}

function searchAuthority(reportedTotal, pageCount, uniqueCollectedCount) {
  return { query: "delivery-failure-signature/v1", reportedTotal, pageCount, uniqueCollectedCount };
}

function unknownSource(reason, authority = {}, values = []) {
  return {
    status: "unknown",
    reasons: [reason],
    values: values ?? [],
    authority: { ...authority, status: "unknown", reasons: [reason] },
  };
}

async function collectSource(source, collect) {
  try {
    const result = await collect();
    if (!result || !["complete", "unknown"].includes(result.status) || !Array.isArray(result.values)) {
      return { source, ...unknownSource("collector-source-omitted") };
    }
    return { source, ...result };
  } catch (error) {
    return { source, ...unknownSource(`collector-unavailable:${boundedReason(error)}`) };
  }
}

export async function publishReleaseHealthFlakeDigest(options) {
  validateCollectorOptions(options);
  const frozen = await readAndValidateFrozenArtifact(options);
  if (frozen.status === "unknown") return { ...frozen, mutations: [] };
  const { digest, payloadSha256, artifact } = frozen;
  if (digest.collection.status !== "complete" || digest.classification === "unknown") {
    return {
      status: "unknown",
      reasons: digest.collection.reasons.length > 0 ? digest.collection.reasons : ["collection-not-complete"],
      artifact,
      payloadSha256,
      mutations: [],
    };
  }

  const authority = await readLegacyIssueAuthority(options);
  if (authority.status === "unknown") {
    return { ...authority, artifact, payloadSha256, mutations: [] };
  }
  const publication = publicationRecord(options, digest, payloadSha256, artifact);
  const mutations = [];
  const canonical = authority.byNumber.get(CANONICAL_ISSUE_NUMBER);
  const adoption =
    authority.dispositions.get(CANONICAL_ISSUE_NUMBER) ??
    dispositionRecord(publication, CANONICAL_ISSUE_NUMBER, "adopted-canonical");
  const canonicalBody = [
    digest.issueBody,
    renderCanonicalMarker(options.repository),
    renderDispositionBlock(adoption),
  ].join("\n\n");
  const canonicalDesired = {
    title: CANONICAL_ISSUE_TITLE,
    body: canonicalBody,
    ...(digest.classification === "breaching" ? { state: "open" } : { state: "closed", state_reason: "completed" }),
  };
  const canonicalMutation = await patchIssueIdempotently(options, canonical, canonicalDesired);
  mutations.push({ issueNumber: CANONICAL_ISSUE_NUMBER, action: canonicalMutation });

  const legacyAction = digest.classification === "breaching" ? "superseded" : "recovered";
  for (const legacy of LEGACY_ISSUES.filter((entry) => entry.number !== CANONICAL_ISSUE_NUMBER)) {
    const prior = authority.dispositions.get(legacy.number);
    if (prior) {
      mutations.push({ issueNumber: legacy.number, action: "skipped-terminal" });
      continue;
    }
    const issue = authority.byNumber.get(legacy.number);
    const record = dispositionRecord(publication, legacy.number, legacyAction);
    const desired = {
      body: appendDispositionBlock(issue.issue.body, record),
      state: "closed",
      state_reason: "completed",
    };
    const action = await patchIssueIdempotently(options, issue, desired);
    mutations.push({ issueNumber: legacy.number, action });
  }
  return {
    status: digest.classification,
    reasons: [],
    artifact,
    payloadSha256,
    issueAuthority: authority.issueAuthority,
    mutations,
  };
}

async function readAndValidateFrozenArtifact(options) {
  const payload = await validateReleaseHealthFlakeDigestPayloads(options);
  const reasons = [...payload.reasons, ...validateArtifactAuthority(options)];
  const artifact = artifactAuthority(options);
  return reasons.length > 0
    ? { ...payload, status: "unknown", reasons, artifact }
    : { ...payload, status: "valid", reasons: [], artifact };
}

export async function validateReleaseHealthFlakeDigestPayloads(options) {
  const reasons = [];
  if (!options.outPath || !options.markdownOutPath || !options.issueBodyOutPath) {
    reasons.push("required-payload-path-missing");
    return { status: "unknown", reasons };
  }
  let jsonBytes;
  let markdownBytes;
  let issueBodyBytes;
  try {
    [jsonBytes, markdownBytes, issueBodyBytes] = await Promise.all([
      readFile(options.outPath),
      readFile(options.markdownOutPath),
      readFile(options.issueBodyOutPath),
    ]);
  } catch (error) {
    return { status: "unknown", reasons: [...reasons, `required-payload-unavailable:${boundedReason(error)}`] };
  }
  if (jsonBytes.length === 0 || markdownBytes.length === 0 || issueBodyBytes.length === 0) {
    reasons.push("required-payload-empty");
  }
  let digest;
  try {
    digest = JSON.parse(jsonBytes.toString("utf8"));
  } catch {
    reasons.push("digest-json-malformed");
  }
  if (digest) reasons.push(...validateFrozenDigest(digest, options, markdownBytes, issueBodyBytes));
  return reasons.length > 0
    ? { status: "unknown", reasons, payloadSha256: sha256(jsonBytes) }
    : { status: "valid", reasons: [], digest, payloadSha256: sha256(jsonBytes) };
}

function validateArtifactAuthority(options) {
  const reasons = [];
  if (!/^\d+$/.test(String(options.artifactId ?? ""))) reasons.push("artifact-id-invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(String(options.artifactDigest ?? ""))) reasons.push("artifact-digest-invalid");
  if (options.artifactProducerOutcome !== "success") reasons.push("artifact-producer-not-successful");
  if (options.producerWorkflow !== WORKFLOW_FILE) reasons.push("artifact-producer-workflow-invalid");
  if (options.producerJob !== "digest") reasons.push("artifact-producer-job-invalid");
  if (options.producerStep !== "artifact") reasons.push("artifact-producer-step-invalid");
  if (!/^\d+$/.test(String(options.runId ?? ""))) reasons.push("run-id-invalid");
  if (!Number.isInteger(options.runAttempt) || options.runAttempt < 1) reasons.push("run-attempt-invalid");
  if (!/^[a-f0-9]{40}$/i.test(String(options.headSha ?? ""))) reasons.push("head-sha-invalid");
  return reasons;
}

function artifactAuthority(options) {
  return {
    artifactId: Number(options.artifactId),
    artifactDigest: options.artifactDigest,
    producer: {
      workflow: options.producerWorkflow,
      job: options.producerJob,
      step: options.producerStep,
      outcome: options.artifactProducerOutcome,
      runId: String(options.runId),
      runAttempt: options.runAttempt,
      headSha: String(options.headSha ?? "").toLowerCase(),
    },
  };
}

function validateFrozenDigest(digest, options, markdownBytes, issueBodyBytes) {
  const reasons = [];
  if (digest.schemaVersion !== RELEASE_HEALTH_FLAKE_DIGEST_VERSION) reasons.push("digest-schema-invalid");
  if (digest.repository !== options.repository) reasons.push("digest-repository-mismatch");
  if (!["complete", "unknown"].includes(digest.collection?.status)) reasons.push("digest-collection-status-invalid");
  if (!Array.isArray(digest.collection?.reasons) || typeof digest.collection?.sources !== "object") {
    reasons.push("digest-completeness-evidence-invalid");
  } else if (!validCollectionEvidence(digest.collection, digest.window)) {
    reasons.push("digest-completeness-evidence-invalid");
  }
  if (!["breaching", "clear", "unknown"].includes(digest.classification)) reasons.push("digest-classification-invalid");
  if (!validWindow(digest.window?.current) || !validWindow(digest.window?.previous))
    reasons.push("digest-window-invalid");
  if (
    !validIso(digest.checkedAt) ||
    digest.checkedAt !== digest.window?.current?.end ||
    digest.window?.previous?.end !== digest.window?.current?.start
  ) {
    reasons.push("digest-window-lineage-invalid");
  }
  if (typeof digest.markdown !== "string" || renderFlakeDigestMarkdown(digest) !== digest.markdown) {
    reasons.push("digest-markdown-invalid");
  }
  if (typeof digest.issueBody !== "string" || renderFlakeDigestIssueBody(digest) !== digest.issueBody) {
    reasons.push("digest-issue-body-invalid");
  }
  if (markdownBytes.toString("utf8") !== `${digest.markdown}\n`) reasons.push("markdown-payload-mismatch");
  if (issueBodyBytes.toString("utf8") !== `${digest.issueBody}\n`) reasons.push("issue-body-payload-mismatch");
  const expectedClassification =
    digest.collection?.status === "complete" ? (digest.breachCount > 0 ? "breaching" : "clear") : "unknown";
  if (digest.classification !== expectedClassification) reasons.push("digest-classification-conflict");
  return reasons;
}

function validCollectionEvidence(collection, windows) {
  const current = collection.sources?.["actions-current"];
  const previous = collection.sources?.["actions-previous"];
  const signatures = collection.sources?.["delivery-signatures"];
  if (!current || !previous || !signatures) return false;
  if (!sameWindow(current.window, windows?.current) || !sameWindow(previous.window, windows?.previous)) return false;
  if (collection.status === "unknown") {
    return (
      collection.reasons.length > 0 && [current, previous, signatures].some((source) => source.status === "unknown")
    );
  }
  return (
    collection.reasons.length === 0 &&
    validCompleteActionsAuthority(current) &&
    validCompleteActionsAuthority(previous) &&
    signatures.status === "complete" &&
    signatures.query === "delivery-failure-signature/v1" &&
    nonNegativeInteger(signatures.reportedTotal) &&
    signatures.uniqueCollectedCount === signatures.reportedTotal &&
    positiveIntegerValue(signatures.pageCount)
  );
}

function validCompleteActionsAuthority(authority) {
  return (
    authority.status === "complete" &&
    nonNegativeInteger(authority.reportedTotal) &&
    authority.uniqueCollectedCount === authority.reportedTotal &&
    positiveIntegerValue(authority.pageCount) &&
    Array.isArray(authority.sourceRunIds) &&
    authority.sourceRunIds.length === authority.uniqueCollectedCount &&
    new Set(authority.sourceRunIds).size === authority.sourceRunIds.length &&
    Array.isArray(authority.shards) &&
    authority.shards.length > 0
  );
}

function sameWindow(left, right) {
  return validWindow(left) && validWindow(right) && left.start === right.start && left.end === right.end;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function positiveIntegerValue(value) {
  return Number.isInteger(value) && value > 0;
}

async function readLegacyIssueAuthority(options) {
  const reads = await Promise.all(
    LEGACY_ISSUES.map(async (expected) => {
      try {
        const snapshot = await githubIssueSnapshot(options, expected.number);
        return { expected, snapshot, issue: snapshot.issue };
      } catch (error) {
        return { expected, error: boundedReason(error) };
      }
    }),
  );
  const issueAuthority = {
    expectedCount: LEGACY_ISSUES.length,
    collectedCount: reads.filter((entry) => entry.issue).length,
    issueNumbers: reads
      .filter((entry) => entry.issue)
      .map((entry) => entry.issue.number)
      .sort((a, b) => a - b),
  };
  const reasons = [];
  const byNumber = new Map();
  const dispositions = new Map();
  let canonicalMode = null;
  for (const { expected, snapshot, issue, error } of reads) {
    if (error) {
      reasons.push(`issue-${expected.number}-unavailable:${error}`);
      continue;
    }
    if (issue?.number !== expected.number || issue?.node_id !== expected.nodeId) {
      reasons.push(`issue-${expected.number}-identity-conflict`);
      continue;
    }
    byNumber.set(expected.number, snapshot);
    const canonicalMarkers = parseMarkers(issue.body, CI_FLAKE_DIGEST_MARKER_VERSION);
    const dispositionMarkers = parseMarkers(issue.body, CI_FLAKE_DIGEST_DISPOSITION_VERSION);
    const dispositionBlockCount = String(issue.body ?? "").split("## CI flake digest legacy disposition").length - 1;
    if (canonicalMarkers.error) reasons.push(`issue-${expected.number}-${canonicalMarkers.error}`);
    if (dispositionMarkers.error) reasons.push(`issue-${expected.number}-${dispositionMarkers.error}`);
    if (!dispositionMarkers.error && dispositionBlockCount !== dispositionMarkers.values.length) {
      reasons.push(`issue-${expected.number}-disposition-block-conflict`);
    }
    if (
      canonicalMarkers.error ||
      dispositionMarkers.error ||
      dispositionBlockCount !== dispositionMarkers.values.length
    )
      continue;

    if (expected.number === CANONICAL_ISSUE_NUMBER) {
      if (canonicalMarkers.values.length === 0 && dispositionMarkers.values.length === 0) {
        if (!isExactLegacyCanonical(issue)) reasons.push("canonical-legacy-authority-conflict");
        else canonicalMode = "legacy-adoption";
      } else if (canonicalMarkers.values.length === 1 && dispositionMarkers.values.length === 1) {
        if (!validCanonicalMarker(canonicalMarkers.values[0], options.repository)) {
          reasons.push("canonical-marker-invalid");
        }
        if (!validDisposition(dispositionMarkers.values[0], expected.number, options.repository, "adopted-canonical")) {
          reasons.push("canonical-adoption-marker-invalid");
        } else {
          dispositions.set(expected.number, dispositionMarkers.values[0]);
        }
        canonicalMode = "adopted";
      } else {
        reasons.push("canonical-marker-pair-invalid");
      }
    } else {
      if (canonicalMarkers.values.length > 0) reasons.push(`issue-${expected.number}-conflicting-canonical-marker`);
      if (dispositionMarkers.values.length === 1) {
        const record = dispositionMarkers.values[0];
        if (!validDisposition(record, expected.number, options.repository)) {
          reasons.push(`issue-${expected.number}-disposition-invalid`);
        } else if (issue.state !== "closed" || issue.state_reason !== "completed") {
          reasons.push(`issue-${expected.number}-terminal-state-conflict`);
        } else {
          dispositions.set(expected.number, record);
        }
      }
    }
  }
  if (issueAuthority.collectedCount !== issueAuthority.expectedCount) reasons.push("issue-authority-incomplete");
  if (!canonicalMode) reasons.push("canonical-authority-missing");
  return reasons.length > 0
    ? { status: "unknown", reasons: [...new Set(reasons)], issueAuthority }
    : { status: "complete", reasons: [], issueAuthority, byNumber, dispositions, canonicalMode };
}

function parseMarkers(body, version) {
  const text = String(body ?? "");
  const prefix = new RegExp(`<!--\\s*${escapeRegExp(version)}(?:\\s|-->)`, "g");
  const pattern = new RegExp(`<!--\\s*${escapeRegExp(version)}\\s+([\\s\\S]*?)\\s*-->`, "g");
  const prefixCount = [...text.matchAll(prefix)].length;
  const matches = [...text.matchAll(pattern)];
  if (prefixCount !== matches.length) return { values: [], error: `${version}-malformed` };
  if (matches.length > 1) return { values: [], error: `${version}-duplicate` };
  const values = [];
  for (const match of matches) {
    try {
      values.push(JSON.parse(match[1]));
    } catch {
      return { values: [], error: `${version}-malformed` };
    }
  }
  return { values, error: null };
}

function validCanonicalMarker(record, repository) {
  return (
    record?.schemaVersion === CI_FLAKE_DIGEST_MARKER_VERSION &&
    record.repository === repository &&
    record.issueNumber === CANONICAL_ISSUE_NUMBER &&
    record.nodeId === CANONICAL_ISSUE_NODE_ID
  );
}

function validDisposition(record, issueNumber, repository, exactAction) {
  const allowedAction = exactAction
    ? record?.action === exactAction
    : ["superseded", "recovered"].includes(record?.action);
  return (
    record?.schemaVersion === CI_FLAKE_DIGEST_DISPOSITION_VERSION &&
    record.repository === repository &&
    record.issueNumber === issueNumber &&
    allowedAction &&
    record.canonicalIssueNumber === CANONICAL_ISSUE_NUMBER &&
    record.workflow === WORKFLOW_FILE &&
    /^\d+$/.test(String(record.runId ?? "")) &&
    Number.isInteger(record.runAttempt) &&
    record.runAttempt > 0 &&
    /^[a-f0-9]{40}$/.test(String(record.headSha ?? "")) &&
    validIso(record.checkedAt) &&
    validWindow(record.currentWindow) &&
    validWindow(record.previousWindow) &&
    /^[a-f0-9]{64}$/.test(String(record.payloadSha256 ?? "")) &&
    Number.isInteger(record.artifactId) &&
    record.artifactId > 0 &&
    /^sha256:[a-f0-9]{64}$/.test(String(record.artifactDigest ?? ""))
  );
}

function isExactLegacyCanonical(issue) {
  return (
    issue.number === CANONICAL_ISSUE_NUMBER &&
    issue.node_id === CANONICAL_ISSUE_NODE_ID &&
    issue.title === LEGACY_CANONICAL_TITLE &&
    sha256(Buffer.from(String(issue.body ?? ""), "utf8")) === LEGACY_CANONICAL_BODY_SHA256
  );
}

function publicationRecord(options, digest, payloadSha256, artifact) {
  return {
    repository: options.repository,
    workflow: WORKFLOW_FILE,
    runId: String(options.runId),
    runAttempt: options.runAttempt,
    headSha: String(options.headSha).toLowerCase(),
    checkedAt: digest.checkedAt,
    currentWindow: digest.window.current,
    previousWindow: digest.window.previous,
    payloadSha256,
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
  };
}

function dispositionRecord(publication, issueNumber, action) {
  return {
    schemaVersion: CI_FLAKE_DIGEST_DISPOSITION_VERSION,
    repository: publication.repository,
    issueNumber,
    action,
    canonicalIssueNumber: CANONICAL_ISSUE_NUMBER,
    workflow: publication.workflow,
    runId: publication.runId,
    runAttempt: publication.runAttempt,
    headSha: publication.headSha,
    checkedAt: publication.checkedAt,
    currentWindow: publication.currentWindow,
    previousWindow: publication.previousWindow,
    payloadSha256: publication.payloadSha256,
    artifactId: publication.artifactId,
    artifactDigest: publication.artifactDigest,
  };
}

function renderCanonicalMarker(repository) {
  return `<!-- ${CI_FLAKE_DIGEST_MARKER_VERSION} ${JSON.stringify({
    schemaVersion: CI_FLAKE_DIGEST_MARKER_VERSION,
    repository,
    issueNumber: CANONICAL_ISSUE_NUMBER,
    nodeId: CANONICAL_ISSUE_NODE_ID,
  })} -->`;
}

function renderDispositionBlock(record) {
  return [
    "## CI flake digest legacy disposition",
    "",
    `- Action: ${record.action}`,
    `- Canonical issue: #${record.canonicalIssueNumber}`,
    `- Frozen artifact: ${record.artifactId} (${record.artifactDigest})`,
    "",
    `<!-- ${CI_FLAKE_DIGEST_DISPOSITION_VERSION} ${JSON.stringify(record)} -->`,
  ].join("\n");
}

function appendDispositionBlock(body, record) {
  const current = String(body ?? "").trimEnd();
  return current ? `${current}\n\n${renderDispositionBlock(record)}` : renderDispositionBlock(record);
}

async function patchIssueIdempotently(options, issue, desired) {
  let current = issue;
  if (issueMatchesDesired(current.issue, desired)) return "already-converged";
  const fresh = await githubIssueSnapshot(options, current.issue.number);
  if (issueMatchesDesired(fresh.issue, desired)) return "already-converged";
  if (!sameIssueSnapshot(fresh.issue, current.issue)) {
    throw new Error(`issue-${current.issue.number}-authority-moved`);
  }
  current = fresh;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const saved = await githubJson(options, `/issues/${current.issue.number}`, {
        method: "PATCH",
        body: desired,
      });
      if (issueMatchesDesired(saved, desired)) return attempt === 0 ? "patched" : "patched-after-retry";
      lastError = new Error(`issue-${current.issue.number}-patch-response-ambiguous`);
    } catch (error) {
      lastError = error;
    }
    try {
      const reread = await githubIssueSnapshot(options, current.issue.number);
      if (issueMatchesDesired(reread.issue, desired)) return "reconciled-ambiguous-response";
      if (!sameIssueSnapshot(reread.issue, current.issue)) {
        throw new Error(`issue-${current.issue.number}-authority-moved`);
      }
      current = reread;
    } catch (error) {
      lastError = error;
      if (/authority-moved/.test(String(error?.message ?? ""))) throw error;
    }
  }
  throw new Error(`Issue #${current.issue.number} mutation did not reconcile: ${boundedReason(lastError)}`);
}

function issueMatchesDesired(issue, desired) {
  if (!issue || (desired.title !== undefined && issue.title !== desired.title) || issue.body !== desired.body)
    return false;
  if (desired.state !== undefined && issue.state !== desired.state) return false;
  if (desired.state_reason !== undefined && issue.state_reason !== desired.state_reason) return false;
  return true;
}

function sameIssueSnapshot(left, right) {
  return ["number", "node_id", "title", "body", "state", "state_reason"].every(
    (field) => left?.[field] === right?.[field],
  );
}

async function githubIssueSnapshot(options, issueNumber) {
  return { issue: await githubJson(options, `/issues/${issueNumber}`) };
}

async function githubJson(options, path, request = {}) {
  const response = await githubResponse(options, path, request);
  return response.status === 204 ? null : response.json();
}

async function githubResponse(options, path, request = {}) {
  const response = await options.fetchImpl(new URL(`${API_BASE_URL}/repos/${options.repository}${path}`), {
    method: request.method ?? "GET",
    headers: githubHeaders(options.token),
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  if (!response?.ok) throw new Error(`GitHub issue request failed: ${response?.status ?? "unavailable"}`);
  return response;
}

function validateCollectorOptions(options) {
  if (!options.repository) throw new Error("GitHub repository is required.");
  if (typeof options.fetchImpl !== "function") throw new Error("A fetch implementation is required.");
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function emptyJob(name) {
  return { name, retryCount: 0, flakyFailureCount: 0 };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value) {
  return /^(?:1|true|yes)$/i.test(String(value ?? ""));
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validWindow(value) {
  return value && validIso(value.start) && validIso(value.end) && Date.parse(value.start) <= Date.parse(value.end);
}

function timestampWithin(value, window) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= Date.parse(window.start) && timestamp <= Date.parse(window.end);
}

function validActionRun(run, window) {
  return (
    timestampWithin(run?.created_at, window) &&
    validIso(run?.updated_at) &&
    Date.parse(run.updated_at) <= Date.parse(window.end) &&
    Number.isInteger(run?.run_attempt) &&
    run.run_attempt > 0 &&
    typeof run?.name === "string" &&
    Boolean(run.name.trim())
  );
}

function formatSignedDelta(value) {
  return value > 0 ? `+${value}` : String(value);
}

function escapeMarkdownCell(value) {
  return String(value).replaceAll("|", "\\|");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numericStringCompare(left, right) {
  return Number(left) - Number(right) || String(left).localeCompare(String(right));
}

function boundedReason(error) {
  return String(error instanceof Error ? error.message : (error ?? "unknown"))
    .replaceAll(/\s+/g, " ")
    .slice(0, 200);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path, value, options = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { flag: options.append ? "a" : "w" });
}

async function main(argv, env = process.env) {
  try {
    const options = parseReleaseHealthFlakeDigestArgs(argv, env);
    if (options.validatePayloads) {
      const result = await validateReleaseHealthFlakeDigestPayloads(options);
      if (result.status !== "valid")
        throw new Error(`Flake digest payload validation failed: ${result.reasons.join(", ")}`);
      console.log(JSON.stringify(result, null, 2));
    } else if (options.publishIssues) {
      const result = await publishReleaseHealthFlakeDigest(options);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const digest = await writeReleaseHealthFlakeDigest(options);
      console.log(digest.markdown);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
