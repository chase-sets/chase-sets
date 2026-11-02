#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import process from "node:process";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { classifyPrScope } from "./lib/pr-scope-policy-v1.mjs";
import { parseCircuitMarker, thresholdForObservations } from "./release-health-merge-group-failure-signatures.mjs";
import {
  evaluateMergeQualificationPolicy,
  inventoryMergeQualificationAttempts,
  inventoryMergeQualificationProducerAttempts,
  listMergeQualificationAdvisoryRuns,
  readMergeQualificationProducerImageEligibility,
  readMergeQualificationProducerTerminalRecords,
  readMergeQualificationRunCollection,
  readMergeQualificationTerminalRecords,
  readHistoricalProducerPolicy,
  resolveMergeQualificationTerminalReplay,
  validateMergeQualificationDecision,
  validateMergeQualificationCandidate,
  validateMergeQualificationEvent,
  validateMergeQualificationProducerTerminal,
} from "./merge-qualification.mjs";

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
const QUALIFICATION_RECORD_MAX_BYTES = 64 * 1024;

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
  const window = { start: queryStart, end: options.checkedAt, limit: policy.windows.lastN };
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
    safely("pull-requests", () => fetchPullRequests(client, options.repository, window, policy.collection.maxPages)),
    safely("platform-pr-runs", () =>
      fetchWorkflowRuns(client, workflows.platformPr, window, policy.collection.maxPages),
    ),
    safely("release-dispatch-runs", () =>
      fetchWorkflowRuns(client, workflows.releaseDispatch, window, policy.collection.maxPages),
    ),
    safely("platform-deploy-runs", () =>
      fetchWorkflowRuns(client, workflows.platformDeploy, window, policy.collection.maxPages),
    ),
    safely("ephemeral-verification-runs", () =>
      fetchWorkflowRuns(client, workflows.ephemeralVerification, window, policy.collection.maxPages),
    ),
    safely("delivery-failure-signatures", () =>
      fetchCircuitIssues(client, options.repository, policy.collection.maxPages),
    ),
  ]);

  const attemptCache = new Map();
  const runIdCounts = countBy(platformPrRuns, (run) => String(run.id));
  await mapConcurrent(platformPrRuns, policy.collection.concurrency, async (run) => {
    if (!["pull_request", "merge_group"].includes(run.event)) return;
    const key = String(run.id);
    if (runIdCounts[key] !== 1 || !validateFirstAttempt({ ...run, run_attempt: 1 }, run, options.repository)) {
      run.firstAttempt = null;
      return;
    }
    if (!attemptCache.has(key)) {
      attemptCache.set(
        key,
        (async () => {
          try {
            return run.run_attempt === 1
              ? run
              : await client.json(`/actions/runs/${run.id}/attempts/1`, { advisory: true });
          } catch {
            return null;
          }
        })(),
      );
    }
    run.firstAttempt = validateFirstAttempt(await attemptCache.get(key), run, options.repository);
  });
  const firstAttemptCollectionComplete =
    !sourceFailures.some((failure) => failure.source === "platform-pr-runs") &&
    !(client.status().truncated ?? []).includes(`workflow:${workflows.platformPr}`);

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

  const qualification = await collectQualificationEvidence({ options, client });

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
    collection: { ephemeralArtifacts: true, firstAttemptCollectionComplete },
    circuits: circuitIssues.map((issue) => normalizeCircuitIssue(issue)).filter(Boolean),
    artifactFailures,
    sourceFailures,
    qualification,
    apiStatus: client.status(),
  };
}

