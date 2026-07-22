#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import {
  MERGE_QUALIFICATION_CANDIDATE_SCHEMA_VERSION,
  RELEASE_CANDIDATE_LINKAGE_SCHEMA_VERSION,
  buildMergeQualificationCandidateFromGithubMetadata,
  validateMergeQualificationCandidate,
} from "./merge-qualification-advisory.mjs";

export { RELEASE_CANDIDATE_LINKAGE_SCHEMA_VERSION };
const PLATFORM_PR_WORKFLOW_PATH = ".github/workflows/platform-pr.yml";
const ISO_EVENT_NAMES = new Set(["added_to_merge_queue", "ready_for_review", "merged", "removed_from_merge_queue"]);
const MAX_PAGES = 20;
const PER_PAGE = 100;

export function parseReleaseHealthGithubMetadataArgs(argv, env = process.env) {
  return {
    repository: readOption(argv, "--repository") ?? readEnv("GITHUB_REPOSITORY", env),
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    sourceWorkflowCreatedAt:
      readOption(argv, "--source-workflow-created-at") ?? readEnv("SOURCE_WORKFLOW_CREATED_AT", env),
    linkageFile: readOption(argv, "--linkage-file"),
    outPath: readOption(argv, "--out"),
    token: readOption(argv, "--token") ?? readEnv("GH_TOKEN", env) ?? readEnv("GITHUB_TOKEN", env),
    format: readOption(argv, "--format") ?? "github-output",
  };
}

export function buildReleaseHealthGithubMetadata(input) {
  const pull = input.pull ?? null;
  const timeline = Array.isArray(input.timeline) ? input.timeline : [];
  const reviews = Array.isArray(input.reviews) ? input.reviews : [];
  const branchRules = Array.isArray(input.branchRules) ? input.branchRules : [];
  const releaseCommit = normalizeCommitSha(input.releaseCommit);
  const candidate = input.candidate ?? null;
  const lineageReasons = uniqueReasons(input.lineageReasons ?? []);
  const queueQueuedAt =
    latestTimelineTimestamp(timeline, "added_to_merge_queue") ?? normalizeIso(input.sourceWorkflowCreatedAt);
  const mergedEvent = latestTimelineEvent(timeline, "merged");
  const removedEvent = latestTimelineEvent(timeline, "removed_from_merge_queue");
  const queueMergedAt = normalizeIso(pull?.merged_at) ?? normalizeIso(mergedEvent?.created_at);
  const queueDequeuedAt = removedEvent && !queueMergedAt ? normalizeIso(removedEvent.created_at) : null;
  const fullCandidate =
    candidate &&
    isPositiveSafeInteger(candidate.artifactId) &&
    normalizeCommitSha(candidate.record?.candidateSha) &&
    normalizeCommitSha(candidate.record?.candidateTreeSha)
      ? candidate
      : null;
  if (!fullCandidate && Number.isSafeInteger(pull?.number)) lineageReasons.push("candidate-linkage-unavailable");
  const metadata = {
    schemaVersion: RELEASE_CANDIDATE_LINKAGE_SCHEMA_VERSION,
    repository: normalizeString(input.repository),
    releaseCommit,
    pullRequestNumber: pull?.number ?? null,
    prOpenedAt: normalizeIso(pull?.created_at),
    prReadyForReviewAt: readyForReviewAt(pull, timeline),
    prApprovedAt: latestApprovedAt(reviews),
    queueQueuedAt,
    queueMergeGroupStartedAt: normalizeIso(fullCandidate?.run?.created_at),
    queueMergedAt,
    queueDequeuedAt,
    queueFailureReason: queueDequeuedAt ? queueFailureReason(timeline) : null,
    queueBatchSize: mergeQueueBatchSize(branchRules),
    candidateArtifactId: fullCandidate ? String(fullCandidate.artifactId) : null,
    candidateArtifactName: fullCandidate?.artifactName ?? null,
    mergeGroupWorkflowId: fullCandidate ? String(fullCandidate.run.workflow_id) : null,
    mergeGroupWorkflowPath: fullCandidate?.run.path ?? null,
    mergeGroupRunId: fullCandidate ? String(fullCandidate.run.id) : null,
    mergeGroupRunAttempt: fullCandidate ? String(fullCandidate.run.run_attempt) : null,
    candidateSha: fullCandidate?.record.candidateSha ?? null,
    candidateTreeSha: fullCandidate?.record.candidateTreeSha ?? null,
    candidateImageDigest: fullCandidate?.record.builtImageDigest ?? null,
    mergeSha: normalizeCommitSha(mergedEvent?.commit_id) ?? normalizeCommitSha(pull?.merge_commit_sha) ?? releaseCommit,
    mergeTreeSha: normalizeCommitSha(input.releaseTreeSha),
    lineageComplete: fullCandidate !== null && lineageReasons.length === 0,
    lineageReasons: uniqueReasons(lineageReasons),
  };
  const errors = validateReleaseCandidateLinkage(metadata);
  if (errors.length > 0) throw new Error(`Invalid release candidate linkage: ${errors.join(" ")}`);
  return metadata;
}

