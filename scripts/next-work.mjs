import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { classified } from "./backlog-classify.mjs";
import { BLOCKED_BY_QUERY, BLOCKING_QUERY, LABELS_QUERY, reduceUnlockCounts } from "./dispatch-unlock-count.mjs";
import { extractReceipt, projectComment, sameMilestoneRevision, stableBotComments } from "./issue-readiness.mjs";
import {
  compareOutcomeOrder,
  findOutcomeOrderTies,
  isExecutableOutcome,
  readOutcomePolicy,
  readSteeringPolicy,
} from "./milestone-policy.mjs";

export const SCHEMA_VERSION = "next-work/v1";
export const DEFAULT_REPOSITORY = "chase-sets/chase-sets";
export const EXCLUSION_REASONS = Object.freeze([
  "EPIC",
  "TRACKING_ONLY",
  "PLATFORM_HELD",
  "NO_MILESTONE",
  "NOT_COMMITTED_OUTCOME",
  "EXCLUDED_MILESTONE",
  "BLOCKED",
]);
export const LANE_CLASSES = Object.freeze(["product", "ops", "other"]);

const PAGE_SIZE = 50;
const NESTED_PAGE_SIZE = 20;
const PR_PAGE_SIZE = 10;
const PROJECT_ITEM_PAGE_SIZE = 10;
const MILESTONE_PAGE_SIZE = 100;
const BOARD_PROJECT_NUMBER = 1;
const PAGE_INTERVAL_MS = 1000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RATE_LIMIT_WAITS = 3;
const DEFAULT_TOP = 10;
const DEFAULT_READINESS_DEPTH = 15;
const COMMENTS_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 100;

const DEPENDENCY_EDGE = "nodes { id number state repository { nameWithOwner } }";

export const ISSUES_QUERY = `
query NextWorkIssues($owner:String!, $repository:String!, $after:String) {
  repository(owner:$owner, name:$repository) {
    issues(states:OPEN, first:${PAGE_SIZE}, after:$after, orderBy:{field:CREATED_AT, direction:ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id number state title updatedAt lastEditedAt
        issueType { name }
        milestone { id number title }
        parent { number }
        labels(first:${NESTED_PAGE_SIZE}) { totalCount pageInfo { hasNextPage endCursor } nodes { id name } }
        blockedBy(first:${NESTED_PAGE_SIZE}) { totalCount pageInfo { hasNextPage endCursor } ${DEPENDENCY_EDGE} }
        blocking(first:${NESTED_PAGE_SIZE}) { totalCount pageInfo { hasNextPage endCursor } ${DEPENDENCY_EDGE} }
        closedByPullRequestsReferences(first:${PR_PAGE_SIZE}, includeClosedPrs:false) {
          totalCount pageInfo { hasNextPage } nodes { number state }
        }
        projectItems(first:${PROJECT_ITEM_PAGE_SIZE}) {
          totalCount pageInfo { hasNextPage }
          nodes {
            project { number owner { ... on Organization { login } } }
            dispatchRank: fieldValueByName(name:"Dispatch rank") { ... on ProjectV2ItemFieldNumberValue { number } }
            status: fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          }
        }
      }
    }
  }
}`;

const OVERFLOW_QUERIES = Object.freeze({
  labels: LABELS_QUERY,
  blockedBy: BLOCKED_BY_QUERY,
  blocking: BLOCKING_QUERY,
});

export class NextWorkError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "NextWorkError";
    this.code = code;
  }
}

function incomplete(detail) {
  return new NextWorkError("NEXT_WORK_FACTS_INCOMPLETE", detail);
}

function parseRepository(value) {
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(value ?? "");
  if (!match) throw new NextWorkError("NEXT_WORK_USAGE", `repository must be <owner>/<name>, received ${value}`);
  return { owner: match[1], name: match[2], nameWithOwner: value };
}

function normalizeExcludedMilestones(values) {
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new NextWorkError("NEXT_WORK_USAGE", `excluded milestone must be a positive integer, received ${value}`);
    }
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

// ---------------------------------------------------------------------------
// Ranking (pure)
// ---------------------------------------------------------------------------

function labelNames(issue) {
  return issue.labels.map((label) => label.name);
}

