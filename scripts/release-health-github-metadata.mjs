#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { validateMergeQualificationCandidate, validateMergeQualificationEvent } from "./merge-qualification.mjs";

const ISO_EVENT_NAMES = new Set(["added_to_merge_queue", "ready_for_review", "merged", "removed_from_merge_queue"]);

export function parseReleaseHealthGithubMetadataArgs(argv, env = process.env) {
  return {
    repository: readOption(argv, "--repository") ?? readEnv("GITHUB_REPOSITORY", env),
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    sourceWorkflowCreatedAt:
      readOption(argv, "--source-workflow-created-at") ?? readEnv("SOURCE_WORKFLOW_CREATED_AT", env),
    token: readOption(argv, "--token") ?? readEnv("GH_TOKEN", env) ?? readEnv("GITHUB_TOKEN", env),
    format: readOption(argv, "--format") ?? "github-output",
  };
}

export function buildReleaseHealthGithubMetadata(input) {
  const pull = input.pull ?? null;
  const timeline = Array.isArray(input.timeline) ? input.timeline : [];
  const reviews = Array.isArray(input.reviews) ? input.reviews : [];
  const mergeGroupRuns = Array.isArray(input.mergeGroupRuns) ? input.mergeGroupRuns : [];
  const branchRules = Array.isArray(input.branchRules) ? input.branchRules : [];
  const releaseCommit = normalizeString(input.releaseCommit);
  const queueQueuedAt =
    firstTimelineTimestamp(timeline, "added_to_merge_queue") ?? input.sourceWorkflowCreatedAt ?? null;
  const mergedEvent = firstTimelineEvent(timeline, "merged");
  const removedEvent = firstTimelineEvent(timeline, "removed_from_merge_queue");
  const queueMergedAt = normalizeIso(pull?.merged_at) ?? normalizeIso(mergedEvent?.created_at) ?? null;
  const queueDequeuedAt = removedEvent && !queueMergedAt ? normalizeIso(removedEvent.created_at) : null;

  return {
    pullRequestNumber: pull?.number ?? null,
    prOpenedAt: normalizeIso(pull?.created_at) ?? null,
    prReadyForReviewAt: readyForReviewAt(pull, timeline),
    prApprovedAt: latestApprovedAt(reviews),
    queueQueuedAt,
    queueMergeGroupStartedAt: firstMergeGroupStartedAt(mergeGroupRuns),
    queueMergedAt,
    queueDequeuedAt,
    queueFailureReason: queueDequeuedAt ? queueFailureReason(timeline) : null,
    queueBatchSize: mergeQueueBatchSize(branchRules),
    mergeSha: normalizeCommitSha(mergedEvent?.commit_id) ?? normalizeCommitSha(pull?.merge_commit_sha) ?? releaseCommit,
  };
}

export async function collectReleaseHealthGithubMetadata(options, dependencies = {}) {
  if (!options.repository) {
    throw new Error("GITHUB_REPOSITORY or --repository is required.");
  }
  if (!options.releaseCommit) {
    throw new Error("RELEASE_COMMIT or --release-commit is required.");
  }

  // The collector imports the pure joins; load its client only for metadata collection.
  const { createGitHubClient } = await import("./release-health-delivery-health.mjs");
  const client = createGitHubClient(
    {
      repository: options.repository,
      token: options.token,
      fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    },
    { maxPages: 20 },
  );
  const request = client.json;

  const pulls = await client.paginate(`/commits/${options.releaseCommit}/pulls?per_page=100`, (payload) => payload, {
    identity: (entry) => entry?.id ?? entry?.node_id ?? entry?.number,
  });
  const pull = Array.isArray(pulls) ? pulls[0] : null;
  const [pullDetails, reviews, timeline, runs, branchRules] = await Promise.all([
    pull?.number ? request(`/pulls/${pull.number}`) : null,
    pull?.number
      ? client.paginate(`/pulls/${pull.number}/reviews?per_page=100`, (payload) => payload, {
          identity: (entry) =>
            entry?.id ?? entry?.node_id ?? [entry?.user?.id, entry?.submitted_at, entry?.state].join(":"),
        })
      : [],
    pull?.number
      ? client.paginate(`/issues/${pull.number}/timeline?per_page=100`, (payload) => payload, {
          identity: timelineIdentity,
        })
      : [],
    client.paginate(
      `/actions/runs?head_sha=${encodeURIComponent(options.releaseCommit)}&event=merge_group&per_page=100`,
      (payload) => payload?.workflow_runs,
      { requireTotal: true, providerCap: 1000 },
    ),
    client
      .paginate(`/rules/branches/main?per_page=100`, (payload) => payload, {
        identity: (rule) => [rule?.id ?? rule?.node_id ?? "none", rule?.type ?? "none"].join(":"),
      })
      .catch((error) => {
        if (error.message === "github-not-found") return [];
        throw error;
      }),
  ]);

  return buildReleaseHealthGithubMetadata({
    releaseCommit: options.releaseCommit,
    sourceWorkflowCreatedAt: normalizeIso(options.sourceWorkflowCreatedAt),
    pull: pullDetails ?? pull,
    reviews,
    timeline,
    mergeGroupRuns: runs,
    branchRules,
  });
}

