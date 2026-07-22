#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { parseCircuitMarker } from "./release-health-merge-group-failure-signatures.mjs";

export const RELEASE_HEALTH_FLAKE_DIGEST_VERSION = "release-health-flake-digest/v1";
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_RETRY_THRESHOLD = 3;
export const DEFAULT_FLAKY_FAILURE_THRESHOLD = 1;
const PER_SPEC_ARTIFACT_PREFIX = "playwright-e2e-results-v1-";
const PER_SPEC_ARTIFACT_SCHEMA_MARKER = "PER_SPEC_FLAKE_TELEMETRY_SCHEMA=playwright-per-spec-flake/v1";
const PLAYWRIGHT_REPORT_PATH = "results/playwright-results.json";
// Retained red-run diagnostic bundles are currently as large as 98 MiB. The
// machine-readable payload is uploaded separately, but retain a bounded reader
// for historical v1 artifacts rather than trusting a server-provided length.
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

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
  const perSpecTelemetry = await collectPerSpecFlakeTelemetry(options, currentRuns);

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
    perSpecTelemetry,
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
  const topFlakySpecs = summarizePerSpecFlakes(input.perSpecTelemetry ?? []);
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
    topFlakySpecs,
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
  } else {
    lines.push("| Job | Retries | Trend | Flaky successful retries | Trend | Breach |");
    lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
    for (const job of digest.topFlakyJobs) {
      lines.push(
        `| ${escapeMarkdownCell(job.name)} | ${job.retryCount} | ${formatSignedDelta(job.retryTrend)} | ${job.flakyFailureCount} | ${formatSignedDelta(job.flakyFailureTrend)} | ${job.breached ? "yes" : "no"} |`,
      );
    }
  }

  if (digest.topFlakySpecs.length > 0) {
    lines.push("", "### Per-spec Playwright telemetry", "", "| Spec | Passed on retry | Failed jobs | Example run |");
    lines.push("| --- | ---: | ---: | --- |");
    for (const spec of digest.topFlakySpecs) {
      lines.push(
        `| ${escapeMarkdownCell(spec.name)} | ${spec.passedOnRetryCount} | ${spec.failedJobCount} | [run](${spec.runUrl}) |`,
      );
    }
  }

  if (digest.breachCount > 0) {
    lines.push("", "### Actionable work item", "", `Open or update: ${digest.issueTitle}`);
  } else {
    lines.push("", "Clean: no job crossed the configured flake threshold.");
  }

  return lines.join("\n");
}

/**
 * Reads only reports made eligible by the workflow source at the run's exact head.
 * That keeps pre-producer retained runs readable while making a missing or malformed
 * report from a producer-enabled run an explicit collector failure.
 */
export async function collectPerSpecFlakeTelemetry(options, runs) {
  const telemetry = [];
  for (const run of runs) {
    if (!(await runProducesPerSpecTelemetry(options, run))) continue;
    const jobs = await fetchRunJobsForFlakeDigest(options, run.id);
    const attempt = authoritativeRunAttempt(run);
    const e2eJobs = jobs.filter((job) => isEligibleE2eJob(job, attempt));
    // Scope-skipped and in-progress placeholders intentionally publish no report.
    if (e2eJobs.length === 0) continue;
    const artifacts = await fetchRunArtifacts(options, run.id);
    const expectedPrefix = `${PER_SPEC_ARTIFACT_PREFIX}${run.id}-${attempt}-`;
    const reports = artifacts.filter((artifact) => String(artifact?.name ?? "").startsWith(expectedPrefix));
    if (reports.length !== e2eJobs.length) {
      throw new Error(
        `Run ${run.id} attempt ${attempt} has ${e2eJobs.length} eligible E2E jobs but ${reports.length} per-spec report artifacts.`,
      );
    }
    const matrixIndices = new Set();
    for (const artifact of reports) {
      const matrixIndex = String(artifact.name).slice(expectedPrefix.length);
      if (!/^\d+$/.test(matrixIndex)) throw new Error(`Artifact ${artifact.id} has an invalid matrix identity.`);
      if (matrixIndices.has(matrixIndex))
        throw new Error(`Run ${run.id} attempt ${attempt} has duplicate matrix artifact ${matrixIndex}.`);
      matrixIndices.add(matrixIndex);
      const report = await readPlaywrightReportArtifact(options, artifact);
      telemetry.push(
        ...extractPlaywrightSpecTelemetry(report, { run, runAttempt: attempt, matrixIndex, artifactId: artifact.id }),
      );
    }
  }
  return collapsePerSpecTelemetry(telemetry);
}

export function extractPlaywrightSpecTelemetry(report, source) {
  const entries = [];
  for (const suite of report?.suites ?? []) collectSuiteSpecs(suite, [], entries, source);
  return entries;
}

