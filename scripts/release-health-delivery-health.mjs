#!/usr/bin/env node
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import process from "node:process";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { buildMetaWorkShareObservation } from "./change-scope.mjs";
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
const SLI_MARKER_PREFIX = "<!-- delivery-health-sli/v1";
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
const SLI_REASON_RANKS = new Map(
  [
    "producer-disabled",
    "source-failure",
    "source-truncated",
    "field-missing",
    "field-invalid",
    "job-collection-failure",
    "artifact-collection-failure",
    "artifact-missing",
    "attempt-conflict",
    "metric-path-missing",
    "sample-path-missing",
    "below-minimum-sample",
  ].map((reasonCode, index) => [reasonCode, index + 1]),
);
const CANONICAL_JOB_NAMES = ["Resolve Release", "Deploy Staging", "Deploy Production"];
const EPHEMERAL_JOB_NAME = "Verify Release in Ephemeral Namespace";
const PRODUCER_REASON_SOURCE = "repo-variable:PLATFORM_EPHEMERAL_VERIFICATION_ENABLED";
const CANONICAL_REASON_RANKS = new Map(
  [
    "canonical-request-failure",
    "canonical-source-truncated",
    "canonical-provider-cap",
    "canonical-count-mismatch",
    "canonical-marker-malformed",
    "canonical-marker-unconfigured",
  ].map((reasonCode, index) => [reasonCode, index + 1]),
);
const TARGET_BASELINE_CONTROL = {
  "pull-request-ci-success": [
    0.738,
    "rolling7d",
    "prs.platformPr.pullRequest.successRate",
    84,
    62,
    84,
    0.7380952380952381,
    "floor-4dp",
  ],
  "merge-group-success": [
    0.9428,
    "rolling7d",
    "prs.platformPr.mergeGroup.successRate",
    35,
    33,
    35,
    0.9428571428571428,
    "floor-4dp",
  ],
  "actual-release-success": [
    0.7857,
    "lastN",
    "releases.actual.successRate",
    14,
    11,
    14,
    0.7857142857142857,
    "floor-4dp",
  ],
  "ephemeral-verification-success": [
    0.95,
    "unavailable",
    "releases.ephemeral.successRate",
    0,
    null,
    null,
    null,
    "unavailable-preserve",
  ],
  "pr-ci-p90": [
    993,
    "rolling7d",
    "prs.platformPr.combined.executionSeconds.p90",
    126,
    null,
    null,
    993,
    "exact-integer",
  ],
  "creation-to-merge-p90": [
    119829,
    "rolling7d",
    "prs.creationToMergeSeconds.p90",
    31,
    null,
    null,
    119829,
    "exact-integer",
  ],
  "repeated-failure-detection": [
    0,
    "rolling7d",
    "failureSignatures.detectionSeconds.p90",
    2,
    null,
    null,
    0,
    "exact-integer",
  ],
  "open-mutation-circuit": [
    0,
    "rolling24h",
    "failureSignatures.openMutationCircuitCount",
    0,
    null,
    null,
    0,
    "exact-integer",
  ],
};
const TARGET_SHAPE_CONTROL = {
  "pull-request-ci-success": [
    "rolling24h",
    "prs.platformPr.pullRequest.successRate",
    "prs.platformPr.pullRequest.denominator",
    "gte",
    10,
    "p1",
    null,
    null,
  ],
  "merge-group-success": [
    "rolling24h",
    "prs.platformPr.mergeGroup.successRate",
    "prs.platformPr.mergeGroup.denominator",
    "gte",
    10,
    "p1",
    null,
    null,
  ],
  "actual-release-success": [
    "lastN",
    "releases.actual.successRate",
    "releases.actual.denominator",
    "gte",
    10,
    "p1",
    0.5,
    null,
  ],
  "ephemeral-verification-success": [
    "lastN",
    "releases.ephemeral.successRate",
    "releases.ephemeral.denominator",
    "gte",
    10,
    "p1",
    null,
    0,
  ],
  "pr-ci-p90": [
    "rolling24h",
    "prs.platformPr.combined.executionSeconds.p90",
    "prs.platformPr.combined.executionSeconds.sampleCount",
    "lte",
    10,
    "p1",
    null,
    null,
  ],
  "creation-to-merge-p90": [
    "rolling7d",
    "prs.creationToMergeSeconds.p90",
    "prs.creationToMergeSeconds.sampleCount",
    "lte",
    10,
    "p1",
    null,
    null,
  ],
  "repeated-failure-detection": [
    "rolling7d",
    "failureSignatures.detectionSeconds.p90",
    "failureSignatures.detectionSeconds.sampleCount",
    "lte",
    1,
    "p1",
    null,
    null,
  ],
  "open-mutation-circuit": [
    "rolling24h",
    "failureSignatures.openMutationCircuitCount",
    "failureSignatures.sourceCount",
    "eq",
    0,
    "p0",
    null,
    null,
  ],
};

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
    ephemeralProducerState: readOption(argv, "--ephemeral-producer-state") ?? "unknown",
    policyPath: readOption(argv, "--policy") ?? DELIVERY_HEALTH_POLICY_PATH,
    fetchImpl: globalThis.fetch,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