async function collectQualificationEvidence({ options, client }) {
  const evidence = emptyQualificationEvidence();
  const repository = options.repository;
  const now = () => new Date(options.checkedAt);
  const requestJson = (endpoint) => {
    const prefix = `repos/${repository}`;
    if (!endpoint.startsWith(`${prefix}/`)) throw new Error("qualification_endpoint_invalid");
    return client.json(endpoint.slice(prefix.length), { advisory: true });
  };
  const policies = new Map();
  const readPolicyContent = async (revision) => {
    if (!policies.has(revision)) {
      policies.set(
        revision,
        (async () => {
          const payload = await client.json(`/contents/scripts/merge-qualification-policy.json?ref=${revision}`, {
            advisory: true,
          });
          if (payload?.encoding !== "base64" || typeof payload.content !== "string" || payload.content.length > 100_000)
            throw new Error("qualification_policy_unavailable");
          return Buffer.from(payload.content, "base64").toString("utf8");
        })(),
      );
    }
    return policies.get(revision);
  };
  try {
    let currentContent;
    try {
      currentContent = await readPolicyContent("main");
    } catch (error) {
      if (error.message === "github-not-found") return evidence;
      throw error;
    }
    const currentPolicy = evaluateMergeQualificationPolicy(currentContent, { now });
    if (!currentPolicy.enabled) return evidence;
    evidence.status = "complete";
    const listing = await listMergeQualificationAdvisoryRuns({ repository, requestJson, now });
    if (listing.errors.length) throw new Error(listing.errors[0]);
    const latest = new Map();
    for (const run of listing.runs) {
      const id = decimalIdentity(run?.id);
      const attempt = decimalIdentity(run?.run_attempt);
      if (!id || !attempt) throw new Error("qualification_identity_invalid");
      if (!latest.has(id) || BigInt(attempt) > BigInt(latest.get(id).run_attempt)) latest.set(id, run);
    }
    const inventory = await inventoryMergeQualificationAttempts({
      repository,
      requestJson,
      now,
      advisoryRuns: listing.runs,
      readPolicyContent,
    });
    if (inventory.errors.length) {
      evidence.attempts = [...latest.values()].map((run) => ({
        ...qualificationAttempt(run.id, run.run_attempt, run.conclusion),
        status: "invalid",
      }));
      throw new Error(inventory.errors[0]);
    }
    const collections = new Map();
    const artifactsFor = (runId) => {
      if (!collections.has(runId))
        collections.set(
          runId,
          readMergeQualificationRunCollection({
            repository,
            runId: String(runId),
            runAttempt: "1",
            collection: "artifacts",
            requestJson,
          }),
        );
      return collections.get(runId);
    };
    const downloadArtifact = async ({ runId, name, fileName = "event.json" }) => {
      const listing = await artifactsFor(runId);
      const matches = listing.artifacts.filter((artifact) => artifact.name === name && artifact.expired === false);
      if (matches.length !== 1) throw new Error("qualification_artifact_ambiguous");
      const artifact = matches[0];
      if (
        !Number.isSafeInteger(artifact.size_in_bytes) ||
        artifact.size_in_bytes < 1 ||
        artifact.size_in_bytes > EPHEMERAL_ARCHIVE_MAX_BYTES
      )
        throw new Error("qualification_archive_size_invalid");
      const response = await client.request(`/actions/artifacts/${artifact.id}/zip`, { advisory: true });
      const bytes = await readBoundedQualificationArchive(response);
      return readQualificationArchive(bytes, fileName);
    };
    for (const run of latest.values()) {
      if (run.event !== "workflow_dispatch") continue;
      if (
        run.status === "completed" &&
        !inventory.attempts.some(
          (attempt) => attempt.run_id === String(run.id) && attempt.run_attempt === String(run.run_attempt),
        )
      )
        continue;
      const enabled = evaluateMergeQualificationPolicy(await readPolicyContent(run.head_sha), {
        now: () => new Date(run.run_started_at),
      }).enabled;
      if (!enabled) continue;
      const attempt = qualificationAttempt(run.id, run.run_attempt, run.conclusion);
      evidence.attempts.push(attempt);
      try {
        const text = await downloadArtifact({
          runId: attempt.runId,
          name: `merge-qualification-decision-${attempt.runId}-${attempt.runAttempt}`,
          fileName: "decision.json",
        });
        const decision = JSON.parse(text);
        if (
          validateMergeQualificationDecision(decision).length ||
          decision.repository !== repository ||
          decision.runId !== attempt.runId ||
          decision.runAttempt !== attempt.runAttempt ||
          decision.workflowId !== String(run.workflow_id) ||
          decision.workflowPath !== run.path ||
          decision.policyRevision !== run.head_sha ||
          decision.observedAt !== run.run_started_at ||
          run.display_title !== `Merge Qualification producer ${decision.parentRunId}-${decision.parentRunAttempt}` ||
          decision.policyEnabled !== true
        )
          throw new Error("qualification_decision_invalid");
        attempt.classifierClass = decision.classifierClass;
        attempt.eligible = decision.classifierClass === "isolated" ? true : null;
        if (["not_applicable", "persistent_required"].includes(decision.classifierClass)) {
          attempt.status = "not-required";
          attempt.eligible = false;
          continue;
        }
        const parent = await requestJson(
          `repos/${repository}/actions/runs/${decision.parentRunId}/attempts/${decision.parentRunAttempt}`,
        );
        if (
          parent?.repository?.full_name !== repository ||
          parent.path !== decision.parentWorkflowPath ||
          parent.event !== "merge_group" ||
          String(parent.id) !== decision.parentRunId ||
          String(parent.run_attempt) !== decision.parentRunAttempt ||
          String(parent.workflow_id) !== decision.parentWorkflowId
        )
          throw new Error("qualification_parent_invalid");
        if (decision.candidateSha !== null) {
          const candidate = JSON.parse(
            await downloadArtifact({
              runId: decision.parentRunId,
              name: `merge-qualification-candidate-${decision.parentRunId}-${decision.parentRunAttempt}`,
              fileName: "candidate.json",
            }),
          );
          if (
            validateMergeQualificationCandidate(candidate).length ||
            candidate.repository !== repository ||
            candidate.workflowId !== decision.parentWorkflowId ||
            candidate.workflowPath !== decision.parentWorkflowPath ||
            candidate.runId !== decision.parentRunId ||
            candidate.runAttempt !== decision.parentRunAttempt ||
            candidate.candidateSha !== parent.head_sha ||
            candidate.candidateSha !== decision.candidateSha ||
            candidate.candidateTreeSha !== decision.candidateTreeSha ||
            candidate.builtImageDigest !== decision.builtImageDigest
          )
            throw new Error("qualification_candidate_invalid");
        }
        const terminal = await readMergeQualificationTerminalRecords({
          decision,
          defaultBranch: "main",
          requestJson,
          downloadArtifact,
        });
        if (terminal.errors.length) throw new Error(terminal.errors[0]);
        const replay = resolveMergeQualificationTerminalReplay({ decision, records: terminal.records });
        if (replay.errors.length) throw new Error(replay.errors[0]);
        if (replay.event) {
          attempt.status = "terminal";
          attempt.terminalState = replay.event.terminalState;
          attempt.identityAvailable = replay.event.identityAvailable;
          evidence.events.push(replay.event);
        }
      } catch {
        attempt.status = "invalid";
      }
      if (attempt.status !== "terminal")
        evidence.reasons.push(`qualification:${attempt.runId}/${attempt.runAttempt}:${attempt.status}`);
    }
    let policyHistory;
    const producers = await inventoryMergeQualificationProducerAttempts({
      repository,
      requestJson,
      now,
      advisoryRuns: listing.runs,
      readHistoricalPolicyContent: ({ run }) =>
        readHistoricalProducerPolicy({
          run,
          repository,
          readPolicy: readPolicyContent,
          readHistory: async () => {
            if (!policyHistory)
              policyHistory = client.paginate(
                "/commits?sha=main&path=scripts%2Fmerge-qualification-policy.json&per_page=100",
                (payload) => payload,
                { identity: (commit) => commit.sha },
              );
            return (await policyHistory).map((commit) => `${commit.sha}\t${commit.commit?.committer?.date}`).join("\n");
          },
          readLandingEvidence: ({ revision }) => client.paginate(`/commits/${revision}/pulls?per_page=100`),
        }),
      readProducerImageEligibility: ({ run }) =>
        readMergeQualificationProducerImageEligibility({ repository, run, requestJson }),
    });
    if (producers.errors.length) throw new Error(producers.errors[0]);
    for (const producer of producers.attempts) {
      const attempt = {
        ...qualificationAttempt(producer.run_id, producer.run_attempt, producer.conclusion),
        kind: "producer",
      };
      evidence.attempts.push(attempt);
      if (producer.historicalPolicyState !== "enabled") {
        evidence.reasons.push(`qualification:${attempt.runId}/${attempt.runAttempt}:policy-unknown`);
        continue;
      }
      attempt.eligible = true;
      const run = await requestJson(`repos/${repository}/actions/runs/${attempt.runId}/attempts/${attempt.runAttempt}`);
      const advisoryRun = producer.advisoryRunId
        ? await requestJson(
            `repos/${repository}/actions/runs/${producer.advisoryRunId}/attempts/${producer.advisoryRunAttempt}`,
          )
        : null;
      if (
        advisoryRun &&
        (String(advisoryRun.id) !== producer.advisoryRunId ||
          String(advisoryRun.run_attempt) !== producer.advisoryRunAttempt ||
          advisoryRun.display_title !== `Merge Qualification producer ${attempt.runId}-${attempt.runAttempt}`)
      )
        throw new Error("qualification_advisory_binding_invalid");
      const terminal = await readMergeQualificationProducerTerminalRecords({
        repository,
        producer: run,
        advisoryRun,
        defaultBranch: "main",
        requestJson,
        downloadArtifact,
      });
      if (!terminal.errors.length && terminal.records?.length && terminal.state === "dispatch_loss") {
        attempt.status = "terminal";
        attempt.terminalState = "infrastructure_error";
        attempt.identityAvailable = false;
        evidence.producerEvents.push(...terminal.records.map((record) => JSON.parse(record)));
      } else {
        if (advisoryRun || terminal.state.includes("conflict")) attempt.status = "conflict";
        evidence.reasons.push(`qualification:${attempt.runId}/${attempt.runAttempt}:${terminal.state}`);
      }
    }
  } catch {
    evidence.reasons.push("qualification:authority-unavailable");
  }
  if (evidence.reasons.length) evidence.status = "partial";
  return evidence;
}

