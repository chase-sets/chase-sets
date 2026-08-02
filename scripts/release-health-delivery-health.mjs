#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import process from "node:process";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { classifyPrScope } from "./lib/pr-scope-policy-v1.mjs";
import { parseCircuitMarker, thresholdForObservations } from "./release-health-merge-group-failure-signatures.mjs";

export const DELIVERY_HEALTH_VERSION = "delivery-health/v1";
export const DELIVERY_HEALTH_POLICY_PATH = new URL("./release-health-delivery-health-policy.json", import.meta.url);
export const DELIVERY_HEALTH_SLI_MARKER_VERSION = "delivery-health-sli/v1";

const API_BASE_URL = "https://api.github.com";
const GRAPHQL_URL = "https://api.github.com/graphql";
const SUCCESS_OUTCOMES = new Set(["success", "retry-pass/flake"]);
const FAILURE_OUTCOMES = new Set(["deterministic-failure"]);
const INTENTIONAL_OUTCOMES = new Set([
  "intentional-superseded/coalesced",
  "cancelled-by-newer-candidate",
  "automatic-concurrency-displaced",
  "skipped/not-eligible",
]);
const SLI_MARKER_PATTERN = /<!--\s*delivery-health-sli\/v1\s+({[\s\S]*?})\s*-->/;
const EPHEMERAL_VERIFICATION_VERSION = "ephemeral-verification/v1";
const EPHEMERAL_RECORD_KEYS = new Set([
  "schemaVersion",
  "releaseCommit",
  "imageRepository",
  "imageDigest",
  "producerRunId",
  "producerRunAttempt",
  "trigger",
  "namespace",
  "workflowRunId",
  "workflowRunAttempt",
  "result",
  "failurePhase",
  "teardownResult",
  "persistentStagingResult",
  "persistentStagingRetained",
  "workloads",
  "checkedAt",
]);
const EPHEMERAL_FAILURE_PHASES = new Set([
  "promoted-release-handoff-pending-timeout",
  "promoted-release-handoff-absent",
  "promoted-release-handoff-invalid",
  "promoted-release-handoff-wait",
  "promoted-release-handoff-validation",
  "trusted-default-branch-checkout",
  "release-commit-checkout",
  "release-workspace-install",
  "terraform-setup",
  "doctl-setup",
  "promoted-release-image-resolution",
  "kubernetes-context",
  "namespace-reset",
  "registry-authority",
  "provider-registration",
  "runtime-secrets",
  "release-deploy",
  "ingress-readiness",
  "representative-commerce-state",
  "platform-smoke",
  "stripe-money-smoke",
  "provider-teardown",
  "namespace-teardown",
  "workflow-cancelled-or-setup",
]);
const EPHEMERAL_WORKLOADS = new Set(["representative-commerce-state", "platform-smoke", "stripe-money-smoke"]);
const EPHEMERAL_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const EPHEMERAL_RECORD_MAX_BYTES = 256 * 1024;