function timelineIdentity(event) {
  return (
    event?.id ??
    event?.node_id ??
    [
      event?.event,
      event?.created_at,
      event?.source?.issue?.number ?? event?.commit_id ?? event?.sha ?? event?.comments?.[0]?.id ?? "none",
    ].join(":")
  );
}

export function formatGithubOutput(metadata) {
  const entries = {
    pr_number: metadata.pullRequestNumber,
    pr_opened_at: metadata.prOpenedAt,
    pr_ready_for_review_at: metadata.prReadyForReviewAt,
    pr_approved_at: metadata.prApprovedAt,
    queue_queued_at: metadata.queueQueuedAt,
    queue_merge_group_started_at: metadata.queueMergeGroupStartedAt,
    queue_merged_at: metadata.queueMergedAt,
    queue_dequeued_at: metadata.queueDequeuedAt,
    queue_failure_reason: metadata.queueFailureReason,
    queue_batch_size: metadata.queueBatchSize,
    merge_sha: metadata.mergeSha,
  };

  return `${Object.entries(entries)
    .map(([key, value]) => `${key}=${value ?? ""}`)
    .join("\n")}\n`;
}

const closed = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const digest = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const identity = (value) =>
  typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const text = (value) => typeof value === "string" && value.length <= 4096;
const repositoryIdentity = (value) => typeof value === "string" && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(value);

export function isStagingLineageInstant(value) {
  if (typeof value !== "string" || value.length > 40) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , , offsetHour = "0", offsetMinute = "0"] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return (
    Number(year) >= 2020 &&
    Number(year) < 2100 &&
    Number(month) >= 1 &&
    Number(month) <= 12 &&
    Number(day) >= 1 &&
    Number(day) <= days &&
    Number(hour) < 24 &&
    Number(minute) < 60 &&
    Number(second) < 60 &&
    Number(offsetHour) < 24 &&
    Number(offsetMinute) < 60 &&
    Number.isFinite(Date.parse(value))
  );
}