export async function readDeliveryHealthPolicy(path = DELIVERY_HEALTH_POLICY_PATH) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function parseRepositoryVariablesAuthority(pages) {
  if (!Array.isArray(pages) || pages.length < 1) return "unknown";
  const totals = new Set();
  const names = new Set();
  const variables = [];
  for (const page of pages) {
    if (
      !page ||
      typeof page !== "object" ||
      Array.isArray(page) ||
      !Number.isInteger(page.total_count) ||
      page.total_count < 0 ||
      !Array.isArray(page.variables)
    ) {
      return "unknown";
    }
    totals.add(page.total_count);
    for (const variable of page.variables) {
      if (
        !variable ||
        typeof variable !== "object" ||
        Array.isArray(variable) ||
        typeof variable.name !== "string" ||
        variable.name.trim().length === 0 ||
        typeof variable.value !== "string"
      ) {
        return "unknown";
      }
      const identity = variable.name.toLocaleLowerCase("en-US");
      if (names.has(identity)) return "unknown";
      names.add(identity);
      variables.push(variable);
    }
  }
  if (totals.size !== 1 || [...totals][0] !== variables.length) return "unknown";
  const target = variables.filter((variable) => variable.name === "PLATFORM_EPHEMERAL_VERIFICATION_ENABLED");
  return target.length === 1 && target[0].value === "true" ? "enabled" : "disabled";
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
  const queryDays = options.publicationMode === "daily" ? 14 : policy.windows.rolling7dDays;
  const queryStart = new Date(end.getTime() - queryDays * 86_400_000).toISOString();
  const source = dependencies.source ?? (await collectSourceData({ options, policy, client, queryStart }));
  const result = buildDeliveryHealth({
    checkedAt: options.checkedAt,
    publicationMode: options.publicationMode,
    repository: options.repository,
    policy,
    source,
    ephemeralProducerState: options.ephemeralProducerState,
    apiStatus: source.apiStatus ?? client.status(),
  });
  await writeOutputs(options, result);
  if (options.updateIssues) {
    await validateCanonicalOutputPayloads(options, result);
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
    options.ephemeralProducerState === "enabled"
      ? safely("ephemeral-verification-runs", () =>
          fetchWorkflowRuns(
            client,
            workflows.ephemeralVerification,
            queryStart,
            policy.collection.maxPages,
            policy.windows.lastN,
          ),
        )
      : [],
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

  let metaWork = { pulls: [], sourceReasons: [] };
  if (options.publicationMode === "daily") {
    try {
      metaWork = await fetchMetaWorkPulls({
        client,
        repository: options.repository,
        start: new Date(Date.parse(options.checkedAt) - 14 * 86_400_000).toISOString(),
        end: options.checkedAt,
        concurrency: policy.collection.concurrency,
      });
    } catch (error) {
      sourceFailures.push({ source: "meta-pull-requests", error: boundedError(error) });
      metaWork = {
        pulls: [],
        sourceReasons: [{ reasonCode: "meta-source-failure", reasonSource: "pull-requests" }],
      };
    }
  }

  const actualRuns = deployRuns.filter((run) => run.event === "workflow_dispatch");
  const jobRuns = [...actualRuns, ...ephemeralRuns];
  const jobStatusByRun = new Map();
  const jobsByRun = new Map(
    await mapConcurrent(jobRuns, policy.collection.concurrency, async (run) => {
      try {
        const jobs = await fetchRunJobs(client, run.id, policy.collection.maxPages);
        jobStatusByRun.set(String(run.id), "collected");
        return [String(run.id), jobs];
      } catch (error) {
        sourceFailures.push({ source: `jobs:${run.id}`, error: boundedError(error) });
        jobStatusByRun.set(String(run.id), "failure");
        return [String(run.id), []];
      }
    }),
  );

  const releaseRecordsByRun = new Map();
  const releaseArtifactStatusByRun = new Map();
  const ephemeralRecordsByRun = new Map();
  const ephemeralArtifactStatusByRun = new Map();
  const artifactFailures = [];
  await mapConcurrent(actualRuns, policy.collection.concurrency, async (run) => {
    try {
      const records = await fetchReleaseHealthArtifacts(client, run.id);
      releaseRecordsByRun.set(String(run.id), records);
      releaseArtifactStatusByRun.set(String(run.id), records.length > 0 ? "collected" : "absent");
    } catch (error) {
      releaseArtifactStatusByRun.set(String(run.id), "failure");
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
      jobCollectionStatus: jobStatusByRun.get(String(run.id)) ?? "omitted",
      releaseArtifacts: releaseRecordsByRun.get(String(run.id)) ?? [],
      artifactCollectionStatus: releaseArtifactStatusByRun.get(String(run.id)) ?? "omitted",
    })),
    ephemeralRuns: ephemeralRuns.map((run) => ({
      ...run,
      jobs: jobsByRun.get(String(run.id)) ?? [],
      jobCollectionStatus: jobStatusByRun.get(String(run.id)) ?? "omitted",
      verificationArtifact: ephemeralRecordsByRun.get(String(run.id)) ?? null,
      artifactCollectionStatus: ephemeralArtifactStatusByRun.get(String(run.id)) ?? "omitted",
    })),
    collection: {
      ephemeralArtifacts: options.ephemeralProducerState === "enabled",
      metaWorkFiles: options.publicationMode === "daily",
    },
    circuits: circuitIssues.map((issue) => normalizeCircuitIssue(issue)).filter(Boolean),
    artifactFailures,
    sourceFailures,
    metaWork,
    apiStatus: client.status(),
  };
}

export function buildDeliveryHealth(input) {
  const generatedAt = normalizeIso(input.checkedAt);
  if (!generatedAt) throw new Error("checkedAt must be an ISO date.");
  const ephemeralProducerState = input.ephemeralProducerState ?? input.source?.ephemeralProducerState ?? "unknown";
  const normalized = normalizeSource(input.source);
  const windows = buildWindows(generatedAt, input.policy.windows);
  const summaries = Object.fromEntries(
    Object.entries(windows).map(([name, window]) => [name, summarizeWindow(normalized, window, input.policy)]),
  );
  const completeness = buildCompleteness(normalized, input.apiStatus, ephemeralProducerState);
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
  if (record.publication.mode === "daily") {
    const bounds = {
      start: new Date(Date.parse(generatedAt) - 14 * 86_400_000).toISOString(),
      end: generatedAt,
    };
    const sourceReasons = [];
    if (!normalized.collection.metaWorkFiles) {
      sourceReasons.push({ reasonCode: "meta-source-failure", reasonSource: "pull-requests" });
    }
    sourceReasons.push(...normalized.metaWork.sourceReasons);
    record.observations = {
      metaWorkShare: buildMetaWorkShareObservation({
        bounds,
        sourceReasons,
        pulls: normalized.metaWork.pulls,
      }),
    };
  }
  record.baselineComparison = buildBaselineComparison(record, input.policy.baseline);
  record.rolloutComparisons = buildRolloutComparisons(normalized, windows.rolling7d.start, generatedAt, input.policy);
  record.slis = evaluateSlis(
    record,
    input.policy,
    buildTargetReasons(normalized, input.apiStatus, windows, input.policy, ephemeralProducerState),
    ephemeralProducerState,
  );
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
  const platformPr = bindAuthoritativeRunRecords(
    Array.isArray(source.platformPrRuns) ? source.platformPrRuns : [],
    "platform-pr.yml",
  );
  const dispatch = bindAuthoritativeRunRecords(
    Array.isArray(source.dispatchRuns) ? source.dispatchRuns : combinedDeployRuns.filter((run) => run.event === "push"),
    "platform-release-candidate.yml",
  );
  const deploy = bindAuthoritativeRunRecords(
    combinedDeployRuns.filter((run) => run.event !== "push"),
    "platform-production.yml",
  );
  const ephemeral = bindAuthoritativeRunRecords(
    Array.isArray(source.ephemeralRuns) ? source.ephemeralRuns : [],
    "platform-ephemeral-verification.yml",
  );
  return {
    pulls: Array.isArray(source.pulls) ? source.pulls : [],
    platformPrRuns: platformPr.runs,
    dispatchRuns: dispatch.runs,
    deployRuns: deploy.runs,
    ephemeralRuns: ephemeral.runs,
    attemptReasons: {
      platformPr: platformPr.reasons,
      dispatch: dispatch.reasons,
      deploy: deploy.reasons,
      ephemeral: ephemeral.reasons,
    },
    circuits: Array.isArray(source.circuits) ? source.circuits : [],
    artifactFailures: Array.isArray(source.artifactFailures) ? source.artifactFailures : [],
    sourceFailures: Array.isArray(source.sourceFailures) ? source.sourceFailures : [],
    metaWork: {
      pulls: Array.isArray(source.metaWork?.pulls) ? source.metaWork.pulls : [],
      sourceReasons: Array.isArray(source.metaWork?.sourceReasons) ? source.metaWork.sourceReasons : [],
    },
    collection: {
      ephemeralArtifacts: source.collection?.ephemeralArtifacts === true,
      metaWorkFiles: source.collection?.metaWorkFiles === true,
    },
  };
}