export async function readBoundedQualificationArchive(response) {
  const length = response.headers?.get?.("content-length");
  if (
    length !== null &&
    length !== undefined &&
    (!/^\d+$/.test(length) || Number(length) > EPHEMERAL_ARCHIVE_MAX_BYTES)
  )
    throw new Error("qualification_archive_size_invalid");
  if (!response.body?.getReader) throw new Error("qualification_archive_stream_unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > EPHEMERAL_ARCHIVE_MAX_BYTES) throw new Error("qualification_archive_size_invalid");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (size === 0) throw new Error("qualification_archive_size_invalid");
  return Buffer.concat(chunks, size);
}

export function readQualificationArchive(bytes, fileName = "event.json") {
  if (!["event.json", "decision.json", "candidate.json", "cleanup-complete.json"].includes(fileName))
    throw new Error("qualification_payload_path_invalid");
  const entries = unzipJsonEntries(bytes, {
    include: (entry) => entry === fileName,
    maxEntryBytes: QUALIFICATION_RECORD_MAX_BYTES,
  });
  if (entries.size !== 1) throw new Error("qualification_payload_missing");
  return entries.get(fileName).toString("utf8");
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
    qualification: normalized.qualification,
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
    qualification: normalizeQualificationEvidence(source.qualification),
    collection: {
      ephemeralArtifacts: source.collection?.ephemeralArtifacts === true,
      firstAttemptCollectionComplete: source.collection?.firstAttemptCollectionComplete === true,
    },
  };
}

function decimalIdentity(value) {
  if (typeof value !== "string" && !Number.isSafeInteger(value)) return null;
  return /^[1-9][0-9]{0,63}$/.test(String(value)) ? String(value) : null;
}

function qualificationConclusion(value) {
  return [
    "success",
    "failure",
    "neutral",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "stale",
    "startup_failure",
  ].includes(value)
    ? value
    : "unknown";
}

function qualificationAttempt(runId, runAttempt, conclusion) {
  return {
    runId: String(runId),
    runAttempt: String(runAttempt),
    conclusion: qualificationConclusion(conclusion),
    status: "missing",
    terminalState: null,
    classifierClass: null,
    eligible: null,
    identityAvailable: null,
  };
}

function emptyQualificationEvidence() {
  return {
    schemaVersion: "delivery-health-qualification/v1",
    status: "disabled",
    attempts: [],
    events: [],
    producerEvents: [],
    reasons: [],
  };
}