export function validateStagingAdvisorySummary(value) {
  const outcome = (record, withError = false) =>
    closed(record, withError ? ["outcome", "error"] : ["outcome"]) &&
    ["success", "failure", "cancelled", "skipped"].includes(record.outcome) &&
    (!withError || text(record.error));
  const image = (record) =>
    closed(record, ["releaseCommit", "platformImage", "platformImageDigest"]) &&
    sha(record.releaseCommit) &&
    text(record.platformImage) &&
    record.platformImage.length > 0 &&
    digest(record.platformImageDigest);
  if (
    !closed(value, [
      "schemaVersion",
      "checkedAt",
      "releaseCommit",
      "platformImage",
      "platformImageDigest",
      "admission",
      "freshness",
      "postWindow",
      "scenarioSeed",
      "marketplaceE2e",
      "failedPhases",
    ]) ||
    value.schemaVersion !== "staging-advisory-evidence/v2" ||
    !isStagingLineageInstant(value.checkedAt) ||
    !sha(value.releaseCommit) ||
    !text(value.platformImage) ||
    !value.platformImage ||
    !digest(value.platformImageDigest) ||
    !closed(value.admission, ["outcome", "error"]) ||
    !["admitted", "refused", "unknown"].includes(value.admission.outcome) ||
    !text(value.admission.error) ||
    !closed(value.freshness, ["status", "reason", "requested", "observed", "publicationAt", "windowCensus"]) ||
    !["fresh", "stale", "unknown"].includes(value.freshness.status) ||
    !text(value.freshness.reason) ||
    !image(value.freshness.requested) ||
    ["releaseCommit", "platformImage", "platformImageDigest"].some(
      (key) => value[key] !== value.freshness.requested[key],
    ) ||
    !closed(value.freshness.observed, [
      "releaseCommit",
      "platformImage",
      "platformImageDigest",
      "supersedingIdentity",
    ]) ||
    ![null, true, false].includes(value.freshness.observed.supersedingIdentity) ||
    !(value.freshness.publicationAt === "" || isStagingLineageInstant(value.freshness.publicationAt)) ||
    (value.freshness.publicationAt !== "" && Date.parse(value.freshness.publicationAt) > Date.parse(value.checkedAt)) ||
    !outcome(value.postWindow, true) ||
    !outcome(value.scenarioSeed) ||
    !outcome(value.marketplaceE2e) ||
    !Array.isArray(value.failedPhases) ||
    value.failedPhases.length > 3 ||
    new Set(value.failedPhases).size !== value.failedPhases.length ||
    value.failedPhases.some((phase) => !["advisory-preflight", "scenario-seed", "marketplace-e2e"].includes(phase))
  )
    return ["staging-summary-invalid"];
  const observed = value.freshness.observed;
  if (
    !["releaseCommit", "platformImage", "platformImageDigest"].every(
      (key) =>
        observed[key] === "" ||
        (key === "releaseCommit"
          ? sha(observed[key])
          : key === "platformImageDigest"
            ? digest(observed[key])
            : text(observed[key])),
    )
  )
    return ["staging-summary-invalid"];
  const census = value.freshness.windowCensus;
  const emptyCensus = closed(census, []);
  if (
    !emptyCensus &&
    (!closed(census, ["admissionAt", "publicationAt", "overlaps"]) ||
      !isStagingLineageInstant(census.admissionAt) ||
      !isStagingLineageInstant(census.publicationAt) ||
      census.publicationAt !== value.freshness.publicationAt ||
      Date.parse(census.admissionAt) >= Date.parse(census.publicationAt) ||
      !Array.isArray(census.overlaps) ||
      census.overlaps.length > 1024 ||
      census.overlaps.some(
        (entry) =>
          !closed(entry, ["workflow", "runId", "job", "conclusion", "status"]) ||
          typeof entry.workflow !== "string" ||
          !/^[\w.-]{1,128}\.ya?ml$/.test(entry.workflow) ||
          !Number.isSafeInteger(entry.runId) ||
          entry.runId < 1 ||
          !text(entry.job) ||
          ![
            null,
            "success",
            "failure",
            "cancelled",
            "skipped",
            "neutral",
            "timed_out",
            "action_required",
            "stale",
            "startup_failure",
          ].includes(entry.conclusion) ||
          !["queued", "waiting", "pending", "in_progress", "completed"].includes(entry.status),
      ))
  )
    return ["staging-summary-invalid"];
  if (
    value.freshness.status === "fresh" &&
    (emptyCensus ||
      census.overlaps.length ||
      value.postWindow.outcome !== "success" ||
      value.admission.outcome !== "admitted" ||
      value.scenarioSeed.outcome !== "success" ||
      observed.supersedingIdentity !== false ||
      ["releaseCommit", "platformImage", "platformImageDigest"].some((key) => observed[key] !== value[key]))
  )
    return ["staging-summary-invalid"];
  if (
    value.failedPhases.includes("scenario-seed") !== (value.scenarioSeed.outcome !== "success") ||
    value.failedPhases.includes("marketplace-e2e") !== (value.marketplaceE2e.outcome !== "success")
  )
    return ["staging-summary-invalid"];
  return [];
}

