import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPORTER_JOB_NAME = "Report Preview Cleanup Failure";
const REPORTER_STEP_NAME = "Report workflow failure";
const OBSERVATION_SCHEMA = "preview-cleanup-run-observation/v1";
const ALLOWED_CONCLUSIONS = new Set(["success", "skipped"]);
const KNOWN_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "success",
  "skipped",
  "stale",
  "timed_out",
]);

function positiveInteger(value, field) {
  if (!/^\d+$/.test(String(value ?? "")) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Number(value);
}

function conclusionOf(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jobSummary(job) {
  return { name: String(job?.name ?? ""), conclusion: conclusionOf(job?.conclusion) };
}

function reporterStepConclusion(reporter) {
  const step = reporter?.steps?.find((candidate) => candidate?.name === REPORTER_STEP_NAME);
  return conclusionOf(step?.conclusion);
}

/**
 * Classify only the completed attempt's jobs. The run conclusion is a
 * supporting fact, never a substitute for the job list. `jobs` is every job
 * read; `listedJobs` is the subset an alert names.
 */
export function classifyPreviewCleanupRun({ run, jobs, totalCount = jobs.length }) {
  if (!run || !Array.isArray(jobs) || !Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw new Error("run, jobs, and totalCount are required.");
  }

  const summaries = jobs.map(jobSummary);
  const reporter = jobs.find((job) => job?.name === REPORTER_JOB_NAME);
  const reporterStep = reporterStepConclusion(reporter);
  const runConclusion = conclusionOf(run.conclusion);

  if (jobs.length < totalCount) {
    return {
      classification: "unreported",
      reason: "incomplete-job-list",
      jobs: summaries,
      listedJobs: summaries,
      reporterStepConclusion: reporterStep,
    };
  }

  const unknown = jobs.filter((job) => !KNOWN_CONCLUSIONS.has(job?.conclusion));
  if (unknown.length > 0 || !KNOWN_CONCLUSIONS.has(run.conclusion)) {
    return {
      classification: "unreported",
      reason: "unknown-conclusion",
      jobs: summaries,
      listedJobs: summaries,
      reporterStepConclusion: reporterStep,
    };
  }

  if (reporterStep === "success") {
    return {
      classification: "reported",
      reason: null,
      jobs: summaries,
      listedJobs: [],
      reporterStepConclusion: reporterStep,
    };
  }

  if (!reporter) {
    return {
      classification: "unreported",
      reason: "missing-reporter",
      jobs: summaries,
      listedJobs: summaries,
      reporterStepConclusion: null,
    };
  }

  const unfinished = summaries.filter((job) => !ALLOWED_CONCLUSIONS.has(job.conclusion));
  if (ALLOWED_CONCLUSIONS.has(runConclusion) && unfinished.length === 0) {
    return {
      classification: "clean",
      reason: null,
      jobs: summaries,
      listedJobs: [],
      reporterStepConclusion: reporterStep,
    };
  }

  return {
    classification: "unreported",
    reason: "unfinished-jobs",
    jobs: summaries,
    listedJobs: unfinished,
    reporterStepConclusion: reporterStep,
  };
}

function repositoryFromEnvironment() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[^/]+\/[^/]+$/.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY is required.");
  return repository;
}

async function githubJson(path) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required.");
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status}).`);
  return response.json();
}

export async function readAttemptJobs({ repository, runId, runAttempt, fetchJson = githubJson }) {
  const jobs = [];
  let totalCount = null;
  for (let page = 1; ; page += 1) {
    const body = await fetchJson(
      `/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`,
    );
    if (!Number.isSafeInteger(body?.total_count) || body.total_count < 0 || !Array.isArray(body.jobs)) {
      throw new Error("GitHub jobs response was malformed.");
    }
    totalCount ??= body.total_count;
    if (body.total_count !== totalCount) throw new Error("GitHub jobs total changed while paging.");
    jobs.push(...body.jobs);
    if (jobs.length >= totalCount || body.jobs.length === 0) break;
  }
  return { jobs, totalCount };
}

function observationPath() {
  return resolve(process.env.OBSERVATION_PATH ?? "artifacts/preview-cleanup-run-observation.json");
}

function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const delimiter = `preview_cleanup_${name}_${process.pid}_${Date.now()}`;
  appendFileSync(output, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

function observationRecord({ run, runAttempt, classification }) {
  const record = {
    schemaVersion: OBSERVATION_SCHEMA,
    runId: run.id,
    runAttempt,
    event: run.event,
    runConclusion: conclusionOf(run.conclusion),
    jobs: classification.jobs,
    reporterStepConclusion: classification.reporterStepConclusion,
    classification: classification.classification,
    reason: classification.reason,
    alerted: false,
  };
  return record;
}

function alertDetails({ repository, run, runAttempt, classification }) {
  const runUrl = run.html_url ?? `https://github.com/${repository}/actions/runs/${run.id}`;
  const jobs = classification.listedJobs
    .map(({ name, conclusion }) => `- ${name}: ${conclusion ?? "unknown"}`)
    .join("\n");
  return [`Run: ${runUrl}`, `Attempt: ${runAttempt}`, `Conclusion: ${run.conclusion ?? "unknown"}`, jobs].join("\n");
}

/**
 * Read one completed attempt of a scheduled Platform Preview Cleanup run and
 * return its observation record and alert details. Any other run fails before
 * its jobs are read.
 */
export async function observePreviewCleanupRun({ repository, runId, runAttempt, fetchJson = githubJson }) {
  const run = await fetchJson(`/repos/${repository}/actions/runs/${runId}`);
  if (run?.name !== "Platform Preview Cleanup" || run?.event !== "schedule") {
    throw new Error("The observed run is not a scheduled Platform Preview Cleanup run.");
  }
  if (run.run_attempt !== runAttempt) throw new Error("The observed run attempt does not match the requested attempt.");
  const { jobs, totalCount } = await readAttemptJobs({ repository, runId, runAttempt, fetchJson });
  const classification = classifyPreviewCleanupRun({ run, jobs, totalCount });
  return {
    record: observationRecord({ run, runAttempt, classification }),
    details: alertDetails({ repository, run, runAttempt, classification }),
  };
}

async function observe() {
  const repository = repositoryFromEnvironment();
  const runId = positiveInteger(process.env.OBSERVED_RUN_ID, "OBSERVED_RUN_ID");
  const runAttempt = positiveInteger(process.env.OBSERVED_RUN_ATTEMPT, "OBSERVED_RUN_ATTEMPT");
  const { record, details } = await observePreviewCleanupRun({ repository, runId, runAttempt });
  const path = observationPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  writeOutput("classification", record.classification);
  writeOutput("reason", record.reason ?? "");
  writeOutput("summary", "Scheduled preview cleanup did not finish cleanly or its reporter did not post.");
  writeOutput("details", details);
  writeOutput("record_path", path);
}

function markAlerted() {
  const path = observationPath();
  const record = JSON.parse(readFileSync(path, "utf8"));
  record.alerted = true;
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "observe") await observe();
  else if (command === "mark-alerted") markAlerted();
  else throw new Error("Usage: node scripts/preview-cleanup-run-observer.mjs <observe|mark-alerted>");
}