export function validateReleaseCandidateLinkage(metadata, { releaseCommit } = {}) {
  const fields = [
    "schemaVersion",
    "repository",
    "releaseCommit",
    "pullRequestNumber",
    "prOpenedAt",
    "prReadyForReviewAt",
    "prApprovedAt",
    "queueQueuedAt",
    "queueMergeGroupStartedAt",
    "queueMergedAt",
    "queueDequeuedAt",
    "queueFailureReason",
    "queueBatchSize",
    "candidateArtifactId",
    "candidateArtifactName",
    "mergeGroupWorkflowId",
    "mergeGroupWorkflowPath",
    "mergeGroupRunId",
    "mergeGroupRunAttempt",
    "candidateSha",
    "candidateTreeSha",
    "candidateImageDigest",
    "mergeSha",
    "mergeTreeSha",
    "lineageComplete",
    "lineageReasons",
  ];
  if (!isClosedObject(metadata, fields)) return ["release candidate linkage must be a closed object."];
  const errors = [];
  if (metadata.schemaVersion !== RELEASE_CANDIDATE_LINKAGE_SCHEMA_VERSION) errors.push("unsupported linkage schema.");
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(metadata.repository ?? "")) errors.push("repository is invalid.");
  if (
    !normalizeCommitSha(metadata.releaseCommit) ||
    !normalizeCommitSha(metadata.mergeSha) ||
    !normalizeCommitSha(metadata.mergeTreeSha)
  ) {
    errors.push("release and final merge identity must be complete immutable SHA/tree values.");
  }
  if (normalizeCommitSha(releaseCommit) && metadata.releaseCommit !== normalizeCommitSha(releaseCommit)) {
    errors.push("linkage releaseCommit does not match the requested release.");
  }
  if (metadata.mergeSha !== metadata.releaseCommit)
    errors.push("final merge SHA must equal the dispatched release commit.");
  if (
    metadata.pullRequestNumber !== null &&
    (!Number.isSafeInteger(metadata.pullRequestNumber) || metadata.pullRequestNumber <= 0)
  ) {
    errors.push("pullRequestNumber is invalid.");
  }
  for (const field of [
    "prOpenedAt",
    "prReadyForReviewAt",
    "prApprovedAt",
    "queueQueuedAt",
    "queueMergeGroupStartedAt",
    "queueMergedAt",
    "queueDequeuedAt",
  ]) {
    if (metadata[field] !== null && !normalizeIso(metadata[field])) errors.push(`${field} is invalid.`);
  }
  if (
    metadata.queueBatchSize !== null &&
    (!Number.isSafeInteger(metadata.queueBatchSize) || metadata.queueBatchSize <= 0)
  ) {
    errors.push("queueBatchSize is invalid.");
  }
  const candidateFields = [
    metadata.candidateArtifactId,
    metadata.candidateArtifactName,
    metadata.mergeGroupWorkflowId,
    metadata.mergeGroupWorkflowPath,
    metadata.mergeGroupRunId,
    metadata.mergeGroupRunAttempt,
    metadata.candidateSha,
    metadata.candidateTreeSha,
    metadata.candidateImageDigest,
  ];
  const candidatePresent = candidateFields.some((value) => value !== null);
  if (candidatePresent) {
    if (
      !candidateFields.every((value) => value !== null) ||
      !isPositiveSafeIntegerString(metadata.candidateArtifactId) ||
      !isPositiveSafeIntegerString(metadata.mergeGroupWorkflowId) ||
      !isPositiveSafeIntegerString(metadata.mergeGroupRunId) ||
      !isPositiveSafeIntegerString(metadata.mergeGroupRunAttempt) ||
      metadata.mergeGroupWorkflowPath !== PLATFORM_PR_WORKFLOW_PATH ||
      metadata.candidateArtifactName !==
        `merge-qualification-candidate-${metadata.mergeGroupRunId}-${metadata.mergeGroupRunAttempt}` ||
      !normalizeCommitSha(metadata.candidateSha) ||
      !normalizeCommitSha(metadata.candidateTreeSha) ||
      !/^sha256:[0-9a-f]{64}$/.test(metadata.candidateImageDigest ?? "")
    ) {
      errors.push("candidate artifact/workflow/run/attempt/SHA/tree/digest linkage is incomplete or contradictory.");
    }
    if (metadata.candidateTreeSha !== metadata.mergeTreeSha) errors.push("candidate and final merge tree must agree.");
    const queued = Date.parse(metadata.queueQueuedAt ?? "");
    const started = Date.parse(metadata.queueMergeGroupStartedAt ?? "");
    const merged = Date.parse(metadata.queueMergedAt ?? "");
    if (![queued, started, merged].every(Number.isFinite) || queued > started || started > merged) {
      errors.push("candidate linkage violates queue/run/merge temporal order.");
    }
  }
  if (!Array.isArray(metadata.lineageReasons) || metadata.lineageReasons.length > 100) {
    errors.push("lineageReasons is invalid.");
  } else if (
    new Set(metadata.lineageReasons).size !== metadata.lineageReasons.length ||
    metadata.lineageReasons.some((reason) => typeof reason !== "string" || reason.length === 0 || reason.length > 256)
  ) {
    errors.push("lineageReasons must be unique bounded strings.");
  }
  if (typeof metadata.lineageComplete !== "boolean") errors.push("lineageComplete must be boolean.");
  const expectedComplete = candidatePresent && metadata.lineageReasons.length === 0;
  if (metadata.lineageComplete !== expectedComplete)
    errors.push("lineageComplete must be derived from exact candidate evidence and collection reasons.");
  return errors;
}

