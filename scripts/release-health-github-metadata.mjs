#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";

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
  const mergeCandidate = selectMergeCandidate({
    pullNumber: pull?.number,
    queueQueuedAt,
    queueMergedAt,
    mergeGroupRuns,
    releaseTreeSha: input.releaseTreeSha,
  });

  return {
    pullRequestNumber: pull?.number ?? null,
    prOpenedAt: normalizeIso(pull?.created_at) ?? null,
    prReadyForReviewAt: readyForReviewAt(pull, timeline),
    prApprovedAt: latestApprovedAt(reviews),
    queueQueuedAt,
    queueMergeGroupStartedAt: normalizeIso(mergeCandidate?.created_at) ?? null,
    queueMergedAt,
    queueDequeuedAt,
    queueFailureReason: queueDequeuedAt ? queueFailureReason(timeline) : null,
    queueBatchSize: mergeQueueBatchSize(branchRules),
    candidateSha: mergeCandidate?.head_sha ?? null,
    candidateTreeSha: mergeCandidate?.candidateTreeSha ?? null,
    mergeGroupRunId: mergeCandidate ? String(mergeCandidate.id) : null,
    mergeGroupRunAttempt: mergeCandidate ? String(mergeCandidate.run_attempt) : null,
    mergeSha: normalizeCommitSha(mergedEvent?.commit_id) ?? normalizeCommitSha(pull?.merge_commit_sha) ?? releaseCommit,
    mergeTreeSha: normalizeCommitSha(input.releaseTreeSha),
  };
}

export async function collectReleaseHealthGithubMetadata(options, dependencies = {}) {
  if (!options.repository) {
    throw new Error("GITHUB_REPOSITORY or --repository is required.");
  }
  if (!options.releaseCommit) {
    throw new Error("RELEASE_COMMIT or --release-commit is required.");
  }

  const request = createGitHubRequest({
    repository: options.repository,
    token: options.token,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
  });

  const pulls = await request(`/commits/${options.releaseCommit}/pulls`);
  const pull = Array.isArray(pulls) ? pulls[0] : null;
  const [pullDetails, reviews, timeline, branchRules, releaseCommit] = await Promise.all([
    pull?.number ? request(`/pulls/${pull.number}`) : null,
    pull?.number ? request(`/pulls/${pull.number}/reviews?per_page=100`) : [],
    pull?.number ? request(`/issues/${pull.number}/timeline?per_page=100`) : [],
    request(`/rules/branches/main?per_page=100`).catch(() => []),
    request(`/git/commits/${options.releaseCommit}`),
  ]);
  const queueQueuedAt =
    firstTimelineTimestamp(Array.isArray(timeline) ? timeline : [], "added_to_merge_queue") ??
    normalizeIso(options.sourceWorkflowCreatedAt);
  const runs = await collectMergeGroupRuns(request, { queueQueuedAt, maxPages: 20 });
  const candidateRuns = [];
  const pullBranch = pull?.number ? new RegExp(`(?:^|/)pr-${pull.number}-`) : null;
  for (const run of runs) {
    if (
      run?.event !== "merge_group" ||
      run?.path !== ".github/workflows/platform-pr.yml" ||
      (pullBranch && !pullBranch.test(String(run?.head_branch ?? "")))
    ) {
      continue;
    }
    const candidateSha = normalizeCommitSha(run?.head_sha);
    if (!candidateSha) continue;
    try {
      const commit = await request(`/git/commits/${candidateSha}`);
      candidateRuns.push({ ...run, candidateTreeSha: normalizeCommitSha(commit?.tree?.sha) });
    } catch {
      candidateRuns.push({ ...run, candidateTreeSha: null });
    }
  }

  return buildReleaseHealthGithubMetadata({
    releaseCommit: options.releaseCommit,
    sourceWorkflowCreatedAt: normalizeIso(options.sourceWorkflowCreatedAt),
    pull: pullDetails ?? pull,
    reviews,
    timeline,
    mergeGroupRuns: candidateRuns,
    releaseTreeSha: releaseCommit?.tree?.sha,
    branchRules,
  });
}

