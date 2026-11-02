#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { createGitHubClient } from "./release-health-delivery-health.mjs";

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
        identity: (rule) => rule?.id ?? rule?.node_id ?? rule.type,
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
    [event?.event, event?.created_at, event?.source?.issue?.number ?? event?.commit_id ?? event?.sha ?? "none"].join(
      ":",
    )
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