export async function collectReleaseHealthGithubMetadata(options, dependencies = {}) {
  if (!options.repository) throw new Error("GITHUB_REPOSITORY or --repository is required.");
  if (!normalizeCommitSha(options.releaseCommit)) throw new Error("RELEASE_COMMIT or --release-commit is required.");
  const request = createGitHubRequest({
    repository: options.repository,
    token: options.token,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
  });
  const pulls = await request.json(`/commits/${options.releaseCommit}/pulls`);
  const lineageReasons = [];
  const pull = Array.isArray(pulls) && pulls.length === 1 ? pulls[0] : null;
  if (!Array.isArray(pulls) || pulls.length !== 1)
    lineageReasons.push(`final-commit-pull-count:${Array.isArray(pulls) ? pulls.length : "invalid"}`);
  const [pullDetails, reviews, timeline, branchRules, releaseCommit] = await Promise.all([
    pull?.number ? request.json(`/pulls/${pull.number}`) : null,
    pull?.number ? request.json(`/pulls/${pull.number}/reviews?per_page=100`) : [],
    pull?.number ? request.json(`/issues/${pull.number}/timeline?per_page=100`) : [],
    request.json(`/rules/branches/main?per_page=100`).catch(() => []),
    request.json(`/git/commits/${options.releaseCommit}`),
  ]);
  const queueQueuedAt =
    latestTimelineTimestamp(Array.isArray(timeline) ? timeline : [], "added_to_merge_queue") ??
    normalizeIso(options.sourceWorkflowCreatedAt);
  const queueMergedAt = normalizeIso(pullDetails?.merged_at) ?? latestTimelineTimestamp(timeline, "merged");
  const runCollection = await collectMergeGroupRuns(request, { maxPages: MAX_PAGES });
  lineageReasons.push(...runCollection.reasons);
  const candidates = [];
  for (const run of runCollection.runs) {
    if (!candidateRunCouldBelong({ run, queueQueuedAt, queueMergedAt })) continue;
    const artifactCollection = await collectRunArtifacts(request, run, { maxPages: MAX_PAGES });
    lineageReasons.push(...artifactCollection.reasons.map((reason) => `run-${run.id}-artifacts:${reason}`));
    const artifactName = `merge-qualification-candidate-${run.id}-${run.run_attempt}`;
    const exactArtifacts = artifactCollection.artifacts.filter(
      (artifact) => artifact?.name === artifactName && artifact?.expired !== true,
    );
    if (exactArtifacts.length !== 1) {
      if (exactArtifacts.length > 1)
        lineageReasons.push(`run-${run.id}-attempt-${run.run_attempt}:duplicate-candidate-artifact`);
      continue;
    }
    try {
      const artifact = exactArtifacts[0];
      const bytes = await request.bytes(artifact.archive_download_url);
      if (bytes.length > 10 * 1024 * 1024) throw new Error("candidate artifact archive exceeds 10 MiB");
      const entries = [...unzipJsonEntries(bytes)].filter(([name]) => basename(name) === "candidate.json");
      if (entries.length !== 1) throw new Error("candidate archive must contain exactly one candidate.json");
      const record = JSON.parse(entries[0][1].toString("utf8"));
      const associationPage = await request.jsonPage(`/commits/${run.head_sha}/pulls?per_page=100`);
      if (associationPage.hasNext) throw new Error("candidate commit association exceeds the 100-PR refusal ceiling");
      const associatedPulls = associationPage.value;
      const recordErrors = validateCandidateArtifact(record, {
        repository: options.repository,
        run,
        associatedPulls,
        pull: pullDetails,
        releaseTreeSha: releaseCommit?.tree?.sha,
      });
      if (recordErrors.length > 0) throw new Error(recordErrors.join(" "));
      candidates.push({ run, artifactId: artifact.id, artifactName, record });
    } catch (error) {
      lineageReasons.push(
        `run-${run.id}-attempt-${run.run_attempt}:candidate-artifact-invalid:${boundedReason(error)}`,
      );
    }
  }
  let candidate = null;
  if (candidates.length === 1) candidate = candidates[0];
  else if (candidates.length > 1) lineageReasons.push(`ambiguous-exact-candidates:${candidates.length}`);
  return buildReleaseHealthGithubMetadata({
    repository: options.repository,
    releaseCommit: options.releaseCommit,
    sourceWorkflowCreatedAt: normalizeIso(options.sourceWorkflowCreatedAt),
    pull: pullDetails ?? pull,
    reviews,
    timeline,
    candidate,
    lineageReasons,
    releaseTreeSha: releaseCommit?.tree?.sha,
    branchRules,
  });
}