function hasOpenBlocker(issue) {
  return issue.blockedBy.some((edge) => edge.state === "OPEN");
}

function exclusionReason(issue, milestone, excluded) {
  const labels = labelNames(issue);
  if (issue.issueType === "Epic") return "EPIC";
  if (labels.includes("status:tracking-only")) return "TRACKING_ONLY";
  if (labels.includes("dispatch:platform") || labels.includes("dispatch:platform-return")) return "PLATFORM_HELD";
  if (issue.milestone === null) return "NO_MILESTONE";
  if (milestone === null || !isExecutableOutcome(milestone)) return "NOT_COMMITTED_OUTCOME";
  if (excluded.has(milestone.number)) return "EXCLUDED_MILESTONE";
  if (hasOpenBlocker(issue)) return "BLOCKED";
  return null;
}

function laneClass(issue) {
  const labels = labelNames(issue);
  if (labels.includes("kind:product")) return "product";
  if (labels.includes("kind:ops") || issue.title.startsWith("[controller]")) return "ops";
  return "other";
}

function action(issue, milestone) {
  const labels = labelNames(issue);
  if (labels.includes("status:needs-operator")) return { action: "operator-wait", reasons: [] };
  if (labels.includes("status:needs-replan")) return { action: "replan", reasons: [] };
  const isClassified = classified({
    number: issue.number,
    state: "open",
    labels,
    issueTypeName: issue.issueType,
    milestoneTitle: issue.milestone.title,
    milestoneDescription: milestone.description,
    milestoneNumber: milestone.number,
    milestoneState: milestone.state,
    blockedByCount: 0,
    hasParent: issue.parentNumber !== null,
  });
  if (!isClassified) return { action: "planning-repair", reasons: ["UNCLASSIFIED"] };
  if (issue.issueType === "Decision") return { action: "decide", reasons: [] };
  if (issue.openPrs.length > 0) return { action: "pr-open", reasons: [] };
  return { action: "implement", reasons: [] };
}

function priority(issue) {
  const levels = labelNames(issue)
    .map((label) => /^priority:p([0-3])$/.exec(label))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  return levels.length === 0 ? null : Math.min(...levels);
}

function compareMissingLast(left, right) {
  if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
  return left - right;
}

function compareRanked(left, right) {
  return (
    Number(right.entry.steered) - Number(left.entry.steered) ||
    compareOutcomeOrder(left.milestone, right.milestone) ||
    compareMissingLast(left.entry.dispatchRank, right.entry.dispatchRank) ||
    compareMissingLast(left.entry.priority, right.entry.priority) ||
    right.entry.unlockCount - left.entry.unlockCount ||
    left.entry.issue - right.entry.issue
  );
}

/**
 * Ranks the runnable frontier from one complete fact set. Every open issue is
 * either ranked once in its lane class or counted once under its first
 * exclusion reason. The function performs no I/O.
 */