function normalizeQualificationEvidence(value) {
  if (value === undefined) return emptyQualificationEvidence();
  const invalid = () => ({
    ...emptyQualificationEvidence(),
    status: "partial",
    reasons: ["qualification:record-invalid"],
  });
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== "delivery-health-qualification/v1" ||
    Object.keys(value).sort().join(",") !== "attempts,events,producerEvents,reasons,schemaVersion,status" ||
    !["disabled", "complete", "partial"].includes(value.status) ||
    ["attempts", "events", "producerEvents", "reasons"].some(
      (key) => !Array.isArray(value[key]) || value[key].length > 1024,
    ) ||
    value.reasons.some((reason) => typeof reason !== "string" || !/^qualification:[a-z0-9_:/-]{1,160}$/.test(reason))
  )
    return invalid();
  const identities = new Set();
  for (const attempt of value.attempts) {
    const fields =
      attempt?.kind === "producer"
        ? "classifierClass,conclusion,eligible,identityAvailable,kind,runAttempt,runId,status,terminalState"
        : "classifierClass,conclusion,eligible,identityAvailable,runAttempt,runId,status,terminalState";
    const key = `${attempt?.kind ?? "advisory"}:${attempt?.runId}/${attempt?.runAttempt}`;
    if (
      !attempt ||
      Object.keys(attempt).sort().join(",") !== fields ||
      decimalIdentity(attempt.runId) !== attempt.runId ||
      decimalIdentity(attempt.runAttempt) !== attempt.runAttempt ||
      !["terminal", "missing", "invalid", "not-required", "conflict"].includes(attempt.status) ||
      qualificationConclusion(attempt.conclusion) !== attempt.conclusion ||
      ![null, "isolated", "not_applicable", "persistent_required"].includes(attempt.classifierClass) ||
      ![null, true, false].includes(attempt.eligible) ||
      ![null, true, false].includes(attempt.identityAvailable) ||
      (attempt.status === "not-required" &&
        (attempt.eligible !== false || !["not_applicable", "persistent_required"].includes(attempt.classifierClass))) ||
      identities.has(key) ||
      (attempt.status !== "terminal" && attempt.terminalState !== null)
    )
      return invalid();
    identities.add(key);
  }
  const events = [
    ...value.events.map((event) => [event, validateMergeQualificationEvent(event), "advisory"]),
    ...value.producerEvents.map((event) => [event, validateMergeQualificationProducerTerminal(event), "producer"]),
  ];
  const terminalIdentities = new Set();
  for (const [event, errors, kind] of events) {
    const runId = kind === "producer" ? event?.producerRunId : event?.runId;
    const runAttempt = kind === "producer" ? event?.producerRunAttempt : event?.runAttempt;
    const key = `${kind}:${runId}/${runAttempt}`;
    const attempt = value.attempts.find(
      (candidate) =>
        (candidate.kind ?? "advisory") === kind && candidate.runId === runId && candidate.runAttempt === runAttempt,
    );
    if (
      errors.length ||
      !attempt ||
      attempt.status !== "terminal" ||
      attempt.terminalState !== event.terminalState ||
      (kind === "advisory" &&
        (attempt.classifierClass !== event.classifierClass ||
          attempt.identityAvailable !== event.identityAvailable ||
          attempt.eligible !== (event.classifierClass === "isolated" ? true : null))) ||
      (kind === "producer" &&
        (attempt.eligible !== true || attempt.identityAvailable !== false || attempt.classifierClass !== null)) ||
      terminalIdentities.has(key)
    )
      return invalid();
    terminalIdentities.add(key);
  }
  if (
    value.attempts.some(
      (attempt) =>
        attempt.status === "terminal" &&
        !terminalIdentities.has(`${attempt.kind ?? "advisory"}:${attempt.runId}/${attempt.runAttempt}`),
    ) ||
    (value.status === "disabled" &&
      (value.attempts.length || value.events.length || value.producerEvents.length || value.reasons.length)) ||
    (value.status === "complete" &&
      (value.reasons.length ||
        value.attempts.some((attempt) => !["terminal", "not-required"].includes(attempt.status)))) ||
    (value.status === "partial" && value.reasons.length === 0)
  )
    return invalid();
  return value;
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
  for (const event of ["pullRequest", "mergeGroup"]) {
    if (!source.collection.firstAttemptCollectionComplete) {
      prs.platformPr[event].firstAttempt.coverage = "partial";
      prs.platformPr[event].firstAttempt.successRate = null;
      prs.platformPr[event].firstAttempt.collectionComplete = false;
    }
  }
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
      pullRequest: { ...pullMetric, firstAttempt: summarizeFirstAttempts(runGroups.pullRequest) },
      mergeGroup: { ...mergeMetric, firstAttempt: summarizeFirstAttempts(runGroups.mergeGroup) },
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

function validateFirstAttempt(attempt, run, repository) {
  if (
    !attempt ||
    !Number.isSafeInteger(run.id) ||
    run.id <= 0 ||
    !Number.isSafeInteger(run.workflow_id) ||
    run.workflow_id <= 0 ||
    !/^[a-f0-9]{40}$/i.test(run.head_sha ?? "") ||
    run.repository?.full_name !== repository ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    attempt.id !== run.id ||
    attempt.workflow_id !== run.workflow_id ||
    attempt.event !== run.event ||
    attempt.head_sha !== run.head_sha ||
    attempt.repository?.full_name !== repository ||
    attempt.run_attempt !== 1 ||
    !(typeof attempt.conclusion === "string" || attempt.conclusion === null) ||
    !["completed", "queued", "in_progress", "waiting", "requested", "pending"].includes(attempt.status)
  )
    return null;
  return { status: attempt.status, conclusion: attempt.conclusion };
}