export async function collectMergeGroupRuns(request, { maxPages = MAX_PAGES } = {}) {
  const collected = await collectTotalAwarePages({
    request,
    maxPages,
    source: "merge-group-runs",
    pathForPage: (page) =>
      `/actions/workflows/platform-pr.yml/runs?event=merge_group&per_page=${PER_PAGE}&page=${page}`,
    values: (payload) => payload?.workflow_runs,
    identity: (run) => `${run?.id ?? ""}:${run?.run_attempt ?? ""}`,
    orderValue: (run) => Date.parse(run?.created_at ?? ""),
  });
  return { runs: collected.values, ...collected, values: undefined };
}

async function collectRunArtifacts(request, run, { maxPages }) {
  const collected = await collectTotalAwarePages({
    request,
    maxPages,
    source: `run-${run.id}-artifacts`,
    pathForPage: (page) => `/actions/runs/${run.id}/artifacts?per_page=${PER_PAGE}&page=${page}`,
    values: (payload) => payload?.artifacts,
    identity: (artifact) => String(artifact?.id ?? ""),
    orderValue: null,
  });
  return { artifacts: collected.values, reasons: collected.reasons };
}

async function collectTotalAwarePages({ request, maxPages, source, pathForPage, values, identity, orderValue }) {
  const byIdentity = new Map();
  const conflictedIdentities = new Set();
  const reasons = [];
  const pageFingerprints = new Set();
  let declaredTotal = null;
  let observedEntries = 0;
  let pagesFetched = 0;
  let previousOrder = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await request.json(pathForPage(page));
    pagesFetched = page;
    if (
      !isObject(payload) ||
      !Number.isSafeInteger(payload.total_count) ||
      payload.total_count < 0 ||
      !Array.isArray(values(payload))
    ) {
      reasons.push(`${source}:page-${page}:response-contract`);
      break;
    }
    if (declaredTotal === null) {
      declaredTotal = payload.total_count;
      if (declaredTotal > maxPages * PER_PAGE) reasons.push(`${source}:refusal-ceiling:${declaredTotal}`);
    } else if (declaredTotal !== payload.total_count) {
      reasons.push(`${source}:page-${page}:declared-total-changed:${payload.total_count}`);
    }
    const entries = values(payload);
    const fingerprint = JSON.stringify(entries.map(identity));
    if (pageFingerprints.has(fingerprint) && entries.length > 0) reasons.push(`${source}:page-${page}:page-loop`);
    pageFingerprints.add(fingerprint);
    observedEntries += entries.length;
    for (const entry of entries) {
      const key = identity(entry);
      if (!key || /^(?:undefined|null)?(?::(?:undefined|null)?)?$/.test(key)) {
        reasons.push(`${source}:page-${page}:missing-identity`);
        continue;
      }
      const encoded = JSON.stringify(entry);
      const previous = byIdentity.get(key);
      if (previous) {
        reasons.push(`${source}:page-${page}:duplicate:${key}`);
        if (previous.encoded !== encoded) {
          reasons.push(`${source}:page-${page}:conflicting-duplicate:${key}`);
          conflictedIdentities.add(key);
          byIdentity.delete(key);
        }
      } else if (conflictedIdentities.has(key)) {
        reasons.push(`${source}:page-${page}:duplicate-after-conflict:${key}`);
      } else {
        byIdentity.set(key, { encoded, value: entry });
      }
      if (orderValue) {
        const currentOrder = orderValue(entry);
        if (Number.isFinite(currentOrder) && Number.isFinite(previousOrder) && currentOrder > previousOrder) {
          reasons.push(`${source}:page-${page}:out-of-order`);
        }
        if (Number.isFinite(currentOrder)) previousOrder = currentOrder;
      }
    }
    if (declaredTotal === 0) break;
    if (observedEntries >= declaredTotal) break;
    if (entries.length === 0) {
      reasons.push(`${source}:page-${page}:missing-page:${observedEntries}/${declaredTotal}`);
      break;
    }
    if (entries.length < PER_PAGE)
      reasons.push(`${source}:page-${page}:short-page:${observedEntries}/${declaredTotal}`);
  }
  if (declaredTotal === null) reasons.push(`${source}:declared-total-missing`);
  else if (observedEntries < declaredTotal)
    reasons.push(`${source}:incomplete-total:${observedEntries}/${declaredTotal}`);
  if (declaredTotal !== null && observedEntries > declaredTotal)
    reasons.push(`${source}:declared-total-overrun:${observedEntries}/${declaredTotal}`);
  if (declaredTotal !== null && observedEntries < declaredTotal && pagesFetched >= maxPages) {
    reasons.push(`${source}:refusal-ceiling-reached:${maxPages}`);
  }
  return {
    values: [...byIdentity.values()].map(({ value }) => value),
    reasons: uniqueReasons(reasons),
    declaredTotal,
    observedEntries,
    pagesFetched,
  };
}

