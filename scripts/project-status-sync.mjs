import process from "node:process";
import { classified, isEpic as classifiedEpic, isTrackingOnly } from "./backlog-classify.mjs";

// Recomputes the delivery board's Status and Target date fields from facts that
// already exist on each issue. Collection is deliberately completed and
// reconciled before the first write: partial board state must never drive a
// partial synchronization.

export const DERIVED_STATUSES = Object.freeze(["Backlog", "Refined", "Blocked"]);
export const NON_EXECUTABLE_MILESTONES = Object.freeze(["Deferred / Incubation", "Operations"]);
export const REQUIRED_STATUS_OPTIONS = Object.freeze(["Backlog", "Refined", "Blocked"]);

export class ProjectStatusSyncConfigurationError extends Error {
  constructor(variable, detail) {
    super(`[configuration:${variable}] ${detail}`);
    this.name = "ProjectStatusSyncConfigurationError";
    this.variable = variable;
  }
}

export class ProjectStatusSyncCollectionError extends Error {
  constructor(scope, detail, { collected, totalCount } = {}) {
    const countDetail =
      Number.isInteger(collected) && Number.isInteger(totalCount)
        ? `aborted: collected ${collected} of totalCount ${totalCount} for ${scope}`
        : `aborted: completeness could not be established for ${scope}`;
    super(`[collection:${scope}] ${countDetail}: ${detail}`);
    this.name = "ProjectStatusSyncCollectionError";
    this.scope = scope;
    this.collected = collected;
    this.totalCount = totalCount;
  }
}

function requiredValue(env, variable) {
  const value = env[variable];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProjectStatusSyncConfigurationError(variable, "a non-empty value is required");
  }
  return value.trim();
}

