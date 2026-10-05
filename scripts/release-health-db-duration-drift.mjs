#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readOption } from "./lib/cli-options.mjs";
import { listWorkspacePackages, repoRoot } from "./lib/repo.mjs";
import { DB_TEST_SCRIPT_SELECTOR, validateRunWorkspacesSummary, workspaceScriptNames } from "./run-workspaces.mjs";
import {
  DB_DURATION_BASELINE_PATH,
  RECOMPUTE_SAMPLE_SIZE,
  driftBound,
  parseBaselineInstant,
  validateDbDurationBaseline,
} from "./check-structure/db-duration-baseline.mjs";

export const MAX_LOG_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const PRODUCER_CREATED_AT = "2026-10-05T04:44:41Z";
const WORKFLOW = "platform-db-duration-drift.yml";
const PAGE_SIZE = 100;
const MAX_ITEMS = 1000;
const DETECTION_SAMPLE_SIZE = 10;
const DAY_MS = 86_400_000;

export function upperMedian(values) {
  if (!values.length || values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Median requires positive integer observations.");
  }
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

export function dbWorkspaceCensus(workspaces = listWorkspacePackages()) {
  const names = workspaces
    .filter((workspace) => workspaceScriptNames(workspace, DB_TEST_SCRIPT_SELECTOR).length > 0)
    .map((workspace) => workspace.name)
    .sort();
  if (!names.length || new Set(names).size !== names.length)
    throw new Error("Missing or duplicate DB workspace census.");
  return names;
}

export function classifyDbJob({ run, job, log, workspaceNames }) {
  const exclude = (reason) => ({ eligible: false, runId: run.id, jobId: job.id, reason });
  if (run.event !== "merge_group") return exclude("not-merge-group");
  if (job.status !== "completed" || job.conclusion !== "success") return exclude(`job-${job.conclusion ?? job.status}`);
  const lines = log.split(/\r?\n/).filter((line) => /^(?:\d{4}-\d{2}-\d{2}T\S+\s+)?RUN_WORKSPACES_SUMMARY /.test(line));
  if (lines.length !== 1) return exclude(lines.length ? "duplicate-summary" : "summary-less");
  let summary;
  try {
    summary = validateRunWorkspacesSummary(
      JSON.parse(lines[0].slice(lines[0].indexOf("RUN_WORKSPACES_SUMMARY ") + 23)),
    );
  } catch {
    return exclude("malformed-summary");
  }
  if (
    summary.scriptName !== "test:db" ||
    summary.failedCount ||
    summary.tasks.some((task) => task.outcome !== "passed")
  ) {
    return exclude("not-complete-green-db-summary");
  }
  const tasks = new Map(summary.tasks.map((task) => [task.workspace, task]));
  if (tasks.size !== summary.tasks.length) return exclude("duplicate-workspace");
  if (workspaceNames.some((name) => !tasks.has(name))) return exclude("scoped-summary");
  const workspaces = Object.fromEntries(workspaceNames.map((name) => [name, tasks.get(name).actualDurationMs]));
  if (Object.values(workspaces).some((ms) => ms <= 0)) return exclude("nonpositive-duration");
  const started = parseBaselineInstant(job.started_at);
  const completed = parseBaselineInstant(job.completed_at);
  if (completed <= started || completed - started > DAY_MS) throw new Error(`Invalid job wall time: ${job.id}`);
  return {
    eligible: true,
    runId: run.id,
    jobId: job.id,
    headSha: run.head_sha,
    completedAt: job.completed_at,
    workspaces,
    jobWallMs: completed - started,
    reason: "complete-green-summary-validated",
  };
}

function latestUniqueJobs(jobs) {
  const ids = new Set();
  for (const job of jobs) {
    if (!Number.isSafeInteger(job.jobId) || job.jobId <= 0 || ids.has(job.jobId))
      throw new Error("Duplicate or invalid job ID.");
    ids.add(job.jobId);
  }
  return [...jobs].sort(
    (a, b) => parseBaselineInstant(b.completedAt) - parseBaselineInstant(a.completedAt) || b.jobId - a.jobId,
  );
}

function medians(jobs, workspaceNames) {
  return {
    workspaces: Object.fromEntries(
      workspaceNames.map((name) => [name, upperMedian(jobs.map((job) => job.workspaces[name]))]),
    ),
    jobWallMs: upperMedian(jobs.map((job) => job.jobWallMs)),
  };
}

export function buildDbDurationDigest({
  baseline,
  collection,
  workspaceNames,
  checkedAt,
  headSha,
  repository,
  recompute = false,
}) {
  validateDbDurationBaseline(baseline);
  const ratified = baseline.recomputes.at(-1);
  const result = {
    schemaVersion: "db-duration-drift/v1",
    checkedAt,
    headSha,
    repository,
    baselineState: ratified ? "ratified" : "baseline-pending",
    baselineSha256: createHash("sha256").update(JSON.stringify(baseline)).digest("hex"),
    ratifiedAt: ratified?.recomputedAt ?? null,
    state: "unknown",
    cohortReady: false,
    required: recompute || !ratified ? RECOMPUTE_SAMPLE_SIZE : DETECTION_SAMPLE_SIZE,
    eligibleCount: 0,
    includedJobIds: [],
    excluded: collection.excluded,
    workspaceNames,
    collection: { status: collection.status, reasons: collection.reasons },
  };
  if (collection.status !== "complete") return result;
  const now = parseBaselineInstant(checkedAt);
  let jobs = latestUniqueJobs(collection.jobs);
  if (jobs.some((job) => parseBaselineInstant(job.completedAt) > now)) throw new Error("Future job completion.");
  const expired =
    ratified && !recompute ? jobs.filter((job) => parseBaselineInstant(job.completedAt) < now - 14 * DAY_MS) : [];
  if (ratified && !recompute) jobs = jobs.filter((job) => parseBaselineInstant(job.completedAt) >= now - 14 * DAY_MS);
  result.eligibleCount = jobs.length;
  const selected = jobs.slice(0, result.required);
  result.includedJobIds = selected.map((job) => job.jobId);
  result.excluded = [
    ...result.excluded,
    ...expired.map((job) => ({ jobId: job.jobId, reason: "outside-detection-window" })),
    ...jobs.slice(result.required).map((job) => ({ jobId: job.jobId, reason: "older-than-selected-cohort" })),
  ];
  if (!ratified) {
    result.state = "baseline-pending";
    result.cohortReady = jobs.length >= RECOMPUTE_SAMPLE_SIZE;
    return result;
  }
  if (jobs.length < result.required) {
    result.state = "insufficient-sample";
    return result;
  }
  result.state = "ratified";
  const observed = medians(selected, workspaceNames);
  result.verdicts = [...workspaceNames, "jobWall"].map((key) => {
    const baselineMs = key === "jobWall" ? ratified.jobWallMs : ratified.workspaces[key];
    const observedMs = key === "jobWall" ? observed.jobWallMs : observed.workspaces[key];
    return baselineMs === undefined
      ? { key, state: "unbaselined", observedMs }
      : {
          key,
          state: observedMs > driftBound(baselineMs) ? "breach" : "healthy",
          observedMs,
          baselineMs,
          boundMs: driftBound(baselineMs),
        };
  });
  return result;
}

export async function recomputeDbDurationBaseline({
  baselinePath,
  collection,
  workspaceNames,
  checkedAt,
  cause,
  read = readFile,
  write = writeFile,
}) {
  if (collection.status !== "complete") throw new Error("unknown: incomplete collection; record unchanged.");
  const jobs = latestUniqueJobs(collection.jobs).slice(0, RECOMPUTE_SAMPLE_SIZE);
  if (jobs.length < RECOMPUTE_SAMPLE_SIZE)
    throw new Error("insufficient-cohort: exactly 20 eligible jobs required; record unchanged.");
  const original = await read(baselinePath, "utf8");
  const baseline = validateDbDurationBaseline(JSON.parse(original));
  if (!baseline.recomputes.length && cause !== "initial (#6660 split)")
    throw new Error('First recompute requires --cause "initial (#6660 split)".');
  const entry = {
    recomputedAt: checkedAt,
    sampleJobIds: jobs.map((job) => job.jobId),
    ...medians(jobs, workspaceNames),
    cause: cause ?? null,
  };
  const next = validateDbDurationBaseline({ ...baseline, recomputes: [...baseline.recomputes, entry] }, baseline);
  if ((await read(baselinePath, "utf8")) !== original)
    throw new Error("Baseline changed during recompute; record unchanged.");
  await write(baselinePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return entry;
}

export async function readBoundedBody(response, limit, signal) {
  if (!response.body) throw new Error("Missing response body.");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error(`Response exceeds ${limit} bytes.`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel();
    reader.releaseLock();
  }
}

function apiClient(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const deadline = AbortSignal.timeout(8 * 60_000);
  return async (suffix, { log = false, method = "GET", body } = {}) => {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(30_000)]);
    const apiPath = suffix.startsWith("search/") ? suffix : `repos/${options.repository}/${suffix}`;
    const response = await fetchImpl(`https://api.github.com/${apiPath}`, {
      method,
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub ${response.status}: ${suffix}`);
    const text = await readBoundedBody(response, log ? MAX_LOG_BYTES : MAX_JSON_BYTES, signal);
    if (options.evidenceDir && method === "GET") {
      const name = suffix.replace(/[^a-zA-Z0-9.-]/g, "_");
      await mkdir(options.evidenceDir, { recursive: true });
      await writeFile(path.join(options.evidenceDir, `${name}.${log ? "log" : "json"}`), text);
    }
    return { payload: log ? text : JSON.parse(text), link: response.headers.get("link") };
  };
}

async function collectPages(request, suffix, field) {
  const items = [];
  const ids = new Set();
  let total;
  for (let page = 1; page <= MAX_ITEMS / PAGE_SIZE; page++) {
    const { payload, link } = await request(
      `${suffix}${suffix.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`,
    );
    const values = field ? payload[field] : payload;
    if (!Array.isArray(values) || values.length > PAGE_SIZE) throw new Error(`Malformed ${field ?? "issues"} page.`);
    if (field) {
      if (field === "items" && payload.incomplete_results !== false) throw new Error("Incomplete issue search.");
      if (!Number.isSafeInteger(payload.total_count) || payload.total_count < 0)
        throw new Error("Missing pagination total.");
      if (total !== undefined && total !== payload.total_count) throw new Error("Pagination total changed.");
      total = payload.total_count;
      if (total > MAX_ITEMS) throw new Error("Collection cap exhausted.");
    }
    for (const value of values) {
      if (!Number.isSafeInteger(value.id) || value.id <= 0 || ids.has(value.id))
        throw new Error("Duplicate or invalid page identity.");
      ids.add(value.id);
      items.push(value);
    }
    const hasNext = /;\s*rel="next"/.test(link ?? "");
    if (field && (items.length > total || (items.length === total && hasNext)))
      throw new Error("Contradictory pagination.");
    if (!hasNext) {
      if (field && items.length !== total) throw new Error("Incomplete pagination.");
      if (!field && values.length === PAGE_SIZE) throw new Error("Issue pagination omitted next link.");
      return items;
    }
    if (!values.length) throw new Error("Empty page with next link.");
  }
  throw new Error("Collection cap exhausted.");
}

export async function collectDbDurationJobs(options) {
  const jobs = [];
  const excluded = [];
  try {
    const request = apiClient(options);
    const runs = await collectPages(
      request,
      `actions/workflows/platform-pr.yml/runs?event=merge_group&created=${encodeURIComponent(`${PRODUCER_CREATED_AT}..${options.checkedAt}`)}`,
      "workflow_runs",
    );
    for (const run of runs) {
      if (
        run.event !== "merge_group" ||
        run.path !== ".github/workflows/platform-pr.yml" ||
        !/^[a-f0-9]{40}$/.test(run.head_sha) ||
        !Number.isSafeInteger(run.run_attempt) ||
        run.run_attempt < 1
      ) {
        throw new Error(`Run identity mismatch: ${run.id}`);
      }
      const inventory = await collectPages(request, `actions/runs/${run.id}/jobs?filter=all`, "jobs");
      const candidates = inventory.filter((job) => job.name === "DB Profile Tests");
      if (!candidates.length || new Set(candidates.map((job) => job.run_attempt)).size !== candidates.length)
        throw new Error(`Missing or duplicate DB job: ${run.id}`);
      for (const job of candidates) {
        if (
          job.run_id !== run.id ||
          job.head_sha !== run.head_sha ||
          !Number.isSafeInteger(job.run_attempt) ||
          job.run_attempt < 1 ||
          job.run_attempt > run.run_attempt
        )
          throw new Error(`Job identity mismatch: ${job.id}`);
        if (job.status !== "completed" || job.conclusion !== "success") {
          excluded.push({ runId: run.id, jobId: job.id, reason: `job-${job.conclusion ?? job.status}` });
          continue;
        }
        const execution = job.steps?.filter((step) => step.name === "Run DB-profile tests");
        if (execution?.length !== 1 || execution[0].status !== "completed" || execution[0].conclusion !== "success")
          throw new Error(`DB execution step authority missing: ${job.id}`);
        const stepStart = parseBaselineInstant(execution[0].started_at);
        const stepEnd = parseBaselineInstant(execution[0].completed_at);
        if (
          stepStart < parseBaselineInstant(job.started_at) ||
          stepEnd > parseBaselineInstant(job.completed_at) ||
          stepEnd < stepStart
        )
          throw new Error(`DB execution timestamps contradict job: ${job.id}`);
        const { payload: log } = await request(`actions/jobs/${job.id}/logs`, { log: true });
        const result = classifyDbJob({ run, job, log, workspaceNames: options.workspaceNames });
        if (result.eligible) jobs.push(result);
        else excluded.push(result);
      }
    }
    latestUniqueJobs(jobs);
    return { status: "complete", reasons: [], jobs, excluded };
  } catch (error) {
    return { status: "unknown", reasons: [error.message], jobs, excluded };
  }
}

export async function reconcileDbDurationIssues(digest, options) {
  if (digest.state !== "ratified" || digest.collection.status !== "complete") return [];
  const env = options.env ?? process.env;
  if (
    env.GITHUB_ACTIONS !== "true" ||
    !["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) ||
    env.GITHUB_WORKFLOW_REF !== `${options.repository}/.github/workflows/${WORKFLOW}@refs/heads/main`
  ) {
    throw new Error("Issue publication is restricted to the registered main-branch drift workflow.");
  }
  const request = apiClient(options);
  const issueQuery = `repo:${options.repository} is:issue in:title "DB duration drift:"`;
  const issues = await collectPages(request, `search/issues?q=${encodeURIComponent(issueQuery)}`, "items");
  const plans = digest.verdicts
    .filter((verdict) => verdict.state !== "unbaselined")
    .map((verdict) => {
      const title = `DB duration drift: ${verdict.key}`;
      const marker = `<!-- db-duration-drift/v1:${verdict.key} -->`;
      const matches = issues.filter(
        (issue) => !issue.pull_request && (issue.title === title || issue.body?.includes(marker)),
      );
      if (
        matches.length > 1 ||
        matches.some((issue) => !issue.body?.includes(marker) || !Number.isSafeInteger(issue.number))
      )
        throw new Error(`Ambiguous canonical drift issue: ${verdict.key}`);
      return { verdict, title, marker, issue: matches[0] };
    });
  const actions = (digest.issueActions = []);
  for (const { verdict, title, marker, issue } of plans) {
    const body = `${marker}\n\n${verdict.key}: median ${verdict.observedMs} ms; drift bound ${verdict.boundMs} ms; ratified ${verdict.baselineMs} ms (${digest.ratifiedAt}).\n\nChecked ${digest.checkedAt}; head ${digest.headSha}.\nSample jobs: ${digest.includedJobIds.join(", ")}.\n`;
    if (verdict.state === "breach") {
      const suffix = issue ? `issues/${issue.number}` : "issues";
      await request(suffix, {
        method: issue ? "PATCH" : "POST",
        body: { title, body, state: "open", labels: ["kind:tech-debt", "area:infrastructure"] },
      });
      actions.push({ key: verdict.key, action: issue ? "updated" : "opened" });
    } else if (issue?.state === "open") {
      await request(`issues/${issue.number}/comments`, { method: "POST", body: { body: `Recovered: ${body}` } });
      await request(`issues/${issue.number}`, {
        method: "PATCH",
        body: { state: "closed", state_reason: "completed" },
      });
      actions.push({ key: verdict.key, action: "closed" });
    }
  }
  return actions;
}

export async function runDbDurationDrift(options) {
  let digest;
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository ?? "") || !options.token)
      throw new Error("Repository and GitHub token are required.");
    if (!/^[a-f0-9]{40}$/.test(options.headSha ?? "")) throw new Error("Collector head SHA is required.");
    parseBaselineInstant(options.checkedAt);
    const baseline = validateDbDurationBaseline(JSON.parse(await readFile(options.baselinePath, "utf8")));
    const workspaceNames = dbWorkspaceCensus(options.workspaces);
    const collection = await collectDbDurationJobs({ ...options, workspaceNames });
    digest = buildDbDurationDigest({ ...options, baseline, collection, workspaceNames });
    if (options.recompute) {
      if ((options.env ?? process.env).GITHUB_ACTIONS === "true" || options.publishIssues)
        throw new Error("Recompute is local-only and cannot publish issues.");
      digest.recompute = await recomputeDbDurationBaseline({ ...options, collection, workspaceNames });
    }
    digest.issueActions = options.publishIssues ? await reconcileDbDurationIssues(digest, options) : [];
  } catch (error) {
    digest = {
      ...digest,
      schemaVersion: "db-duration-drift/v1",
      headSha: options.headSha,
      checkedAt: options.checkedAt,
      state: error.message.startsWith("insufficient-cohort") ? "insufficient-cohort" : "unknown",
      cohortReady: false,
      error: error.message,
      issueActions: digest?.issueActions ?? [],
    };
  }
  await mkdir(path.dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, `${JSON.stringify(digest, null, 2)}\n`);
  return digest;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name) && readOption(argv, name) !== "false";
  const outPath = readOption(argv, "--out") ?? "artifacts/release-health/db-duration-drift.json";
  const result = await runDbDurationDrift({
    repository: readOption(argv, "--repository") ?? process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    checkedAt: new Date().toISOString(),
    headSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    baselinePath: path.join(repoRoot, DB_DURATION_BASELINE_PATH),
    outPath,
    evidenceDir: `${outPath}.evidence`,
    recompute: flag("--recompute"),
    publishIssues: flag("--publish-issues"),
    cause: readOption(argv, "--cause"),
  });
  console.log(
    `DB duration drift: ${result.state}; eligible=${result.eligibleCount ?? "unknown"}; cohortReady=${result.cohortReady}; artifact=${outPath}`,
  );
  if (["unknown", "insufficient-cohort"].includes(result.state)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