function bindAuthoritativeRunRecords(runs, workflow) {
  const groups = new Map();
  const reasons = [];
  for (const [index, run] of runs.entries()) {
    const id = run?.id;
    const attempt = run?.run_attempt ?? run?.runAttempt;
    const source = `workflow:${workflow}:run:${isPositiveIdentity(id) ? id : `index-${index}`}`;
    if (!isPositiveIdentity(id)) {
      reasons.push(sliReason(Object.hasOwn(run ?? {}, "id") ? "field-invalid" : "field-missing", `${source}:id`));
      continue;
    }
    if (!isPositiveInteger(attempt)) {
      reasons.push(
        sliReason(
          Object.hasOwn(run ?? {}, "run_attempt") || Object.hasOwn(run ?? {}, "runAttempt")
            ? "field-invalid"
            : "field-missing",
          `${source}:run_attempt`,
        ),
      );
      continue;
    }
    const group = groups.get(String(id)) ?? [];
    group.push({ run, attempt });
    groups.set(String(id), group);
  }
  const authoritative = [];
  for (const [id, group] of groups) {
    const highest = Math.max(...group.map((entry) => entry.attempt));
    const latest = group.filter((entry) => entry.attempt === highest);
    const chosen = [...latest].sort((left, right) =>
      ordinalCompare(JSON.stringify(left.run), JSON.stringify(right.run)),
    )[0].run;
    authoritative.push({
      ...chosen,
      attemptBindingReasons:
        latest.length === 1 ? [] : [sliReason("attempt-conflict", `workflow:${workflow}:run:${id}:attempt:${highest}`)],
    });
  }
  return { runs: authoritative, reasons: orderSliReasons(reasons) };
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
  const releaseCandidates = selectByWindow(
    deployRuns.filter((run) => run.event === "workflow_dispatch"),
    window,
    runTimestamp,
  );
  const releaseAnalysis = analyzeActualReleaseFrontier(
    releaseCandidates,
    window.kind === "last-n" ? window.limit : Number.POSITIVE_INFINITY,
  );
  const actualRuns = releaseAnalysis.selected.map((entry) => entry.run);
  const actualOutcomes = releaseAnalysis.selected.map((entry) => ({
    outcome: entry.outcome,
    preMutationFailure: entry.preMutationFailure,
  }));
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
  const analysis = analyzeEphemeralFrontier(
    windowedRuns,
    window.kind === "last-n" ? window.limit : Number.POSITIVE_INFINITY,
  );
  const automaticRuns = analysis.selected;
  const manualRuns = analysis.manual;
  const otherRuns = analysis.other;
  const classified = automaticRuns.map((entry) => ({
    ...entry,
    jobConclusion: entry.jobConclusion,
  }));
  const metricEntries = classified.filter(
    (entry) => SUCCESS_OUTCOMES.has(entry.outcome) || FAILURE_OUTCOMES.has(entry.outcome),
  );
  const intentionalEntries = classified.filter(
    (entry) => !SUCCESS_OUTCOMES.has(entry.outcome) && !FAILURE_OUTCOMES.has(entry.outcome),
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

function analyzeActualReleaseFrontier(runs, limit) {
  const selected = [];
  const pendingReasons = [];
  const ordered = [...runs].sort(compareRunsNewestFirst);
  for (const run of ordered) {
    const decision = resolveActualReleaseDecision(run);
    if (!decision.applicable) continue;
    if (decision.resolved) {
      if (selected.length < limit) selected.push(decision);
    } else if (selected.length < limit) {
      pendingReasons.push(...decision.reasons);
    }
  }
  return { selected, reasons: orderSliReasons(pendingReasons) };
}

function resolveActualReleaseDecision(run) {
  const runId = String(run.id ?? "unknown");
  const attempt = run.run_attempt ?? run.runAttempt;
  const allJobs = Array.isArray(run.jobs) ? run.jobs : [];
  const releaseRecords = (run.releaseArtifacts ?? []).filter((record) => record?.schemaVersion === "release-health/v1");
  const hasCanonicalEvidence =
    releaseRecords.length > 0 ||
    allJobs.some((job) => CANONICAL_JOB_NAMES.includes(job?.name)) ||
    run.jobCollectionStatus === "failure" ||
    run.artifactCollectionStatus === "failure";
  if (!hasCanonicalEvidence) return { applicable: false, resolved: false, reasons: [] };

  const reasons = [...(run.attemptBindingReasons ?? [])];
  if (run.jobCollectionStatus === "failure") {
    reasons.push(sliReason("job-collection-failure", `run:${runId}`));
  }
  if (run.artifactCollectionStatus === "failure") {
    reasons.push(sliReason("artifact-collection-failure", `run:${runId}`));
  }
  const jobs = new Map();
  for (const name of CANONICAL_JOB_NAMES) {
    const named = allJobs.filter((job) => job?.name === name);
    const current = named.filter((job) => (job.run_attempt ?? job.runAttempt) === attempt);
    if (named.some((job) => !isPositiveInteger(job.run_attempt ?? job.runAttempt))) {
      reasons.push(sliReason("attempt-conflict", `run:${runId}:job:${name}`));
    }
    if (current.length !== 1) reasons.push(sliReason("attempt-conflict", `run:${runId}:job:${name}`));
    if (current.length === 1) jobs.set(name, current[0]);
  }

  const currentRecords = [];
  for (const record of releaseRecords) {
    const recordRunId = record.workflowRunId;
    const recordAttempt = Number(record.workflowRunAttempt);
    if (String(recordRunId) === runId && isPositiveInteger(recordAttempt) && recordAttempt < attempt) continue;
    if (String(recordRunId) !== runId || recordAttempt !== attempt) {
      reasons.push(sliReason("attempt-conflict", `run:${runId}:release-record-identity`));
      continue;
    }
    currentRecords.push(record);
  }

  const byPhase = new Map();
  for (const record of currentRecords) {
    const phase = record.attempt?.phase;
    if (!["queue", "staging", "production"].includes(phase)) {
      reasons.push(sliReason("attempt-conflict", `run:${runId}:release-phase`));
      continue;
    }
    const records = byPhase.get(phase) ?? [];
    records.push(record);
    byPhase.set(phase, records);
  }
  for (const [phase, records] of byPhase) {
    if (records.length !== 1) reasons.push(sliReason("attempt-conflict", `run:${runId}:phase:${phase}`));
  }

  const resolveJob = jobs.get("Resolve Release")?.conclusion;
  const stagingJob = jobs.get("Deploy Staging")?.conclusion;
  const productionJob = jobs.get("Deploy Production")?.conclusion;
  let outcome;
  let terminal;
  if (currentRecords.length === 0) {
    if (resolveJob === "success" && stagingJob === "skipped" && productionJob === "skipped") {
      outcome = "skipped/not-eligible";
    } else {
      if (resolveJob === "success" && [stagingJob, productionJob].some((value) => value && value !== "skipped")) {
        reasons.push(sliReason("artifact-missing", `run:${runId}`));
      }
      reasons.push(sliReason("attempt-conflict", `run:${runId}:zero-record-posture`));
    }
  } else if (currentRecords.length === 1 && byPhase.has("queue")) {
    const record = byPhase.get("queue")[0];
    const valid =
      record.attempt?.result === "skipped" &&
      record.attempt?.reason === "candidate-superseded-before-staging-mutation" &&
      /^[0-9a-f]{40}$/u.test(record.attempt?.supersededByCommit ?? "") &&
      record.staging?.result === "skipped" &&
      record.staging?.applied === false &&
      record.production?.result === "skipped" &&
      resolveJob === "success" &&
      stagingJob === "success" &&
      productionJob === "skipped";
    if (valid) outcome = "intentional-superseded/coalesced";
    else reasons.push(sliReason("attempt-conflict", `run:${runId}:queue-posture`));
  } else if (currentRecords.length === 1 && byPhase.has("staging")) {
    const record = byPhase.get("staging")[0];
    const result = record.attempt?.result;
    if (
      resolveJob === "success" &&
      stagingJob === result &&
      productionJob === "skipped" &&
      record.staging?.result === result
    ) {
      terminal = record;
      outcome = normalizeDeliveryConclusion({
        conclusion: result,
        runAttempt: attempt,
        reason: record.attempt?.reason,
      });
    } else reasons.push(sliReason("attempt-conflict", `run:${runId}:staging-posture`));
  } else if (currentRecords.length === 2 && byPhase.size === 2 && byPhase.has("staging") && byPhase.has("production")) {
    const staging = byPhase.get("staging")[0];
    const production = byPhase.get("production")[0];
    if (
      resolveJob === "success" &&
      stagingJob === staging.attempt?.result &&
      productionJob === production.attempt?.result &&
      staging.staging?.result === staging.attempt?.result &&
      production.production?.result === production.attempt?.result
    ) {
      terminal = production;
      outcome = normalizeDeliveryConclusion({
        conclusion: production.attempt?.result,
        runAttempt: attempt,
        reason: production.attempt?.reason,
      });
    } else reasons.push(sliReason("attempt-conflict", `run:${runId}:production-posture`));
  } else {
    reasons.push(sliReason("attempt-conflict", `run:${runId}:release-shape`));
  }

  const orderedReasons = orderSliReasons(reasons);
  if (orderedReasons.length > 0 || !outcome || outcome === "unknown") {
    if (!outcome || outcome === "unknown")
      orderedReasons.push(sliReason("attempt-conflict", `run:${runId}:terminal-outcome`));
    return { run, applicable: true, resolved: false, reasons: orderSliReasons(orderedReasons) };
  }
  return {
    run,
    applicable: true,
    resolved: true,
    outcome,
    preMutationFailure:
      Boolean(terminal) &&
      FAILURE_OUTCOMES.has(outcome) &&
      terminal.staging?.applied !== true &&
      stagingJob !== "success",
    reasons: [],
  };
}

function analyzeEphemeralFrontier(runs, limit) {
  const ordered = [...runs].sort(compareRunsNewestFirst);
  const resolved = ordered.map(resolveEphemeralDecision);
  const automatic = resolved.filter((entry) => entry.resolved && entry.trigger === "automatic");
  const selected = automatic.slice(0, limit);
  const frontierIndex = selected.length >= limit ? ordered.indexOf(selected.at(-1).run) : Number.POSITIVE_INFINITY;
  const reasons = [];
  for (const entry of resolved) {
    if (entry.resolved) continue;
    const index = ordered.indexOf(entry.run);
    if (index <= frontierIndex) reasons.push(...entry.reasons);
  }
  const automaticRuns = automatic.map((entry) => entry.run);
  for (const entry of selected) {
    entry.displaced = isConcurrencyDisplaced(entry.run, automaticRuns, entry.jobConclusion);
    entry.outcome = normalizeDeliveryConclusion({
      conclusion: entry.record.result ?? entry.jobConclusion,
      runAttempt: entry.run.run_attempt ?? entry.run.runAttempt,
      displaced: entry.displaced,
    });
  }
  return {
    selected,
    manual: resolved.filter((entry) => entry.resolved && entry.trigger === "manual"),
    other: resolved.filter((entry) => !entry.resolved),
    reasons: orderSliReasons(reasons),
  };
}

function resolveEphemeralDecision(run) {
  const runId = String(run.id ?? "unknown");
  const attempt = run.run_attempt ?? run.runAttempt;
  const namedJobs = (run.jobs ?? []).filter((job) => job?.name === EPHEMERAL_JOB_NAME);
  const jobs = namedJobs.filter((job) => (job.run_attempt ?? job.runAttempt) === attempt);
  const reasons = [...(run.attemptBindingReasons ?? [])];
  if (run.jobCollectionStatus === "failure") {
    reasons.push(sliReason("job-collection-failure", `run:${runId}`));
  }
  if (run.artifactCollectionStatus === "invalid") {
    reasons.push(sliReason("artifact-collection-failure", `run:${runId}`));
  }
  if (namedJobs.some((job) => !isPositiveInteger(job.run_attempt ?? job.runAttempt)) || jobs.length !== 1) {
    reasons.push(sliReason("attempt-conflict", `run:${runId}:job:${EPHEMERAL_JOB_NAME}`));
  }
  const record = run.verificationArtifact;
  if (!record) reasons.push(sliReason("artifact-missing", `run:${runId}`));
  else if (String(record.workflowRunId) !== runId || Number(record.workflowRunAttempt) !== attempt) {
    reasons.push(sliReason("attempt-conflict", `run:${runId}:verification-record-identity`));
  }
  if (record && !["automatic", "manual"].includes(record.trigger)) {
    reasons.push(sliReason("field-invalid", `run:${runId}:trigger`));
  }
  const orderedReasons = orderSliReasons(reasons);
  return {
    run,
    record,
    trigger: record?.trigger ?? null,
    jobConclusion: jobs[0]?.conclusion ?? run.conclusion,
    resolved: orderedReasons.length === 0,
    reasons: orderedReasons,
  };
}

function compareRunsNewestFirst(left, right) {
  const time = Date.parse(runTimestamp(right) ?? "") - Date.parse(runTimestamp(left) ?? "");
  if (time !== 0) return time;
  const leftId = BigInt(String(left.id ?? 0));
  const rightId = BigInt(String(right.id ?? 0));
  return rightId > leftId ? 1 : rightId < leftId ? -1 : 0;
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

export function evaluateSlis(record, policy, targetReasons = {}, ephemeralProducerState = "unknown") {
  const evaluations = [];
  for (const [id, target] of Object.entries(policy.targets)) {
    const window = record.windows[target.window];
    const value = getPath(window, target.metric);
    const sample = getPath(window, target.sampleMetric);
    const reasons = [...(targetReasons[id] ?? [])];
    if (value === undefined) reasons.push(sliReason("metric-path-missing", `target:${id}:metric:${target.metric}`));
    if (sample === undefined)
      reasons.push(sliReason("sample-path-missing", `target:${id}:sample:${target.sampleMetric}`));
    const disabled = id === "ephemeral-verification-success" && ephemeralProducerState === "disabled";
    const complete = disabled || orderSliReasons(reasons).every((reason) => reason.reasonCode === "producer-disabled");
    if (!disabled && complete && Number.isFinite(sample) && sample < target.minimumSample) {
      reasons.push(sliReason("below-minimum-sample", `target:${id}`));
    }
    const orderedReasons = orderSliReasons(reasons);
    const sufficient =
      !disabled &&
      orderedReasons.length === 0 &&
      Number.isFinite(sample) &&
      sample >= target.minimumSample &&
      Number.isFinite(value);
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
      status: disabled ? "disabled" : !sufficient ? "insufficient-data" : passes ? "passing" : "breaching",
      severity,
      reasons: disabled ? [sliReason("producer-disabled", PRODUCER_REASON_SOURCE)] : orderedReasons,
    });
  }
  return evaluations;
}

function buildTargetReasons(source, apiStatus = {}, windows, policy, ephemeralProducerState = "unknown") {
  const reasons = Object.fromEntries(Object.keys(policy.targets).map((id) => [id, []]));
  const add = (ids, reasonCode, reasonSource) => {
    for (const id of ids) reasons[id]?.push(sliReason(reasonCode, reasonSource));
  };
  const sourceConsumers = {
    "pull-requests": ["creation-to-merge-p90"],
    "platform-pr-runs": ["pull-request-ci-success", "merge-group-success", "pr-ci-p90"],
    "platform-deploy-runs": ["actual-release-success"],
    "release-dispatch-runs": ["actual-release-success"],
    "ephemeral-verification-runs": ["ephemeral-verification-success"],
    "delivery-failure-signatures": ["repeated-failure-detection", "open-mutation-circuit"],
  };
  for (const failure of source.sourceFailures) {
    if (failure.source.startsWith("jobs:")) {
      // Attempt-bound analyzers localize this failure to the applicable
      // last-N frontier instead of suppressing for an older run.
    } else if (failure.source.startsWith("pull-files:")) {
      // Status-aware PR-file failures belong to the daily observation, not an SLI.
    } else {
      add(sourceConsumers[failure.source] ?? [], "source-failure", failure.source);
    }
  }
  const truncatedConsumers = {
    "workflow:platform-pr.yml": sourceConsumers["platform-pr-runs"],
    "workflow:platform-production.yml": ["actual-release-success"],
    "workflow:platform-release-candidate.yml": ["actual-release-success"],
    "workflow:platform-ephemeral-verification.yml": ["ephemeral-verification-success"],
    "delivery-failure-signatures": sourceConsumers["delivery-failure-signatures"],
    "pull-requests": sourceConsumers["pull-requests"],
  };
  for (const entry of Array.isArray(apiStatus.truncated) ? apiStatus.truncated : []) {
    add(truncatedConsumers[entry] ?? [], "source-truncated", entry);
  }

  for (const reason of source.attemptReasons.platformPr)
    add(sourceConsumers["platform-pr-runs"], reason.reasonCode, reason.reasonSource);
  for (const reason of source.attemptReasons.deploy)
    add(["actual-release-success"], reason.reasonCode, reason.reasonSource);
  if (ephemeralProducerState === "enabled") {
    for (const reason of source.attemptReasons.ephemeral)
      add(["ephemeral-verification-success"], reason.reasonCode, reason.reasonSource);
  }

  for (const run of source.platformPrRuns) {
    validateRequiredFields(
      run,
      ["updated_at"],
      `workflow:platform-pr.yml:run:${run.id ?? "unknown"}`,
      sourceConsumers["platform-pr-runs"],
      add,
      { updated_at: isIsoInstant },
    );
    if (!isIsoInstant(run.updated_at) || !inBounds(run.updated_at, windows.rolling24h)) continue;
    const affected =
      run.event === "pull_request"
        ? ["pull-request-ci-success", "pr-ci-p90"]
        : run.event === "merge_group"
          ? ["merge-group-success", "pr-ci-p90"]
          : sourceConsumers["platform-pr-runs"];
    for (const reason of run.attemptBindingReasons ?? []) add(affected, reason.reasonCode, reason.reasonSource);
    validateRequiredFields(
      run,
      ["id", "event", "conclusion", "run_attempt"],
      `workflow:platform-pr.yml:run:${run.id ?? "unknown"}`,
      affected,
      add,
      {
        id: isPositiveIdentity,
        event: (value) => ["pull_request", "merge_group"].includes(value),
        conclusion: isTerminalConclusion,
        run_attempt: isPositiveInteger,
      },
    );
    if (["pull_request", "merge_group"].includes(run.event)) {
      validateRequiredFields(
        run,
        ["run_started_at"],
        `workflow:platform-pr.yml:run:${run.id ?? "unknown"}`,
        ["pr-ci-p90"],
        add,
        { run_started_at: isIsoInstant },
      );
    }
  }

  for (const pull of source.pulls) {
    if (pull.mergedAt === null || pull.mergedAt === undefined) continue;
    if (!isIsoInstant(pull.mergedAt)) {
      add(["creation-to-merge-p90"], "field-invalid", `pull:${pull.number ?? "unknown"}:mergedAt`);
      continue;
    }
    if (!inBounds(pull.mergedAt, windows.rolling7d)) continue;
    validateRequiredFields(
      pull,
      ["number", "createdAt", "updatedAt", "mergedAt"],
      `pull:${pull.number ?? "unknown"}`,
      ["creation-to-merge-p90"],
      add,
      { number: isPositiveInteger, createdAt: isIsoInstant, updatedAt: isIsoInstant, mergedAt: isIsoInstant },
    );
  }

  for (const run of source.deployRuns.filter((entry) => entry.event === "workflow_dispatch")) {
    validateRequiredFields(
      run,
      ["id", "event", "conclusion", "run_attempt", "updated_at"],
      `workflow:platform-production.yml:run:${run.id ?? "unknown"}`,
      ["actual-release-success"],
      add,
      {
        id: isPositiveIdentity,
        event: (value) => value === "workflow_dispatch",
        conclusion: isTerminalConclusion,
        run_attempt: isPositiveInteger,
        updated_at: isIsoInstant,
      },
    );
  }

  const releaseAnalysis = analyzeActualReleaseFrontier(source.deployRuns, windows.lastN.limit);
  for (const reason of releaseAnalysis.reasons) add(["actual-release-success"], reason.reasonCode, reason.reasonSource);
  if (ephemeralProducerState === "disabled") {
    reasons["ephemeral-verification-success"] = [sliReason("producer-disabled", PRODUCER_REASON_SOURCE)];
  } else if (ephemeralProducerState !== "enabled") {
    add(["ephemeral-verification-success"], "source-failure", PRODUCER_REASON_SOURCE);
  } else {
    for (const run of source.ephemeralRuns) {
      validateRequiredFields(
        run,
        ["id", "conclusion", "run_attempt", "updated_at"],
        `workflow:platform-ephemeral-verification.yml:run:${run.id ?? "unknown"}`,
        ["ephemeral-verification-success"],
        add,
        {
          id: isPositiveIdentity,
          conclusion: isTerminalConclusion,
          run_attempt: isPositiveInteger,
          updated_at: isIsoInstant,
        },
      );
    }
    const ephemeralAnalysis = analyzeEphemeralFrontier(source.ephemeralRuns, windows.lastN.limit);
    for (const reason of ephemeralAnalysis.reasons)
      add(["ephemeral-verification-success"], reason.reasonCode, reason.reasonSource);
  }

  for (const circuit of source.circuits) {
    const base = `delivery-failure-signature:${circuit.canonicalIssueNumber ?? "unknown"}`;
    if (circuit.invalidMarker) {
      add(sourceConsumers["delivery-failure-signatures"], "field-invalid", base);
      continue;
    }
    for (const [field, validator] of [
      ["lastObservedAt", isIsoInstant],
      ["state", (value) => typeof value === "string" && value.length > 0],
      ["lane", (value) => typeof value === "string" && value.length > 0],
    ]) {
      if (!Object.hasOwn(circuit, field) || circuit[field] === null)
        add(sourceConsumers["delivery-failure-signatures"], "field-missing", `${base}:${field}`);
      else if (!validator(circuit[field]))
        add(sourceConsumers["delivery-failure-signatures"], "field-invalid", `${base}:${field}`);
    }
    if (!Array.isArray(circuit.observations))
      add(["repeated-failure-detection"], "field-invalid", `${base}:observations`);
    else if (circuit.observations.some((entry) => !isIsoInstant(entry?.observedAt)))
      add(["repeated-failure-detection"], "field-invalid", `${base}:observations.observedAt`);
    const publishedAt = circuit.canonicalIssueCreatedAt ?? circuit.checkedAt;
    if (!isIsoInstant(publishedAt)) add(["repeated-failure-detection"], "field-invalid", `${base}:publishedAt`);
  }
  return Object.fromEntries(Object.entries(reasons).map(([id, values]) => [id, orderSliReasons(values)]));
}

function validateRequiredFields(value, fields, source, ids, add, validators) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field) || value[field] === null || value[field] === undefined) {
      add(ids, "field-missing", `${source}:${field}`);
    } else if (!validators[field](value[field])) {
      add(ids, "field-invalid", `${source}:${field}`);
    }
  }
}