export function parseDeliveryHealthArgs(argv, env = process.env) {
  return {
    repository: readOption(argv, "--repository") ?? readEnv("GITHUB_REPOSITORY", env),
    token: readOption(argv, "--token") ?? readEnv("GH_TOKEN", env) ?? readEnv("GITHUB_TOKEN", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    publicationMode: readOption(argv, "--publication-mode") ?? "hourly",
    outPath: readOption(argv, "--out") ?? readEnv("DELIVERY_HEALTH_OUT", env),
    markdownOutPath: readOption(argv, "--markdown-out") ?? readEnv("DELIVERY_HEALTH_MARKDOWN_OUT", env),
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env),
    githubSummaryPath: readOption(argv, "--github-summary") ?? readEnv("GITHUB_STEP_SUMMARY", env),
    updateIssues: parseBoolean(readOption(argv, "--update-issues") ?? "false"),
    policyPath: readOption(argv, "--policy") ?? DELIVERY_HEALTH_POLICY_PATH,
    fetchImpl: globalThis.fetch,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

export async function readDeliveryHealthPolicy(path = DELIVERY_HEALTH_POLICY_PATH) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function normalizeDeliveryConclusion(input = {}) {
  const reason = `${input.reason ?? ""} ${input.attemptReason ?? ""}`.toLowerCase();
  if (input.displaced === true) return "automatic-concurrency-displaced";
  if (/supersed|coalesc/.test(reason)) return "intentional-superseded/coalesced";
  if (/newer|stale-release|stale-candidate/.test(reason)) return "cancelled-by-newer-candidate";
  const conclusion = String(input.conclusion ?? "").toLowerCase();
  if (conclusion === "success") return Number(input.runAttempt ?? 1) > 1 ? "retry-pass/flake" : "success";
  if (["failure", "timed_out", "startup_failure", "action_required"].includes(conclusion)) {
    return "deterministic-failure";
  }
  if (conclusion === "cancelled") return "unknown";
  if (["skipped", "neutral"].includes(conclusion) || input.eligible === false) return "skipped/not-eligible";
  return "unknown";
}

export function percentileSummary(values) {
  const numbers = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  return {
    sampleCount: numbers.length,
    p50: nearestRank(numbers, 0.5),
    p90: nearestRank(numbers, 0.9),
  };
}

export async function collectDeliveryHealth(options, dependencies = {}) {
  validateOptions(options);
  const policy = dependencies.policy ?? (await readDeliveryHealthPolicy(options.policyPath));
  validatePolicy(policy);
  const client = dependencies.client ?? createGitHubClient(options, policy.collection);
  const end = new Date(options.checkedAt);
  const queryStart = new Date(end.getTime() - policy.windows.rolling7dDays * 86_400_000).toISOString();
  const source = dependencies.source ?? (await collectSourceData({ options, policy, client, queryStart }));
  const result = buildDeliveryHealth({
    checkedAt: options.checkedAt,
    publicationMode: options.publicationMode,
    repository: options.repository,
    policy,
    source,
    apiStatus: source.apiStatus ?? client.status(),
  });
  if (options.updateIssues) {
    result.issueUpdates = await publishSliIssues({ client, repository: options.repository, record: result.record });
  }
  return result;
}

async function collectSourceData({ options, policy, client, queryStart }) {
  const workflows = policy.collection.workflowSources;
  const sourceFailures = [];
  const safely = async (source, collect) => {
    try {
      return await collect();
    } catch (error) {
      sourceFailures.push({ source, error: boundedError(error) });
      return [];
    }
  };
  const [pulls, platformPrRuns, dispatchRuns, deployRuns, ephemeralRuns, circuitIssues] = await Promise.all([
    safely("pull-requests", () =>
      fetchPullRequests(client, options.repository, queryStart, policy.collection.maxPages),
    ),
    safely("platform-pr-runs", () =>
      fetchWorkflowRuns(client, workflows.platformPr, queryStart, policy.collection.maxPages, policy.windows.lastN),
    ),
    safely("release-dispatch-runs", () =>
      fetchWorkflowRuns(
        client,
        workflows.releaseDispatch,
        queryStart,
        policy.collection.maxPages,
        policy.windows.lastN,
      ),
    ),
    safely("platform-deploy-runs", () =>
      fetchWorkflowRuns(client, workflows.platformDeploy, queryStart, policy.collection.maxPages, policy.windows.lastN),
    ),
    safely("ephemeral-verification-runs", () =>
      fetchWorkflowRuns(
        client,
        workflows.ephemeralVerification,
        queryStart,
        policy.collection.maxPages,
        policy.windows.lastN,
      ),
    ),
    safely("delivery-failure-signatures", () =>
      fetchCircuitIssues(client, options.repository, policy.collection.maxPages),
    ),
  ]);

  await mapConcurrent(
    pulls.filter((pull) => pull.filesTruncated || pull.reviewsTruncated),
    policy.collection.concurrency,
    async (pull) => {
      if (pull.filesTruncated) {
        const files = await safely(`pull-files:${pull.number}`, () =>
          fetchPullFiles(client, pull.number, policy.collection.maxPages),
        );
        if (files.length === pull.changedFiles) {
          pull.files = files;
          pull.filesTruncated = false;
        }
      }
      if (pull.reviewsTruncated) {
        const reviews = await safely(`pull-reviews:${pull.number}`, () =>
          fetchPullReviews(client, pull.number, policy.collection.maxPages),
        );
        if (reviews.length === pull.reviewCount) {
          pull.approvedReviewCount = reviews.filter((review) => review.state === "APPROVED").length;
          pull.reviewsTruncated = false;
        }
      }
      pull.nestedDataTruncated = pull.filesTruncated || pull.reviewsTruncated;
    },
  );

  const actualRuns = deployRuns.filter((run) => run.event === "workflow_dispatch");
  const jobRuns = [...actualRuns, ...ephemeralRuns];
  const jobsByRun = new Map(
    await mapConcurrent(jobRuns, policy.collection.concurrency, async (run) => {
      const jobs = await safely(`jobs:${run.id}`, () => fetchRunJobs(client, run.id, policy.collection.maxPages));
      return [String(run.id), jobs];
    }),
  );

  const releaseRecordsByRun = new Map();
  const ephemeralRecordsByRun = new Map();
  const ephemeralArtifactStatusByRun = new Map();
  const artifactFailures = [];
  await mapConcurrent(actualRuns, policy.collection.concurrency, async (run) => {
    try {
      const records = await fetchReleaseHealthArtifacts(client, run.id);
      releaseRecordsByRun.set(String(run.id), records);
    } catch (error) {
      artifactFailures.push({ runId: run.id, error: boundedError(error) });
    }
  });
  await mapConcurrent(ephemeralRuns, policy.collection.concurrency, async (run) => {
    try {
      const result = await fetchEphemeralVerificationArtifact(client, run);
      ephemeralArtifactStatusByRun.set(String(run.id), result.status);
      if (result.record) ephemeralRecordsByRun.set(String(run.id), result.record);
    } catch (error) {
      ephemeralArtifactStatusByRun.set(String(run.id), "invalid");
      artifactFailures.push({ runId: run.id, artifact: "ephemeral-verification", error: boundedError(error) });
    }
  });

  return {
    pulls,
    platformPrRuns: platformPrRuns.map((run) => ({ ...run, jobs: jobsByRun.get(String(run.id)) ?? [] })),
    dispatchRuns,
    deployRuns: deployRuns.map((run) => ({
      ...run,
      jobs: jobsByRun.get(String(run.id)) ?? [],
      releaseArtifacts: releaseRecordsByRun.get(String(run.id)) ?? [],
    })),
    ephemeralRuns: ephemeralRuns.map((run) => ({
      ...run,
      jobs: jobsByRun.get(String(run.id)) ?? [],
      verificationArtifact: ephemeralRecordsByRun.get(String(run.id)) ?? null,
      artifactCollectionStatus: ephemeralArtifactStatusByRun.get(String(run.id)) ?? "omitted",
    })),
    collection: { ephemeralArtifacts: true },
    circuits: circuitIssues.map((issue) => normalizeCircuitIssue(issue)).filter(Boolean),
    artifactFailures,
    sourceFailures,
    apiStatus: client.status(),
  };
}

export function buildDeliveryHealth(input) {
  const generatedAt = normalizeIso(input.checkedAt);
  if (!generatedAt) throw new Error("checkedAt must be an ISO date.");
  const normalized = normalizeSource(input.source);
  const windows = buildWindows(generatedAt, input.policy.windows);
  const summaries = Object.fromEntries(
    Object.entries(windows).map(([name, window]) => [name, summarizeWindow(normalized, window, input.policy)]),
  );
  const completeness = buildCompleteness(normalized, input.apiStatus);
  const record = {
    schemaVersion: DELIVERY_HEALTH_VERSION,
    generatedAt,
    repository: input.repository,
    publication: { mode: input.publicationMode === "daily" ? "daily" : "hourly" },
    query: {
      bounds: { start: windows.rolling7d.start, end: generatedAt },
      sourceRunIds: {
        platformPr: normalized.platformPrRuns.map((run) => run.id),
        releaseDispatch: normalized.dispatchRuns.map((run) => run.id),
        platformDeploy: normalized.deployRuns.map((run) => run.id),
        ephemeralVerification: normalized.ephemeralRuns.map((run) => run.id),
      },
      sourceRuns: {
        ephemeralVerification: normalized.ephemeralRuns.map((run) => ({
          id: run.id,
          runAttempt: run.run_attempt ?? run.runAttempt ?? null,
          trigger: run.verificationArtifact?.trigger ?? null,
          producerRunId: run.verificationArtifact?.producerRunId ?? null,
          producerRunAttempt: run.verificationArtifact?.producerRunAttempt ?? null,
          failurePhase: run.verificationArtifact?.failurePhase ?? null,
          artifactCollectionStatus: run.artifactCollectionStatus ?? null,
        })),
      },
    },
    completeness,
    policy: {
      schemaVersion: input.policy.schemaVersion,
      windows: input.policy.windows,
      targets: input.policy.targets,
    },
    windows: summaries,
  };
  record.baselineComparison = buildBaselineComparison(record, input.policy.baseline);
  record.rolloutComparisons = buildRolloutComparisons(normalized, windows.rolling7d.start, generatedAt, input.policy);
  record.slis = evaluateSlis(record, input.policy);
  return { record, markdown: renderDeliveryHealthMarkdown(record) };
}

function buildBaselineComparison(record, baseline) {
  return {
    sourceIssue: baseline.sourceIssue,
    capturedAt: baseline.capturedAt,
    metrics: Object.fromEntries(
      Object.entries(baseline.metrics).map(([name, metric]) => {
        const current = getPath(record, metric.currentPath);
        return [
          name,
          {
            baseline: metric.value,
            current: Number.isFinite(current) ? current : null,
            delta: Number.isFinite(current) ? current - metric.value : null,
          },
        ];
      }),
    ),
  };
}

function buildRolloutComparisons(source, queryStart, end, policy) {
  return (policy.rollouts ?? []).map((rollout) => {
    if (!rollout.landedAt) return { issue: rollout.issue, status: "pending", landedAt: null };
    const landedAt = normalizeIso(rollout.landedAt);
    const beforeWindow = { kind: "rolling", start: queryStart, end: landedAt };
    const afterWindow = { kind: "rolling", start: landedAt, end };
    return {
      issue: rollout.issue,
      status: "landed",
      landedAt,
      before: rolloutSnapshot(summarizeWindow(source, beforeWindow, policy)),
      after: rolloutSnapshot(summarizeWindow(source, afterWindow, policy)),
    };
  });
}

function rolloutSnapshot(window) {
  return {
    bounds: window.bounds,
    pullRequestCi: pickRate(window.prs.platformPr.pullRequest),
    mergeGroup: pickRate(window.prs.platformPr.mergeGroup),
    actualRelease: pickRate(window.releases.actual),
    ephemeralVerification: pickRate(window.releases.ephemeral),
    prCiP90Seconds: window.prs.platformPr.combined.executionSeconds.p90,
    creationToMergeP90Seconds: window.prs.creationToMergeSeconds.p90,
  };
}

function pickRate(metric) {
  return { numerator: metric.numerator, denominator: metric.denominator, successRate: metric.successRate };
}

function normalizeSource(source = {}) {
  const combinedDeployRuns = Array.isArray(source.deployRuns) ? source.deployRuns : [];
  return {
    pulls: Array.isArray(source.pulls) ? source.pulls : [],
    platformPrRuns: Array.isArray(source.platformPrRuns) ? source.platformPrRuns : [],
    dispatchRuns: Array.isArray(source.dispatchRuns)
      ? source.dispatchRuns
      : combinedDeployRuns.filter((run) => run.event === "push"),
    deployRuns: combinedDeployRuns.filter((run) => run.event !== "push"),
    ephemeralRuns: Array.isArray(source.ephemeralRuns) ? source.ephemeralRuns : [],
    circuits: Array.isArray(source.circuits) ? source.circuits : [],
    artifactFailures: Array.isArray(source.artifactFailures) ? source.artifactFailures : [],
    sourceFailures: Array.isArray(source.sourceFailures) ? source.sourceFailures : [],
    collection:
      source.collection?.ephemeralArtifacts === true ? { ephemeralArtifacts: true } : { ephemeralArtifacts: false },
  };
}

function buildWindows(end, policy) {
  const endMs = Date.parse(end);
  return {
    rolling24h: {
      kind: "rolling",
      start: new Date(endMs - policy.rolling24hHours * 3_600_000).toISOString(),
      end,
    },
    rolling7d: {
      kind: "rolling",
      start: new Date(endMs - policy.rolling7dDays * 86_400_000).toISOString(),
      end,
    },
    lastN: { kind: "last-n", limit: policy.lastN, start: null, end },
  };
}

function summarizeWindow(source, window, policy) {
  const pulls = selectByWindow(source.pulls, window, (pull) => pull.updatedAt ?? pull.createdAt);
  const platformRuns = selectByWindow(source.platformPrRuns, window, runTimestamp);
  const dispatchRuns = selectByWindow(source.dispatchRuns, window, runTimestamp);
  const deployRuns = selectByWindow(source.deployRuns, window, runTimestamp);
  const ephemeralRuns = selectByWindow(source.ephemeralRuns, window, runTimestamp);
  const circuits = selectByWindow(source.circuits, window, circuitTimestamp);
  const lastNSeries = [
    platformRuns.filter((run) => run.event === "pull_request"),
    platformRuns.filter((run) => run.event === "merge_group"),
    dispatchRuns,
    deployRuns.filter((run) => run.event === "workflow_dispatch"),
    ephemeralRuns,
  ].map((values) => selectMetricSeries(values, window, runTimestamp));
  const bounds = window.kind === "last-n" ? deriveLastNBounds(window.end, window.limit, lastNSeries) : window;
  const failureSignatures = summarizeFailureSignatures(selectMetricSeries(circuits, window, circuitTimestamp));
  const prs = summarizePullRequests(pulls, platformRuns, policy.collection.generatedPaths, window);
  prs.platformPr.rootFailures = failureSignatures.top
    .filter((signature) => signature.lane === "merge-group")
    .map((signature) => ({
      job: signature.job,
      step: signature.step,
      signature: signature.signature,
      rootCauseCode: signature.rootCauseCode,
      occurrenceCount: signature.occurrenceCount,
      canonicalIssueNumber: signature.canonicalIssueNumber,
    }));
  return {
    bounds,
    prs,
    releases: summarizeReleases(dispatchRuns, deployRuns, ephemeralRuns, window),
    failureSignatures,
  };
}

function summarizePullRequests(pulls, runs, generatedPaths, window) {
  const created = selectMetricSeries(pulls, window, (pull) => pull.createdAt);
  const merged = selectMetricSeries(
    pulls.filter((pull) => pull.mergedAt),
    window,
    (pull) => pull.mergedAt,
  );
  const reviewTotals = created.reduce(
    (total, pull) => ({
      submitted: total.submitted + nonNegativeInteger(pull.reviewCount),
      approved: total.approved + nonNegativeInteger(pull.approvedReviewCount),
    }),
    { submitted: 0, approved: 0 },
  );
  const runGroups = {
    pullRequest: selectMetricSeries(
      runs.filter((run) => run.event === "pull_request"),
      window,
      runTimestamp,
    ),
    mergeGroup: selectMetricSeries(
      runs.filter((run) => run.event === "merge_group"),
      window,
      runTimestamp,
    ),
  };
  const pullMetric = summarizeRuns(runGroups.pullRequest);
  const mergeMetric = summarizeRuns(runGroups.mergeGroup);
  return {
    created: created.length,
    merged: merged.length,
    stillOpen: created.filter((pull) => String(pull.state).toUpperCase() === "OPEN").length,
    creationToReadySeconds: percentileSummary(
      created.map((pull) => durationSeconds(pull.createdAt, pull.readyForReviewAt)),
    ),
    creationToMergeSeconds: percentileSummary(merged.map((pull) => durationSeconds(pull.createdAt, pull.mergedAt))),
    changedFiles: percentileSummary(created.map((pull) => numberOrNull(pull.changedFiles))),
    nonGeneratedChurn: percentileSummary(
      created.map((pull) =>
        (pull.files ?? [])
          .filter((file) => !isGeneratedPath(file.path, generatedPaths))
          .reduce((sum, file) => sum + nonNegativeInteger(file.additions) + nonNegativeInteger(file.deletions), 0),
      ),
    ),
    reviews: reviewTotals,
    prScope: summarizePrScope(created),
    platformPr: {
      pullRequest: pullMetric,
      mergeGroup: mergeMetric,
      combined: summarizeRuns(selectMetricSeries(runs, window, runTimestamp)),
      rootFailures: [],
    },
  };
}

// Feeds the pr-scope-policy/v1 calculator (scripts/lib/pr-scope-policy-v1.mjs,
// shared with scripts/platform-pr-scope.mjs) with the same per-pull file data
// this collector already fetches for `changedFiles`/`nonGeneratedChurn`,
// rather than a fixture: production files carry either the GraphQL shape
// (`path`/`additions`/`deletions` only) or, once truncation is resolved via
// the REST fallback above, the full REST shape (`filename`/`status`/patch).
function toScopeChangedFile(file) {
  return {
    filename: file.filename ?? file.path,
    status: file.status ?? "modified",
    previousFilename: file.previous_filename ?? file.previousFilename ?? null,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch ?? null,
  };
}

function summarizePrScope(pulls) {
  const evaluable = pulls.filter((pull) => Array.isArray(pull.files) && pull.files.length > 0 && !pull.filesTruncated);
  const scopes = evaluable.map((pull) => classifyPrScope({ changedFiles: pull.files.map(toScopeChangedFile) }));
  return {
    schemaVersion: "pr-scope-policy/v1",
    evaluated: scopes.length,
    skippedIncomplete: pulls.length - evaluable.length,
    normalizedLines: percentileSummary(scopes.map((scope) => scope.normalized.lines)),
    normalizedFiles: percentileSummary(scopes.map((scope) => scope.normalized.files)),
    statusCounts: countBy(scopes, (scope) => scope.status),
  };
}

function summarizeRuns(runs) {
  const outcomes = countBy(runs, (run) =>
    normalizeDeliveryConclusion({ conclusion: run.conclusion, runAttempt: run.run_attempt ?? run.runAttempt }),
  );
  const numerator = sumOutcomes(outcomes, SUCCESS_OUTCOMES);
  const failures = sumOutcomes(outcomes, FAILURE_OUTCOMES);
  const denominator = numerator + failures;
  return {
    runCount: runs.length,
    outcomes,
    numerator,
    denominator,
    excluded: Object.fromEntries([...INTENTIONAL_OUTCOMES].map((outcome) => [outcome, outcomes[outcome] ?? 0])),
    unknown: outcomes.unknown ?? 0,
    successRate: denominator > 0 ? numerator / denominator : null,
    cancellations: runs.filter((run) => run.conclusion === "cancelled").length,
    retries: runs.reduce((sum, run) => sum + Math.max(0, Number(run.run_attempt ?? run.runAttempt ?? 1) - 1), 0),
    queueWaitSeconds: percentileSummary(
      runs.map((run) => durationSeconds(run.created_at ?? run.createdAt, run.run_started_at ?? run.runStartedAt)),
    ),
    executionSeconds: percentileSummary(
      runs.map((run) => durationSeconds(run.run_started_at ?? run.runStartedAt, run.updated_at ?? run.completedAt)),
    ),
  };
}

function summarizeReleases(dispatchRuns, deployRuns, ephemeralRuns, window) {
  dispatchRuns = selectMetricSeries(dispatchRuns, window, runTimestamp);
  const actualRuns = selectMetricSeries(
    deployRuns.filter((run) => run.event === "workflow_dispatch" && isActualReleaseRun(run)),
    window,
    runTimestamp,
  );
  const actualOutcomes = actualRuns.map((run) => actualReleaseOutcome(run));
  const actualCounts = countBy(actualOutcomes, (entry) => entry.outcome);
  const actualNumerator = sumOutcomes(actualCounts, SUCCESS_OUTCOMES);
  const actualFailures = sumOutcomes(actualCounts, FAILURE_OUTCOMES);
  const actualDenominator = actualNumerator + actualFailures;
  const staging = summarizeStage(actualRuns, "staging");
  const production = summarizeStage(actualRuns, "production");
  const ephemeral = summarizeEphemeral(ephemeralRuns, window);
  return {
    dispatch: summarizeRuns(dispatchRuns),
    actual: {
      runCount: actualRuns.length,
      outcomes: actualCounts,
      numerator: actualNumerator,
      denominator: actualDenominator,
      successRate: actualDenominator > 0 ? actualNumerator / actualDenominator : null,
      supersededOrCoalesced: sumOutcomes(
        actualCounts,
        new Set(["intentional-superseded/coalesced", "cancelled-by-newer-candidate"]),
      ),
      cancelled: actualRuns.filter((run) => run.conclusion === "cancelled").length,
      preMutationFailures: actualOutcomes.filter((entry) => entry.preMutationFailure).length,
    },
    staging,
    production,
    ephemeral,
  };
}

function actualReleaseOutcome(run) {
  if (isNoMutationDecision(run)) return { outcome: "skipped/not-eligible", preMutationFailure: false };
  const record = primaryReleaseRecord(run);
  const outcome = normalizeDeliveryConclusion({
    conclusion: record?.attempt?.result ?? run.conclusion,
    runAttempt: run.run_attempt ?? run.runAttempt,
    reason: record?.attempt?.reason,
  });
  const stagingJob = findStageJob(run, "staging");
  return {
    outcome,
    preMutationFailure:
      Boolean(record) &&
      FAILURE_OUTCOMES.has(outcome) &&
      record?.staging?.applied !== true &&
      stagingJob?.conclusion !== "success",
  };
}

function summarizeStage(runs, stage) {
  const entries = runs.map((run) => {
    const record = primaryReleaseRecord(run);
    const stageRecord = record?.[stage];
    const job = findStageJob(run, stage);
    const conclusion = stageRecord?.result ?? job?.conclusion ?? "skipped";
    const eligible = Boolean(stageRecord?.startedAt || job) && conclusion !== "skipped";
    return {
      conclusion,
      eligible,
      duration: durationSeconds(
        stageRecord?.startedAt ?? job?.started_at,
        stageRecord?.completedAt ?? job?.completed_at,
      ),
      applied: stage === "staging" ? stageRecord?.applied === true : undefined,
      rollback: stage === "production" && record?.recovery?.mode === "rollback",
    };
  });
  const eligible = entries.filter((entry) => entry.eligible);
  const outcomes = countBy(eligible, (entry) => normalizeDeliveryConclusion(entry));
  const numerator = sumOutcomes(outcomes, SUCCESS_OUTCOMES);
  const denominator = numerator + sumOutcomes(outcomes, FAILURE_OUTCOMES);
  return {
    eligible: eligible.length,
    outcomes,
    numerator,
    denominator,
    successRate: denominator > 0 ? numerator / denominator : null,
    durationSeconds: percentileSummary(eligible.map((entry) => entry.duration)),
    applied: entries.filter((entry) => entry.applied).length,
    rollbacks: entries.filter((entry) => entry.rollback).length,
  };
}

function summarizeEphemeral(runs, window) {
  const windowedRuns = selectByWindow(runs, window, runTimestamp);
  const automaticWindowRuns = windowedRuns.filter((run) => run.verificationArtifact?.trigger === "automatic");
  const manualWindowRuns = windowedRuns.filter((run) => run.verificationArtifact?.trigger === "manual");
  const otherWindowRuns = windowedRuns.filter(
    (run) => !["automatic", "manual"].includes(run.verificationArtifact?.trigger),
  );
  const automaticRuns = selectMetricSeries(automaticWindowRuns, window, runTimestamp);
  const manualRuns = selectMetricSeries(manualWindowRuns, window, runTimestamp);
  const otherRuns = selectMetricSeries(otherWindowRuns, window, runTimestamp);
  const entries = automaticWindowRuns.map((run) => {
    const job = (run.jobs ?? []).find((candidate) =>
      /verify release in ephemeral namespace/i.test(candidate.name ?? ""),
    );
    const conclusion = job?.conclusion ?? run.conclusion;
    return {
      run,
      conclusion: run.verificationArtifact?.result ?? conclusion,
      jobConclusion: conclusion,
      runAttempt: run.run_attempt ?? run.runAttempt,
      eligible: conclusion !== "skipped",
      displaced: isConcurrencyDisplaced(run, automaticWindowRuns, conclusion),
    };
  });
  const classified = entries.map((entry) => ({ ...entry, outcome: normalizeDeliveryConclusion(entry) }));
  const metricEntries = selectMetricSeries(
    classified.filter((entry) => SUCCESS_OUTCOMES.has(entry.outcome) || FAILURE_OUTCOMES.has(entry.outcome)),
    window,
    (entry) => runTimestamp(entry.run),
  );
  const intentionalEntries = selectMetricSeries(
    classified.filter((entry) => !SUCCESS_OUTCOMES.has(entry.outcome) && !FAILURE_OUTCOMES.has(entry.outcome)),
    window,
    (entry) => runTimestamp(entry.run),
  );
  const outcomes = {
    ...countBy(metricEntries, (entry) => entry.outcome),
    ...countBy(intentionalEntries, (entry) => entry.outcome),
  };
  const numerator = sumOutcomes(outcomes, SUCCESS_OUTCOMES);
  const failures = sumOutcomes(outcomes, FAILURE_OUTCOMES);
  const denominator = numerator + failures;
  return {
    automaticRuns: automaticRuns.length,
    manualRuns: manualRuns.length,
    otherRuns: otherRuns.length,
    eligible: denominator,
    success: numerator,
    failure: failures,
    skipped: outcomes["skipped/not-eligible"] ?? 0,
    displaced: outcomes["automatic-concurrency-displaced"] ?? 0,
    cancelledOther: [...metricEntries, ...intentionalEntries].filter(
      (entry) => entry.jobConclusion === "cancelled" && entry.outcome !== "automatic-concurrency-displaced",
    ).length,
    outcomes,
    numerator,
    denominator,
    successRate: denominator > 0 ? numerator / denominator : null,
  };
}

function isConcurrencyDisplaced(run, automaticRuns, conclusion) {
  if (conclusion !== "cancelled") return false;
  const cancelledAt = Date.parse(run.updated_at ?? run.completedAt ?? "");
  const startedAt = Date.parse(run.run_started_at ?? run.runStartedAt ?? run.created_at ?? run.createdAt ?? "");
  if (!Number.isFinite(cancelledAt) || !Number.isFinite(startedAt)) return false;
  return automaticRuns.some((candidate) => {
    if (String(candidate.id) === String(run.id)) return false;
    const createdAt = Date.parse(candidate.created_at ?? candidate.createdAt ?? "");
    return Number.isFinite(createdAt) && createdAt >= startedAt && createdAt <= cancelledAt;
  });
}

function summarizeFailureSignatures(circuits) {
  const rootCauseDistribution = countBy(circuits, (circuit) => circuit.rootCauseCode ?? "unknown");
  const recovered = circuits.filter((circuit) => circuit.recoveredAt);
  const detectionSeconds = circuits
    .map((circuit) => detectionLatencySeconds(circuit))
    .filter((value) => value !== null);
  return {
    sourceCount: circuits.length,
    activeCount: circuits.filter((circuit) => ["observed", "holding", "repairing"].includes(circuit.state)).length,
    openMutationCircuitCount: circuits.filter(
      (circuit) => ["holding", "repairing"].includes(circuit.state) && ["staging", "production"].includes(circuit.lane),
    ).length,
    rootCauseDistribution,
    detectionSeconds: percentileSummary(detectionSeconds),
    meanTimeToRecoverySeconds:
      recovered.length > 0
        ? Math.round(
            recovered
              .map((circuit) => durationSeconds(circuit.firstObservedAt, circuit.recoveredAt))
              .filter(Number.isFinite)
              .reduce((sum, value) => sum + value, 0) / recovered.length,
          )
        : null,
    top: circuits
      .map((circuit) => ({
        signature: circuit.signature,
        lane: circuit.lane,
        job: circuit.job ?? "unknown",
        step: circuit.step ?? "unknown",
        rootCauseCode: circuit.rootCauseCode ?? "unknown",
        state: circuit.state,
        occurrenceCount: circuit.occurrenceCount ?? 0,
        canonicalIssueNumber: circuit.canonicalIssueNumber ?? null,
      }))
      .sort((left, right) => right.occurrenceCount - left.occurrenceCount)
      .slice(0, 10),
  };
}

function detectionLatencySeconds(circuit) {
  const observations = [...(circuit.observations ?? [])].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  );
  let thresholdAt = null;
  for (let index = 1; index <= observations.length; index += 1) {
    const subset = observations.slice(0, index);
    if (thresholdForObservations(subset, subset.at(-1)?.observedAt).crossed) {
      thresholdAt = subset.at(-1)?.observedAt;
      break;
    }
  }
  const publishedAt = circuit.canonicalIssueCreatedAt ?? circuit.checkedAt;
  if (!thresholdAt || !publishedAt) return null;
  const seconds = (Date.parse(publishedAt) - Date.parse(thresholdAt)) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : null;
}

export function evaluateSlis(record, policy) {
  const evaluations = [];
  for (const [id, target] of Object.entries(policy.targets)) {
    const window = record.windows[target.window];
    const value = getPath(window, target.metric);
    const sample = getPath(window, target.sampleMetric);
    const complete = record.completeness.status === "complete";
    const sufficient = complete && Number.isFinite(sample) && sample >= target.minimumSample && Number.isFinite(value);
    const passes = sufficient ? compare(value, target.operator, target.value) : null;
    let severity = target.severity;
    if (passes === false && Number.isFinite(target.p0Below) && value < target.p0Below) severity = "p0";
    if (passes === false && Number.isFinite(target.p0At) && value === target.p0At) severity = "p0";
    evaluations.push({
      id,
      window: target.window,
      metric: target.metric,
      value: Number.isFinite(value) ? value : null,
      sample: Number.isFinite(sample) ? sample : 0,
      target: { operator: target.operator, value: target.value, minimumSample: target.minimumSample },
      status: !sufficient ? "insufficient-data" : passes ? "passing" : "breaching",
      severity,
    });
  }
  return evaluations;
}

function buildCompleteness(source, apiStatus = {}) {
  const truncated = Array.isArray(apiStatus.truncated) ? apiStatus.truncated : [];
  const errors = Array.isArray(apiStatus.errors) ? apiStatus.errors : [];
  const missingReleaseArtifacts = source.deployRuns
    .filter(
      (run) =>
        run.event === "workflow_dispatch" &&
        ["success", "failure"].includes(run.conclusion) &&
        isActualReleaseRun(run) &&
        !isNoMutationDecision(run),
    )
    .filter((run) => (run.releaseArtifacts ?? []).every((record) => record.schemaVersion !== "release-health/v1"))
    .map((run) => run.id);
  const missingEphemeralArtifacts = source.collection.ephemeralArtifacts
    ? source.ephemeralRuns
        .filter((run) => {
          const job = (run.jobs ?? []).find((candidate) =>
            /verify release in ephemeral namespace/i.test(candidate.name ?? ""),
          );
          return job && job.conclusion !== "skipped" && ["absent", "omitted"].includes(run.artifactCollectionStatus);
        })
        .map((run) => run.id)
    : [];
  const reasons = [
    ...truncated.map((entry) => `truncated:${entry}`),
    ...errors.map((entry) => `api:${boundedError(entry)}`),
    ...source.artifactFailures.map((entry) => `artifact:${entry.runId}`),
    ...source.sourceFailures.map((entry) => `source:${entry.source}`),
    ...missingReleaseArtifacts.map((runId) => `missing-release-health:${runId}`),
    ...missingEphemeralArtifacts.map((runId) => `missing-ephemeral-evidence:${runId}`),
    ...(source.pulls.some((pull) => pull.nestedDataTruncated) ? ["truncated:pull-request-nested-data"] : []),
  ];
  return {
    status: reasons.length === 0 ? "complete" : "partial",
    reasons,
    api: {
      truncated,
      rateLimited: Boolean(apiStatus.rateLimited),
      rateLimitRemaining: Number.isFinite(apiStatus.rateLimitRemaining) ? apiStatus.rateLimitRemaining : null,
      rateLimitResetAt: apiStatus.rateLimitResetAt ?? null,
      retryCount: nonNegativeInteger(apiStatus.retryCount),
    },
    artifacts: {
      failedRunIds: source.artifactFailures.map((entry) => entry.runId),
      missingSuccessfulReleaseRunIds: missingReleaseArtifacts,
      omittedEphemeralVerificationRunIds: missingEphemeralArtifacts,
    },
  };
}

export function renderDeliveryHealthMarkdown(record) {
  const lines = [
    "## Delivery health",
    "",
    `Generated ${record.generatedAt} (${record.publication.mode}); completeness: **${record.completeness.status}**.`,
    "",
    "| Window | PR CI | Merge group | Actual release | Ephemeral | PR CI p90 | Create→merge p90 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [name, window] of Object.entries(record.windows)) {
    lines.push(
      `| ${name} | ${formatRate(window.prs.platformPr.pullRequest)} | ${formatRate(window.prs.platformPr.mergeGroup)} | ${formatRate(window.releases.actual)} | ${formatRate(window.releases.ephemeral)} | ${formatSeconds(window.prs.platformPr.combined.executionSeconds.p90)} | ${formatSeconds(window.prs.creationToMergeSeconds.p90)} |`,
    );
  }
  lines.push("", `Epic baseline: #${record.baselineComparison.sourceIssue}.`);
  for (const [name, comparison] of Object.entries(record.baselineComparison.metrics)) {
    lines.push(
      `- ${name}: ${formatMetric(comparison.current)} current; ${formatMetric(comparison.baseline)} baseline; ${formatSignedMetric(comparison.delta)} delta.`,
    );
  }
  const current = record.windows.rolling24h;
  lines.push(
    "",
    "### 24-hour event and stage posture",
    "",
    `- PRs: ${current.prs.created} created; ${current.prs.merged} merged; ${current.prs.stillOpen} still open; reviews ${current.prs.reviews.submitted} submitted / ${current.prs.reviews.approved} approved.`,
    `- Platform PR: ${current.prs.platformPr.pullRequest.cancellations + current.prs.platformPr.mergeGroup.cancellations} cancellations; ${current.prs.platformPr.combined.retries} retries. Intentional outcomes remain visible and are excluded from success denominators.`,
    `- Release: ${current.releases.dispatch.runCount} dispatch candidates; ${current.releases.actual.runCount} actual decisions; ${current.releases.actual.preMutationFailures} pre-mutation failures; ${current.releases.actual.supersededOrCoalesced} superseded/coalesced.`,
    `- Ephemeral verification: ${current.releases.ephemeral.automaticRuns} automatic runs; ${current.releases.ephemeral.manualRuns} manual proofs; ${current.releases.ephemeral.otherRuns} unclassified runs; ${current.releases.ephemeral.displaced} concurrency-displaced and ${current.releases.ephemeral.cancelledOther} other cancellations.`,
    `- Staging: ${formatRate(current.releases.staging)}; duration p50/p90 ${formatSeconds(current.releases.staging.durationSeconds.p50)} / ${formatSeconds(current.releases.staging.durationSeconds.p90)}.`,
    `- Production: ${formatRate(current.releases.production)}; rollbacks ${current.releases.production.rollbacks}; duration p50/p90 ${formatSeconds(current.releases.production.durationSeconds.p50)} / ${formatSeconds(current.releases.production.durationSeconds.p90)}.`,
    "",
    "### SLI posture",
    "",
    "| SLI | Window | Observed | Sample | Target | Status |",
    "| --- | --- | ---: | ---: | --- | --- |",
  );
  for (const sli of record.slis) {
    lines.push(
      `| ${sli.id} | ${sli.window} | ${formatMetric(sli.value)} | ${sli.sample} | ${sli.target.operator} ${formatMetric(sli.target.value)} (min ${sli.target.minimumSample}) | ${sli.status}${sli.status === "breaching" ? ` (${sli.severity})` : ""} |`,
    );
  }
  if (record.completeness.reasons.length > 0) {
    lines.push(
      "",
      `Incomplete evidence: ${record.completeness.reasons.join(", ")}. Alerts are suppressed until complete.`,
    );
  }
  return lines.join("\n");
}

export function renderSliIssue(record, sli) {
  return [
    `## Delivery health SLI: ${sli.id}`,
    "",
    `- Status: **${sli.status}**`,
    `- Severity: **${sli.severity.toUpperCase()}**`,
    `- Window: ${sli.window}`,
    `- Observed: ${formatMetric(sli.value)} from ${sli.sample} samples`,
    `- Target: ${sli.target.operator} ${formatMetric(sli.target.value)} after ${sli.target.minimumSample} samples`,
    `- Generated: ${record.generatedAt}`,
    `- Completeness: ${record.completeness.status}`,
    "",
    sli.status === "breaching"
      ? "Recover the affected delivery lane using the release-process runbook, then let a later complete collection close this canonical signal."
      : sli.status === "passing"
        ? "Recovered: the latest complete collection satisfies the policy target."
        : "No new alert decision is made while evidence is incomplete or below the minimum sample.",
    "",
    renderSliMarker({ sli: sli.id, schemaVersion: DELIVERY_HEALTH_SLI_MARKER_VERSION }),
  ].join("\n");
}

export function renderSliMarker(value) {
  return `<!-- ${DELIVERY_HEALTH_SLI_MARKER_VERSION} ${JSON.stringify(value)} -->`;
}

export function parseSliMarker(body) {
  const match = String(body ?? "").match(SLI_MARKER_PATTERN);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return value?.schemaVersion === DELIVERY_HEALTH_SLI_MARKER_VERSION && typeof value.sli === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function publishSliIssues({ client, repository, record }) {
  const query = encodeURIComponent(`repo:${repository} is:issue "${DELIVERY_HEALTH_SLI_MARKER_VERSION}" in:body`);
  const existing = await client.paginate(
    `${API_BASE_URL}/search/issues?q=${query}&per_page=100`,
    (payload) => payload?.items,
    {
      source: "delivery-health-sli-issues",
      maxPages: 5,
    },
  );
  const bySli = new Map(existing.map((issue) => [parseSliMarker(issue.body)?.sli, issue]).filter(([id]) => id));
  const updates = [];
  for (const sli of record.slis) {
    const issue = bySli.get(sli.id);
    if (sli.status === "breaching") {
      const body = renderSliIssue(record, sli);
      const title = `[Delivery health] ${sli.severity.toUpperCase()} ${sli.id}`;
      const saved = issue
        ? await client.json(`/issues/${issue.number}`, { method: "PATCH", body: { title, body, state: "open" } })
        : await client.json("/issues", {
            method: "POST",
            body: { title, body, labels: ["kind:ops", "area:infrastructure", `priority:${sli.severity}`] },
          });
      updates.push({ sli: sli.id, action: issue ? "updated" : "created", issueNumber: saved.number });
    } else if (issue?.state === "open" && sli.status === "passing") {
      await client.json(`/issues/${issue.number}`, {
        method: "PATCH",
        body: { body: renderSliIssue(record, sli), state: "closed", state_reason: "completed" },
      });
      updates.push({ sli: sli.id, action: "closed", issueNumber: issue.number });
    } else if (issue?.state === "open" && sli.status === "insufficient-data") {
      await client.json(`/issues/${issue.number}`, { method: "PATCH", body: { body: renderSliIssue(record, sli) } });
      updates.push({ sli: sli.id, action: "held-open-insufficient-data", issueNumber: issue.number });
    }
  }
  return updates;
}

export function createGitHubClient(options, collection = {}) {
  const status = {
    truncated: [],
    errors: [],
    rateLimited: false,
    rateLimitRemaining: null,
    rateLimitResetAt: null,
    retryCount: 0,
  };
  const maxPages = collection.maxPages ?? 10;
  const retries = collection.retries ?? 3;

  async function request(pathOrUrl, requestOptions = {}) {
    const url = String(pathOrUrl).startsWith("http")
      ? String(pathOrUrl)
      : `${API_BASE_URL}/repos/${options.repository}${pathOrUrl}`;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await options.fetchImpl(url, {
          method: requestOptions.method ?? "GET",
          headers: {
            Accept: requestOptions.accept ?? "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            ...(requestOptions.headers ?? {}),
          },
          ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
        });
        updateRateLimit(status, response.headers);
        if (response.ok) return response;
        const rateLimitResponse =
          response.status === 429 ||
          (response.status === 403 && Number(response.headers?.get?.("x-ratelimit-remaining")) === 0);
        if (![502, 503, 504].includes(response.status) && !rateLimitResponse) {
          throw new Error(`GitHub API request failed for ${safeRequestLabel(url)}: ${response.status}`);
        }
        if (attempt === retries)
          throw new Error(`GitHub API request failed for ${safeRequestLabel(url)}: ${response.status}`);
        status.retryCount += 1;
        if (rateLimitResponse) status.rateLimited = true;
        await options.sleep(Math.min(4_000, 250 * 2 ** attempt));
      } catch (error) {
        lastError = error;
        if (attempt === retries || !isRetryableError(error)) break;
        status.retryCount += 1;
        await options.sleep(Math.min(4_000, 250 * 2 ** attempt));
      }
    }
    const message = boundedError(lastError);
    status.errors.push(message);
    throw new Error(message);
  }

  async function json(path, requestOptions = {}) {
    const response = await request(path, requestOptions);
    return response.status === 204 ? null : response.json();
  }

  async function paginate(path, select = (payload) => payload, pagination = {}) {
    const values = [];
    const separator = path.includes("?") ? "&" : "?";
    const pageLimit = pagination.maxPages ?? maxPages;
    for (let page = 1; page <= pageLimit; page += 1) {
      const response = await json(`${path}${separator}page=${page}`);
      const selected = select(response);
      const entries = Array.isArray(selected) ? selected : [];
      values.push(...entries);
      if (entries.length < 100) return values;
    }
    status.truncated.push(pagination.source ?? path.split("?")[0]);
    return values;
  }

  return {
    request,
    json,
    paginate,
    markTruncated: (source) => status.truncated.push(source),
    status: () => structuredClone(status),
  };
}