export function validateStagingLineageMapping(value) {
  if (
    !closed(value, ["schemaVersion", "repository", "candidate", "release"]) ||
    value.schemaVersion !== "staging-lineage-mapping/v1" ||
    !repositoryIdentity(value.repository) ||
    !closed(value.candidate, ["workflowId", "workflowPath", "runId", "runAttempt", "sha", "treeSha", "baseSha"]) ||
    !["workflowId", "runId", "runAttempt"].every((key) => identity(value.candidate[key])) ||
    value.candidate.workflowPath !== ".github/workflows/platform-pr.yml" ||
    !["sha", "treeSha", "baseSha"].every((key) => sha(value.candidate[key])) ||
    !closed(value.release, ["commit", "treeSha", "baseSha", "mergeSha", "pullRequests"]) ||
    !["commit", "treeSha", "baseSha", "mergeSha"].every((key) => sha(value.release[key])) ||
    value.release.mergeSha !== value.release.commit ||
    value.release.treeSha !== value.candidate.treeSha ||
    value.release.baseSha !== value.candidate.baseSha ||
    !Array.isArray(value.release.pullRequests) ||
    !value.release.pullRequests.length ||
    value.release.pullRequests.length > 100 ||
    new Set(value.release.pullRequests.map((pull) => pull?.number)).size !== value.release.pullRequests.length ||
    value.release.pullRequests.some(
      (pull) =>
        !closed(pull, ["number", "headSha", "queuedAt", "mergedAt", "dequeuedAt"]) ||
        !Number.isSafeInteger(pull.number) ||
        pull.number < 1 ||
        !sha(pull.headSha) ||
        !isStagingLineageInstant(pull.queuedAt) ||
        !isStagingLineageInstant(pull.mergedAt) ||
        !(pull.dequeuedAt === null || isStagingLineageInstant(pull.dequeuedAt)) ||
        Date.parse(pull.queuedAt) >= Date.parse(pull.mergedAt),
    )
  )
    return ["staging-mapping-invalid"];
  return [];
}

export async function collectStagingLineageMapping({
  repository,
  releaseCommit,
  candidate,
  client,
  cache = new Map(),
}) {
  const read = (path, list = false) => {
    if (!cache.has(path))
      cache.set(
        path,
        list
          ? client.paginate(path, (payload) => payload, {
              advisory: true,
              identity: path.includes("/timeline?")
                ? timelineIdentity
                : (entry) => entry?.id ?? entry?.node_id ?? entry?.number,
            })
          : client.json(path, { advisory: true }),
      );
    return cache.get(path);
  };
  const [run, latest, candidateCommit, release, associated] = await Promise.all([
    read(`/actions/runs/${candidate.runId}/attempts/${candidate.runAttempt}`),
    read(`/actions/runs/${candidate.runId}`),
    read(`/git/commits/${candidate.candidateSha}`),
    read(`/git/commits/${releaseCommit}`),
    read(`/commits/${releaseCommit}/pulls?per_page=100`, true),
  ]);
  if (
    run?.repository?.full_name !== repository ||
    run.event !== "merge_group" ||
    run.path !== candidate.workflowPath ||
    String(run.id) !== candidate.runId ||
    String(run.run_attempt) !== candidate.runAttempt ||
    String(run.workflow_id) !== candidate.workflowId ||
    run.head_sha !== candidate.candidateSha ||
    latest?.id !== run.id ||
    latest?.repository?.full_name !== repository ||
    String(latest.run_attempt) !== candidate.runAttempt ||
    latest.workflow_id !== run.workflow_id ||
    latest.event !== run.event ||
    latest.head_sha !== run.head_sha ||
    latest.path !== run.path ||
    latest.status !== "completed" ||
    latest.conclusion !== run.conclusion ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    candidateCommit?.sha !== run.head_sha ||
    release?.sha !== releaseCommit ||
    !Array.isArray(associated) ||
    associated.length !== candidate.pullRequests.length
  )
    throw new Error("staging-mapping-invalid");
  const pulls = await Promise.all(
    associated.map(async (associatedPull) => {
      if (!Number.isSafeInteger(associatedPull?.number) || associatedPull.number < 1)
        throw new Error("staging-mapping-invalid");
      const [pull, timeline] = await Promise.all([
        read(`/pulls/${associatedPull.number}`),
        read(`/issues/${associatedPull.number}/timeline?per_page=100`, true),
      ]);
      if (
        pull?.number !== associatedPull.number ||
        pull.base?.repo?.full_name !== repository ||
        pull.base.ref !== "main" ||
        pull.merge_commit_sha !== releaseCommit
      )
        throw new Error("staging-mapping-invalid");
      const queuedAt =
        timeline
          .filter((event) => event.event === "added_to_merge_queue" && isStagingLineageInstant(event.created_at))
          .map((event) => event.created_at)
          .sort((a, b) => Date.parse(a) - Date.parse(b))
          .at(-1) ?? null;
      const dequeuedAt =
        timeline
          .filter(
            (event) =>
              event.event === "removed_from_merge_queue" &&
              isStagingLineageInstant(event.created_at) &&
              Date.parse(event.created_at) >= Date.parse(queuedAt),
          )
          .map((event) => event.created_at)
          .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
      return { number: pull.number, headSha: pull.head?.sha ?? null, queuedAt, mergedAt: pull.merged_at, dequeuedAt };
    }),
  );
  const mapping = {
    schemaVersion: "staging-lineage-mapping/v1",
    repository,
    candidate: {
      workflowId: String(run.workflow_id),
      workflowPath: run.path,
      runId: String(run.id),
      runAttempt: String(run.run_attempt),
      sha: run.head_sha,
      treeSha: candidateCommit.tree?.sha,
      baseSha: candidateCommit.parents?.[0]?.sha,
    },
    release: {
      commit: releaseCommit,
      treeSha: release.tree?.sha,
      baseSha: release.parents?.[0]?.sha,
      mergeSha: releaseCommit,
      pullRequests: pulls.sort((a, b) => a.number - b.number),
    },
  };
  if (validateStagingLineageMapping(mapping).length) throw new Error("staging-mapping-invalid");
  return mapping;
}