function candidateRunCouldBelong({ run, queueQueuedAt, queueMergedAt }) {
  const created = Date.parse(run?.created_at ?? "");
  const updated = Date.parse(run?.updated_at ?? "");
  const queued = Date.parse(queueQueuedAt ?? "");
  const merged = Date.parse(queueMergedAt ?? "");
  return (
    run?.event === "merge_group" &&
    run?.path === PLATFORM_PR_WORKFLOW_PATH &&
    run?.status === "completed" &&
    run?.conclusion === "success" &&
    isPositiveSafeInteger(run?.workflow_id) &&
    isPositiveSafeInteger(run?.id) &&
    isPositiveSafeInteger(run?.run_attempt) &&
    Number.isFinite(created) &&
    Number.isFinite(updated) &&
    Number.isFinite(queued) &&
    Number.isFinite(merged) &&
    created >= queued &&
    updated <= merged
  );
}

function validateCandidateArtifact(record, { repository, run, associatedPulls, pull, releaseTreeSha }) {
  const errors = validateMergeQualificationCandidate(record);
  const rebuilt = buildMergeQualificationCandidateFromGithubMetadata({
    repository,
    run,
    associatedPullRequestPages: [associatedPulls],
    queueBaseSha: record?.queueBaseSha,
    builtImageDigest: record?.builtImageDigest,
    capturedAt: record?.capturedAt,
  });
  errors.push(...rebuilt.errors);
  if (record.schemaVersion !== MERGE_QUALIFICATION_CANDIDATE_SCHEMA_VERSION)
    errors.push("candidate schema is not current.");
  if (
    record.repository !== repository ||
    record.workflowId !== String(run?.workflow_id ?? "") ||
    record.workflowPath !== run?.path ||
    record.runId !== String(run?.id ?? "") ||
    record.runAttempt !== String(run?.run_attempt ?? "") ||
    record.candidateSha !== normalizeCommitSha(run?.head_sha)
  ) {
    errors.push("candidate artifact does not bind its immutable workflow/run/attempt/candidate identity.");
  }
  if (canonicalJson(record) !== canonicalJson(rebuilt.record)) {
    errors.push("candidate artifact does not match the authoritative merge-group commit association.");
  }
  if (
    !record.pullRequests.some(
      (candidatePull) =>
        candidatePull.number === pull?.number && candidatePull.headSha === normalizeCommitSha(pull?.head?.sha),
    )
  ) {
    errors.push("candidate artifact does not include the final merged PR/head identity.");
  }
  if (record.candidateTreeSha !== normalizeCommitSha(releaseTreeSha)) {
    errors.push("candidate artifact tree does not match the final merge tree.");
  }
  const captured = Date.parse(record.capturedAt ?? "");
  if (captured < Date.parse(run?.created_at ?? "") || captured > Date.parse(run?.updated_at ?? "")) {
    errors.push("candidate artifact capture time is outside its exact workflow attempt.");
  }
  return errors;
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
    merge_qualification_lineage_version: metadata.schemaVersion,
    candidate_artifact_id: metadata.candidateArtifactId,
    candidate_artifact_name: metadata.candidateArtifactName,
    merge_group_workflow_id: metadata.mergeGroupWorkflowId,
    merge_group_workflow_path: metadata.mergeGroupWorkflowPath,
    candidate_sha: metadata.candidateSha,
    candidate_tree_sha: metadata.candidateTreeSha,
    candidate_image_digest: metadata.candidateImageDigest,
    merge_group_run_id: metadata.mergeGroupRunId,
    merge_group_run_attempt: metadata.mergeGroupRunAttempt,
    merge_sha: metadata.mergeSha,
    merge_tree_sha: metadata.mergeTreeSha,
    lineage_complete: metadata.lineageComplete ? "true" : "false",
    lineage_reasons_json: JSON.stringify(metadata.lineageReasons),
  };
  return `${Object.entries(entries)
    .map(([key, value]) => `${key}=${value ?? ""}`)
    .join("\n")}\n`;
}