export function rankNextWork(facts, options = {}) {
  const excludedMilestones = normalizeExcludedMilestones(options.excludeMilestones ?? []);
  const excluded = new Set(excludedMilestones);
  const milestonesByNumber = new Map(facts.milestones.map((milestone) => [milestone.number, milestone]));
  const steeringByNumber = new Map();
  const steeringDefects = [];
  for (const milestone of facts.milestones) {
    const steering = readSteeringPolicy(milestone);
    if (steering === null) continue;
    if (String(milestone.state ?? "").toLowerCase() === "open" && !isExecutableOutcome(milestone)) {
      steeringDefects.push({ code: "STEERING_ON_NON_EXECUTABLE", milestones: [milestone.number] });
      continue;
    }
    if (isExecutableOutcome(milestone)) steeringByNumber.set(milestone.number, steering);
  }
  const rankedMilestones = facts.milestones.filter(
    (milestone) => isExecutableOutcome(milestone) && !excluded.has(milestone.number),
  );
  const exclusions = Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0]));
  const buckets = Object.fromEntries(LANE_CLASSES.map((name) => [name, []]));
  const seen = new Set();

  for (const issue of facts.issues) {
    if (seen.has(issue.id)) throw incomplete(`issue ${issue.number} appears more than once`);
    seen.add(issue.id);
    if (!Number.isSafeInteger(issue.unlockCount) || issue.unlockCount < 0) {
      throw incomplete(`issue ${issue.number} has no unlock count`);
    }
    const milestone = issue.milestone === null ? null : (milestonesByNumber.get(issue.milestone.number) ?? null);
    const reason = exclusionReason(issue, milestone, excluded);
    if (reason !== null) {
      exclusions[reason] += 1;
      continue;
    }
    const policy = readOutcomePolicy(milestone);
    const steering = steeringByNumber.get(milestone.number) ?? null;
    const lane = laneClass(issue);
    buckets[lane].push({
      milestone,
      entry: {
        rank: 0,
        issue: issue.number,
        nodeId: issue.id,
        title: issue.title,
        type: issue.issueType,
        laneClass: lane,
        ...action(issue, milestone),
        steered: steering !== null,
        milestone: { number: milestone.number, title: milestone.title, track: policy.track, order: policy.order },
        priority: priority(issue),
        dispatchRank: issue.dispatchRank,
        unlockCount: issue.unlockCount,
        boardStatus: issue.boardStatus,
        openPrs: issue.openPrs,
        readiness: "not-evaluated",
        readinessSource: null,
      },
    });
  }

  const classes = Object.fromEntries(
    LANE_CLASSES.map((name) => [
      name,
      buckets[name].sort(compareRanked).map(({ entry }, index) => ({ ...entry, rank: index + 1 })),
    ]),
  );
  const steering = [...steeringByNumber]
    .map(([number, policy]) => {
      const milestone = milestonesByNumber.get(number);
      const outcome = readOutcomePolicy(milestone);
      return {
        milestone: number,
        title: milestone.title,
        order: outcome.order,
        source: policy.source,
        until: policy.until,
      };
    })
    .sort((left, right) => left.order - right.order || left.milestone - right.milestone);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? facts.collectedAt ?? null,
    repository: facts.repository,
    excludedMilestones,
    collection: facts.collection,
    steering,
    defects: [...findOutcomeOrderTies(rankedMilestones), ...steeringDefects],
    classes,
    excluded: exclusions,
  };
}

function issueCommentUrl(repository, issue, comment) {
  return `https://github.com/${repository}/issues/${issue}#issuecomment-${comment.id}`;
}

function sameStringSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function receiptIsCurrent(receipt, issue, milestone, repository) {
  if (
    receipt.subject.repository !== repository ||
    receipt.subject.number !== issue.number ||
    receipt.subject.nodeId !== issue.id ||
    (issue.lastEditedAt !== null && Date.parse(issue.lastEditedAt) > Date.parse(receipt.subject.updatedAt))
  ) {
    return false;
  }
  if (!sameMilestoneRevision(receipt.facts.milestone, milestone)) return false;
  if (!sameStringSet(receipt.facts.labels, labelNames(issue))) return false;
  return (receipt.facts.issueType?.name ?? null) === issue.issueType;
}

function dependencyOnlyStale(receipt, issue) {
  const failures = receipt.checkedRules.filter((rule) => rule.status === "fail").map((rule) => rule.id);
  if (failures.length !== 1 || failures[0] !== "ready-00-dependencies-resolved") return false;
  if (!Array.isArray(receipt.facts.dependencies) || receipt.facts.dependencies.length === 0) return false;
  const current = new Map(issue.blockedBy.map((dependency) => [dependency.id, dependency.state]));
  return receipt.facts.dependencies.every(
    (dependency) => current.get(dependency.nodeId) === "CLOSED" || current.get(dependency.nodeId) === "closed",
  );
}

function classifyReadiness({ comments, complete, issue, milestone, repository }) {
  if (!complete) return { readiness: "unknown", readinessSource: null };
  const stable = stableBotComments(comments);
  if (stable.length !== 1) {
    return { readiness: stable.length === 0 ? "missing" : "unknown", readinessSource: null };
  }
  const comment = stable[0];
  const source = issueCommentUrl(repository, issue.number, comment);
  if (comment.body.includes("Current structural evaluation: unknown")) {
    return { readiness: "unknown", readinessSource: source };
  }
  const receipt = extractReceipt(comment.body);
  if (receipt === null) return { readiness: "unknown", readinessSource: source };
  if (!receiptIsCurrent(receipt, issue, milestone, repository)) {
    return { readiness: "stale", readinessSource: source };
  }
  if (receipt.status === "ready") return { readiness: "ready", readinessSource: source };
  if (receipt.status === "not-ready") {
    return {
      readiness: dependencyOnlyStale(receipt, issue) ? "stale" : "not-ready",
      readinessSource: source,
    };
  }
  return { readiness: "unknown", readinessSource: source };
}

