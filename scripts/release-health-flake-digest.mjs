#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { parseCircuitMarker } from "./release-health-merge-group-failure-signatures.mjs";

export const RELEASE_HEALTH_FLAKE_DIGEST_VERSION = "release-health-flake-digest/v1";
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_RETRY_THRESHOLD = 3;
export const DEFAULT_FLAKY_FAILURE_THRESHOLD = 1;

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
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env),
    fetchImpl: globalThis.fetch,
  };
}

export async function collectReleaseHealthFlakeDigest(options) {
  if (!options.repository) {
    throw new Error("GitHub repository is required.");
  }
  if (typeof options.fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  const windows = buildDigestWindows(options.checkedAt, options.windowDays);
  const [currentRuns, previousRuns, signatureFlakes] = await Promise.all([
    fetchWorkflowRunsForWindow(options, windows.current),
    fetchWorkflowRunsForWindow(options, windows.previous),
    fetchDeliverySignatureFlakes(options, windows.current),
  ]);

  return buildFlakeDigest({
    checkedAt: options.checkedAt,
    repository: options.repository,
    windows,
    thresholds: {
      retryCount: options.retryThreshold,
      flakyFailureCount: options.flakyFailureThreshold,
    },
    currentRuns,
    previousRuns,
    signatureFlakes,
  });
}

export function buildDigestWindows(checkedAt, windowDays = DEFAULT_WINDOW_DAYS) {
  const end = new Date(checkedAt);
  if (Number.isNaN(end.getTime())) {
    throw new Error("checkedAt must be an ISO date.");
  }
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

  const breaches = jobs.filter((job) => job.breached);
  const digest = {
    schemaVersion: RELEASE_HEALTH_FLAKE_DIGEST_VERSION,
    checkedAt: input.checkedAt,
    repository: input.repository,
    window: input.windows,
    thresholds: input.thresholds,
    retryCount: current.retryCount,
    flakyFailureCount: current.flakyFailureCount,
    previousRetryCount: previous.retryCount,
    previousFlakyFailureCount: previous.flakyFailureCount,
    breachCount: breaches.length,
    topFlakyJobs: jobs,
    signatureFlakeCount: (input.signatureFlakes ?? []).length,
    deliverySignatureFlakes: input.signatureFlakes ?? [],
    issueTitle: `CI flake digest breach: ${input.windows.current.start.slice(0, 10)} to ${input.windows.current.end.slice(0, 10)}`,
  };
  return {
    ...digest,
    markdown: renderFlakeDigestMarkdown(digest),
    issueBody: renderFlakeDigestIssueBody(digest),
  };
}

export function summarizeWorkflowRuns(runs) {
  const jobs = new Map();
  let retryCount = 0;
  let flakyFailureCount = 0;

  for (const run of runs) {
    const attempts = positiveInteger(run?.run_attempt, 0);
    const retries = Math.max(0, attempts - 1);
    if (retries === 0) {
      continue;
    }
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
    `Retries: ${digest.retryCount} (${formatSignedDelta(digest.retryCount - digest.previousRetryCount)} vs previous window). Flaky successful retries: ${digest.flakyFailureCount} (${formatSignedDelta(digest.flakyFailureCount - digest.previousFlakyFailureCount)}).`,
    `Thresholds: job retries >= ${digest.thresholds.retryCount}; job flaky successful retries >= ${digest.thresholds.flakyFailureCount}.`,
    `Delivery signature retry-pass evidence: ${digest.signatureFlakeCount ?? 0}.`,
    "",
  ];

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

  if (digest.breachCount > 0) {
    lines.push("", "### Actionable work item", "", `Open or update: ${digest.issueTitle}`);
  } else {
    lines.push("", "Clean: no job crossed the configured flake threshold.");
  }

  return lines.join("\n");
}

export function renderFlakeDigestIssueBody(digest) {
  return [
    "## CI flake threshold breach",
    "",
    digest.markdown,
    "",
    "## Follow-up policy",
    "",
    "- Identify whether the top breached job should be fixed immediately or quarantined out of the blocking lane.",
    "- Link the fixing PR or the quarantine decision back to this issue.",
    "- Close only after a later digest shows the breached job below threshold or the exception is explicitly accepted.",
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
  if (options.outPath) {
    await writeJson(options.outPath, digest);
  }
  if (options.markdownOutPath) {
    await writeText(options.markdownOutPath, `${digest.markdown}\n`);
  }
  if (options.githubOutputPath) {
    await writeText(
      options.githubOutputPath,
      [`breach_count=${digest.breachCount}`, `issue_title<<EOF`, digest.issueTitle, "EOF", ""].join("\n"),
      { append: true },
    );
  }
  return digest;
}

async function fetchWorkflowRunsForWindow(options, window) {
  const runs = [];
  let url = new URL(`https://api.github.com/repos/${options.repository}/actions/runs`);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("created", `${window.start}..${window.end}`);

  while (url) {
    const response = await options.fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub workflow run lookup failed: ${response.status}`);
    }
    const body = await response.json();
    runs.push(...(Array.isArray(body?.workflow_runs) ? body.workflow_runs : []));
    url = nextLink(response.headers?.get?.("link"));
  }

  return runs;
}

async function fetchDeliverySignatureFlakes(options, window) {
  const issues = [];
  let url = new URL(`https://api.github.com/repos/${options.repository}/issues`);
  url.searchParams.set("state", "all");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", "100");

  while (url && issues.length < 300) {
    const response = await options.fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GitHub delivery signature issue lookup failed: ${response.status}`);
    const body = await response.json();
    issues.push(...(Array.isArray(body) ? body.filter((issue) => !issue.pull_request) : []));
    url = nextLink(response.headers?.get?.("link"));
  }
  return summarizeDeliverySignatureFlakes(issues, window);
}

function nextLink(linkHeader) {
  const next = String(linkHeader ?? "")
    .split(",")
    .find((part) => part.includes('rel="next"'));
  if (!next) {
    return null;
  }
  const start = next.indexOf("<");
  const end = next.indexOf(">");
  return start >= 0 && end > start ? new URL(next.slice(start + 1, end)) : null;
}

function emptyJob(name) {
  return { name, retryCount: 0, flakyFailureCount: 0 };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatSignedDelta(value) {
  return value > 0 ? `+${value}` : String(value);
}

function escapeMarkdownCell(value) {
  return String(value).replaceAll("|", "\\|");
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
    const digest = await writeReleaseHealthFlakeDigest(parseReleaseHealthFlakeDigestArgs(argv, env));
    console.log(digest.markdown);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