async function main(argv, env = process.env) {
  try {
    const options = parseReleaseHealthGithubMetadataArgs(argv, env);
    const metadata = options.linkageFile
      ? JSON.parse(await readFile(options.linkageFile, "utf8"))
      : await collectReleaseHealthGithubMetadata(options);
    const errors = validateReleaseCandidateLinkage(metadata, { releaseCommit: options.releaseCommit });
    if (errors.length > 0) throw new Error(errors.join(" "));
    if (options.outPath) await writeFile(options.outPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    if (options.format === "json") console.log(JSON.stringify(metadata, null, 2));
    else process.stdout.write(formatGithubOutput(metadata));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function createGitHubRequest({ repository, token, fetchImpl }) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  const response = async (pathOrUrl) => {
    const url = String(pathOrUrl).startsWith("http")
      ? String(pathOrUrl)
      : `https://api.github.com/repos/${repository}${pathOrUrl}`;
    const result = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!result.ok) throw new Error(`GitHub API request failed for ${pathOrUrl}: ${result.status}`);
    return result;
  };
  return {
    json: async (path) => (await response(path)).json(),
    jsonPage: async (path) => {
      const result = await response(path);
      return {
        value: await result.json(),
        hasNext: /<[^>]+>;\s*rel="next"/u.test(result.headers.get("link") ?? ""),
      };
    },
    bytes: async (path) => Buffer.from(await (await response(path)).arrayBuffer()),
  };
}

function readyForReviewAt(pull, timeline) {
  const readyEvent = firstTimelineTimestamp(timeline, "ready_for_review");
  if (readyEvent) return readyEvent;
  return pull?.draft === false ? normalizeIso(pull.created_at) : null;
}

function latestApprovedAt(reviews) {
  return (
    (Array.isArray(reviews) ? reviews : [])
      .filter((review) => review?.state === "APPROVED")
      .map((review) => normalizeIso(review.submitted_at))
      .filter(Boolean)
      .sort()
      .at(-1) ?? null
  );
}

function queueFailureReason(timeline) {
  const removed = latestTimelineEvent(timeline, "removed_from_merge_queue");
  return normalizeString(removed?.reason) ?? normalizeString(removed?.dismissed_reason) ?? "removed-from-merge-queue";
}

function mergeQueueBatchSize(branchRules) {
  const mergeQueueRule = branchRules.find((rule) => rule?.type === "merge_queue");
  const value = Number.parseInt(String(mergeQueueRule?.parameters?.max_entries_to_merge ?? ""), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function firstTimelineTimestamp(timeline, eventName) {
  return normalizeIso(firstTimelineEvent(timeline, eventName)?.created_at);
}

function latestTimelineTimestamp(timeline, eventName) {
  return normalizeIso(latestTimelineEvent(timeline, eventName)?.created_at);
}

function firstTimelineEvent(timeline, eventName) {
  return timelineEvents(timeline, eventName)[0] ?? null;
}

function latestTimelineEvent(timeline, eventName) {
  return timelineEvents(timeline, eventName).at(-1) ?? null;
}

function timelineEvents(timeline, eventName) {
  return (Array.isArray(timeline) ? timeline : [])
    .filter((event) => event?.event === eventName && ISO_EVENT_NAMES.has(event.event) && normalizeIso(event.created_at))
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function unzipJsonEntries(buffer) {
  const entries = new Map();
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("artifact archive is not a supported ZIP file");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  if (entryCount > 1_000) throw new Error("artifact ZIP contains too many entries");
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("artifact ZIP central directory is invalid");
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
      if (uncompressedSize > 2 * 1024 * 1024) throw new Error(`artifact JSON entry ${name} exceeds 2 MiB`);
      if (method === 0) entries.set(name, compressed);
      else if (method === 8) entries.set(name, inflateRawSync(compressed));
      else throw new Error(`artifact ZIP uses unsupported compression method ${method}`);
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

function normalizeIso(value) {
  const normalized = normalizeString(value);
  return normalized && !Number.isNaN(Date.parse(normalized)) ? normalized : null;
}

function normalizeCommitSha(value) {
  const normalized = normalizeString(value);
  return normalized && /^[0-9a-f]{40}$/i.test(normalized) ? normalized.toLowerCase() : null;
}

function uniqueReasons(reasons) {
  return [...new Set(reasons.filter((reason) => typeof reason === "string" && reason.length > 0))].sort();
}

function boundedReason(error) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 160);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isClosedObject(value, fields) {
  return (
    isObject(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isPositiveSafeIntegerString(value) {
  return typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