async function collectReadinessComments(transport, repository, issueNumber) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    if (page > MAX_COMMENT_PAGES) {
      throw new NextWorkError("NEXT_WORK_FACTS_INCOMPLETE", "comments pagination exceeded 100 pages");
    }
    const batch = await transport.rest(
      `/repos/${repository.owner}/${repository.name}/issues/${issueNumber}/comments?per_page=${COMMENTS_PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(batch)) throw new NextWorkError("NEXT_WORK_REQUEST_FAILED", "comments response is not a list");
    comments.push(...batch.map(projectComment));
    if (batch.length < COMMENTS_PAGE_SIZE) return { comments, complete: true };
  }
}

/**
 * Attaches historical structural readiness to only the dispatchable frontier.
 * Comment authority is advisory: any failed or incomplete read becomes unknown.
 */
export async function attachReadiness(
  document,
  facts,
  {
    token,
    depth = DEFAULT_READINESS_DEPTH,
    fetchImplementation = globalThis.fetch,
    sleep,
    now,
    pageIntervalMs = PAGE_INTERVAL_MS,
  } = {},
) {
  const target = parseRepository(facts.repository);
  const transport = createTransport({
    fetchImplementation,
    token,
    sleep: sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
    now: now ?? Date.now,
    pageIntervalMs,
  });
  const milestones = new Map(facts.milestones.map((milestone) => [milestone.number, milestone]));
  const classes = Object.fromEntries(
    LANE_CLASSES.map((name) => [name, document.classes[name].map((entry) => ({ ...entry }))]),
  );
  const issues = new Map(facts.issues.map((issue) => [issue.number, issue]));
  for (const name of LANE_CLASSES) {
    for (const entry of classes[name].slice(0, depth)) {
      if (entry.action !== "implement") continue;
      const issue = issues.get(entry.issue);
      const milestone = milestones.get(entry.milestone.number) ?? null;
      let result;
      try {
        result = await collectReadinessComments(transport, target, entry.issue);
      } catch {
        result = { comments: [], complete: false };
      }
      const readiness = classifyReadiness({
        comments: result.comments,
        complete: result.complete,
        issue,
        milestone,
        repository: facts.repository,
      });
      entry.readiness = readiness.readiness;
      entry.readinessSource = readiness.readinessSource;
      if (entry.readiness === "not-ready") {
        entry.action = "planning-repair";
        entry.reasons = ["STRUCTURAL_NOT_READY"];
      } else if (["stale", "missing", "unknown"].includes(entry.readiness)) {
        entry.action = "readiness-check";
        entry.reasons = [];
      }
    }
  }
  return { ...document, classes };
}

// ---------------------------------------------------------------------------
// Collection (paced, read-only)
// ---------------------------------------------------------------------------

function retryAfterMs(response) {
  const raw = response.headers.get("retry-after");
  const seconds = raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : DEFAULT_RETRY_AFTER_SECONDS;
  return seconds * 1000;
}

function createTransport({ fetchImplementation, token, sleep, now, pageIntervalMs }) {
  let lastStart = null;
  const counters = { requests: 0 };

  async function send(url, init) {
    for (let waits = 0; ; waits += 1) {
      if (lastStart !== null) {
        const gap = lastStart + pageIntervalMs - now();
        if (gap > 0) await sleep(gap);
      }
      lastStart = now();
      counters.requests += 1;
      const response = await fetchImplementation(url, {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          ...init.headers,
        },
      });
      if (response.status === 403 || response.status === 429) {
        if (waits >= MAX_RATE_LIMIT_WAITS) {
          throw new NextWorkError("NEXT_WORK_RATE_LIMITED", `HTTP ${response.status} after ${waits} waits for ${url}`);
        }
        await sleep(retryAfterMs(response));
        continue;
      }
      if (!response.ok) throw new NextWorkError("NEXT_WORK_REQUEST_FAILED", `HTTP ${response.status} for ${url}`);
      try {
        return await response.json();
      } catch {
        throw new NextWorkError("NEXT_WORK_REQUEST_FAILED", `invalid JSON from ${url}`);
      }
    }
  }

  async function graphql(query, variables) {
    const payload = await send("https://api.github.com/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (payload?.errors !== undefined || payload?.data === undefined || payload.data === null) {
      const message = Array.isArray(payload?.errors) ? payload.errors.map((error) => error?.message).join("; ") : "";
      throw new NextWorkError("NEXT_WORK_REQUEST_FAILED", `GraphQL returned errors: ${message}`);
    }
    return payload.data;
  }

  async function rest(path) {
    return send(`https://api.github.com${path}`, { method: "GET", headers: {} });
  }

  return { graphql, rest, counters };
}