export function collapsePerSpecTelemetry(entries) {
  const collapsed = new Map();
  for (const entry of entries) {
    const prior = collapsed.get(entry.occurrenceId);
    if (!prior) {
      collapsed.set(entry.occurrenceId, entry);
      continue;
    }
    if (prior.terminalStatus !== entry.terminalStatus || prior.terminalRetry !== entry.terminalRetry) {
      throw new Error(`Conflicting terminal Playwright outcomes for ${entry.occurrenceId}.`);
    }
  }
  return [...collapsed.values()];
}

export function summarizePerSpecFlakes(entries) {
  const specs = new Map();
  for (const entry of entries) {
    const previous = specs.get(entry.name) ?? {
      name: entry.name,
      passedOnRetryCount: 0,
      failedJobCount: 0,
      runUrl: entry.runUrl,
    };
    if (entry.terminalStatus === "passed" && entry.terminalRetry > 0) previous.passedOnRetryCount += 1;
    if (["failed", "timedOut", "interrupted"].includes(entry.terminalStatus)) previous.failedJobCount += 1;
    specs.set(entry.name, previous);
  }
  return [...specs.values()]
    .filter((spec) => spec.passedOnRetryCount > 0 || spec.failedJobCount > 0)
    .sort(
      (a, b) =>
        b.passedOnRetryCount + b.failedJobCount - (a.passedOnRetryCount + a.failedJobCount) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 10);
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

async function fetchRunJobsForFlakeDigest(options, runId) {
  return fetchPaginated(options, `/actions/runs/${runId}/jobs?filter=all&per_page=100`, "jobs");
}

async function fetchRunArtifacts(options, runId) {
  return fetchPaginated(options, `/actions/runs/${runId}/artifacts?per_page=100`, "artifacts");
}

async function fetchPaginated(options, path, field) {
  const values = [];
  let url = new URL(`https://api.github.com/repos/${options.repository}${path}`);
  while (url) {
    const response = await githubFetch(options, url);
    if (!response.ok) throw new Error(`GitHub ${field} lookup failed: ${response.status}`);
    const body = await response.json();
    values.push(...(Array.isArray(body?.[field]) ? body[field] : []));
    url = nextLink(response.headers?.get?.("link"));
  }
  return values;
}

export async function runProducesPerSpecTelemetry(options, run) {
  if (!run?.head_sha) return false;
  const url = new URL(`https://api.github.com/repos/${options.repository}/contents/.github/workflows/platform-pr.yml`);
  url.searchParams.set("ref", run.head_sha);
  const response = await githubFetch(options, url);
  // A pre-producer commit intentionally has no report contract. It remains readable.
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Workflow source lookup for run ${run.id} failed: ${response.status}`);
  const body = await response.json();
  const workflow = Buffer.from(String(body?.content ?? "").replaceAll(/\s/g, ""), "base64").toString("utf8");
  return workflowProducesPerSpecTelemetry(workflow);
}

export function workflowProducesPerSpecTelemetry(workflow) {
  const raw = String(workflow);
  const normalized = raw.replaceAll(/\s/g, "");
  return (
    raw.includes(PER_SPEC_ARTIFACT_SCHEMA_MARKER) &&
    normalized.includes(
      "playwright-e2e-results-v1-${{github.run_id}}-${{github.run_attempt}}-${{strategy.job-index}}",
    ) &&
    normalized.includes("artifacts/playwright/per-spec-flake-telemetry") &&
    normalized.includes("name:Uploadper-specflaketelemetryv1") &&
    normalized.includes("if:always()")
  );
}

async function readPlaywrightReportArtifact(options, artifact) {
  if (!artifact?.archive_download_url) throw new Error(`Artifact ${artifact?.id ?? "unknown"} has no download URL.`);
  const response = await githubFetch(options, artifact.archive_download_url);
  if (!response.ok) throw new Error(`Artifact ${artifact.id} download failed: ${response.status}`);
  const bytes = await readBoundedResponseBytes(response, MAX_ARTIFACT_BYTES, `Artifact ${artifact.id}`);
  const payload = readExactZipEntry(bytes, PLAYWRIGHT_REPORT_PATH, MAX_REPORT_BYTES);
  try {
    return validatePlaywrightReport(JSON.parse(payload.toString("utf8")));
  } catch {
    throw new Error(`Artifact ${artifact.id} has malformed ${PLAYWRIGHT_REPORT_PATH}.`);
  }
}

async function githubFetch(options, url) {
  return options.fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

function collectSuiteSpecs(suite, parents, entries, source) {
  const path = [...parents, suite?.title].filter(Boolean);
  for (const spec of suite?.specs ?? []) {
    for (const test of spec?.tests ?? []) {
      const results = [...(test?.results ?? [])].filter((result) => Number.isInteger(result?.retry));
      if (results.length === 0) continue;
      const terminalRetry = Math.max(...results.map((result) => result.retry));
      const terminal = results.filter((result) => result.retry === terminalRetry).at(-1);
      const name = [...path, spec.title, test.projectName].filter(Boolean).join(" › ");
      entries.push({
        name,
        occurrenceId: `${source.run.id}:${source.runAttempt}:${source.matrixIndex}:${name}`,
        terminalStatus: terminal.status,
        terminalRetry,
        runUrl:
          source.run.html_url ??
          `https://github.com/${source.run.repository?.full_name ?? ""}/actions/runs/${source.run.id}`,
      });
    }
  }
  for (const child of suite?.suites ?? []) collectSuiteSpecs(child, path, entries, source);
}