function summarizeFirstAttempts(runs) {
  const outcomes = countBy(runs, (run) => {
    const attempt = run.firstAttempt;
    if (!attempt) return "unknown";
    if (attempt.status !== "completed") return attempt.conclusion == null ? "pending" : "unknown";
    return [
      "success",
      "failure",
      "timed_out",
      "startup_failure",
      "action_required",
      "cancelled",
      "skipped",
      "neutral",
    ].includes(attempt.conclusion)
      ? attempt.conclusion
      : "unknown";
  });
  const numerator = outcomes.success ?? 0;
  const denominator =
    numerator + sumOutcomes(outcomes, new Set(["failure", "timed_out", "startup_failure", "action_required"]));
  const unknown = outcomes.unknown ?? 0;
  return {
    runIds: runs.map((run) => run.id),
    runCount: runs.length,
    outcomes,
    numerator,
    denominator,
    excluded: Object.fromEntries(
      ["cancelled", "skipped", "neutral", "pending"].map((outcome) => [outcome, outcomes[outcome] ?? 0]),
    ),
    unknown,
    coverage: unknown > 0 ? "partial" : "complete",
    collectionComplete: true,
    successRate: unknown === 0 && denominator > 0 ? numerator / denominator : null,
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
    ...source.qualification.reasons,
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
  lines.push("", "### Advisory qualification evidence", "", `Evidence: ${record.qualification.status}.`);
  if (record.qualification.status === "disabled")
    lines.push("Qualification is disabled; no advisory assertion is made.");
  lines.push(
    "",
    "| Run / attempt | Conclusion | Evidence | Terminal state | Eligible | Classification | Immutable proof |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const attempt of record.qualification.attempts) {
    lines.push(
      `| ${attempt.runId} / ${attempt.runAttempt} | ${attempt.conclusion ?? "pending"} | ${attempt.status} | ${attempt.terminalState ?? "unknown"} | ${attempt.eligible ?? "unknown"} | ${attempt.classifierClass ?? "unknown"} | ${attempt.identityAvailable ?? "unknown"} |`,
    );
  }
  lines.push(
    "",
    "### First-attempt workflow success (advisory)",
    "",
    "First-attempt workflow success is completed attempt-1 success over determinate completed success/failure outcomes (failure, timed_out, startup_failure, action_required). Cancelled, skipped, neutral and pending are exclusions.",
    "Attempt-one outcomes of the existing latest-activity run cohort (updated_at ?? completedAt ?? created_at ?? createdAt), not a created-at or first-push cohort. Latest/recovered and attempt-one views use identical selected run IDs. Partial counts are observed only; unknown authority makes the rate unavailable. This is not flake attribution or an SLI/gate.",
    "",
    "| Window | Event | Latest/recovered | Attempt-one | Coverage | Unknown | Exclusions (cancelled / skipped / neutral / pending) |",
    "| --- | --- | ---: | ---: | --- | ---: | --- |",
  );
  for (const [name, window] of Object.entries(record.windows)) {
    for (const [event, key] of [
      ["pull_request", "pullRequest"],
      ["merge_group", "mergeGroup"],
    ]) {
      const latest = window.prs.platformPr[key];
      const first = latest.firstAttempt;
      const rate = first.successRate === null ? "unavailable" : `${(first.successRate * 100).toFixed(1)}%`;
      lines.push(
        `| ${name} | ${event} | ${formatRate(latest)} | ${first.numerator}/${first.denominator} (${rate}) | ${first.coverage}${first.collectionComplete ? "" : " (incomplete collection)"} | ${first.unknown} | ${Object.values(first.excluded).join(" / ")} |`,
      );
    }
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
        if (response.status === 404) throw new Error("github-not-found");
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
    if (!requestOptions.advisory) status.errors.push(message);
    throw new Error(message);
  }

  async function json(path, requestOptions = {}) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const response = await request(path, requestOptions);
      if (response.status === 204) return null;
      try {
        return await response.json();
      } catch (error) {
        if (attempt === retries) {
          const message = "github-response-invalid";
          if (!requestOptions.advisory) status.errors.push(message);
          throw new Error(message);
        }
        status.retryCount += 1;
        await options.sleep(Math.min(4_000, 250 * 2 ** attempt));
      }
    }
    throw new Error("github-response-invalid");
  }

  async function paginate(path, select = (payload) => payload, pagination = {}) {
    const values = [];
    const identities = new Set();
    const base = new URL(path, `${API_BASE_URL}/repos/${options.repository}/`);
    if (path.startsWith("/") && !path.startsWith("/repos/"))
      base.pathname = `/repos/${options.repository}${base.pathname}`;
    const initialPage = base.searchParams.get("page");
    if (initialPage !== null && initialPage !== "1") throw new Error("collection_page_invalid");
    const perPage = Number(base.searchParams.get("per_page") ?? 100);
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new Error("collection_page_invalid");
    const pageLimit = Math.min(pagination.maxPages ?? maxPages, 20);
    const repositoryIds = new Set();
    let total;
    const refused = () => {
      status.truncated.push(pagination.source ?? path.split("?")[0]);
      throw new Error("collection_incomplete");
    };
    for (let page = 1; page <= pageLimit; page += 1) {
      base.searchParams.set("page", String(page));
      const response = await request(base.href);
      const payload = await response.json();
      const entries = select(payload);
      if (!Array.isArray(entries) || entries.length > perPage || payload?.incomplete_results === true) return refused();
      const observedTotal = payload?.total_count;
      if (observedTotal !== undefined) {
        if (
          !Number.isSafeInteger(observedTotal) ||
          observedTotal < 0 ||
          (total !== undefined && total !== observedTotal) ||
          observedTotal > pageLimit * perPage ||
          (pagination.providerCap !== undefined && observedTotal >= pagination.providerCap)
        )
          return refused();
        total = observedTotal;
      } else if (pagination.requireTotal) return refused();
      for (const entry of entries) {
        const identity = pagination.identity ? pagination.identity(entry) : (entry?.id ?? entry?.node_id);
        if (
          (typeof identity !== "string" && !Number.isSafeInteger(identity)) ||
          String(identity).length < 1 ||
          String(identity).length > 256 ||
          identities.has(String(identity))
        )
          return refused();
        identities.add(String(identity));
      }
      values.push(...entries);
      const link = response.headers?.get?.("link") ?? "";
      if (link.length > 8192) return refused();
      const next = [];
      for (const part of link ? link.split(/,\s*(?=<)/) : []) {
        const match = /^<([^<>]+)>\s*;\s*rel="([a-z_ ]+)"$/.exec(part.trim());
        if (!match) return refused();
        let target;
        try {
          target = new URL(match[1]);
        } catch {
          return refused();
        }
        const linkedPage = Number(target.searchParams.get("page"));
        if (!Number.isInteger(linkedPage) || linkedPage < 1 || linkedPage > pageLimit) return refused();
        const expected = new URL(base);
        expected.searchParams.set("page", String(linkedPage));
        target.searchParams.sort();
        expected.searchParams.sort();
        if (
          target.origin !== API_BASE_URL ||
          !sameRepositoryPath(target.pathname, expected.pathname, repositoryIds) ||
          target.search !== expected.search ||
          (entries.length < perPage && linkedPage > page)
        )
          return refused();
        for (const relation of match[2].split(" ")) {
          if (!["next", "prev", "first", "last"].includes(relation)) return refused();
          if (relation === "next") {
            if (linkedPage !== page + 1) return refused();
            next.push(target);
          }
        }
      }
      if (next.length > 1) return refused();
      if (total !== undefined) {
        if (values.length > total || (values.length === total && next.length)) return refused();
        if (values.length === total) return values;
        if (entries.length !== perPage) return refused();
      } else if (entries.length < perPage) {
        if (next.length) return refused();
        return values;
      }
    }
    return refused();
  }

  return {
    request,
    json,
    paginate,
    markTruncated: (source) => status.truncated.push(source),
    status: () => structuredClone(status),
  };
}