async function fetchPullRequests(client, repository, queryStart, maxPages) {
  const [owner, name] = repository.split("/");
  const pulls = [];
  let cursor = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await client.json(GRAPHQL_URL, {
      method: "POST",
      body: {
        query: `query DeliveryHealthPulls($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor}nodes{number state isDraft createdAt updatedAt mergedAt additions deletions changedFiles timelineItems(first:1,itemTypes:[READY_FOR_REVIEW_EVENT]){nodes{... on ReadyForReviewEvent{createdAt}}}reviews(first:100){totalCount nodes{state}}files(first:100){totalCount nodes{path additions deletions}}}}}}`,
        variables: { owner, name, cursor },
      },
    });
    if (payload.errors?.length) throw new Error(`GitHub GraphQL failed: ${boundedError(payload.errors[0]?.message)}`);
    const connection = payload.data?.repository?.pullRequests;
    const nodes = connection?.nodes ?? [];
    pulls.push(
      ...nodes.map((pull) => ({
        number: pull.number,
        state: pull.state,
        isDraft: pull.isDraft,
        createdAt: pull.createdAt,
        updatedAt: pull.updatedAt,
        mergedAt: pull.mergedAt,
        readyForReviewAt: pull.timelineItems?.nodes?.[0]?.createdAt ?? (!pull.isDraft ? pull.createdAt : null),
        changedFiles: pull.changedFiles,
        reviewCount: pull.reviews?.totalCount ?? 0,
        approvedReviewCount: (pull.reviews?.nodes ?? []).filter((review) => review.state === "APPROVED").length,
        files: pull.files?.nodes ?? [],
        reviewsTruncated: (pull.reviews?.totalCount ?? 0) > 100,
        filesTruncated: (pull.files?.totalCount ?? 0) > 100,
        nestedDataTruncated: (pull.reviews?.totalCount ?? 0) > 100 || (pull.files?.totalCount ?? 0) > 100,
      })),
    );
    if (!connection?.pageInfo?.hasNextPage || Date.parse(nodes.at(-1)?.updatedAt ?? 0) < Date.parse(queryStart))
      return pulls;
    cursor = connection.pageInfo.endCursor;
  }
  client.markTruncated("pull-requests");
  return pulls;
}