export function validateStagingDeployment(value) {
  if (
    !closed(value, [
      "repository",
      "workflowId",
      "workflowPath",
      "runId",
      "runAttempt",
      "jobId",
      "startedAt",
      "completedAt",
      "appliedAt",
      "releaseCommit",
      "imageDigest",
      "result",
      "mapping",
    ]) ||
    !repositoryIdentity(value.repository) ||
    !["workflowId", "runId", "runAttempt", "jobId"].every((key) => identity(value[key])) ||
    value.workflowPath !== ".github/workflows/platform-production.yml" ||
    !["startedAt", "completedAt", "appliedAt"].every((key) => isStagingLineageInstant(value[key])) ||
    Date.parse(value.startedAt) >= Date.parse(value.appliedAt) ||
    Date.parse(value.appliedAt) > Date.parse(value.completedAt) ||
    !sha(value.releaseCommit) ||
    !digest(value.imageDigest) ||
    !["success", "failure"].includes(value.result) ||
    !(
      value.mapping === null ||
      (!validateStagingLineageMapping(value.mapping).length &&
        value.mapping.repository === value.repository &&
        value.mapping.release.commit === value.releaseCommit)
    )
  )
    return ["staging-deployment-invalid"];
  return [];
}

export function joinQualificationStaging({ repository, events = [], candidates = [], staging = [] }) {
  const byCandidate = new Map();
  for (const candidate of candidates) {
    const key = `${candidate?.runId}/${candidate?.runAttempt}`;
    if (!byCandidate.has(key)) byCandidate.set(key, []);
    byCandidate.get(key).push(candidate);
  }
  const byProducer = new Map();
  for (const entry of staging) {
    const mapped = entry?.deployment?.mapping?.candidate;
    const key = `${mapped?.runId}/${mapped?.runAttempt}`;
    if (!byProducer.has(key)) byProducer.set(key, []);
    byProducer.get(key).push(entry);
  }
  const joins = events.map((event) => {
    const result = {
      runId: event.runId,
      runAttempt: event.runAttempt,
      status: "unknown",
      reason: "staging-lineage-missing",
      stagingRunId: null,
      stagingRunAttempt: null,
      evidenceRunId: null,
      evidenceRunAttempt: null,
      candidateSha: event.candidateSha,
      mergeSha: null,
      imageDigest: null,
    };
    if (validateMergeQualificationEvent(event).length || event.repository !== repository)
      return { ...result, reason: "qualification-identity-invalid" };
    if (event.terminalState !== "passed" || event.classifierClass !== "isolated" || !event.identityAvailable)
      return { ...result, status: "not-eligible", reason: "qualification-not-eligible" };
    const candidateMatches = byCandidate.get(`${event.parentRunId}/${event.parentRunAttempt}`) ?? [];
    const candidate = candidateMatches[0];
    if (
      candidateMatches.length !== 1 ||
      validateMergeQualificationCandidate(candidate).length ||
      candidate.repository !== repository ||
      candidate.workflowId !== event.parentWorkflowId ||
      candidate.workflowPath !== event.parentWorkflowPath ||
      candidate.candidateSha !== event.candidateSha ||
      candidate.candidateTreeSha !== event.candidateTreeSha ||
      candidate.builtImageDigest !== event.imageDigest ||
      Date.parse(candidate.capturedAt) > Date.parse(event.startedAt)
    )
      return { ...result, reason: "qualification-lineage-invalid" };
    const matches = [];
    let refused = "staging-lineage-missing";
    const possible = [...(byProducer.get(`${candidate.runId}/${candidate.runAttempt}`) ?? [])].sort((a, b) =>
      `${a?.runId}/${a?.runAttempt}/${a?.artifactId}`.localeCompare(`${b?.runId}/${b?.runAttempt}/${b?.artifactId}`),
    );
    for (const entry of possible) {
      if (entry?.deployment === null) {
        refused = "staging-orphan";
        continue;
      }
      if (
        validateStagingAdvisorySummary(entry?.summary).length ||
        validateStagingDeployment(entry?.deployment).length
      ) {
        refused = "staging-evidence-invalid";
        continue;
      }
      const { summary, deployment } = entry;
      const mapping = deployment.mapping;
      if (
        !mapping ||
        deployment.repository !== repository ||
        mapping.repository !== repository ||
        mapping.candidate.workflowId !== candidate.workflowId ||
        mapping.candidate.workflowPath !== candidate.workflowPath ||
        mapping.candidate.runId !== candidate.runId ||
        mapping.candidate.runAttempt !== candidate.runAttempt ||
        mapping.candidate.sha !== candidate.candidateSha ||
        mapping.candidate.treeSha !== candidate.candidateTreeSha ||
        mapping.candidate.baseSha !== candidate.queueBaseSha ||
        deployment.releaseCommit !== summary.releaseCommit ||
        mapping.release.pullRequests.length !== candidate.pullRequests.length ||
        candidate.pullRequests.some(
          (pull) =>
            !mapping.release.pullRequests.some(
              (mapped) => mapped.number === pull.number && mapped.headSha === pull.headSha,
            ),
        )
      ) {
        refused = "staging-lineage-mismatch";
        continue;
      }
      if (
        deployment.imageDigest !== candidate.builtImageDigest ||
        summary.platformImageDigest !== candidate.builtImageDigest ||
        summary.freshness.observed.platformImageDigest !== candidate.builtImageDigest
      ) {
        refused = "staging-digest-mismatch";
        continue;
      }
      if (
        mapping.release.pullRequests.some(
          (pull) =>
            pull.dequeuedAt !== null ||
            Date.parse(pull.queuedAt) > Date.parse(candidate.capturedAt) ||
            Date.parse(pull.mergedAt) <= Date.parse(event.completedAt) ||
            Date.parse(pull.mergedAt) > Date.parse(deployment.startedAt),
        ) ||
        Date.parse(deployment.startedAt) <= Date.parse(event.completedAt) ||
        Date.parse(summary.checkedAt) <= Date.parse(deployment.completedAt) ||
        Date.parse(summary.freshness.windowCensus.admissionAt) < Date.parse(deployment.completedAt) ||
        Date.parse(summary.freshness.publicationAt) < Date.parse(deployment.completedAt)
      ) {
        refused = "staging-causality-refused";
        continue;
      }
      if (
        summary.admission.outcome !== "admitted" ||
        summary.freshness.status !== "fresh" ||
        summary.freshness.observed.supersedingIdentity !== false ||
        summary.freshness.observed.releaseCommit !== deployment.releaseCommit ||
        summary.postWindow.outcome !== "success"
      ) {
        refused = "staging-freshness-unknown";
        continue;
      }
      matches.push(entry);
    }
    if (matches.length > 1) return { ...result, status: "ambiguous", reason: "staging-lineage-ambiguous" };
    if (!matches.length) return { ...result, reason: refused };
    const { deployment, runId, runAttempt } = matches[0];
    return {
      ...result,
      status: "joined",
      reason: "staging-lineage-joined",
      stagingRunId: deployment.runId,
      stagingRunAttempt: deployment.runAttempt,
      evidenceRunId: runId,
      evidenceRunAttempt: runAttempt,
      mergeSha: deployment.mapping.release.mergeSha,
      imageDigest: deployment.imageDigest,
    };
  });
  const counts = new Map();
  const key = (join) =>
    `${join.stagingRunId}/${join.stagingRunAttempt}/${join.evidenceRunId}/${join.evidenceRunAttempt}`;
  for (const join of joins) if (join.status === "joined") counts.set(key(join), (counts.get(key(join)) ?? 0) + 1);
  return joins.map((join) =>
    join.status === "joined" && counts.get(key(join)) > 1
      ? {
          ...join,
          status: "ambiguous",
          reason: "staging-lineage-ambiguous",
          stagingRunId: null,
          stagingRunAttempt: null,
          evidenceRunId: null,
          evidenceRunAttempt: null,
          mergeSha: null,
          imageDigest: null,
        }
      : join,
  );
}