export function readConfiguration(env = process.env) {
  const token = requiredValue(env, "GITHUB_TOKEN");
  const project = requiredValue(env, "PROJECT_ID");
  const statusFieldId = requiredValue(env, "STATUS_FIELD_ID");
  const optionsRaw = requiredValue(env, "STATUS_OPTION_IDS");
  const dateFieldId = requiredValue(env, "TARGET_DATE_FIELD_ID");

  let optionIds;
  try {
    optionIds = JSON.parse(optionsRaw);
  } catch (error) {
    throw new ProjectStatusSyncConfigurationError(
      "STATUS_OPTION_IDS",
      `must be valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (optionIds === null || typeof optionIds !== "object" || Array.isArray(optionIds)) {
    throw new ProjectStatusSyncConfigurationError("STATUS_OPTION_IDS", "must be a JSON object");
  }
  for (const status of REQUIRED_STATUS_OPTIONS) {
    if (typeof optionIds[status] !== "string" || optionIds[status].trim() === "") {
      throw new ProjectStatusSyncConfigurationError(
        "STATUS_OPTION_IDS",
        `must contain a non-empty option id for ${status}`,
      );
    }
    optionIds[status] = optionIds[status].trim();
  }

  return { token, project, statusFieldId, optionIds, dateFieldId };
}

export function toBacklogInput(issue) {
  const issueTypeName = Object.hasOwn(issue, "issueTypeName")
    ? issue.issueTypeName
    : (issue.type?.name ?? issue.issueType?.name ?? null);
  const blockedByCount = Object.hasOwn(issue, "blockedByCount") ? issue.blockedByCount : issue.blockedBy;
  const hasParent = Object.hasOwn(issue, "hasParent")
    ? issue.hasParent
    : Object.hasOwn(issue, "parent")
      ? issue.parent !== null
      : undefined;

  return {
    number: issue.number,
    state: typeof issue.state === "string" ? issue.state.toLowerCase() : issue.state,
    labels: Array.isArray(issue.labels) ? issue.labels.map((label) => label.name ?? label) : issue.labels,
    issueTypeName,
    milestoneTitle: issue.milestone?.title ?? null,
    blockedByCount,
    hasParent,
  };
}

// Kept as a caller-facing compatibility seam; the decision itself lives in
// backlog-classify.mjs.
export function isEpic(issue) {
  return classifiedEpic(toBacklogInput(issue));
}

export function deriveStatus(issue) {
  const input = toBacklogInput(issue);
  if (classifiedEpic(input)) return null;
  if (isTrackingOnly(input)) return null;
  if (input.blockedByCount > 0) return "Blocked";
  return classified(input) ? "Refined" : "Backlog";
}

// GitHub's Roadmap layout cannot plot the built-in Milestone field, so the
// board carries a Date field derived only from the milestone's due date.
export function deriveTargetDate(issue) {
  const dueOn = issue.milestone?.dueOn ?? issue.milestone?.due_on ?? null;
  return dueOn ? String(dueOn).slice(0, 10) : null;
}

export function planDateUpdates(items) {
  const updates = [];
  for (const item of items) {
    const next = deriveTargetDate(item.issue);
    if (next === item.targetDate || (next === null && item.targetDate === null)) continue;
    if (next === null) {
      updates.push({
        type: "clear",
        itemId: item.itemId,
        number: item.issue.number,
        from: item.targetDate,
        to: null,
      });
      continue;
    }
    updates.push({
      type: "set",
      itemId: item.itemId,
      number: item.issue.number,
      from: item.targetDate,
      to: next,
    });
  }
  return updates;
}

export function planStatusUpdates(items) {
  const updates = [];
  for (const item of items) {
    if (toBacklogInput(item.issue).state === "closed") continue;
    const next = deriveStatus(item.issue);
    if (next === null) continue;
    // Lane states (In lane / In review / Landed) have a different owner.
    if (item.status && !DERIVED_STATUSES.includes(item.status)) continue;
    if (item.status === next) continue;
    updates.push({ itemId: item.itemId, number: item.issue.number, from: item.status, to: next });
  }
  return updates;
}

export async function graphql(query, variables, token, fetchImplementation = globalThis.fetch) {
  const response = await fetchImplementation("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(`GraphQL failed: ${response.status} ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return payload.data;
}

export const ITEMS_QUERY = `
query($project:ID!, $after:String) {
  node(id:$project) {
    ... on ProjectV2 {
      items(first:100, after:$after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          status: fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          targetDate: fieldValueByName(name:"Target date") { ... on ProjectV2ItemFieldDateValue { date } }
          content {
            ... on Issue {
              id
              number
              state
              issueType { name }
              parent { number }
              milestone { title dueOn }
              labels(first:30) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes { id name }
              }
              issueDependenciesSummary { blockedBy }
            }
          }
        }
      }
    }
  }
}`;

export const LABELS_QUERY = `
query($issue:ID!, $after:String!) {
  node(id:$issue) {
    ... on Issue {
      labels(first:30, after:$after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id name }
      }
    }
  }
}`;

const UPDATE_STATUS_MUTATION = `
mutation ($p: ID!, $i: ID!, $f: ID!, $o: String!) {
  updateProjectV2ItemFieldValue(
    input: { projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }
  ) {
    projectV2Item { id }
  }
}`;

const SET_TARGET_DATE_MUTATION = `
mutation ($p: ID!, $i: ID!, $f: ID!, $d: Date!) {
  updateProjectV2ItemFieldValue(
    input: { projectId: $p, itemId: $i, fieldId: $f, value: { date: $d } }
  ) {
    projectV2Item { id }
  }
}`;

const CLEAR_TARGET_DATE_MUTATION = `
mutation ($p: ID!, $i: ID!, $f: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f }) {
    projectV2Item { id }
  }
}`;

function connectionPage(connection, scope, priorTotalCount) {
  if (connection === null || typeof connection !== "object") {
    throw new ProjectStatusSyncCollectionError(scope, "connection is absent");
  }
  if (!Number.isInteger(connection.totalCount) || connection.totalCount < 0) {
    throw new ProjectStatusSyncCollectionError(scope, "totalCount is absent or invalid");
  }
  if (priorTotalCount !== null && connection.totalCount !== priorTotalCount) {
    throw new ProjectStatusSyncCollectionError(scope, "totalCount changed while paginating", {
      collected: 0,
      totalCount: priorTotalCount,
    });
  }
  if (!Array.isArray(connection.nodes)) {
    throw new ProjectStatusSyncCollectionError(scope, "nodes is absent or invalid", {
      collected: 0,
      totalCount: connection.totalCount,
    });
  }
  if (
    connection.pageInfo === null ||
    typeof connection.pageInfo !== "object" ||
    typeof connection.pageInfo.hasNextPage !== "boolean"
  ) {
    throw new ProjectStatusSyncCollectionError(scope, "pageInfo is absent or invalid", {
      collected: connection.nodes.length,
      totalCount: connection.totalCount,
    });
  }
  return connection;
}

function nextCursor(connection, scope, seenCursors, collected) {
  if (!connection.pageInfo.hasNextPage) return null;
  const cursor = connection.pageInfo.endCursor;
  if (typeof cursor !== "string" || cursor.trim() === "" || seenCursors.has(cursor)) {
    throw new ProjectStatusSyncCollectionError(scope, "hasNextPage was true without a new safe cursor", {
      collected,
      totalCount: connection.totalCount,
    });
  }
  seenCursors.add(cursor);
  return cursor;
}

function appendUniqueNodes(target, nodes, seenNodeKeys, scope, totalCount, keyForNode) {
  for (const node of nodes) {
    const key = keyForNode(node);
    if (typeof key !== "string" || key === "" || seenNodeKeys.has(key)) {
      throw new ProjectStatusSyncCollectionError(scope, "a page contained an absent or duplicate node identity", {
        collected: target.length,
        totalCount,
      });
    }
    seenNodeKeys.add(key);
    target.push(node);
  }
  if (target.length > totalCount) {
    throw new ProjectStatusSyncCollectionError(scope, "collected count exceeded totalCount", {
      collected: target.length,
      totalCount,
    });
  }
}

async function collectLabels(node, { request, token }) {
  const scope = `labels for issue #${node.content.number}`;
  let connection = connectionPage(node.content.labels, scope, null);
  const totalCount = connection.totalCount;
  const labels = [];
  const seenLabels = new Set();
  const seenCursors = new Set();
  appendUniqueNodes(labels, connection.nodes, seenLabels, scope, totalCount, (label) => label?.id ?? label?.name);

  let after = nextCursor(connection, scope, seenCursors, labels.length);
  while (after !== null) {
    if (typeof node.content.id !== "string" || node.content.id === "") {
      throw new ProjectStatusSyncCollectionError(scope, "the issue node id required for pagination is absent", {
        collected: labels.length,
        totalCount,
      });
    }
    const data = await request(LABELS_QUERY, { issue: node.content.id, after }, token);
    connection = connectionPage(data?.node?.labels, scope, totalCount);
    appendUniqueNodes(labels, connection.nodes, seenLabels, scope, totalCount, (label) => label?.id ?? label?.name);
    after = nextCursor(connection, scope, seenCursors, labels.length);
  }

  if (labels.length !== totalCount) {
    throw new ProjectStatusSyncCollectionError(scope, "the exhausted connection count did not match totalCount", {
      collected: labels.length,
      totalCount,
    });
  }
  return labels.map((label) => label.name);
}

export function projectItemFromNode(node, completeLabels) {
  if (!node.content?.number) return null;
  const labels =
    completeLabels ??
    node.content.labels?.nodes?.map((label) => {
      return label.name;
    });
  return {
    itemId: node.id,
    status: node.status?.name ?? null,
    targetDate: node.targetDate?.date ? String(node.targetDate.date).slice(0, 10) : null,
    issue: {
      number: node.content.number,
      state: typeof node.content.state === "string" ? node.content.state.toLowerCase() : node.content.state,
      issueTypeName: Object.hasOwn(node.content, "issueType") ? (node.content.issueType?.name ?? null) : undefined,
      milestone: node.content.milestone,
      labels,
      blockedByCount: node.content.issueDependenciesSummary?.blockedBy,
      hasParent: node.content.parent === undefined ? undefined : node.content.parent !== null,
    },
  };
}

export async function collectProjectItems({ request = graphql, project, token }) {
  const scope = "project items";
  const nodes = [];
  const seenNodes = new Set();
  const seenCursors = new Set();
  let totalCount = null;
  let after = null;

  do {
    const data = await request(ITEMS_QUERY, { project, after }, token);
    const connection = connectionPage(data?.node?.items, scope, totalCount);
    totalCount ??= connection.totalCount;
    appendUniqueNodes(nodes, connection.nodes, seenNodes, scope, totalCount, (node) => node?.id);
    after = nextCursor(connection, scope, seenCursors, nodes.length);
  } while (after !== null);

  if (nodes.length !== totalCount) {
    throw new ProjectStatusSyncCollectionError(scope, "the exhausted connection count did not match totalCount", {
      collected: nodes.length,
      totalCount,
    });
  }

  const items = [];
  for (const node of nodes) {
    if (!node.content?.number) continue;
    const labels = await collectLabels(node, { request, token });
    const item = projectItemFromNode(node, labels);
    if (item) items.push(item);
  }
  return { items, totalCount };
}

function display(value) {
  return value ?? "(none)";
}

export async function main({ env = process.env, request = graphql, logger = console, dryRun = false } = {}) {
  const { token, project, statusFieldId, optionIds, dateFieldId } = readConfiguration(env);
  const { items, totalCount } = await collectProjectItems({ request, project, token });
  const statusUpdates = planStatusUpdates(items);
  const dateUpdates = planDateUpdates(items);

  logger.log(
    `${dryRun ? "DRY RUN: " : ""}${totalCount} project items verified; ${items.length} issue items scanned; ` +
      `${statusUpdates.length} status changes; ${dateUpdates.length} target-date changes.`,
  );

  for (const update of statusUpdates) {
    if (!dryRun) {
      await request(
        UPDATE_STATUS_MUTATION,
        { p: project, i: update.itemId, f: statusFieldId, o: optionIds[update.to] },
        token,
      );
    }
    logger.log(`  status #${update.number}: ${display(update.from)} -> ${update.to}`);
  }

  for (const update of dateUpdates) {
    if (!dryRun) {
      if (update.type === "set") {
        await request(SET_TARGET_DATE_MUTATION, { p: project, i: update.itemId, f: dateFieldId, d: update.to }, token);
      } else {
        await request(CLEAR_TARGET_DATE_MUTATION, { p: project, i: update.itemId, f: dateFieldId }, token);
      }
    }
    logger.log(`  target-date:${update.type} #${update.number}: ${display(update.from)} -> ${display(update.to)}`);
  }

  return { totalCount, issueCount: items.length, statusUpdates, dateUpdates, dryRun };
}

if (process.argv[1] && process.argv[1].endsWith("project-status-sync.mjs")) {
  try {
    await main({ dryRun: process.argv.slice(2).includes("--dry-run") });
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}