async function fetchWorkflowRuns(client, workflow, queryStart, maxPages, lastN) {
  const runs = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await client.json(
      `/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=100&page=${page}`,
    );
    const entries = payload?.workflow_runs ?? [];
    runs.push(...entries);
    const oldest = entries.at(-1);
    if (
      entries.length < 100 ||
      (runs.length >= lastN && Date.parse(runTimestamp(oldest) ?? 0) < Date.parse(queryStart))
    ) {
      return runs;
    }
  }
  client.markTruncated(`workflow:${workflow}`);
  return runs;
}

async function fetchRunJobs(client, runId, maxPages) {
  return client.paginate(`/actions/runs/${runId}/jobs?filter=all&per_page=100`, (payload) => payload?.jobs, {
    source: `jobs:${runId}`,
    maxPages,
  });
}

async function fetchPullFiles(client, pullNumber, maxPages) {
  return client.paginate(`/pulls/${pullNumber}/files?per_page=100`, (payload) => payload, {
    source: `pull-files:${pullNumber}`,
    maxPages,
  });
}

async function fetchPullReviews(client, pullNumber, maxPages) {
  return client.paginate(`/pulls/${pullNumber}/reviews?per_page=100`, (payload) => payload, {
    source: `pull-reviews:${pullNumber}`,
    maxPages,
  });
}