// A created-date window alone loses old runs retried today. Reconcile disjoint
// historical partitions before selecting latest-activity and independent last-N series.
async function collectPartitionedHistory({ end, maxPages, read, identity, createdAt }) {
  let queries = 0;
  const seen = new Map();
  const visit = async (start, finish) => {
    if (++queries > maxPages * 8) throw new Error("history_partition_limit");
    const range = `${new Date(start * 1000).toISOString()}..${new Date(finish * 1000 + 999).toISOString()}`;
    const collection = await read(range);
    if (!Number.isSafeInteger(collection.total) || collection.total < 0)
      throw new Error("history_collection_incomplete");
    if (collection.total >= 1000 || collection.total > maxPages * 100) {
      if (start >= finish) throw new Error("history_provider_cap");
      const midpoint = Math.floor((start + finish) / 2);
      const left = await visit(start, midpoint);
      const right = await visit(midpoint + 1, finish);
      const total = left.total + right.total;
      // A saturated provider count is a lower bound, not an exact parent total.
      if (collection.saturated ? total < collection.total : total !== collection.total)
        throw new Error("history_total_changed");
      return { total, values: [...left.values, ...right.values] };
    }
    const values = await collection.collect();
    if (values.length !== collection.total) throw new Error("history_total_changed");
    for (const value of values) {
      const key = identity(value);
      const created = Date.parse(createdAt(value));
      if (
        (typeof key !== "string" && !Number.isSafeInteger(key)) ||
        String(key).length < 1 ||
        String(key).length > 256 ||
        (seen.has(String(key)) && seen.get(String(key)) !== range) ||
        !Number.isFinite(created) ||
        created < start * 1000 ||
        created > finish * 1000 + 999
      )
        throw new Error("history_identity_or_range_invalid");
      seen.set(String(key), range);
    }
    return { total: collection.total, values };
  };
  return (await visit(0, Math.floor(Date.parse(end) / 1000))).values;
}

function selectCollectedWindow(values, window, series) {
  const selected = new Set();
  for (const [cohort, timestamp] of series) {
    for (const value of selectMetricSeries(cohort, { kind: "last-n", limit: window.limit, end: window.end }, timestamp))
      selected.add(value);
  }
  return values.filter((value) => selected.has(value) || inBounds(value.updatedAt ?? runTimestamp(value), window));
}

function sameRepositoryPath(actualPath, expectedPath, repositoryIds) {
  const actual = parseRepositoryPath(actualPath);
  const expected = parseRepositoryPath(expectedPath);
  if (!actual || !expected || actual.suffix !== expected.suffix) return false;
  if (actual.kind === "id") {
    repositoryIds.add(actual.value);
    if (repositoryIds.size > 1) return false;
    return true;
  }
  return expected.kind === "name" && actual.value === expected.value;
}

function parseRepositoryPath(pathname) {
  const match = /^\/(repos\/([^/]+\/[^/]+)|repositories\/(\d+))(\/.*)?$/.exec(pathname);
  if (!match) return null;
  return {
    kind: match[2] ? "name" : "id",
    value: match[2] ?? match[3],
    suffix: match[4] ?? "",
  };
}

async function fetchPullRequests(client, repository, window, maxPages) {
  const pulls = await collectPartitionedHistory({
    end: window.end,
    maxPages,
    identity: (pull) => pull.number,
    createdAt: (pull) => pull.createdAt,
    read: async (range) => {
      const query = `repo:${repository} is:pr created:${range}`;
      const first = await fetchPullRequestPage(client, query, null);
      return {
        total: first.issueCount,
        collect: () => fetchPullRequestPartition(client, query, first, maxPages),
      };
    },
  });
  const selected = selectCollectedWindow(pulls, window, [
    [pulls, (pull) => pull.createdAt],
    [pulls.filter((pull) => pull.mergedAt), (pull) => pull.mergedAt],
  ]);
  return enrichPullRequestWindow(client, selected, maxPages);
}

