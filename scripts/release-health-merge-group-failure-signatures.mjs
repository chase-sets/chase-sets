#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { classifyDeploymentRootCause, redactDeployDiagnosticText } from "./platform-deploy-incident.mjs";
import { readEnv, readOption, readRepeatedOptions } from "./lib/cli-options.mjs";

export const DELIVERY_FAILURE_SIGNATURE_VERSION = "delivery-failure-signature/v1";
export const MERGE_GROUP_FAILURE_SIGNATURES_VERSION = DELIVERY_FAILURE_SIGNATURE_VERSION;
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_MAX_RUNS = 100;
export const DEFAULT_MAX_JOBS = 30;
export const DEFAULT_MAX_LOG_BYTES = 128 * 1024;
export const ACTIVE_CIRCUIT_STATES = Object.freeze(["observed", "holding", "repairing"]);
export const DELIVERY_LANES = Object.freeze([
  "merge-group",
  "release-dispatch",
  "staging",
  "production",
  "ephemeral-verification",
]);

const CIRCUIT_TITLE_PREFIX = "[Delivery circuit]";
const MARKER_PATTERN = /<!--\s*delivery-failure-signature\/v1\s+({[\s\S]*})\s*-->/;
const SUMMARY_PATTERN = /<!-- delivery-circuit-summary:start -->[\s\S]*?<!-- delivery-circuit-summary:end -->/;

export function parseMergeGroupFailureSignaturesArgs(argv, env = process.env) {
  const repeatedLanes = readRepeatedOptions(argv, "--lane");
  return {
    command: readOption(argv, "--command") ?? "reconcile",
    repository: readOption(argv, "--repository") ?? readEnv("GITHUB_REPOSITORY", env),
    token: readOption(argv, "--token") ?? readEnv("GH_TOKEN", env) ?? readEnv("GITHUB_TOKEN", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    windowDays: positiveInteger(readOption(argv, "--window-days"), DEFAULT_WINDOW_DAYS),
    sourceRunId: readOption(argv, "--source-run-id") ?? readEnv("SOURCE_WORKFLOW_RUN_ID", env),
    workflowRunId: readOption(argv, "--workflow-run-id") ?? readEnv("GITHUB_RUN_ID", env),
    sourceWorkflow: readOption(argv, "--source-workflow") ?? readEnv("SOURCE_WORKFLOW_NAME", env),
    baseSha: readOption(argv, "--base-sha") ?? readEnv("DELIVERY_CIRCUIT_BASE_SHA", env),
    candidateSha: readOption(argv, "--candidate-sha") ?? readEnv("DELIVERY_CIRCUIT_CANDIDATE_SHA", env),
    actor: readOption(argv, "--actor") ?? readEnv("GITHUB_TRIGGERING_ACTOR", env) ?? readEnv("GITHUB_ACTOR", env),
    automatic: parseBoolean(readOption(argv, "--automatic") ?? "false"),
    circuitIssueNumber: optionalInteger(
      readOption(argv, "--circuit-issue-number") ?? readEnv("DELIVERY_CIRCUIT_ISSUE_NUMBER", env),
    ),
    circuitReason: readOption(argv, "--circuit-reason") ?? readEnv("DELIVERY_CIRCUIT_REASON", env) ?? "",
    lanes: (repeatedLanes.length > 0 ? repeatedLanes : [readOption(argv, "--lane")]).filter(Boolean),
    enforcement: parseBoolean(
      readOption(argv, "--enforcement") ?? readEnv("DELIVERY_FAILURE_CIRCUIT_ENFORCEMENT", env) ?? "false",
    ),
    mutate: parseBoolean(readOption(argv, "--mutate") ?? "true"),
    maxRuns: positiveInteger(readOption(argv, "--max-runs"), DEFAULT_MAX_RUNS),
    maxJobs: positiveInteger(readOption(argv, "--max-jobs"), DEFAULT_MAX_JOBS),
    maxLogBytes: positiveInteger(readOption(argv, "--max-log-bytes"), DEFAULT_MAX_LOG_BYTES),
    outPath: readOption(argv, "--out") ?? readEnv("MERGE_GROUP_FAILURE_SIGNATURES_OUT", env),
    markdownOutPath: readOption(argv, "--markdown-out") ?? readEnv("MERGE_GROUP_FAILURE_SIGNATURES_MARKDOWN_OUT", env),
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env),
    githubSummaryPath: readOption(argv, "--github-summary") ?? readEnv("GITHUB_STEP_SUMMARY", env),
    fetchImpl: globalThis.fetch,
    apiBaseUrl: "https://api.github.com",
  };
}