async function fetchCircuitIssues(client, repository, maxPages) {
  const query = encodeURIComponent(`repo:${repository} is:issue "delivery-failure-signature/v1" in:body`);
  return client.paginate(`${API_BASE_URL}/search/issues?q=${query}&per_page=100`, (payload) => payload?.items, {
    source: "delivery-failure-signatures",
    maxPages,
  });
}

async function fetchReleaseHealthArtifacts(client, runId) {
  const artifacts = await client.paginate(
    `/actions/runs/${runId}/artifacts?per_page=100`,
    (payload) => payload?.artifacts,
    {
      source: `artifacts:${runId}`,
      maxPages: 2,
    },
  );
  const selected = artifacts.filter((artifact) => /(?:staging|production)-release-health/.test(artifact.name ?? ""));
  const records = [];
  for (const artifact of selected) {
    const response = await client.request(artifact.archive_download_url, { accept: "application/vnd.github+json" });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 10 * 1024 * 1024) throw new Error(`Release-health artifact ${artifact.id} exceeds 10 MiB.`);
    for (const [name, contents] of unzipJsonEntries(bytes)) {
      const file = basename(name);
      if (
        ![
          "production-release.json",
          "staging-release.json",
          "production-deploy-root-cause.json",
          "staging-deploy-root-cause.json",
        ].includes(file)
      )
        continue;
      const record = JSON.parse(contents.toString("utf8"));
      if (["release-health/v1", "platform-deploy-root-cause/v1"].includes(record?.schemaVersion)) records.push(record);
    }
  }
  return records;
}