async function fetchPullRequestPage(client, query, cursor) {
  const payload = await client.json(GRAPHQL_URL, {
    method: "POST",
    body: {
      query: `query DeliveryHealthPulls($query:String!,$cursor:String){search(query:$query,type:ISSUE,first:100,after:$cursor){issueCount pageInfo{hasNextPage endCursor}nodes{... on PullRequest{number state isDraft createdAt updatedAt mergedAt}}}}`,
      variables: { query, cursor },
    },
  });
  if (payload.errors?.length) throw new Error(`GitHub GraphQL failed: ${boundedError(payload.errors[0]?.message)}`);
  return payload.data?.search ?? {};
}

async function fetchPullRequestPartition(client, query, first, maxPages) {
  const pulls = [];
  let cursor = null;
  let total;
  const cursors = new Set();
  const identities = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const connection = page === 1 ? first : await fetchPullRequestPage(client, query, cursor);
    const nodes = connection?.nodes ?? [];
    if (!Array.isArray(nodes) || nodes.length > 100 || typeof connection?.pageInfo?.hasNextPage !== "boolean")
      throw new Error("pull_collection_incomplete");
    if (connection.issueCount !== undefined) {
      if (
        !Number.isSafeInteger(connection.issueCount) ||
        connection.issueCount < 0 ||
        (total !== undefined && total !== connection.issueCount) ||
        connection.issueCount > maxPages * 100 ||
        connection.issueCount >= 1000
      )
        throw new Error("pull_collection_incomplete");
      total = connection.issueCount;
    } else throw new Error("pull_collection_incomplete");
    for (const node of nodes) {
      if (!Number.isSafeInteger(node?.number) || identities.has(node.number))
        throw new Error("pull_collection_incomplete");
      identities.add(node.number);
    }
    pulls.push(
      ...nodes.map((pull) => ({
        number: pull.number,
        state: pull.state,
        isDraft: pull.isDraft,
        createdAt: pull.createdAt,
        updatedAt: pull.updatedAt,
        mergedAt: pull.mergedAt,
        readyForReviewAt: pull.timelineItems?.nodes?.[0]?.createdAt ?? (!pull.isDraft ? pull.createdAt : null),
        changedFiles: pull.changedFiles ?? null,
        reviewCount: pull.reviews ? pull.reviews.totalCount : null,
        approvedReviewCount: (pull.reviews?.nodes ?? []).filter((review) => review.state === "APPROVED").length,
        files: Array.isArray(pull.files?.nodes) ? pull.files.nodes : null,
        reviewsTruncated: Number.isSafeInteger(pull.reviews?.totalCount) && pull.reviews.totalCount > 100,
        filesTruncated: Number.isSafeInteger(pull.files?.totalCount) && pull.files.totalCount > 100,
        nestedDataTruncated:
          !Number.isSafeInteger(pull.reviews?.totalCount) ||
          pull.reviews.totalCount !== pull.reviews.nodes?.length ||
          !Number.isSafeInteger(pull.files?.totalCount) ||
          pull.files.totalCount !== pull.files.nodes?.length,
      })),
    );
    if (connection.pageInfo.hasNextPage && pulls.length >= total) throw new Error("pull_collection_incomplete");
    if (!connection.pageInfo.hasNextPage) {
      if (total !== undefined && pulls.length !== total) throw new Error("pull_collection_incomplete");
      return pulls;
    }
    if (
      nodes.length !== 100 ||
      typeof connection.pageInfo.endCursor !== "string" ||
      !connection.pageInfo.endCursor ||
      cursors.has(connection.pageInfo.endCursor)
    )
      throw new Error("pull_collection_incomplete");
    cursor = connection.pageInfo.endCursor;
    cursors.add(cursor);
  }
  throw new Error("pull_collection_incomplete");
}

async function enrichPullRequestWindow(client, pulls, maxPages) {
  const missing = pulls.filter(
    (pull) =>
      !Number.isSafeInteger(pull.changedFiles) || !Array.isArray(pull.files) || !Number.isSafeInteger(pull.reviewCount),
  );
  await Promise.all(
    missing.map(async (pull) => {
      const detail = await client.json(`/pulls/${pull.number}`, { advisory: true });
      if (!Number.isSafeInteger(pull.changedFiles) && Number.isSafeInteger(detail?.changed_files))
        pull.changedFiles = detail.changed_files;
      if (pull.files === null) pull.files = await fetchPullFiles(client, pull.number, maxPages);
      if (!Number.isSafeInteger(pull.reviewCount)) {
        const reviews = await fetchPullReviews(client, pull.number, maxPages);
        pull.reviewCount = reviews.length;
        pull.approvedReviewCount = reviews.filter((review) => review.state === "APPROVED").length;
      }
      pull.reviewsTruncated = false;
      pull.filesTruncated = false;
      pull.nestedDataTruncated = false;
    }),
  );
  return pulls;
}

async function fetchWorkflowRuns(client, workflow, window, maxPages) {
  const runs = await collectPartitionedHistory({
    end: window.end,
    maxPages,
    identity: (run) => run.id,
    createdAt: (run) => run.created_at,
    read: async (range) => {
      const path = `/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=100&created=${encodeURIComponent(range)}`;
      const first = await client.json(path);
      if (first?.incomplete_results === true) throw new Error("history_collection_incomplete");
      return {
        total: first?.total_count,
        // Workflow count metadata can saturate at 2500 independently of its 1000-result page cap.
        saturated: first?.total_count === 2500,
        collect: () =>
          client.paginate(path, (payload) => payload?.workflow_runs, {
            source: `workflow:${workflow}`,
            maxPages,
            requireTotal: true,
            providerCap: 1000,
          }),
      };
    },
  });
  return selectCollectedWindow(
    runs,
    window,
    [...new Set(runs.map((run) => run.event))].map((event) => [
      runs.filter((run) => run.event === event),
      runTimestamp,
    ]),
  );
}

async function fetchRunJobs(client, runId, maxPages) {
  return client.paginate(`/actions/runs/${runId}/jobs?filter=all&per_page=100`, (payload) => payload?.jobs, {
    source: `jobs:${runId}`,
    maxPages,
    requireTotal: true,
  });
}