function sliReason(reasonCode, reasonSource) {
  return { reasonCode, reasonSource };
}

function orderSliReasons(reasons) {
  const unique = new Map();
  for (const reason of reasons) {
    if (!SLI_REASON_RANKS.has(reason?.reasonCode) || typeof reason?.reasonSource !== "string") continue;
    unique.set(`${reason.reasonCode}\u0000${reason.reasonSource}`, reason);
  }
  return [...unique.values()].sort(
    (left, right) =>
      SLI_REASON_RANKS.get(left.reasonCode) - SLI_REASON_RANKS.get(right.reasonCode) ||
      ordinalCompare(left.reasonSource, right.reasonSource),
  );
}

function isPositiveIdentity(value) {
  return (Number.isInteger(value) && value > 0) || (typeof value === "string" && /^[1-9][0-9]*$/u.test(value));
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isIsoInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isTerminalConclusion(value) {
  return [
    "success",
    "failure",
    "timed_out",
    "startup_failure",
    "action_required",
    "cancelled",
    "skipped",
    "neutral",
  ].includes(value);
}

function buildCompleteness(source, apiStatus = {}, ephemeralProducerState = "unknown") {
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
    ...(ephemeralProducerState === "unknown" ? [`source:${PRODUCER_REASON_SOURCE}`] : []),
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
  );
  if (record.publication.mode === "daily") {
    const observation = record.observations.metaWorkShare;
    lines.push(
      "",
      "### 14-day work purpose",
      "",
      `Inclusive bounds: ${observation.bounds.start} to ${observation.bounds.end}.`,
      `- Counts: ${observation.counts.metaOnly} meta-only; ${observation.counts.mixed} mixed; ${observation.counts.product} product; ${observation.counts.unknown} unknown.`,
      `- Share: ${observation.status === "available" ? formatMetric(observation.share) : "unavailable"} (${observation.numerator}/${observation.denominator}).`,
      ...observation.reasons.map((reason) => `- ${reason.reasonCode}: ${reason.reasonSource}.`),
    );
  }
  lines.push(
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
      `Incomplete evidence telemetry: ${record.completeness.reasons.join(", ")}. Each SLI suppresses only the incomplete evidence it consumes.`,
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
        : sli.status === "disabled"
          ? "The automatic producer is authoritatively disabled; an existing canonical signal remains held without opening a new issue."
          : "No new alert decision is made while target evidence is incomplete or below the minimum sample.",
    ...(sli.reasons?.length
      ? ["", ...sli.reasons.map((reason) => `- Reason: ${reason.reasonCode} (${reason.reasonSource})`)]
      : []),
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
  const snapshot = await fetchCanonicalIssueSnapshot(client, repository, new Set(record.slis.map((sli) => sli.id)));
  if (snapshot.status !== "complete") {
    return { status: "canonical-lookup-incomplete", reasons: snapshot.reasons, actions: [] };
  }
  const bySli = new Map();
  for (const issue of snapshot.issues) {
    const marker = parseSliMarker(issue.body);
    if (!marker) continue;
    const group = bySli.get(marker.sli) ?? [];
    group.push(issue);
    bySli.set(marker.sli, group);
  }
  const actions = [];
  for (const sli of record.slis) {
    const matches = (bySli.get(sli.id) ?? []).sort((left, right) => left.number - right.number);
    if (matches.length > 1) {
      actions.push({
        action: "duplicate-marker-conflict",
        sli: sli.id,
        issueNumbers: matches.map((issue) => issue.number),
      });
      continue;
    }
    const issue = matches[0];
    if (sli.status === "breaching") {
      const body = renderSliIssue(record, sli);
      const title = `[Delivery health] ${sli.severity.toUpperCase()} ${sli.id}`;
      const saved = issue
        ? await client.json(`/issues/${issue.number}`, { method: "PATCH", body: { title, body, state: "open" } })
        : await client.json("/issues", {
            method: "POST",
            body: { title, body, labels: ["kind:ops", "area:infrastructure", `priority:${sli.severity}`] },
          });
      actions.push({
        sli: sli.id,
        action: issue ? (issue.state === "open" ? "updated" : "reopened") : "created",
        issueNumber: saved.number,
      });
    } else if (issue?.state === "open" && sli.status === "passing") {
      await client.json(`/issues/${issue.number}`, {
        method: "PATCH",
        body: { body: renderSliIssue(record, sli), state: "closed", state_reason: "completed" },
      });
      actions.push({ sli: sli.id, action: "closed", issueNumber: issue.number });
    } else if (issue?.state === "open" && sli.status === "insufficient-data") {
      await client.json(`/issues/${issue.number}`, { method: "PATCH", body: { body: renderSliIssue(record, sli) } });
      actions.push({ sli: sli.id, action: "held-open-insufficient-data", issueNumber: issue.number });
    } else if (issue?.state === "open" && sli.status === "disabled") {
      if (/^- Status: \*\*disabled\*\*$/mu.test(String(issue.body ?? ""))) {
        actions.push({ sli: sli.id, action: "unchanged-disabled", issueNumber: issue.number });
      } else {
        await client.json(`/issues/${issue.number}`, { method: "PATCH", body: { body: renderSliIssue(record, sli) } });
        actions.push({ sli: sli.id, action: "held-open-disabled", issueNumber: issue.number });
      }
    }
  }
  return { status: "complete", reasons: [], actions };
}

async function fetchCanonicalIssueSnapshot(client, repository, configuredSlis) {
  const reasons = [];
  const issues = [];
  const seenUrls = new Set();
  const query = encodeURIComponent(`repo:${repository} is:issue "${DELIVERY_HEALTH_SLI_MARKER_VERSION}" in:body`);
  let nextUrl = `${API_BASE_URL}/search/issues?q=${query}&per_page=100&page=1`;
  let expectedTotal = null;
  try {
    for (let page = 1; page <= 10 && nextUrl; page += 1) {
      if (seenUrls.has(nextUrl)) {
        reasons.push(canonicalReason("canonical-source-truncated", "delivery-health-sli-search"));
        break;
      }
      seenUrls.add(nextUrl);
      const response = await client.request(nextUrl);
      const payload = await response.json();
      if (
        !payload ||
        typeof payload !== "object" ||
        !Number.isInteger(payload.total_count) ||
        payload.total_count < 0 ||
        !Array.isArray(payload.items)
      ) {
        reasons.push(canonicalReason("canonical-source-truncated", "delivery-health-sli-search"));
        break;
      }
      if (expectedTotal === null) expectedTotal = payload.total_count;
      else if (expectedTotal !== payload.total_count)
        reasons.push(canonicalReason("canonical-count-mismatch", "delivery-health-sli-search"));
      if (payload.incomplete_results !== false) {
        reasons.push(canonicalReason("canonical-source-truncated", "delivery-health-sli-search"));
      }
      if (payload.total_count >= 1_000) {
        reasons.push(canonicalReason("canonical-provider-cap", "delivery-health-sli-search"));
      }
      issues.push(...payload.items);
      if (issues.length >= payload.total_count) {
        nextUrl = null;
        break;
      }
      const candidate = parseNextLink(response.headers?.get?.("link"));
      if (!candidate || !isSafeSearchCursor(candidate, query, page + 1)) {
        reasons.push(canonicalReason("canonical-source-truncated", "delivery-health-sli-search"));
        break;
      }
      nextUrl = candidate;
    }
    if (nextUrl) reasons.push(canonicalReason("canonical-source-truncated", "delivery-health-sli-search"));
  } catch {
    reasons.push(canonicalReason("canonical-request-failure", "delivery-health-sli-search"));
  }

  const issueNumbers = issues.map((issue) => issue?.number);
  const uniqueNumbers = new Set(issueNumbers.filter((number) => Number.isInteger(number) && number > 0));
  if (uniqueNumbers.size !== issues.length) {
    reasons.push(canonicalReason("canonical-source-truncated", "delivery-health-sli-search"));
  }
  if (
    expectedTotal !== null &&
    (uniqueNumbers.size !== expectedTotal || issueNumbers.some((number) => !Number.isInteger(number) || number < 1))
  ) {
    reasons.push(canonicalReason("canonical-count-mismatch", "delivery-health-sli-search"));
  }

  for (const issue of [...issues].sort((left, right) => left.number - right.number)) {
    const body = String(issue.body ?? "");
    const prefixCount = body.split(SLI_MARKER_PREFIX).length - 1;
    if (prefixCount === 0) continue;
    const matches = [...body.matchAll(/<!--\s*delivery-health-sli\/v1\s+(\{[\s\S]*?\})\s*-->/gu)];
    const marker = matches.length === 1 ? parseSliMarker(matches[0][0]) : null;
    if (prefixCount !== 1 || matches.length !== 1 || !marker) {
      reasons.push(canonicalReason("canonical-marker-malformed", `issue:${issue.number}`));
    } else if (!configuredSlis.has(marker.sli)) {
      reasons.push(canonicalReason("canonical-marker-unconfigured", `issue:${issue.number}`));
    }
  }
  const orderedReasons = orderCanonicalReasons(reasons);
  return {
    status: orderedReasons.length === 0 ? "complete" : "canonical-lookup-incomplete",
    reasons: orderedReasons,
    issues: orderedReasons.length === 0 ? issues : [],
  };
}

function parseNextLink(value) {
  if (typeof value !== "string") return null;
  for (const part of value.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/u);
    if (match?.[2] === "next") return match[1];
  }
  return null;
}