async function collectOpenMilestones(transport, repository) {
  const milestones = [];
  for (let page = 1; ; page += 1) {
    const batch = await transport.rest(
      `/repos/${repository.owner}/${repository.name}/milestones?state=open&per_page=${MILESTONE_PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(batch)) throw new NextWorkError("NEXT_WORK_REQUEST_FAILED", "milestones response is not a list");
    for (const milestone of batch) {
      milestones.push({
        id: milestone.node_id,
        number: milestone.number,
        title: milestone.title,
        description: milestone.description ?? null,
        state: milestone.state,
      });
    }
    if (batch.length < MILESTONE_PAGE_SIZE) return milestones;
  }
}

async function exhaustConnection(transport, issueId, name, connection) {
  const nodes = [...connection.nodes];
  let page = connection;
  while (page.pageInfo.hasNextPage) {
    const data = await transport.graphql(OVERFLOW_QUERIES[name], { issue: issueId, after: page.pageInfo.endCursor });
    if (data?.node?.id !== issueId || !data.node[name]) throw incomplete(`${name} overflow page for ${issueId}`);
    page = data.node[name];
    nodes.push(...page.nodes);
  }
  if (nodes.length !== page.totalCount) {
    throw incomplete(`${name} for ${issueId} collected ${nodes.length} of ${page.totalCount}`);
  }
  return nodes;
}

// These connections have no exported overflow query; a further page means the
// issue's facts are incomplete.
function boundedConnection(node, name) {
  const connection = node[name];
  if (connection.pageInfo.hasNextPage) {
    throw incomplete(
      `${name} for issue ${node.number} overflowed ${connection.nodes.length} of ${connection.totalCount}`,
    );
  }
  return connection.nodes;
}

async function normalizeIssue(transport, node, repository) {
  const boardItem = boundedConnection(node, "projectItems").find(
    (item) => item.project?.number === BOARD_PROJECT_NUMBER && item.project?.owner?.login === repository.owner,
  );
  const pullRequests = boundedConnection(node, "closedByPullRequestsReferences");
  const edge = ({ id, number, state, repository: target }) => ({
    id,
    number,
    state,
    repository: { nameWithOwner: target.nameWithOwner },
  });
  return {
    id: node.id,
    number: node.number,
    state: node.state,
    title: node.title,
    updatedAt: node.updatedAt,
    lastEditedAt: node.lastEditedAt,
    issueType: node.issueType?.name ?? null,
    milestone: node.milestone === null ? null : { ...node.milestone },
    parentNumber: node.parent?.number ?? null,
    labels: (await exhaustConnection(transport, node.id, "labels", node.labels)).map(({ id, name }) => ({ id, name })),
    blockedBy: (await exhaustConnection(transport, node.id, "blockedBy", node.blockedBy)).map(edge),
    blocking: (await exhaustConnection(transport, node.id, "blocking", node.blocking)).map(edge),
    openPrs: pullRequests
      .filter((pullRequest) => pullRequest.state === "OPEN")
      .map((pullRequest) => pullRequest.number)
      .sort((left, right) => left - right),
    dispatchRank: boardItem?.dispatchRank?.number ?? null,
    boardStatus: boardItem?.status?.name ?? null,
  };
}

/**
 * Builds the `dispatch-dependency-snapshot/v1` shape `reduceUnlockCounts`
 * reads, from the same normalized issues the ranking uses.
 */
export function buildDependencySnapshot(issues, nameWithOwner) {
  return {
    schemaVersion: "dispatch-dependency-snapshot/v1",
    repository: {
      nameWithOwner,
      totalCount: issues.length,
      issues: issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        state: issue.state,
        issueType: issue.issueType === null ? null : { name: issue.issueType },
        milestone: issue.milestone,
        labels: { totalCount: issue.labels.length, nodes: issue.labels },
        blocking: { totalCount: issue.blocking.length, nodes: issue.blocking },
        blockedBy: { totalCount: issue.blockedBy.length, nodes: issue.blockedBy },
      })),
    },
  };
}

async function collectAttempt(transport, repository) {
  const milestones = await collectOpenMilestones(transport, repository);
  const byId = new Map();
  let after = null;
  let totalCount = null;
  do {
    const data = await transport.graphql(ISSUES_QUERY, { owner: repository.owner, repository: repository.name, after });
    const page = data?.repository?.issues;
    if (!page || !Array.isArray(page.nodes)) throw incomplete("issues page is missing");
    totalCount = page.totalCount;
    for (const node of page.nodes) {
      if (node.state !== "OPEN") throw incomplete(`issue ${node.number} is not open`);
      byId.set(node.id, await normalizeIssue(transport, node, repository));
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after !== null);

  if (byId.size !== totalCount) throw incomplete(`collected ${byId.size} distinct issues of ${totalCount}`);
  const issues = [...byId.values()].sort((left, right) => left.number - right.number);
  let unlockCounts;
  try {
    unlockCounts = new Map(
      reduceUnlockCounts(buildDependencySnapshot(issues, repository.nameWithOwner)).map(({ issueId, unlockCount }) => [
        issueId,
        unlockCount,
      ]),
    );
  } catch (error) {
    throw incomplete(`unlock reducer failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { milestones, issues: issues.map((issue) => ({ ...issue, unlockCount: unlockCounts.get(issue.id) ?? 0 })) };
}

/**
 * Collects every fact the ranking needs in one paced pass, retrying the whole
 * pass once when it is incomplete. Read-only: it sends no mutation.
 */
export async function collectNextWorkFacts({
  token,
  repository = DEFAULT_REPOSITORY,
  fetchImplementation = globalThis.fetch,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now = Date.now,
  pageIntervalMs = PAGE_INTERVAL_MS,
} = {}) {
  const target = parseRepository(repository);
  const transport = createTransport({ fetchImplementation, token, sleep, now, pageIntervalMs });
  const startedAt = now();
  const failures = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const { milestones, issues } = await collectAttempt(transport, target);
      return {
        repository: target.nameWithOwner,
        collectedAt: new Date(now()).toISOString(),
        collection: {
          requests: transport.counters.requests,
          wallSeconds: Math.round((now() - startedAt) / 100) / 10,
        },
        milestones,
        issues,
      };
    } catch (error) {
      if (!(error instanceof NextWorkError) || error.code !== "NEXT_WORK_FACTS_INCOMPLETE") throw error;
      failures.push(error.message);
    }
  }
  throw incomplete(`two collections were incomplete: ${failures.join(" | ")}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  "usage: node scripts/next-work.mjs [--json <path>] [--top <n>] [--readiness-depth <n>] [--exclude-milestone <n,...>] [--check] [--repository <owner/name>]";

export function parseArguments(argv) {
  const options = {
    json: null,
    top: DEFAULT_TOP,
    readinessDepth: DEFAULT_READINESS_DEPTH,
    excludeMilestones: [],
    check: false,
    repository: DEFAULT_REPOSITORY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") {
      options.check = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      !["--json", "--top", "--readiness-depth", "--exclude-milestone", "--repository"].includes(flag) ||
      value === undefined
    ) {
      throw new NextWorkError("NEXT_WORK_USAGE", USAGE);
    }
    index += 1;
    if (flag === "--json") options.json = value;
    if (flag === "--repository") options.repository = parseRepository(value).nameWithOwner;
    if (flag === "--top") {
      if (!/^[1-9]\d*$/.test(value)) throw new NextWorkError("NEXT_WORK_USAGE", `--top must be a positive integer`);
      options.top = Number(value);
    }
    if (flag === "--readiness-depth") {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new NextWorkError("NEXT_WORK_USAGE", `--readiness-depth must be a positive integer`);
      options.readinessDepth = Number(value);
    }
    if (flag === "--exclude-milestone") {
      options.excludeMilestones = normalizeExcludedMilestones(
        value.split(",").map((part) => (/^\d+$/.test(part.trim()) ? Number(part.trim()) : Number.NaN)),
      );
    }
  }
  return options;
}

function formatEntry(entry) {
  const parts = [
    `${String(entry.rank).padStart(4)}. #${entry.issue}`,
    entry.action,
    `m${entry.milestone.number} order ${entry.milestone.order}`,
    `rank ${entry.dispatchRank ?? "-"}`,
    `p${entry.priority ?? "-"}`,
    `unlocks ${entry.unlockCount}`,
  ];
  if (entry.openPrs.length > 0) parts.push(`prs ${entry.openPrs.map((number) => `#${number}`).join(",")}`);
  parts.push(`readiness ${entry.readiness}`);
  parts.push(`readinessSource ${entry.readinessSource ?? "-"}`);
  return `${parts.join("  ")}  ${entry.title}`;
}

export function formatNextWorkText(document, top = DEFAULT_TOP) {
  const ranked = LANE_CLASSES.map((name) => document.classes[name].length);
  const excludedTotal = Object.values(document.excluded).reduce((sum, count) => sum + count, 0);
  const rankedTotal = ranked.reduce((sum, count) => sum + count, 0);
  const lines = [
    `${document.schemaVersion} ${document.repository} at ${document.generatedAt}`,
    `collection: requests=${document.collection.requests} wallSeconds=${document.collection.wallSeconds}`,
    `open issues: ${rankedTotal + excludedTotal} = ranked ${rankedTotal} (${LANE_CLASSES.map((name, index) => `${name} ${ranked[index]}`).join(", ")}) + excluded ${excludedTotal} (${EXCLUSION_REASONS.map((reason) => `${reason} ${document.excluded[reason]}`).join(", ")})`,
    `excluded milestones: ${document.excludedMilestones.length === 0 ? "none" : document.excludedMilestones.join(",")}`,
  ];
  for (const name of LANE_CLASSES) {
    const entries = document.classes[name];
    lines.push(`${name} (top ${Math.min(top, entries.length)} of ${entries.length}):`);
    for (const entry of entries.slice(0, top)) lines.push(formatEntry(entry));
  }
  lines.push(`defects: ${document.defects.length}`);
  for (const defect of document.defects) {
    const order = defect.order === undefined ? "" : ` order ${defect.order}`;
    lines.push(`  ${defect.code}${order}: ${defect.milestones.map((number) => `m${number}`).join(" ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function ghAuthToken() {
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 30_000 });
  const token = result.status === 0 ? result.stdout.trim() : "";
  if (token === "") throw new NextWorkError("NEXT_WORK_AUTH", "set GITHUB_TOKEN or sign in with gh auth login");
  return token;
}

/**
 * Exit codes: 0 ranked; 1 `--check` found defects; 2 usage, auth, request or
 * incomplete-facts failure (no file is written).
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  getToken = ghAuthToken,
  writeFile = (path, content) => writeFileSync(path, content, "utf8"),
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  collect = collectNextWorkFacts,
  readiness = attachReadiness,
  generatedAt,
} = {}) {
  try {
    const options = parseArguments(argv);
    const token = env.GITHUB_TOKEN || getToken();
    const facts = await collect({ token, repository: options.repository });
    const ranked = rankNextWork(facts, { excludeMilestones: options.excludeMilestones, generatedAt });
    const document = await readiness(ranked, facts, { token, depth: options.readinessDepth });
    if (options.json !== null) writeFile(options.json, `${JSON.stringify(document, null, 2)}\n`);
    stdout(formatNextWorkText(document, options.top));
    return options.check && document.defects.length > 0 ? 1 : 0;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}