async function fetchEphemeralVerificationArtifact(client, run) {
  const artifacts = await client.paginate(
    `/actions/runs/${run.id}/artifacts?per_page=100`,
    (payload) => payload?.artifacts,
    { source: `ephemeral-artifacts:${run.id}`, maxPages: 2 },
  );
  const runAttempt = run.run_attempt ?? run.runAttempt;
  const suffix = `-${run.id}-${runAttempt}`;
  const selected = artifacts.filter(
    (artifact) =>
      artifact.expired !== true &&
      String(artifact.name ?? "").startsWith("ephemeral-verification-") &&
      String(artifact.name ?? "").endsWith(suffix),
  );
  if (selected.length === 0) return { status: "absent", record: null };
  if (selected.length !== 1) {
    throw new Error(`ephemeral-verification-artifact-ambiguous: run ${run.id} attempt ${runAttempt}.`);
  }
  const [artifact] = selected;
  if (
    !Number.isInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > EPHEMERAL_ARCHIVE_MAX_BYTES
  ) {
    throw new Error(`ephemeral-verification-artifact-size-invalid: artifact ${artifact.id}.`);
  }
  const response = await client.request(artifact.archive_download_url, { accept: "application/vnd.github+json" });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > EPHEMERAL_ARCHIVE_MAX_BYTES) {
    throw new Error(`ephemeral-verification-artifact-size-invalid: artifact ${artifact.id}.`);
  }
  const record = readEphemeralVerificationArchive(bytes, artifact.id);
  if (
    record &&
    (String(record.workflowRunId) !== String(run.id) || String(record.workflowRunAttempt) !== String(runAttempt))
  ) {
    throw new Error(`ephemeral-verification-run-identity-mismatch: run ${run.id} attempt ${runAttempt}.`);
  }
  return record ? { status: "collected", record } : { status: "legacy", record: null };
}