function isSafeSearchCursor(value, encodedQuery, expectedPage) {
  try {
    const url = new URL(value);
    return (
      url.origin === API_BASE_URL &&
      url.pathname === "/search/issues" &&
      url.searchParams.get("q") === decodeURIComponent(encodedQuery) &&
      url.searchParams.get("per_page") === "100" &&
      Number(url.searchParams.get("page")) === expectedPage
    );
  } catch {
    return false;
  }
}

function canonicalReason(reasonCode, reasonSource) {
  return { reasonCode, reasonSource };
}

function orderCanonicalReasons(reasons) {
  const unique = new Map();
  for (const reason of reasons) {
    if (!CANONICAL_REASON_RANKS.has(reason?.reasonCode)) continue;
    unique.set(`${reason.reasonCode}\u0000${reason.reasonSource}`, reason);
  }
  return [...unique.values()].sort((left, right) => {
    const rank = CANONICAL_REASON_RANKS.get(left.reasonCode) - CANONICAL_REASON_RANKS.get(right.reasonCode);
    if (rank !== 0) return rank;
    const leftIssue = Number(left.reasonSource.match(/^issue:(\d+)$/u)?.[1] ?? Number.MAX_SAFE_INTEGER);
    const rightIssue = Number(right.reasonSource.match(/^issue:(\d+)$/u)?.[1] ?? Number.MAX_SAFE_INTEGER);
    return leftIssue - rightIssue || ordinalCompare(left.reasonSource, right.reasonSource);
  });
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

async function fetchMetaWorkPulls({ client, repository, start, end, concurrency }) {
  const queryText = `repo:${repository} is:pr is:merged merged:>=${start.slice(0, 10)}`;
  const encodedQuery = encodeURIComponent(queryText);
  let nextUrl = `${API_BASE_URL}/search/issues?q=${encodedQuery}&per_page=100&page=1`;
  const candidates = [];
  const seenUrls = new Set();
  let expectedTotal = null;
  let truncated = false;
  for (let page = 1; page <= 10 && nextUrl; page += 1) {
    if (seenUrls.has(nextUrl)) {
      truncated = true;
      break;
    }
    seenUrls.add(nextUrl);
    const response = await client.request(nextUrl);
    const payload = await response.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      !Number.isInteger(payload.total_count) ||
      payload.total_count < 0 ||
      !Array.isArray(payload.items)
    ) {
      truncated = true;
      break;
    }
    if (expectedTotal === null) expectedTotal = payload.total_count;
    else if (expectedTotal !== payload.total_count) truncated = true;
    if (payload.incomplete_results !== false || payload.total_count >= 1_000) truncated = true;
    candidates.push(...payload.items);
    if (candidates.length >= payload.total_count) {
      nextUrl = null;
      break;
    }
    const candidate = parseNextLink(response.headers?.get?.("link"));
    if (!candidate || !isSafeSearchCursor(candidate, encodedQuery, page + 1)) {
      truncated = true;
      break;
    }
    nextUrl = candidate;
  }
  if (nextUrl) truncated = true;
  const numbers = candidates.map((candidate) => candidate?.number);
  const uniqueNumbers = new Set(numbers.filter((number) => Number.isInteger(number) && number > 0));
  if (
    expectedTotal === null ||
    uniqueNumbers.size !== candidates.length ||
    uniqueNumbers.size !== expectedTotal ||
    numbers.some((number) => !Number.isInteger(number) || number < 1)
  ) {
    truncated = true;
  }
  if (truncated) {
    return {
      pulls: [],
      sourceReasons: [{ reasonCode: "meta-source-truncated", reasonSource: "pull-requests" }],
    };
  }

  const sourceReasons = [];
  const details = await mapConcurrent(
    [...uniqueNumbers].sort((left, right) => left - right),
    concurrency,
    async (number) => {
      try {
        const pull = await client.json(`/pulls/${number}`);
        if (
          !pull ||
          typeof pull !== "object" ||
          pull.number !== number ||
          !Number.isInteger(pull.changed_files) ||
          pull.changed_files < 0 ||
          !isIsoInstant(pull.merged_at)
        ) {
          sourceReasons.push({ reasonCode: "meta-source-truncated", reasonSource: "pull-requests" });
          return null;
        }
        if (!inBounds(pull.merged_at, { start, end })) return null;
        try {
          const files = await fetchStatusAwarePullFiles(client, number, pull.changed_files);
          return {
            number,
            changedFiles: pull.changed_files,
            files: files.files,
            collectionStatus: files.status,
          };
        } catch {
          return { number, changedFiles: pull.changed_files, files: [], collectionStatus: "failure" };
        }
      } catch {
        sourceReasons.push({ reasonCode: "meta-source-failure", reasonSource: `pull-files:${number}` });
        return null;
      }
    },
  );
  return { pulls: details.filter(Boolean), sourceReasons };
}

