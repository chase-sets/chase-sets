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

  const request = createGitHubRequest({
    repository: options.repository,
    token: options.token,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
  });

  const pulls = await request(`/commits/${options.releaseCommit}/pulls`);
  const pull = Array.isArray(pulls) ? pulls[0] : null;
  const [pullDetails, reviews, timeline, runs] = await Promise.all([
    pull?.number ? request(`/pulls/${pull.number}`) : null,
    pull?.number ? request(`/pulls/${pull.number}/reviews?per_page=100`) : [],
    pull?.number ? request(`/issues/${pull.number}/timeline?per_page=100`) : [],
    request(`/actions/runs?head_sha=${encodeURIComponent(options.releaseCommit)}&event=merge_group&per_page=10`),
  ]);

  return buildReleaseHealthGithubMetadata({
    releaseCommit: options.releaseCommit,
    sourceWorkflowCreatedAt: normalizeIso(options.sourceWorkflowCreatedAt),
    pull: pullDetails ?? pull,
    reviews,
    timeline,
    mergeGroupRuns: runs?.workflow_runs ?? [],
  });
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
    merge_sha: metadata.mergeSha,
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

function queueFailureReason(timeline) {
  const removed = firstTimelineEvent(timeline, "removed_from_merge_queue");
  const reason = normalizeString(removed?.reason) ?? normalizeString(removed?.dismissed_reason);
  return reason ?? "removed-from-merge-queue";
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
