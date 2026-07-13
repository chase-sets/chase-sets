#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";

export const MERGE_GROUP_FAILURE_SIGNATURES_VERSION = "merge-group-failure-signatures/v1";
export const DEFAULT_WINDOW_DAYS = 7;

export function parseMergeGroupFailureSignaturesArgs(argv, env = process.env) {
  return {
    repository: readOption(argv, "--repository") ?? readEnv("GITHUB_REPOSITORY", env),
    token: readOption(argv, "--token") ?? readEnv("GH_TOKEN", env) ?? readEnv("GITHUB_TOKEN", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    windowDays: positiveInteger(readOption(argv, "--window-days"), DEFAULT_WINDOW_DAYS),
    outPath: readOption(argv, "--out") ?? readEnv("MERGE_GROUP_FAILURE_SIGNATURES_OUT", env),
    markdownOutPath: readOption(argv, "--markdown-out") ?? readEnv("MERGE_GROUP_FAILURE_SIGNATURES_MARKDOWN_OUT", env),
    fetchImpl: globalThis.fetch,
  };
}

export async function collectMergeGroupFailureSignatures(options) {
  if (!options.repository) {
    throw new Error("GitHub repository is required.");
  }
  if (typeof options.fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  const window = buildWindow(options.checkedAt, options.windowDays);
  const runs = await fetchMergeGroupRuns(options, window);
  const groups = [];

  for (const run of runs) {
    const jobs = await fetchRunJobs(options, run.id);
    const failures = [];
    for (const job of jobs.filter((candidate) => candidate?.conclusion === "failure")) {
      const log = await fetchJobLog(options, job.id);
      failures.push(
        ...extractFailureSignatures(log, {
          jobName: job.name,
          workspace: job.name,
          jobId: job.id,
        }),
      );
    }

    groups.push({
      runId: run.id,
      runAttempt: run.run_attempt ?? 1,
      createdAt: run.created_at ?? null,
      conclusion: run.conclusion ?? "unknown",
      headSha: run.head_sha ?? null,
      headBranch: run.head_branch ?? null,
      url: run.html_url ?? null,
      composition: await fetchRunComposition(options, run),
      failures,
    });
  }

  return buildMergeGroupFailureSignatureReport({
    checkedAt: options.checkedAt,
    repository: options.repository,
    window,
    groups,
  });
}

export function buildWindow(checkedAt, windowDays = DEFAULT_WINDOW_DAYS) {
  const end = new Date(checkedAt);
  if (Number.isNaN(end.getTime())) {
    throw new Error("checkedAt must be an ISO date.");
  }
  const start = new Date(end.getTime() - Math.max(1, Math.floor(windowDays)) * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function extractFailureSignatures(log, context = {}) {
  const lines = stripAnsi(String(log ?? "")).split(/\r?\n/);
  const fileLine = lines.find((line) => testFileFromText(line));
  const testFile = testFileFromText(fileLine ?? "");
  const testName = testNameFromLines(lines, testFile);
  const assertionShape = assertionShapeFromLines(lines);
  if (!testFile && !testName && !assertionShape) {
    return [fallbackInfrastructureSignature(context)];
  }

  const normalized = {
    testFile: testFile ?? "unknown-test-file",
    testName: testName ?? "unknown-test",
    assertionShape: assertionShape ?? "assertion-failed",
    workspace: boundedIdentifier(context.workspace ?? context.jobName ?? "unknown-workspace"),
  };
  return [
    {
      ...normalized,
      signature: signatureId(normalized.testFile, normalized.testName, normalized.assertionShape),
      jobName: boundedIdentifier(context.jobName ?? "unknown-job"),
      jobId: Number.isInteger(context.jobId) ? context.jobId : null,
      failureClass: "test",
    },
  ];
}

export function buildMergeGroupFailureSignatureReport(input) {
  const groups = [...(input.groups ?? [])]
    .filter((group) => group?.createdAt && !Number.isNaN(Date.parse(group.createdAt)))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const signatures = new Map();

  for (const [groupIndex, group] of groups.entries()) {
    const failuresForGroup = new Map();
    for (const failure of group.failures ?? []) {
      failuresForGroup.set(failure.signature, failuresForGroup.get(failure.signature) ?? failure);
    }
    for (const failure of failuresForGroup.values()) {
      const existing = signatures.get(failure.signature) ?? {
        signature: failure.signature,
        testFile: failure.testFile ?? null,
        testName: failure.testName ?? null,
        assertionShape: failure.assertionShape ?? null,
        failureClass: failure.failureClass ?? "test",
        occurrences: [],
      };
      existing.occurrences.push({
        groupIndex,
        runId: group.runId,
        runAttempt: group.runAttempt,
        createdAt: group.createdAt,
        url: group.url,
        headSha: group.headSha,
        composition: group.composition ?? [],
        jobName: failure.jobName ?? null,
      });
      signatures.set(failure.signature, existing);
    }
  }

  const failures = [...signatures.values()]
    .map((failure) => classifySignature(failure, groups))
    .sort((left, right) => {
      const rank = { "attributed-to-pr": 0, "suspect-flaky": 1, "new-commit-required": 2, observed: 3 };
      return (
        (rank[left.classification] ?? 9) - (rank[right.classification] ?? 9) ||
        left.signature.localeCompare(right.signature)
      );
    });
  const failedRuns = groups.filter((group) => group.conclusion === "failure").length;
  const counts = {
    mergeGroupRuns: groups.length,
    failedRuns,
    trackedSignatures: failures.length,
    suspectFlaky: failures.filter((failure) => failure.classification === "suspect-flaky").length,
    attributed: failures.filter((failure) => failure.classification === "attributed-to-pr").length,
    deterministicRepeats: failures.filter((failure) => failure.classification === "new-commit-required").length,
  };
  const record = {
    schemaVersion: MERGE_GROUP_FAILURE_SIGNATURES_VERSION,
    checkedAt: input.checkedAt,
    mode: "advisory-read-only",
    repository: input.repository,
    window: input.window ?? null,
    counts,
    failures,
  };

  return { record, markdown: renderMergeGroupFailureSignatureMarkdown(record) };
}

function classifySignature(failure, groups) {
  const occurrences = failure.occurrences;
  const compositionFingerprints = new Set(
    occurrences.map((occurrence) => compositionFingerprint(occurrence.composition)),
  );
  const unchangedPasses = occurrences.some((occurrence) => {
    const next = groups[occurrence.groupIndex + 1];
    return (
      next?.conclusion === "success" &&
      !hasRelevantDiff(groups, occurrence.groupIndex, occurrence.groupIndex + 1, failure.testFile)
    );
  });
  const attribution = compositionCorrelation(failure, groups);
  const classification = attribution
    ? "attributed-to-pr"
    : unchangedPasses
      ? "suspect-flaky"
      : occurrences.length > 1 && compositionFingerprints.size === 1 && failure.failureClass === "test"
        ? "new-commit-required"
        : "observed";
  const action = actionFor(classification, failure.failureClass);

  return {
    signature: failure.signature,
    testFile: failure.testFile,
    testName: failure.testName,
    assertionShape: failure.assertionShape,
    failureClass: failure.failureClass,
    firstFailingJob: occurrences[0]?.jobName ?? null,
    occurrenceCount: occurrences.length,
    runs: occurrences.map(({ groupIndex: _groupIndex, ...occurrence }) => occurrence),
    changedHeadCount: compositionFingerprints.size,
    classification,
    attributedPr: attribution?.prNumber ?? null,
    unchangedFailurePassed: unchangedPasses,
    action,
  };
}

function compositionCorrelation(failure, groups) {
  const observedPrs = new Set(
    groups.flatMap((group) => (group.composition ?? []).map((pr) => pr.number)).filter(Number.isInteger),
  );
  for (const prNumber of observedPrs) {
    const containing = groups.filter((group) => group.composition?.some((pr) => pr.number === prNumber));
    const absent = groups.filter((group) => !group.composition?.some((pr) => pr.number === prNumber));
    const containingFailed = containing.some((group) => hasSignature(group, failure.signature));
    const containingPassed = containing.some(
      (group) => group.conclusion === "success" && !hasSignature(group, failure.signature),
    );
    const absentFailed = absent.some((group) => hasSignature(group, failure.signature));
    const absentPassed = absent.some(
      (group) => group.conclusion === "success" && !hasSignature(group, failure.signature),
    );
    if (containingFailed && !containingPassed && !absentFailed && absentPassed) {
      return { prNumber };
    }
  }
  return null;
}

function hasRelevantDiff(groups, fromIndex, toIndex, testFile) {
  if (!testFile) {
    return true;
  }
  const relevantPath = normalizePath(testFile);
  for (const group of groups.slice(fromIndex + 1, toIndex + 1)) {
    for (const pr of group.composition ?? []) {
      if ((pr.changedFiles ?? []).some((file) => normalizePath(file) === relevantPath)) {
        return true;
      }
    }
  }
  return false;
}

function hasSignature(group, signature) {
  return (group.failures ?? []).some((failure) => failure.signature === signature);
}

function actionFor(classification, failureClass) {
  if (classification === "attributed-to-pr") {
    return "new commit required from the attributed PR";
  }
  if (classification === "suspect-flaky") {
    return "report suspect-flaky; do not auto-ignore or re-enqueue unchanged heads";
  }
  if (failureClass === "infrastructure") {
    return "one explicit infrastructure retry permitted";
  }
  if (classification === "new-commit-required") {
    return "new commit required; do not re-enqueue the unchanged head";
  }
  return "review the first failing job and bounded signature";
}

export function renderMergeGroupFailureSignatureMarkdown(record) {
  const lines = [
    "## Merge-group failure signatures",
    "",
    `- Result: ${record.failures.length === 0 ? "success" : "warning"}`,
    `- Mode: ${record.mode}`,
    `- Window: ${record.window?.start ?? "unknown"} to ${record.window?.end ?? "unknown"}`,
    `- Merge-group runs: ${record.counts.mergeGroupRuns}; failed runs: ${record.counts.failedRuns}`,
    `- Tracked signatures: ${record.counts.trackedSignatures}; suspect-flaky: ${record.counts.suspectFlaky}; composition-attributed: ${record.counts.attributed}`,
    "",
  ];
  if (record.failures.length === 0) {
    lines.push("Clean: no failed test signatures were observed in merge-group runs.");
    return lines.join("\n");
  }

  lines.push(
    "| Classification | Signature | Occurrences | PR attribution | Action |",
    "| --- | --- | ---: | --- | --- |",
  );
  for (const failure of record.failures) {
    const label = failure.attributedPr ? `PR #${failure.attributedPr}` : "none";
    lines.push(
      `| ${failure.classification} | ${escapeMarkdownCell(`${failure.testFile ?? "unknown"} > ${failure.testName ?? "unknown"} (${failure.assertionShape ?? "unknown"})`)} | ${failure.occurrenceCount} | ${label} | ${escapeMarkdownCell(failure.action)} |`,
    );
  }
  lines.push(
    "",
    "Policy: a suspect-flaky signature is reported for operator review and is never auto-ignored. A deterministic repeat requires a new PR head; queue membership is never mutated by this report.",
  );
  return lines.join("\n");
}

async function fetchMergeGroupRuns(options, window) {
  const url = new URL(`https://api.github.com/repos/${options.repository}/actions/runs`);
  url.searchParams.set("event", "merge_group");
  url.searchParams.set("created", `${window.start}..${window.end}`);
  url.searchParams.set("per_page", "100");
  return fetchPaginated(options, url, (body) => body?.workflow_runs ?? []);
}

async function fetchRunJobs(options, runId) {
  const url = new URL(`https://api.github.com/repos/${options.repository}/actions/runs/${runId}/jobs`);
  url.searchParams.set("per_page", "100");
  return fetchPaginated(options, url, (body) => body?.jobs ?? []);
}

async function fetchJobLog(options, jobId) {
  const response = await githubFetch(options, `/actions/jobs/${jobId}/logs`);
  return response.text();
}

async function fetchRunComposition(options, run) {
  const pullRequests = Array.isArray(run.pull_requests) && run.pull_requests.length > 0 ? run.pull_requests : null;
  const candidates =
    pullRequests ?? (run.head_sha ? await githubJson(options, `/commits/${run.head_sha}/pulls?per_page=100`) : []);
  const prs = Array.isArray(candidates) ? candidates : [];
  const composition = [];
  for (const pr of prs) {
    const number = Number(pr?.number);
    if (!Number.isInteger(number)) {
      continue;
    }
    const details = pr.head?.sha ? pr : await githubJson(options, `/pulls/${number}`);
    const changedFiles = Array.isArray(details?.changedFiles)
      ? details.changedFiles
      : Array.isArray(details?.files)
        ? details.files.map((file) => file.filename)
        : await fetchPullRequestFiles(options, number);
    composition.push({ number, headSha: details?.head?.sha ?? null, changedFiles });
  }
  return composition.sort((left, right) => left.number - right.number);
}

async function fetchPullRequestFiles(options, number) {
  const files = await githubJson(options, `/pulls/${number}/files?per_page=100`);
  return Array.isArray(files) ? files.map((file) => file?.filename).filter((file) => typeof file === "string") : [];
}

async function fetchPaginated(options, initialUrl, select) {
  const values = [];
  let url = initialUrl;
  while (url) {
    const response = await githubFetch(options, url);
    const selected = select(await response.json());
    values.push(...(Array.isArray(selected) ? selected : []));
    url = nextLink(response.headers?.get?.("link"));
  }
  return values;
}

async function githubJson(options, path) {
  const response = await githubFetch(options, path);
  return response.json();
}

async function githubFetch(options, pathOrUrl) {
  const url = String(pathOrUrl).startsWith("http")
    ? pathOrUrl
    : `https://api.github.com/repos/${options.repository}${pathOrUrl}`;
  const response = await options.fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed for ${url}: ${response.status}`);
  }
  return response;
}

function testFileFromText(line) {
  const match = String(line).match(/((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+)?/i);
  return match ? normalizePath(match[1]) : null;
}

function testNameFromLines(lines, testFile) {
  const fileLine = testFile
    ? lines.find((line) => line.includes(testFile) || line.includes(testFile.replaceAll("/", "\\")))
    : null;
  const fromFile = fileLine?.match(/\s>\s(.+?)\s*$/)?.[1];
  if (fromFile) {
    return boundedIdentifier(fromFile.replace(/^\([^)]*\)\s*/, ""));
  }
  const failedTest = lines.find((line) => /^\s*[×✖]\s+/.test(line));
  return failedTest ? boundedIdentifier(failedTest.replace(/^\s*[×✖]\s+/, "")) : null;
}

function assertionShapeFromLines(lines) {
  const assertion = lines.find((line) => /(?:AssertionError|TypeError|expected\s+.+\s+to\s+)/i.test(line));
  if (!assertion) {
    return null;
  }
  const normalized = assertion.trim();
  if (/^TypeError:/i.test(normalized)) {
    return boundedIdentifier(normalized.replace(/\s+at\s+.+$/, ""));
  }
  const matcher = normalized.match(/\bto\s+.+$/i)?.[0] ?? normalized;
  return boundedIdentifier(
    matcher
      .replace(/\b\d+(?:\.\d+)?\b/g, "<number>")
      .replace(/(['"])(?:\\.|(?!\1).)*\1/g, "<value>")
      .replace(/\{[^}]*\}|\[[^\]]*\]/g, "<value>"),
  );
}

function fallbackInfrastructureSignature(context) {
  const workspace = boundedIdentifier(context.workspace ?? context.jobName ?? "unknown-workspace");
  const assertionShape = "infrastructure-failure";
  return {
    testFile: null,
    testName: null,
    assertionShape,
    workspace,
    signature: signatureId(`workspace:${workspace}`, "infrastructure", assertionShape),
    jobName: boundedIdentifier(context.jobName ?? "unknown-job"),
    jobId: Number.isInteger(context.jobId) ? context.jobId : null,
    failureClass: "infrastructure",
  };
}

function signatureId(testFile, testName, assertionShape) {
  return createHash("sha256").update(`${testFile}\n${testName}\n${assertionShape}`).digest("hex").slice(0, 16);
}

function compositionFingerprint(composition) {
  return (composition ?? [])
    .map((pr) => `${pr.number}:${pr.headSha ?? "unknown"}`)
    .sort()
    .join(",");
}

function normalizePath(value) {
  const normalized = String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  const match = normalized.match(/(?:^|\/)((?:tests|features|packages|bounded-contexts)\/.*)$/i);
  return (match?.[1] ?? normalized).toLowerCase();
}

function boundedIdentifier(value) {
  return String(value ?? "unknown")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replaceAll(/https?:\/\/[^\s)]+/gi, "<url>")
    .replaceAll(/\b(?:account|acct|usr|user|cart|crt|chk|pay|po|evt)_[0-9A-Za-z_:-]+\b/gi, "<identifier>")
    .trim()
    .slice(0, 240);
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "");
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

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeMarkdownCell(value) {
  return String(value).replaceAll("|", "\\|");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${value}\n`);
}

async function main(argv, env = process.env) {
  try {
    const options = parseMergeGroupFailureSignaturesArgs(argv, env);
    const result = await collectMergeGroupFailureSignatures(options);
    if (options.outPath) {
      await writeJson(options.outPath, result.record);
    }
    if (options.markdownOutPath) {
      await writeText(options.markdownOutPath, result.markdown);
    }
    console.log(result.markdown);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