async function main(argv, env = process.env) {
  try {
    const options = parseReleaseHealthGithubMetadataArgs(argv, env);
    const metadata = await collectReleaseHealthGithubMetadata(options);
    if (options.format === "json") {
      console.log(JSON.stringify(metadata, null, 2));
    } else {
      process.stdout.write(formatGithubOutput(metadata));
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function readyForReviewAt(pull, timeline) {
  const readyEvent = firstTimelineTimestamp(timeline, "ready_for_review");
  if (readyEvent) {
    return readyEvent;
  }
  if (pull && pull.draft === false) {
    return normalizeIso(pull.created_at) ?? null;
  }
  return null;
}

function latestApprovedAt(reviews) {
  return (
    reviews
      .filter((review) => review?.state === "APPROVED")
      .map((review) => normalizeIso(review.submitted_at))
      .filter(Boolean)
      .sort()
      .at(-1) ?? null
  );
}

function firstMergeGroupStartedAt(runs) {
  return (
    runs
      .map((run) => normalizeIso(run?.created_at))
      .filter(Boolean)
      .sort()
      .at(0) ?? null
  );
}

function queueFailureReason(timeline) {
  const removed = firstTimelineEvent(timeline, "removed_from_merge_queue");
  const reason = normalizeString(removed?.reason) ?? normalizeString(removed?.dismissed_reason);
  return reason ?? "removed-from-merge-queue";
}

function mergeQueueBatchSize(branchRules) {
  const mergeQueueRule = branchRules.find((rule) => rule?.type === "merge_queue");
  const value = Number.parseInt(String(mergeQueueRule?.parameters?.max_entries_to_merge ?? ""), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function firstTimelineTimestamp(timeline, eventName) {
  return normalizeIso(firstTimelineEvent(timeline, eventName)?.created_at);
}

function firstTimelineEvent(timeline, eventName) {
  return timeline
    .filter((event) => event?.event === eventName)
    .filter((event) => ISO_EVENT_NAMES.has(event.event))
    .filter((event) => normalizeIso(event.created_at))
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))[0];
}

function normalizeIso(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  return Number.isNaN(Date.parse(normalized)) ? null : normalized;
}

function normalizeCommitSha(value) {
  const normalized = normalizeString(value);
  return normalized && /^[0-9a-f]{40}$/i.test(normalized) ? normalized : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