export function readEphemeralVerificationArchive(bytes, artifactId = "unknown") {
  const entries = unzipJsonEntries(bytes, {
    include: (name) => basename(name) === "ephemeral-verification.json",
    maxEntryBytes: EPHEMERAL_RECORD_MAX_BYTES,
  });
  const canonical = [...entries.entries()].filter(([name]) => basename(name) === "ephemeral-verification.json");
  if (canonical.length !== 1) {
    throw new Error(`ephemeral-verification-canonical-payload-absent: artifact ${artifactId}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(canonical[0][1].toString("utf8"));
  } catch {
    throw new Error(`ephemeral-verification-canonical-payload-malformed: artifact ${artifactId}.`);
  }
  return validateEphemeralVerificationRecord(parsed);
}

export function validateEphemeralVerificationRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("ephemeral-verification-record-invalid: record must be an object.");
  }
  if (record.schemaVersion !== EPHEMERAL_VERIFICATION_VERSION) {
    throw new Error(`ephemeral-verification-record-invalid: schemaVersion must be ${EPHEMERAL_VERIFICATION_VERSION}.`);
  }
  const legacyKeys = new Set([
    "schemaVersion",
    "releaseCommit",
    "namespace",
    "workflowRunId",
    "workflowRunAttempt",
    "result",
    "persistentStagingResult",
    "workloads",
    "persistentStagingRetained",
    "checkedAt",
  ]);
  const keys = Object.keys(record);
  if (
    !Object.hasOwn(record, "trigger") &&
    keys.length === legacyKeys.size &&
    keys.every((key) => legacyKeys.has(key))
  ) {
    return null;
  }
  const unknown = keys.filter((key) => !EPHEMERAL_RECORD_KEYS.has(key));
  const missing = [...EPHEMERAL_RECORD_KEYS].filter((key) => !Object.hasOwn(record, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `ephemeral-verification-record-invalid: closed schema mismatch (unknown=${unknown.join(",") || "none"}; missing=${missing.join(",") || "none"}).`,
    );
  }
  if (!isNullableMatch(record.releaseCommit, /^[0-9a-f]{40}$/u)) invalidEphemeralField("releaseCommit");
  if (
    !isNullableMatch(
      record.imageRepository,
      /^registry\.digitalocean\.com\/[a-z0-9][a-z0-9-]{0,62}\/chase-sets-platform$/u,
    )
  )
    invalidEphemeralField("imageRepository");
  if (!isNullableMatch(record.imageDigest, /^sha256:[0-9a-f]{64}$/u)) invalidEphemeralField("imageDigest");
  if (!new Set(["automatic", "manual"]).has(record.trigger)) invalidEphemeralField("trigger");
  if (!/^chase-sets-verify-[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$/u.test(record.namespace ?? ""))
    invalidEphemeralField("namespace");
  for (const field of ["workflowRunId", "workflowRunAttempt"]) {
    if (!isBoundedPositiveIntegerString(record[field], field === "workflowRunId" ? 20 : 6))
      invalidEphemeralField(field);
  }
  if (record.namespace !== `chase-sets-verify-${record.workflowRunId}-${record.workflowRunAttempt}`)
    invalidEphemeralField("namespace identity");
  if (record.trigger === "automatic") {
    if (!isBoundedPositiveIntegerString(record.producerRunId, 20)) invalidEphemeralField("producerRunId");
    if (!isBoundedPositiveIntegerString(record.producerRunAttempt, 6)) invalidEphemeralField("producerRunAttempt");
  } else if (record.producerRunId !== null || record.producerRunAttempt !== null) {
    invalidEphemeralField("manual producer identity");
  }
  if (!new Set(["success", "failure"]).has(record.result)) invalidEphemeralField("result");
  if (record.result === "success" && record.failurePhase !== null) invalidEphemeralField("failurePhase");
  if (record.result === "failure" && !EPHEMERAL_FAILURE_PHASES.has(record.failurePhase))
    invalidEphemeralField("failurePhase");
  if (!new Set(["success", "failure", "not-required"]).has(record.teardownResult))
    invalidEphemeralField("teardownResult");
  if (!new Set(["success", "not-applicable"]).has(record.persistentStagingResult))
    invalidEphemeralField("persistentStagingResult");
  if (typeof record.persistentStagingRetained !== "boolean") invalidEphemeralField("persistentStagingRetained");
  if (
    !Array.isArray(record.workloads) ||
    record.workloads.length < 1 ||
    record.workloads.length > EPHEMERAL_WORKLOADS.size ||
    new Set(record.workloads).size !== record.workloads.length ||
    record.workloads.some((workload) => typeof workload !== "string" || !EPHEMERAL_WORKLOADS.has(workload))
  )
    invalidEphemeralField("workloads");
  if (!isBoundedTimezoneInstant(record.checkedAt)) invalidEphemeralField("checkedAt");
  if (record.result === "success" && (!record.releaseCommit || !record.imageRepository || !record.imageDigest)) {
    throw new Error("ephemeral-verification-record-invalid: successful records require immutable release identity.");
  }
  return structuredClone(record);
}

function invalidEphemeralField(field) {
  throw new Error(`ephemeral-verification-record-invalid: ${field}.`);
}

function isNullableMatch(value, pattern) {
  return value === null || (typeof value === "string" && pattern.test(value));
}

function isBoundedPositiveIntegerString(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength && /^[1-9][0-9]*$/u.test(value);
}

function isBoundedTimezoneInstant(value) {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  )
    return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    timestamp >= Date.parse("2020-01-01T00:00:00.000Z") &&
    timestamp <= Date.parse("2100-01-01T00:00:00.000Z")
  );
}

export function unzipJsonEntries(buffer, options = {}) {
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
    if (name.toLowerCase().endsWith(".json") && (options.include?.(name) ?? true)) {
      const maxEntryBytes = options.maxEntryBytes ?? 2 * 1024 * 1024;
      if (uncompressedSize > maxEntryBytes) throw new Error(`Artifact JSON entry ${name} exceeds its byte bound.`);
      let contents;
      if (method === 0) contents = compressed;
      else if (method === 8) contents = inflateRawSync(compressed);
      else throw new Error(`Artifact ZIP uses unsupported compression method ${method}.`);
      if (contents.length !== uncompressedSize || contents.length > maxEntryBytes)
        throw new Error(`Artifact JSON entry ${name} has an invalid expanded size.`);
      if (entries.has(name)) throw new Error(`Artifact ZIP contains duplicate JSON entry ${name}.`);
      entries.set(name, contents);
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function normalizeCircuitIssue(issue) {
  const record = parseCircuitMarker(issue?.body);
  if (!record) return null;
  return {
    ...record,
    canonicalIssueNumber: record.canonicalIssueNumber ?? issue.number,
    canonicalIssueCreatedAt: issue.created_at ?? null,
    checkedAt: issue.updated_at ?? null,
  };
}

function primaryReleaseRecord(run) {
  const records = (run.releaseArtifacts ?? []).filter((record) => record.schemaVersion === "release-health/v1");
  return records.find((record) => record.attempt?.phase === "production") ?? records[0] ?? null;
}

function isActualReleaseRun(run) {
  if (primaryReleaseRecord(run)) return true;
  return (run.jobs ?? []).some(
    (job) => /resolve release|deploy staging|deploy production/i.test(job.name ?? "") && job.conclusion !== "skipped",
  );
}

function isNoMutationDecision(run) {
  if (primaryReleaseRecord(run)) return false;
  const resolve = (run.jobs ?? []).find((job) => /resolve release/i.test(job.name ?? ""));
  const mutationJobs = (run.jobs ?? []).filter((job) => /deploy staging|deploy production/i.test(job.name ?? ""));
  return (
    run.conclusion === "success" &&
    resolve?.conclusion === "success" &&
    mutationJobs.length > 0 &&
    mutationJobs.every((job) => job.conclusion === "skipped")
  );
}

function findStageJob(run, stage) {
  const pattern = stage === "staging" ? /deploy staging/i : /deploy production/i;
  return (run.jobs ?? []).find((job) => pattern.test(job.name ?? ""));
}

function selectByWindow(values, window, timestamp) {
  const selected = values
    .filter((value) =>
      window.kind === "rolling"
        ? inBounds(timestamp(value), window)
        : Date.parse(timestamp(value) ?? 0) <= Date.parse(window.end),
    )
    .sort((left, right) => Date.parse(timestamp(right) ?? 0) - Date.parse(timestamp(left) ?? 0));
  return selected;
}

function selectMetricSeries(values, window, timestamp) {
  const selected = values
    .filter((value) => inBounds(timestamp(value), window))
    .sort((left, right) => Date.parse(timestamp(right) ?? 0) - Date.parse(timestamp(left) ?? 0));
  return window.kind === "last-n" ? selected.slice(0, window.limit) : selected;
}

function deriveLastNBounds(end, limit, groups) {
  const timestamps = groups.flat().map(runTimestamp).filter(Boolean).sort();
  return {
    kind: "last-n",
    limit,
    start: timestamps[0] ?? null,
    end,
  };
}

function circuitTimestamp(circuit) {
  return circuit.lastObservedAt ?? circuit.firstObservedAt ?? null;
}

function runTimestamp(run) {
  return run.updated_at ?? run.completedAt ?? run.created_at ?? run.createdAt ?? null;
}

function inBounds(value, bounds) {
  const timestamp = Date.parse(value ?? "");
  const start = bounds.start ? Date.parse(bounds.start) : Number.NEGATIVE_INFINITY;
  return Number.isFinite(timestamp) && timestamp >= start && timestamp <= Date.parse(bounds.end);
}

function isGeneratedPath(path, patterns) {
  const normalized = String(path ?? "")
    .replaceAll("\\", "/")
    .toLowerCase();
  return patterns.some((pattern) => {
    const candidate = pattern.toLowerCase();
    if (candidate === "pnpm-lock.yaml") return normalized === candidate;
    if (candidate === "*.snap") return normalized.endsWith(".snap");
    if (candidate === "**/generated/**") return normalized.includes("/generated/");
    if (candidate === "**/*.generated.*") return /\.generated\.[^/]+$/.test(normalized);
    return normalized === candidate;
  });
}

async function mapConcurrent(values, concurrency, mapper) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        output[index] = await mapper(values[index], index);
      }
    }),
  );
  return output;
}

function countBy(values, keyFor) {
  const counts = {};
  for (const value of values) {
    const key = keyFor(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function sumOutcomes(outcomes, selected) {
  return [...selected].reduce((sum, outcome) => sum + (outcomes[outcome] ?? 0), 0);
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * percentile) - 1)];
}

function durationSeconds(start, end) {
  const startMs = Date.parse(start ?? "");
  const endMs = Date.parse(end ?? "");
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? Math.round((endMs - startMs) / 1000)
    : null;
}

function numberOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function getPath(value, path) {
  return path.split(".").reduce((current, segment) => current?.[segment], value);
}

function compare(value, operator, target) {
  if (operator === "gte") return value >= target;
  if (operator === "lte") return value <= target;
  if (operator === "eq") return value === target;
  throw new Error(`Unsupported target operator: ${operator}`);
}

function updateRateLimit(status, headers) {
  const remaining = Number(headers?.get?.("x-ratelimit-remaining"));
  if (Number.isFinite(remaining)) {
    status.rateLimitRemaining =
      status.rateLimitRemaining === null ? remaining : Math.min(status.rateLimitRemaining, remaining);
  }
  const reset = Number(headers?.get?.("x-ratelimit-reset"));
  if (Number.isFinite(reset)) status.rateLimitResetAt = new Date(reset * 1000).toISOString();
}

function isRetryableError(error) {
  return /fetch|network|socket|timed?\s*out|ECONNRESET/i.test(String(error?.message ?? error));
}

function boundedError(error) {
  return String(error?.message ?? error ?? "unknown error")
    .replaceAll(/https?:\/\/[^\s]+/g, "<url>")
    .slice(0, 240);
}

function safeRequestLabel(value) {
  try {
    const url = new URL(value);
    return url.origin === API_BASE_URL ? url.pathname : "artifact-download";
  } catch {
    return "github-api";
  }
}

function normalizeIso(value) {
  const normalized = normalizeString(value);
  return normalized && Number.isFinite(Date.parse(normalized)) ? new Date(normalized).toISOString() : null;
}

function parseBoolean(value) {
  return /^(?:1|true|yes)$/i.test(String(value ?? ""));
}

function formatRate(metric) {
  return metric.denominator > 0
    ? `${formatMetric(metric.successRate)} (${metric.numerator}/${metric.denominator})`
    : "n/a (0/0)";
}

function formatMetric(value) {
  if (!Number.isFinite(value)) return "n/a";
  return value >= 0 && value <= 1 ? `${Math.round(value * 1000) / 10}%` : String(Math.round(value * 10) / 10);
}

function formatSignedMetric(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${formatMetric(value)}`;
}

function formatSeconds(value) {
  return Number.isFinite(value) ? `${Math.round(value)}s` : "n/a";
}

function validateOptions(options) {
  if (!options.repository || !/^[-\w.]+\/[-\w.]+$/.test(options.repository))
    throw new Error("GitHub repository is required.");
  if (!normalizeIso(options.checkedAt)) throw new Error("checkedAt must be an ISO date.");
  if (!["hourly", "daily"].includes(options.publicationMode))
    throw new Error("publicationMode must be hourly or daily.");
  if (typeof options.fetchImpl !== "function") throw new Error("A fetch implementation is required.");
}

function validatePolicy(policy) {
  if (policy?.schemaVersion !== "delivery-health-policy/v1") throw new Error("Unsupported delivery-health policy.");
  if (!Number.isInteger(policy.windows?.lastN) || policy.windows.lastN < 1)
    throw new Error("Policy lastN must be positive.");
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
    const breaches = result.record.slis.filter((sli) => sli.status === "breaching");
    await appendFile(
      options.githubOutputPath,
      `completeness=${result.record.completeness.status}\nbreach_count=${breaches.length}\np0_breach_count=${breaches.filter((sli) => sli.severity === "p0").length}\n`,
    );
  }
}

async function main(argv, env = process.env) {
  const options = parseDeliveryHealthArgs(argv, env);
  try {
    const result = await collectDeliveryHealth(options);
    await writeOutputs(options, result);
    if (!options.githubSummaryPath) console.log(result.markdown);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