async function fetchStatusAwarePullFiles(client, pullNumber, expectedCount) {
  if (!Number.isInteger(expectedCount) || expectedCount < 0) return { files: [], status: "truncated" };
  // GitHub's pull-files REST endpoint exposes at most 3,000 files. Reaching
  // that boundary cannot prove exhaustion, even when the PR count says 3,000.
  if (expectedCount >= 3_000) return { files: [], status: "truncated" };
  const files = [];
  const identities = new Set();
  for (let page = 1; page <= 30; page += 1) {
    const payload = await client.json(`/pulls/${pullNumber}/files?per_page=100&page=${page}`);
    if (!Array.isArray(payload)) throw new Error(`Pull ${pullNumber} file response is not an array.`);
    for (const file of payload) {
      const identity =
        file && typeof file === "object"
          ? `${String(file.filename)}\u0000${String(file.status)}\u0000${String(file.previous_filename ?? "")}`
          : "unreadable";
      if (identities.has(identity)) return { files: [...files, file], status: "truncated" };
      identities.add(identity);
      files.push(file);
    }
    if (payload.length < 100) {
      return { files, status: files.length === expectedCount ? "complete" : "complete" };
    }
  }
  return { files, status: "truncated" };
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
  if (!record) {
    return String(issue?.body ?? "").includes("<!-- delivery-failure-signature/v1")
      ? { invalidMarker: true, canonicalIssueNumber: issue?.number ?? null }
      : null;
  }
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

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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
  if (!["enabled", "disabled", "unknown"].includes(options.ephemeralProducerState ?? "unknown"))
    throw new Error("ephemeralProducerState must be enabled, disabled, or unknown.");
  if (typeof options.fetchImpl !== "function") throw new Error("A fetch implementation is required.");
}