async function fetchPullFiles(client, pullNumber, maxPages) {
  return client.paginate(`/pulls/${pullNumber}/files?per_page=100`, (payload) => payload, {
    source: `pull-files:${pullNumber}`,
    maxPages,
    identity: (file) => file?.filename,
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
    requireTotal: true,
    providerCap: 1000,
  });
}

async function fetchReleaseHealthArtifacts(client, runId) {
  const artifacts = await client.paginate(
    `/actions/runs/${runId}/artifacts?per_page=100`,
    (payload) => payload?.artifacts,
    {
      source: `artifacts:${runId}`,
      maxPages: 20,
      requireTotal: true,
    },
  );
  const selected = artifacts.filter((artifact) => /(?:staging|production)-release-health/.test(artifact.name ?? ""));
  const records = [];
  for (const artifact of selected) {
    const response = await client.request(`/actions/artifacts/${artifact.id}/zip`, {
      accept: "application/vnd.github+json",
    });
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
    { source: `ephemeral-artifacts:${run.id}`, maxPages: 20, requireTotal: true },
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
  const response = await client.request(`/actions/artifacts/${artifact.id}/zip`, {
    accept: "application/vnd.github+json",
  });
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
  if (!Buffer.isBuffer(buffer) || buffer.length > EPHEMERAL_ARCHIVE_MAX_BYTES)
    throw new Error("artifact_archive_size_invalid");
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("Artifact archive is not a supported ZIP file.");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  if (entryCount > 1_000) throw new Error("Artifact ZIP contains too many entries.");
  let offset = buffer.readUInt32LE(eocd + 16);
  if (
    buffer.readUInt16LE(eocd + 4) !== 0 ||
    buffer.readUInt16LE(eocd + 6) !== 0 ||
    buffer.readUInt16LE(eocd + 8) !== entryCount ||
    offset + buffer.readUInt32LE(eocd + 12) !== eocd ||
    eocd + 22 + buffer.readUInt16LE(eocd + 20) !== buffer.length
  )
    throw new Error("artifact_zip_directory_invalid");
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd) throw new Error("artifact_zip_directory_invalid");
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Artifact ZIP central directory is invalid.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (offset + 46 + fileNameLength + extraLength + commentLength > eocd || localOffset + 30 > offset)
      throw new Error("artifact_zip_directory_invalid");
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
    if (
      !name ||
      name.includes("\\") ||
      name.startsWith("/") ||
      name.includes("\0") ||
      name.split("/").includes("..") ||
      /^[A-Za-z]:/.test(name) ||
      ((buffer.readUInt32LE(offset + 38) >>> 16) & 0o170000) === 0o120000 ||
      (buffer.readUInt16LE(offset + 8) & 1) !== 0 ||
      buffer.readUInt32LE(localOffset) !== 0x04034b50
    )
      throw new Error("artifact_zip_entry_invalid");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (
      dataStart + compressedSize > buffer.readUInt32LE(eocd + 16) ||
      buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8") !== name ||
      buffer.readUInt16LE(localOffset + 8) !== method
    )
      throw new Error("artifact_zip_entry_invalid");
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (name.toLowerCase().endsWith(".json") && (options.include?.(name) ?? true)) {
      const maxEntryBytes = options.maxEntryBytes ?? 2 * 1024 * 1024;
      if (uncompressedSize > maxEntryBytes) throw new Error(`Artifact JSON entry ${name} exceeds its byte bound.`);
      let contents;
      if (method === 0) contents = compressed;
      else if (method === 8) contents = inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
      else throw new Error(`Artifact ZIP uses unsupported compression method ${method}.`);
      if (contents.length !== uncompressedSize || contents.length > maxEntryBytes)
        throw new Error(`Artifact JSON entry ${name} has an invalid expanded size.`);
      if (entries.has(name)) throw new Error(`Artifact ZIP contains duplicate JSON entry ${name}.`);
      entries.set(name, contents);
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  if (offset !== eocd) throw new Error("artifact_zip_directory_invalid");
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
  return error?.message === "github-not-found" ? "github-not-found" : "github-authority-unavailable";
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
  const collection = policy.collection;
  if (
    !collection ||
    Object.keys(collection).sort().join(",") !== "concurrency,generatedPaths,maxPages,retries,workflowSources" ||
    !Number.isInteger(collection.maxPages) ||
    collection.maxPages < 1 ||
    collection.maxPages > 20 ||
    !Number.isInteger(collection.concurrency) ||
    collection.concurrency < 1 ||
    collection.concurrency > 16 ||
    !Number.isInteger(collection.retries) ||
    collection.retries < 0 ||
    collection.retries > 5 ||
    !Array.isArray(collection.generatedPaths) ||
    collection.generatedPaths.length > 100 ||
    collection.generatedPaths.some((path) => typeof path !== "string" || path.length < 1 || path.length > 256) ||
    !collection.workflowSources ||
    Object.keys(collection.workflowSources).sort().join(",") !==
      "ephemeralVerification,platformDeploy,platformPr,releaseDispatch" ||
    Object.values(collection.workflowSources).some(
      (workflow) => typeof workflow !== "string" || !/^[A-Za-z0-9._-]{1,128}\.ya?ml$/.test(workflow),
    )
  )
    throw new Error("Invalid delivery-health collection policy.");
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

export async function runDeliveryHealthCommand(argv, env = process.env, dependencies = {}) {
  const options = parseDeliveryHealthArgs(argv, env);
  try {
    const result = await collectDeliveryHealth(options, dependencies);
    await writeOutputs(options, result);
    if (!options.githubSummaryPath) console.log(result.markdown);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runDeliveryHealthCommand(process.argv.slice(2));
}