async function collectMergeGroupRuns(request, { queueQueuedAt, maxPages }) {
  const byAttempt = new Map();
  let declaredTotal = null;
  const queuedMs = Date.parse(queueQueuedAt ?? "");
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await request(
      `/actions/workflows/platform-pr.yml/runs?event=merge_group&per_page=100&page=${page}`,
    );
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      !Number.isSafeInteger(payload.total_count) ||
      payload.total_count < 0 ||
      !Array.isArray(payload.workflow_runs)
    ) {
      throw new Error(`Merge-group run collection page ${page} did not match the GitHub response contract.`);
    }
    if (declaredTotal === null) declaredTotal = payload.total_count;
    else if (declaredTotal !== payload.total_count)
      throw new Error("Merge-group run collection changed total_count between pages.");
    for (const run of payload.workflow_runs) {
      const key = `${run?.id ?? ""}:${run?.run_attempt ?? ""}`;
      const encoded = JSON.stringify(run);
      const previous = byAttempt.get(key);
      if (previous && previous.encoded !== encoded) {
        throw new Error(`Merge-group run collection returned conflicting duplicate attempt ${key}.`);
      }
      if (!previous) byAttempt.set(key, { encoded, run });
    }
    if (byAttempt.size >= declaredTotal) return [...byAttempt.values()].map(({ run }) => run);
    const crossedCausalWindow =
      Number.isFinite(queuedMs) &&
      payload.workflow_runs.some(
        (run) => Number.isFinite(Date.parse(run?.created_at ?? "")) && Date.parse(run.created_at) < queuedMs,
      );
    if (crossedCausalWindow) return [...byAttempt.values()].map(({ run }) => run);
    if (payload.workflow_runs.length === 0) {
      throw new Error(
        `Merge-group run collection stopped at ${byAttempt.size}/${declaredTotal} without crossing the causal window.`,
      );
    }
  }
  throw new Error(`Merge-group run collection exceeded the bounded ${maxPages} pages.`);
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
    candidate_sha: metadata.candidateSha,
    candidate_tree_sha: metadata.candidateTreeSha,
    merge_group_run_id: metadata.mergeGroupRunId,
    merge_group_run_attempt: metadata.mergeGroupRunAttempt,
    merge_sha: metadata.mergeSha,
    merge_tree_sha: metadata.mergeTreeSha,
  };

  return `${Object.entries(entries)
    .map(([key, value]) => `${key}=${value ?? ""}`)
    .join("\n")}\n`;
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

function createGitHubRequest({ repository, token, fetchImpl }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }
  return async (path) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API request failed for ${path}: ${response.status}`);
    }
    return response.json();
  };
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

function selectMergeCandidate({ pullNumber, queueQueuedAt, queueMergedAt, mergeGroupRuns, releaseTreeSha }) {
  if (!Number.isSafeInteger(pullNumber) || !normalizeCommitSha(releaseTreeSha)) return null;
  const queuedMs = Date.parse(queueQueuedAt ?? "");
  const mergedMs = Date.parse(queueMergedAt ?? "");
  const branchPattern = new RegExp(`(?:^|/)pr-${pullNumber}-`);
  const eligible = mergeGroupRuns.filter((run) => {
    const createdMs = Date.parse(run?.created_at ?? "");
    return (
      run?.event === "merge_group" &&
      run?.path === ".github/workflows/platform-pr.yml" &&
      run?.status === "completed" &&
      run?.conclusion === "success" &&
      branchPattern.test(String(run?.head_branch ?? "")) &&
      normalizeCommitSha(run?.head_sha) !== null &&
      normalizeCommitSha(run?.candidateTreeSha) === normalizeCommitSha(releaseTreeSha) &&
      Number.isSafeInteger(run?.id) &&
      Number.isSafeInteger(run?.run_attempt) &&
      run.run_attempt > 0 &&
      Number.isFinite(createdMs) &&
      (!Number.isFinite(queuedMs) || createdMs >= queuedMs) &&
      (!Number.isFinite(mergedMs) || createdMs <= mergedMs)
    );
  });
  return (
    [...eligible].sort((left, right) => {
      const time = Date.parse(right.updated_at ?? right.created_at) - Date.parse(left.updated_at ?? left.created_at);
      if (time !== 0) return time;
      if (left.id !== right.id) return right.id - left.id;
      return right.run_attempt - left.run_attempt;
    })[0] ?? null
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