export function normalizeFailureFingerprint(value) {
  return redactDeployDiagnosticText(String(value ?? ""))
    .normalize("NFKC")
    .replaceAll(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "")
    .replaceAll(/\b\d{4}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?Z?\b/gi, "<timestamp>")
    .replaceAll(/\b[0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?\b/g, "<time>")
    .replaceAll(/\b(?:run(?:[_ -]?id)?|attempt)[=: #]+\d+\b/gi, "$1=<number>")
    .replaceAll(/\/actions\/runs\/\d+(?:\/attempts\/\d+)?/gi, "/actions/runs/<run>")
    .replaceAll(/(?:[A-Za-z]:\\|\/)(?:tmp|temp)(?:[\\/][^\s:'\"]+)+/gi, "<temp-path>")
    .replaceAll(/\/home\/runner\/work\/(?:[^\s:'\"]+\/)+/gi, "<runner-path>/")
    .replaceAll(/\bchase-sets-(?:pr|verify)-[a-z0-9-]+\b/gi, "<namespace>")
    .replaceAll(/\b(?:namespace|ns)[=: ]+[a-z0-9][a-z0-9-]{7,}\b/gi, "$1=<namespace>")
    .replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replaceAll(/\b[0-9a-f]{40,64}\b/gi, "<sha>")
    .replaceAll(/\b(?:port[=: ]+|localhost:|127\.0\.0\.1:)(\d{2,5})\b/gi, (match) => match.replace(/\d{2,5}/, "<port>"))
    .replaceAll(/\b\d{6,}\b/g, "<number>")
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 500);
}

export function buildDeliveryFailureSignature(input) {
  const lane = DELIVERY_LANES.includes(input.lane) ? input.lane : "release-dispatch";
  const errorShape = normalizeFailureFingerprint(input.errorText || input.providerReason || "unknown failure");
  const identity = {
    lane,
    workflow: boundedIdentifier(input.workflow || "unknown-workflow"),
    job: boundedIdentifier(input.job || "unknown-job"),
    step: boundedIdentifier(input.step || "unknown-step"),
    testFile: input.testFile ? normalizePath(input.testFile) : null,
    testTitle: input.testTitle ? boundedIdentifier(input.testTitle) : null,
    rootCauseCode: input.rootCauseCode || null,
    errorFingerprint: digest(errorShape || "unknown failure", 20),
  };
  return {
    schemaVersion: DELIVERY_FAILURE_SIGNATURE_VERSION,
    signature: digest(JSON.stringify(identity), 24),
    ...identity,
    errorShape: errorShape || "unknown failure",
    rootCauseSignature: input.rootCauseSignature || null,
    blocking: input.blocking !== false,
  };
}

export function extractFailureSignatures(log, context = {}) {
  const test = extractTestIdentity(log);
  const step = context.stepName || "unknown-step";
  const rootCause = test
    ? null
    : classifyDeploymentRootCause({
        phase: context.lane || "unknown",
        logs: [{ output: String(log ?? "") }],
        steps: [{ name: step, componentName: context.jobName || "unknown-job", phase: "failure" }],
      });
  const delivery = buildDeliveryFailureSignature({
    lane: context.lane || "merge-group",
    workflow: context.workflow || "Platform PR",
    job: context.jobName,
    step,
    testFile: test?.testFile,
    testTitle: test?.testTitle,
    rootCauseCode: rootCause?.rootCauseCode,
    rootCauseSignature: rootCause?.rootCauseSignature,
    providerReason: rootCause?.providerReason,
    errorText: test?.assertionShape || semanticFailureLine(log),
    blocking: rootCause?.blocking ?? true,
  });
  return [
    {
      ...delivery,
      testName: delivery.testTitle,
      assertionShape: test?.assertionShape ?? delivery.errorShape,
      failureClass: test ? "test" : "infrastructure",
      jobName: delivery.job,
      jobId: Number.isInteger(context.jobId) ? context.jobId : null,
    },
  ];
}

export function thresholdForObservations(observations, checkedAt) {
  const now = Date.parse(checkedAt);
  const valid = observations
    .filter((entry) => Number.isFinite(Date.parse(entry.observedAt)) && Date.parse(entry.observedAt) <= now)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  for (const endpoint of valid) {
    const end = Date.parse(endpoint.observedAt);
    const within30 = valid.filter(
      (entry) => end - Date.parse(entry.observedAt) >= 0 && end - Date.parse(entry.observedAt) <= 30 * 60 * 1000,
    );
    const distinct30 = new Set(within30.map((entry) => entry.candidateSha).filter(Boolean)).size;
    if (distinct30 >= 2) {
      return { crossed: true, reason: "same deterministic signature on 2 distinct candidates within 30 minutes" };
    }
    const within6h = valid.filter(
      (entry) => end - Date.parse(entry.observedAt) >= 0 && end - Date.parse(entry.observedAt) <= 6 * 60 * 60 * 1000,
    );
    if (within6h.length >= 3) {
      return { crossed: true, reason: "same deterministic signature observed 3 times within 6 hours" };
    }
  }
  return { crossed: false, reason: null };
}

export function mergeCircuitRecord(existing, signature, observations, checkedAt) {
  const previous = existing ?? {};
  const previousKeys = new Set((previous.observations ?? []).map(observationKey));
  const addedCount = observations.filter((entry) => !previousKeys.has(observationKey(entry))).length;
  const keyed = new Map(
    [...(previous.observations ?? []), ...observations].map((entry) => [observationKey(entry), entry]),
  );
  const allObservations = [...keyed.values()].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  );
  const threshold = thresholdForObservations(allObservations, checkedAt);
  const candidates = new Set(
    [...(previous.candidateShas ?? []), ...allObservations.map((entry) => entry.candidateSha)].filter(Boolean),
  );
  const first = allObservations[0];
  const last = allObservations.at(-1);
  const state =
    previous.state === "repairing"
      ? "repairing"
      : threshold.crossed && signature.blocking !== false
        ? "holding"
        : previous.state === "holding"
          ? "holding"
          : "observed";
  return {
    ...previous,
    schemaVersion: DELIVERY_FAILURE_SIGNATURE_VERSION,
    signature: signature.signature,
    lane: signature.lane,
    workflow: signature.workflow,
    job: signature.job,
    step: signature.step,
    testIdentity: signature.testFile ? { file: signature.testFile, title: signature.testTitle } : null,
    rootCauseCode: signature.rootCauseCode,
    rootCauseSignature: signature.rootCauseSignature,
    errorFingerprint: signature.errorFingerprint,
    errorShape: signature.errorShape,
    blocking: signature.blocking !== false,
    baseSha: last?.baseSha ?? previous.baseSha ?? null,
    candidateSha: last?.candidateSha ?? previous.candidateSha ?? null,
    runId: last?.runId ?? previous.runId ?? null,
    runAttempt: last?.runAttempt ?? previous.runAttempt ?? 1,
    firstObservedAt: previous.firstObservedAt ?? first?.observedAt ?? checkedAt,
    lastObservedAt: last?.observedAt ?? previous.lastObservedAt ?? checkedAt,
    occurrenceCount: Math.max(allObservations.length, (previous.occurrenceCount ?? 0) + addedCount),
    distinctCandidateCount: candidates.size,
    candidateShas: [...candidates].slice(-100),
    state,
    canonicalIssueNumber: previous.canonicalIssueNumber ?? null,
    holdReason: state === "holding" ? previous.holdReason || threshold.reason || "active deterministic failure" : null,
    recoveryCriteria:
      previous.recoveryCriteria ||
      "An authorized repair must pass the complete affected battery and the actual release/verification, or the lane must record 3 consecutive successes.",
    consecutiveSuccesses: addedCount > 0 ? 0 : (previous.consecutiveSuccesses ?? 0),
    successfulRunKeys: previous.successfulRunKeys ?? [],
    recoveredAt: state === "recovered" ? previous.recoveredAt : null,
    recoveryReason: state === "recovered" ? previous.recoveryReason : null,
    observations: allObservations.slice(-100),
  };
}

export function advanceCircuitRecovery(record, success, checkedAt) {
  const successfulRunKey = `${success.runId}:${success.runAttempt}`;
  if ((record.successfulRunKeys ?? []).includes(successfulRunKey)) return null;
  const retryPass =
    success.runAttempt > 1 &&
    (record.observations ?? []).some(
      (entry) => String(entry.runId) === String(success.runId) && entry.runAttempt < success.runAttempt,
    );
  const repairBatteryPass =
    record.state === "repairing" &&
    record.lane === "merge-group" &&
    String(record.repairWorkflowRunId) === String(success.runId);
  const repairRelease =
    record.state === "repairing" &&
    success.workflow === "Platform Deploy" &&
    (record.lane === "merge-group"
      ? Boolean(record.repairBatteryPassedAt)
      : String(record.repairWorkflowRunId) === String(success.runId));
  const affectedLane = record.state !== "repairing" && success.lanes.includes(record.lane);
  if (!retryPass && !repairBatteryPass && !repairRelease && !affectedLane) return null;

  const next = { ...record };
  next.successfulRunKeys = [...(record.successfulRunKeys ?? []), successfulRunKey].slice(-100);
  if (retryPass) {
    next.state = "recovered";
    next.recoveryReason = "retry-pass evidence classified this occurrence as a flake";
    next.recoveredAt = checkedAt;
    return { record: next, flake: true };
  }
  if (repairBatteryPass) {
    next.repairBatteryPassedAt = checkedAt;
    next.repairBatteryRunId = success.runId;
    next.consecutiveSuccesses = 1;
    return { record: next, flake: false };
  }
  if (repairRelease) {
    next.state = "recovered";
    next.recoveryReason = "repairing circuit passed the actual release and verification";
    next.recoveredAt = checkedAt;
    return { record: next, flake: false };
  }
  next.consecutiveSuccesses = (next.consecutiveSuccesses ?? 0) + 1;
  next.lastSuccessfulRunId = success.runId;
  if (next.consecutiveSuccesses >= 3) {
    next.state = "recovered";
    next.recoveryReason = "affected lane recorded 3 consecutive successes";
    next.recoveredAt = checkedAt;
  }
  return { record: next, flake: false };
}

export function parseCircuitMarker(body) {
  const match = String(body ?? "").match(MARKER_PATTERN);
  if (!match) return null;
  try {
    const record = JSON.parse(match[1]);
    return record?.schemaVersion === DELIVERY_FAILURE_SIGNATURE_VERSION ? record : null;
  } catch {
    return null;
  }
}

export function renderCircuitMarker(record) {
  return `<!-- ${DELIVERY_FAILURE_SIGNATURE_VERSION} ${JSON.stringify(record)} -->`;
}

export function renderCircuitSummary(record) {
  const identity = record.testIdentity
    ? `${record.testIdentity.file} > ${record.testIdentity.title || "unknown test"}`
    : `${record.job} / ${record.step}`;
  const recent = (record.observations ?? [])
    .slice(-5)
    .reverse()
    .map(
      (entry) =>
        `- [Run ${entry.runId}, attempt ${entry.runAttempt}](${entry.url}) — candidate \`${shortSha(entry.candidateSha)}\` at ${entry.observedAt}`,
    );
  return [
    "<!-- delivery-circuit-summary:start -->",
    "## Delivery circuit state",
    "",
    `- State: \`${record.state}\``,
    `- Lane: \`${record.lane}\``,
    `- Identity: ${identity}`,
    `- Root cause: \`${record.rootCauseCode || "not-available"}\``,
    `- Occurrences: ${record.occurrenceCount}; distinct candidates: ${record.distinctCandidateCount}`,
    `- Hold reason: ${record.holdReason || "threshold not crossed"}`,
    `- Recovery: ${record.recoveryCriteria}`,
    "",
    "### Recent redacted evidence",
    "",
    ...(recent.length > 0 ? recent : ["- No run links are available."]),
    "",
    renderCircuitMarker(record),
    "<!-- delivery-circuit-summary:end -->",
  ].join("\n");
}

export function evaluateCircuitGuardDecision(input) {
  const holds = (input.circuits ?? []).filter(
    (circuit) =>
      ["holding", "repairing"].includes(circuit.state) &&
      circuit.blocking !== false &&
      input.lanes.includes(circuit.lane) &&
      circuit.baseCovered !== false,
  );
  if (holds.length === 0) return { decision: "allow", holds: [], reason: "no active circuit covers the lane" };
  if (input.automatic) {
    return { decision: "block", holds, reason: "automatic execution is held by an active delivery circuit" };
  }
  const selected = holds.find((circuit) => circuit.canonicalIssueNumber === input.circuitIssueNumber);
  if (!selected) {
    return { decision: "block", holds, reason: "manual recovery must reference an active canonical circuit issue" };
  }
  if (
    selected.state === "repairing" &&
    selected.repairCandidateSha &&
    selected.repairCandidateSha !== input.candidateSha
  ) {
    return { decision: "block", holds, reason: "another candidate already owns the circuit repair escape" };
  }
  if (!String(input.circuitReason ?? "").trim()) {
    return { decision: "block", holds, reason: "manual recovery requires an audited reason" };
  }
  if (input.actorAuthorized !== true) {
    return { decision: "block", holds, reason: "manual recovery actor does not have write permission" };
  }
  if (input.lanes.includes("merge-group") && input.repairPrValid !== true) {
    return {
      decision: "block",
      holds,
      reason: "merge-group escape requires one ci-circuit-repair PR with a Repairs link",
    };
  }
  const unrelated = holds.filter((circuit) => circuit.canonicalIssueNumber !== selected.canonicalIssueNumber);
  if (unrelated.length > 0) {
    return { decision: "block", holds, reason: "another active circuit still holds the requested lane" };
  }
  return { decision: "escape", holds: [selected], reason: "authorized audited recovery escape" };
}

export async function collectMergeGroupFailureSignatures(options) {
  validateOptions(options);
  if (options.command === "guard") return evaluateDeliveryCircuitGuard(options);

  await ensureRepairLabel(options);
  const issues = await fetchCircuitIssues(options);
  const runs = options.sourceRunId
    ? [await githubJson(options, `/actions/runs/${options.sourceRunId}`)]
    : await fetchEligibleRuns(options);
  const analyses = [];
  for (const run of runs.slice(0, options.maxRuns ?? DEFAULT_MAX_RUNS)) {
    const analysis = await analyzeRun(options, run);
    if (analysis) analyses.push(analysis);
  }

  const issueBySignature = new Map();
  for (const issue of issues) {
    const issueSignature = parseCircuitMarker(issue.body)?.signature;
    if (issueSignature && !issueBySignature.has(issueSignature)) issueBySignature.set(issueSignature, issue);
  }
  const updated = [];
  const flakeEvidence = [];
  for (const analysis of analyses) {
    for (const observation of analysis.failures) {
      let issue = issueBySignature.get(observation.signature.signature);
      if (!issue && analysis.workflow === "Platform Deploy") {
        issue = issues.find(
          (candidate) =>
            String(candidate.title).startsWith("Incident: Platform Deploy ") &&
            String(candidate.body ?? "").includes(`/actions/runs/${observation.occurrence.runId}`),
        );
      }
      if (!issue && observation.signature.rootCauseSignature) {
        issue = issues.find((candidate) =>
          String(candidate.title).includes(`[${observation.signature.rootCauseSignature}]`),
        );
      }
      const previous = parseCircuitMarker(issue?.body);
      let record = mergeCircuitRecord(previous, observation.signature, [observation.occurrence], options.checkedAt);
      if (issue) record.canonicalIssueNumber = issue.number;
      issue = await upsertCircuitIssue(options, issue, record);
      record = { ...record, canonicalIssueNumber: issue.number };
      if (parseCircuitMarker(issue.body)?.canonicalIssueNumber !== issue.number && options.mutate !== false) {
        issue = await updateCircuitIssue(options, issue, record);
      }
      issueBySignature.set(record.signature, issue);
      updated.push(record);
    }

    for (const success of analysis.successes) {
      for (const issue of [...issueBySignature.values()]) {
        const record = parseCircuitMarker(issue.body);
        if (!record || !ACTIVE_CIRCUIT_STATES.includes(record.state)) continue;
        const transition = advanceCircuitRecovery(record, success, options.checkedAt);
        if (!transition) continue;
        const next = transition.record;
        if (transition.flake) {
          flakeEvidence.push({ signature: record.signature, issueNumber: issue.number, runId: success.runId });
        }
        const updatedIssue = await updateCircuitIssue(options, issue, next, next.state === "recovered");
        issueBySignature.set(next.signature, updatedIssue);
        updated.push(next);
      }
    }
  }

  for (const [signatureId, issue] of issueBySignature.entries()) {
    const current = parseCircuitMarker(issue.body);
    if (!current) continue;
    const missingCanonicalLink = current.canonicalIssueNumber !== issue.number;
    const recoveredButOpen = current.state === "recovered" && issue.state !== "closed";
    if (!missingCanonicalLink && !recoveredButOpen) continue;
    const repaired = { ...current, canonicalIssueNumber: issue.number };
    const repairedIssue = await updateCircuitIssue(options, issue, repaired, current.state === "recovered");
    issueBySignature.set(signatureId, repairedIssue);
  }

  const circuits = [
    ...new Map(
      [...issueBySignature.values()].map((issue) => {
        const record = parseCircuitMarker(issue.body);
        return [record?.signature, record];
      }),
    ).values(),
  ].filter(Boolean);
  const record = buildReport(options, analyses, circuits, flakeEvidence);
  return { record, markdown: renderDeliveryFailureSignatureMarkdown(record) };
}

async function analyzeRun(options, run) {
  const workflow = run.name || options.sourceWorkflow;
  if (!isEligibleRun(workflow, run.event)) return null;
  const jobs = (await fetchRunJobs(options, run.id)).slice(0, options.maxJobs ?? DEFAULT_MAX_JOBS);
  const jobLogs = new Map();
  const readJobLog = async (job) => {
    if (!jobLogs.has(job.id)) jobLogs.set(job.id, await fetchJobLog(options, job.id));
    return jobLogs.get(job.id);
  };
  const baseSha = workflow === "Platform PR" ? await mergeGroupBaseSha(options, run.head_sha) : run.head_sha;
  let candidateSha = run.head_sha ?? null;
  if (workflow === "Platform Deploy") {
    const resolveJob = jobs.find((job) => job.name === "Resolve Release");
    if (resolveJob) candidateSha = releaseCommitFromLog(await readJobLog(resolveJob)) ?? candidateSha;
  } else if (workflow === "Platform Ephemeral Verification") {
    const verificationJob = jobs.find((job) => /Verify Release in Ephemeral Namespace/i.test(job.name ?? ""));
    if (verificationJob) candidateSha = releaseCommitFromLog(await readJobLog(verificationJob)) ?? candidateSha;
  }
  const observedAt = run.updated_at ?? run.run_started_at ?? run.created_at ?? options.checkedAt;
  const runUrl = run.html_url ?? `https://github.com/${options.repository}/actions/runs/${run.id}`;
  const failures = [];
  for (const job of jobs.filter((candidate) => candidate?.conclusion === "failure")) {
    const lane = laneForJob(workflow, job.name);
    const failedStep = (job.steps ?? []).find((step) => step.conclusion === "failure");
    const log = await readJobLog(job);
    const [extracted] = extractFailureSignatures(log, {
      lane,
      workflow,
      jobName: job.name,
      stepName: failedStep?.name,
      jobId: job.id,
    });
    failures.push({
      signature: extracted,
      occurrence: {
        runId: run.id,
        runAttempt: run.run_attempt ?? 1,
        observedAt,
        url: runUrl,
        baseSha,
        candidateSha,
        jobId: job.id,
      },
    });
  }
  const jobsByLane = Map.groupBy(jobs, (job) => laneForJob(workflow, job.name));
  const successfulLanes = new Set(
    [...jobsByLane.entries()]
      .filter(
        ([, laneJobs]) =>
          laneJobs.some((job) => job.conclusion === "success") &&
          laneJobs.every((job) => ["success", "skipped", "neutral"].includes(job.conclusion)),
      )
      .map(([lane]) => lane),
  );
  return {
    runId: run.id,
    workflow,
    failures,
    successes:
      run.conclusion === "success" || successfulLanes.size > 0
        ? [
            {
              runId: run.id,
              runAttempt: run.run_attempt ?? 1,
              workflow,
              candidateSha,
              lanes: [...successfulLanes],
            },
          ]
        : [],
  };
}

async function evaluateDeliveryCircuitGuard(options) {
  const lanes = options.lanes.filter((lane) => DELIVERY_LANES.includes(lane));
  if (lanes.length === 0) throw new Error("At least one valid --lane is required for guard evaluation.");
  const issues = await fetchCircuitIssues(options);
  const circuits = [];
  for (const issue of issues) {
    const record = parseCircuitMarker(issue.body);
    if (
      !record ||
      !lanes.includes(record.lane) ||
      !["holding", "repairing"].includes(record.state) ||
      record.blocking === false
    ) {
      continue;
    }
    record.canonicalIssueNumber = issue.number;
    record.baseCovered = await circuitCoversBase(options, record, options.baseSha);
    circuits.push(record);
  }
  const covered = circuits.filter((record) => record.baseCovered !== false);
  const repair = lanes.includes("merge-group")
    ? await validateRepairPullRequest(options, circuits, options.candidateSha)
    : { valid: true, issueNumber: options.circuitIssueNumber, reason: options.circuitReason, actor: options.actor };
  const recoveryActor = repair.actor || options.actor;
  const actorAuthorized =
    covered.length === 0 || options.automatic ? false : await actorHasWritePermission(options, recoveryActor);
  const issueNumber = options.circuitIssueNumber ?? repair.issueNumber;
  const decision = evaluateCircuitGuardDecision({
    circuits,
    lanes,
    automatic: options.automatic,
    circuitIssueNumber: issueNumber,
    circuitReason: options.circuitReason || repair.reason,
    actorAuthorized,
    repairPrValid: repair.valid,
    candidateSha: options.candidateSha,
  });
  if (decision.decision === "escape" && options.mutate !== false) {
    const selectedIssue = issues.find((issue) => issue.number === issueNumber);
    const selected = parseCircuitMarker(selectedIssue?.body);
    if (selectedIssue && selected) {
      const repairing = {
        ...selected,
        state: "repairing",
        repairActor: recoveryActor,
        repairReason: boundedIdentifier(options.circuitReason || repair.reason),
        repairCandidateSha: options.candidateSha ?? null,
        repairWorkflowRunId: options.workflowRunId ?? null,
        repairStartedAt: options.checkedAt,
        canonicalIssueNumber: selectedIssue.number,
      };
      await updateCircuitIssue(options, selectedIssue, repairing);
    }
  }
  const record = {
    schemaVersion: DELIVERY_FAILURE_SIGNATURE_VERSION,
    checkedAt: options.checkedAt,
    command: "guard",
    enforcement: options.enforcement,
    decision: decision.decision,
    reason: decision.reason,
    holds: decision.holds.map((hold) => ({
      issueNumber: hold.canonicalIssueNumber,
      lane: hold.lane,
      signature: hold.signature,
      state: hold.state,
    })),
  };
  return { record, markdown: renderGuardMarkdown(record), blocked: decision.decision === "block" };
}

async function validateRepairPullRequest(options, circuits, candidateSha) {
  if (!candidateSha) return { valid: false, issueNumber: null, reason: "", actor: null };
  const candidates = await githubJson(options, `/commits/${candidateSha}/pulls?per_page=100`);
  const repairs = (Array.isArray(candidates) ? candidates : []).filter((pr) => {
    const labels = (pr.labels ?? []).map((label) => (typeof label === "string" ? label : label.name));
    return labels.includes("ci-circuit-repair") && /(?:^|\s)Repairs\s+#\d+\b/i.test(pr.body ?? "");
  });
  if (repairs.length !== 1) return { valid: false, issueNumber: null, reason: "", actor: null };
  const match = repairs[0].body.match(/(?:^|\s)Repairs\s+#(\d+)\b/i);
  const issueNumber = Number(match?.[1]);
  const active = circuits.some(
    (record) => record.canonicalIssueNumber === issueNumber && ["holding", "repairing"].includes(record.state),
  );
  return {
    valid: active,
    issueNumber,
    reason: `Repair PR #${repairs[0].number} declares Repairs #${issueNumber}`,
    actor: repairs[0].user?.login ?? null,
  };
}

async function actorHasWritePermission(options, actor) {
  if (!actor) return false;
  const result = await githubJson(options, `/collaborators/${encodeURIComponent(actor)}/permission`);
  return ["admin", "maintain", "write"].includes(result?.permission);
}

async function circuitCoversBase(options, record, baseSha) {
  if (record.lane !== "merge-group") return true;
  if (!baseSha || !record.baseSha || record.baseSha === baseSha) return true;
  const comparison = await githubJson(
    options,
    `/compare/${encodeURIComponent(record.baseSha)}...${encodeURIComponent(baseSha)}`,
  );
  return ["ahead", "identical"].includes(comparison?.status);
}

async function fetchEligibleRuns(options) {
  const window = buildWindow(options.checkedAt, options.windowDays);
  const url = new URL(`${options.apiBaseUrl}/repos/${options.repository}/actions/runs`);
  url.searchParams.set("created", `${window.start}..${window.end}`);
  url.searchParams.set("per_page", "100");
  const runs = await fetchPaginated(options, url, (body) => body?.workflow_runs ?? [], options.maxRuns);
  return runs
    .filter((run) => isEligibleRun(run.name, run.event))
    .sort(
      (left, right) =>
        Date.parse(left.updated_at ?? left.created_at ?? 0) - Date.parse(right.updated_at ?? right.created_at ?? 0),
    );
}

function isEligibleRun(workflow, event) {
  return (
    (workflow === "Platform PR" && event === "merge_group") ||
    (workflow === "Platform Deploy" && event === "workflow_dispatch") ||
    workflow === "Platform Ephemeral Verification"
  );
}

function laneForJob(workflow, jobName) {
  if (workflow === "Platform PR") return "merge-group";
  if (workflow === "Platform Ephemeral Verification") return "ephemeral-verification";
  if (/^(?:Deploy Staging|Record Staging Release Health)$/i.test(jobName ?? "")) return "staging";
  if (/^Deploy Production$/i.test(jobName ?? "")) return "production";
  return "release-dispatch";
}

async function mergeGroupBaseSha(options, headSha) {
  if (!headSha) return null;
  const commit = await githubJson(options, `/commits/${headSha}`);
  return commit?.parents?.[0]?.sha ?? headSha;
}

async function fetchRunJobs(options, runId) {
  const url = new URL(`${options.apiBaseUrl}/repos/${options.repository}/actions/runs/${runId}/jobs`);
  url.searchParams.set("filter", "latest");
  url.searchParams.set("per_page", "100");
  return fetchPaginated(options, url, (body) => body?.jobs ?? [], options.maxJobs);
}

async function fetchJobLog(options, jobId) {
  const response = await githubFetch(options, `/actions/jobs/${jobId}/logs`, {
    headers: { Range: `bytes=0-${(options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES) - 1}` },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.subarray(0, options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES).toString("utf8");
}

async function fetchCircuitIssues(options) {
  const url = new URL(`${options.apiBaseUrl}/repos/${options.repository}/issues`);
  url.searchParams.set("state", "all");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", "100");
  const issues = await fetchPaginated(options, url, (body) => body ?? [], 300);
  return issues.filter(
    (issue) =>
      !issue.pull_request &&
      (parseCircuitMarker(issue.body) ||
        String(issue.title ?? "").startsWith(CIRCUIT_TITLE_PREFIX) ||
        String(issue.title ?? "").startsWith("Incident: Platform Deploy ")),
  );
}

async function ensureRepairLabel(options) {
  if (options.mutate === false) return;
  const response = await githubFetch(options, "/labels/ci-circuit-repair", { allowStatuses: [404] });
  if (response.status !== 404) return;
  await githubJson(options, "/labels", {
    method: "POST",
    body: {
      name: "ci-circuit-repair",
      color: "B60205",
      description: "Authorized full-battery repair for one active delivery circuit",
    },
  });
}

async function upsertCircuitIssue(options, issue, record) {
  if (issue) return updateCircuitIssue(options, issue, record);
  if (options.mutate === false) {
    return {
      number: record.canonicalIssueNumber ?? 0,
      title: circuitTitle(record),
      body: renderCircuitSummary(record),
    };
  }
  const created = await githubJson(options, "/issues", {
    method: "POST",
    body: {
      title: circuitTitle(record),
      body: renderCircuitSummary(record),
      labels: ["kind:ops", "area:infrastructure", "priority:p1"],
    },
  });
  return created;
}

async function updateCircuitIssue(options, issue, record, close = false) {
  const body = mergeCircuitSummary(issue.body, record);
  if (options.mutate === false) return { ...issue, body, state: close ? "closed" : issue.state };
  return githubJson(options, `/issues/${issue.number}`, {
    method: "PATCH",
    body: {
      body,
      ...(close ? { state: "closed", state_reason: "completed" } : issue.state === "closed" ? { state: "open" } : {}),
    },
  });
}

function mergeCircuitSummary(body, record) {
  const summary = renderCircuitSummary(record);
  const current = String(body ?? "");
  if (SUMMARY_PATTERN.test(current)) return current.replace(SUMMARY_PATTERN, summary);
  return current.trim() ? `${current.trim()}\n\n${summary}` : summary;
}

function circuitTitle(record) {
  return `${CIRCUIT_TITLE_PREFIX} ${record.lane}: ${record.job} / ${record.step} [${record.signature.slice(0, 12)}]`;
}

function buildReport(options, analyses, circuits, flakeEvidence) {
  const holding = circuits.filter((record) => record.state === "holding").length;
  const repairing = circuits.filter((record) => record.state === "repairing").length;
  return {
    schemaVersion: DELIVERY_FAILURE_SIGNATURE_VERSION,
    checkedAt: options.checkedAt,
    mode: options.sourceRunId ? "event" : "reconciliation",
    repository: options.repository,
    sourceRunId: options.sourceRunId ?? null,
    counts: {
      evaluatedRuns: analyses.length,
      activeSignatures: circuits.filter((record) => ACTIVE_CIRCUIT_STATES.includes(record.state)).length,
      holding,
      repairing,
      flakeEvidence: flakeEvidence.length,
    },
    circuits,
    flakeEvidence,
  };
}

export function renderDeliveryFailureSignatureMarkdown(record) {
  const lines = [
    "## Delivery failure signatures",
    "",
    `- Mode: ${record.mode}`,
    `- Evaluated runs: ${record.counts.evaluatedRuns}`,
    `- Active signatures: ${record.counts.activeSignatures}; holding: ${record.counts.holding}; repairing: ${record.counts.repairing}`,
    `- Retry-pass flake evidence: ${record.counts.flakeEvidence}`,
    "",
  ];
  const active = record.circuits.filter((circuit) => ACTIVE_CIRCUIT_STATES.includes(circuit.state));
  if (active.length === 0) {
    lines.push("No active delivery failure circuits.");
    return lines.join("\n");
  }
  lines.push("| State | Lane | Signature | Occurrences | Issue |", "| --- | --- | --- | ---: | ---: |");
  for (const circuit of active) {
    lines.push(
      `| ${circuit.state} | ${circuit.lane} | \`${circuit.signature.slice(0, 12)}\` | ${circuit.occurrenceCount} | #${circuit.canonicalIssueNumber ?? "pending"} |`,
    );
  }
  return lines.join("\n");
}

export function renderMergeGroupFailureSignatureMarkdown(record) {
  return renderDeliveryFailureSignatureMarkdown(record);
}

function renderGuardMarkdown(record) {
  const lines = [
    "## Known Failure Guard",
    "",
    `- Decision: **${record.decision}**`,
    `- Enforcement: ${record.enforcement ? "enabled" : "advisory"}`,
    `- Reason: ${record.reason}`,
  ];
  for (const hold of record.holds) lines.push(`- Circuit: #${hold.issueNumber} (${hold.lane}, ${hold.state})`);
  return lines.join("\n");
}

export function buildWindow(checkedAt, windowDays = DEFAULT_WINDOW_DAYS) {
  const end = new Date(checkedAt);
  if (Number.isNaN(end.getTime())) throw new Error("checkedAt must be an ISO date.");
  const start = new Date(end.getTime() - Math.max(1, Math.floor(windowDays)) * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function extractTestIdentity(log) {
  const lines = String(log ?? "").split(/\r?\n/);
  const fileLine = lines.find((line) => testFileFromText(line));
  const testFile = testFileFromText(fileLine ?? "");
  const title =
    fileLine?.match(/[>›]\s+([^>›]+?)\s*$/)?.[1] ??
    lines.find((line) => /^\s*[×✖]\s+/.test(line))?.replace(/^\s*[×✖]\s+/, "");
  if (!testFile && !title) return null;
  const assertion = lines.find((line) => /(?:AssertionError|TypeError|expected\s+.+\s+to\s+)/i.test(line));
  return {
    testFile: testFile ?? "unknown-test-file",
    testTitle: boundedIdentifier(title ?? "unknown-test"),
    assertionShape: normalizeAssertion(assertion ?? "assertion failed"),
  };
}

function testFileFromText(line) {
  const match = String(line).match(/((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+)?/i);
  return match ? normalizePath(match[1]) : null;
}

function normalizeAssertion(value) {
  const normalized = String(value).trim();
  const matcher = normalized.match(/\bto\s+.+$/i)?.[0] ?? normalized.replace(/^\w*Error:\s*/i, "");
  return boundedIdentifier(
    matcher
      .replace(/\b\d+(?:\.\d+)?\b/g, "<number>")
      .replace(/(['"])(?:\\.|(?!\1).)*\1/g, "<value>")
      .replace(/\{[^}]*\}|\[[^\]]*\]/g, "<value>"),
  );
}

function semanticFailureLine(log) {
  return (
    String(log ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /(?:error|fail|timeout|refused|missing|invalid|collision|mismatch)/i.test(line)) ??
    "unknown failure"
  );
}

function releaseCommitFromLog(log) {
  return (
    String(log ?? "").match(/\bResolved release commit ([0-9a-f]{40})\b/i)?.[1] ??
    String(log ?? "").match(/\bVerifying release ([0-9a-f]{40})\b/i)?.[1] ??
    null
  );
}

async function fetchPaginated(options, initialUrl, select, limit = Number.POSITIVE_INFINITY) {
  const values = [];
  let url = initialUrl;
  while (url && values.length < limit) {
    const response = await githubFetch(options, url);
    const selected = select(await response.json());
    values.push(...(Array.isArray(selected) ? selected : []));
    url = nextLink(response.headers?.get?.("link"));
  }
  return values.slice(0, limit);
}

async function githubJson(options, path, request = {}) {
  const response = await githubFetch(options, path, request);
  if (response.status === 204) return null;
  return response.json();
}

async function githubFetch(options, pathOrUrl, request = {}) {
  const url = String(pathOrUrl).startsWith("http")
    ? String(pathOrUrl)
    : `${options.apiBaseUrl ?? "https://api.github.com"}/repos/${options.repository}${pathOrUrl}`;
  const response = await options.fetchImpl(url, {
    method: request.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
      ...(request.headers ?? {}),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  if (!response.ok && !(request.allowStatuses ?? []).includes(response.status)) {
    throw new Error(`GitHub API request failed for ${url}: ${response.status}`);
  }
  const remainingHeader = response.headers?.get?.("x-ratelimit-remaining");
  const remaining = remainingHeader === null || remainingHeader === undefined ? null : Number(remainingHeader);
  if (Number.isFinite(remaining) && remaining < 20)
    throw new Error(`GitHub API rate limit is too low (${remaining} remaining).`);
  return response;
}

function nextLink(linkHeader) {
  const next = String(linkHeader ?? "")
    .split(",")
    .find((part) => part.includes('rel="next"'));
  if (!next) return null;
  const start = next.indexOf("<");
  const end = next.indexOf(">");
  return start >= 0 && end > start ? new URL(next.slice(start + 1, end)) : null;
}

function validateOptions(options) {
  if (!options.repository) throw new Error("GitHub repository is required.");
  if (typeof options.fetchImpl !== "function") throw new Error("A fetch implementation is required.");
}

function observationKey(entry) {
  return [entry.runId, entry.runAttempt, entry.jobId ?? "", entry.candidateSha ?? ""].join(":");
}

function normalizePath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

function boundedIdentifier(value) {
  return redactDeployDiagnosticText(String(value ?? "unknown"))
    .replaceAll(/\s+/g, " ")
    .replaceAll(/https?:\/\/[^\s)]+/gi, "<url>")
    .trim()
    .slice(0, 240);
}

function digest(value, length) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function shortSha(value) {
  return value ? String(value).slice(0, 12) : "unknown";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseBoolean(value) {
  return /^(?:1|true|yes)$/i.test(String(value ?? ""));
}

async function writeOutputs(options, result) {
  if (options.outPath) {
    await mkdir(dirname(options.outPath), { recursive: true });
    await writeFile(options.outPath, `${JSON.stringify(result.record, null, 2)}\n`);
  }
  if (options.markdownOutPath) {
    await mkdir(dirname(options.markdownOutPath), { recursive: true });
    await writeFile(options.markdownOutPath, `${result.markdown}\n`);
  }
  if (options.githubSummaryPath) await appendFile(options.githubSummaryPath, `${result.markdown}\n`);
  if (options.githubOutputPath) {
    await appendFile(
      options.githubOutputPath,
      [
        `decision=${result.record.decision ?? "evaluated"}`,
        `blocked=${result.blocked ? "true" : "false"}`,
        `holding_count=${result.record.counts?.holding ?? result.record.holds?.length ?? 0}`,
        "",
      ].join("\n"),
    );
  }
}

async function main(argv, env = process.env) {
  const options = parseMergeGroupFailureSignaturesArgs(argv, env);
  try {
    const result = await collectMergeGroupFailureSignatures(options);
    await writeOutputs(options, result);
    if (!options.githubSummaryPath) console.log(result.markdown);
    return result.blocked && options.enforcement ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    const advisory = !options.enforcement;
    if (advisory && options.githubSummaryPath) {
      await appendFile(
        options.githubSummaryPath,
        `## Delivery failure signatures\n\nAdvisory evaluation unavailable: ${message}\n`,
      );
    }
    return advisory ? 0 : 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