function validatePolicy(policy) {
  if (policy?.schemaVersion !== "delivery-health-policy/v1") throw new Error("Unsupported delivery-health policy.");
  if (!Number.isInteger(policy.windows?.lastN) || policy.windows.lastN < 1)
    throw new Error("Policy lastN must be positive.");
  const ids = Object.keys(policy.targets ?? {});
  const expectedIds = Object.keys(TARGET_BASELINE_CONTROL);
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds))
    throw new Error("Policy must contain the settled eight targets in order.");
  for (const [id, expected] of Object.entries(TARGET_BASELINE_CONTROL)) {
    const target = policy.targets[id];
    const baseline = target?.baseline;
    const sample = baseline?.sample;
    const actual = [
      target?.value,
      baseline?.sourceWindow,
      baseline?.statistic,
      sample?.count,
      sample?.numerator,
      sample?.denominator,
      baseline?.observedValue,
      baseline?.rounding,
    ];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Policy baseline mismatch for ${id}.`);
    const shape = [
      target.window,
      target.metric,
      target.sampleMetric,
      target.operator,
      target.minimumSample,
      target.severity,
      target.p0Below ?? null,
      target.p0At ?? null,
    ];
    if (JSON.stringify(shape) !== JSON.stringify(TARGET_SHAPE_CONTROL[id]))
      throw new Error(`Policy target shape mismatch for ${id}.`);
    if (
      baseline.observedAt !== "2026-08-30T03:20:23Z" ||
      typeof baseline.rationale !== "string" ||
      baseline.rationale.length < 1
    )
      throw new Error(`Policy baseline authority is incomplete for ${id}.`);
    if (JSON.stringify(Object.keys(sample)) !== JSON.stringify(["count", "numerator", "denominator"]))
      throw new Error(`Policy baseline sample is not closed for ${id}.`);
    if (
      JSON.stringify(Object.keys(baseline)) !==
      JSON.stringify(["observedAt", "sourceWindow", "statistic", "sample", "observedValue", "rounding", "rationale"])
    )
      throw new Error(`Policy baseline metadata is not closed for ${id}.`);
  }
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

async function validateCanonicalOutputPayloads(options, result) {
  if (!options.outPath || !options.markdownOutPath) {
    throw new Error("Issue publication requires both canonical delivery-health output paths.");
  }
  const outputDirectory = dirname(options.outPath);
  if (
    outputDirectory !== dirname(options.markdownOutPath) ||
    basename(options.outPath) !== "delivery-health.json" ||
    basename(options.markdownOutPath) !== "delivery-health.md"
  ) {
    throw new Error("Issue publication requires the canonical delivery-health artifact directory shape.");
  }
  const payloads = (await readdir(outputDirectory)).sort();
  if (JSON.stringify(payloads) !== JSON.stringify(["delivery-health.json", "delivery-health.md"])) {
    throw new Error("Delivery-health artifact directory must contain exactly the two canonical payloads.");
  }
  let persisted;
  try {
    persisted = JSON.parse(await readFile(options.outPath, "utf8"));
  } catch {
    throw new Error("Canonical delivery-health JSON payload is malformed.");
  }
  if (JSON.stringify(persisted) !== JSON.stringify(result.record)) {
    throw new Error("Canonical delivery-health JSON payload does not match the evaluated record.");
  }
  if ((await readFile(options.markdownOutPath, "utf8")) !== `${result.markdown}\n`) {
    throw new Error("Canonical delivery-health Markdown payload does not match the evaluated record.");
  }
}

async function main(argv, env = process.env) {
  const options = parseDeliveryHealthArgs(argv, env);
  try {
    const result = await collectDeliveryHealth(options);
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