export function unzipJsonEntries(buffer) {
  const entries = new Map();
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("Artifact archive is not a supported ZIP file.");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  if (entryCount > 1_000) throw new Error("Artifact ZIP contains too many entries.");
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Artifact ZIP central directory is invalid.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (name.toLowerCase().endsWith(".json")) {
      if (uncompressedSize > 2 * 1024 * 1024) throw new Error(`Artifact JSON entry ${name} exceeds 2 MiB.`);
      if (method === 0) entries.set(name, compressed);
      else if (method === 8) entries.set(name, inflateRawSync(compressed));
      else throw new Error(`Artifact ZIP uses unsupported compression method ${method}.`);
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function authoritativeRunAttempt(run) {
  const attempt = positiveInteger(run?.run_attempt, 1);
  if (attempt < 1) throw new Error(`Run ${run?.id ?? "unknown"} has an invalid authoritative run attempt.`);
  return attempt;
}

function isEligibleE2eJob(job, attempt) {
  return (
    /^E2E Tests \(/.test(job?.name ?? "") &&
    positiveInteger(job?.run_attempt, attempt) === attempt &&
    job?.status === "completed" &&
    job?.conclusion !== "skipped"
  );
}

async function readBoundedResponseBytes(response, maximum, label) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`${label} exceeds ${formatMiB(maximum)}.`);
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximum) throw new Error(`${label} exceeds ${formatMiB(maximum)}.`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error(`${label} exceeds ${formatMiB(maximum)}.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, size);
}

function readExactZipEntry(buffer, expectedName, maximum) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("Artifact archive is not a supported ZIP file.");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  if (entryCount > 1_000) throw new Error("Artifact ZIP contains too many entries.");
  let offset = buffer.readUInt32LE(eocd + 16);
  const matches = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Artifact ZIP central directory is invalid.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    if (name === expectedName) matches.push({ method, compressedSize, uncompressedSize, localOffset, name });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  if (matches.length !== 1) throw new Error(`Artifact must contain exactly one ${expectedName} payload.`);
  const entry = matches[0];
  if (entry.uncompressedSize > maximum)
    throw new Error(`Artifact JSON entry ${entry.name} exceeds ${formatMiB(maximum)}.`);
  const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (compressed.length !== entry.compressedSize) throw new Error("Artifact ZIP entry is truncated.");
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawSync(compressed, { maxOutputLength: maximum });
  throw new Error(`Artifact ZIP uses unsupported compression method ${entry.method}.`);
}

function validatePlaywrightReport(report) {
  if (!isRecord(report) || !Array.isArray(report.suites))
    throw new Error("Playwright report must contain a suites array.");
  for (const suite of report.suites) validateSuite(suite);
  return report;
}

function validateSuite(suite) {
  if (!isRecord(suite) || typeof suite.title !== "string") throw new Error("Playwright suite is malformed.");
  if (suite.suites !== undefined) {
    if (!Array.isArray(suite.suites)) throw new Error("Playwright child suites are malformed.");
    for (const child of suite.suites) validateSuite(child);
  }
  if (suite.specs !== undefined) {
    if (!Array.isArray(suite.specs)) throw new Error("Playwright suite specs are malformed.");
    for (const spec of suite.specs) validateSpec(spec);
  }
}

function validateSpec(spec) {
  if (!isRecord(spec) || typeof spec.title !== "string" || !Array.isArray(spec.tests))
    throw new Error("Playwright spec is malformed.");
  for (const test of spec.tests) {
    if (
      !isRecord(test) ||
      !Array.isArray(test.results) ||
      (test.projectName !== undefined && typeof test.projectName !== "string")
    )
      throw new Error("Playwright test is malformed.");
    for (const result of test.results) {
      if (
        !isRecord(result) ||
        !Number.isInteger(result.retry) ||
        result.retry < 0 ||
        !PLAYWRIGHT_RESULT_STATUSES.has(result.status)
      )
        throw new Error("Playwright result is malformed.");
    }
  }
}

const PLAYWRIGHT_RESULT_STATUSES = new Set(["passed", "skipped", "failed", "timedOut", "interrupted"]);
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function formatMiB(bytes) {
  return `${bytes / (1024 * 1024)} MiB`;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
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
