import { createHash } from "node:crypto";

const PAGE_SIZE = 100;
const SNAPSHOT_SCHEMA_VERSION = "dispatch-dependency-snapshot/v1";
const RESULT_SCHEMA_VERSION = "dispatch-dependency-facts/v1";
const NON_EXECUTABLE_MILESTONES = new Set(["Deferred / Incubation", "Operations"]);

export const ISSUES_QUERY = `
query DispatchDependencyIssues($owner:String!, $repository:String!, $after:String) {
  repository(owner:$owner, name:$repository) {
    nameWithOwner
    issues(states:OPEN, first:${PAGE_SIZE}, after:$after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        number
        state
        issueType { name }
        milestone { id number title state }
        labels(first:${PAGE_SIZE}) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { id name }
        }
        issueDependenciesSummary { blocking totalBlocking blockedBy totalBlockedBy }
        blocking(first:${PAGE_SIZE}) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { id number state repository { nameWithOwner } }
        }
        blockedBy(first:${PAGE_SIZE}) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { id number state repository { nameWithOwner } }
        }
      }
    }
  }
}`;

export const LABELS_QUERY = `
query DispatchDependencyLabels($issue:ID!, $after:String!) {
  node(id:$issue) {
    ... on Issue {
      id
      labels(first:${PAGE_SIZE}, after:$after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id name }
      }
    }
  }
}`;

export const BLOCKING_QUERY = `
query DispatchDependencyBlocking($issue:ID!, $after:String!) {
  node(id:$issue) {
    ... on Issue {
      id
      blocking(first:${PAGE_SIZE}, after:$after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id number state repository { nameWithOwner } }
      }
    }
  }
}`;

export const BLOCKED_BY_QUERY = `
query DispatchDependencyBlockedBy($issue:ID!, $after:String!) {
  node(id:$issue) {
    ... on Issue {
      id
      blockedBy(first:${PAGE_SIZE}, after:$after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id number state repository { nameWithOwner } }
      }
    }
  }
}`;

export const FAIL_CLOSED_GUARD_IDS = Object.freeze([
  "graphql-response-envelope",
  "closed-provider-object",
  "provider-scalar-domain",
  "root-repository-and-state",
  "page-size-bound",
  "safe-new-cursor",
  "stable-total-count",
  "unique-case-sensitive-identity",
  "exact-exhausted-count",
  "nested-parent-identity",
  "consistent-repeated-label-facts",
  "consistent-repeated-target-facts",
  "local-edge-root-closure",
  "consecutive-digest-stability",
  "accepted-snapshot-reducer-boundary",
]);

export class DispatchDependencySnapshotError extends Error {
  constructor(code, scope, detail, reason = code) {
    super(`[${code}:${scope}] ${detail}`);
    this.name = "DispatchDependencySnapshotError";
    this.code = code;
    this.scope = scope;
    this.reason = reason;
  }
}

function failSchema(scope, detail) {
  throw new DispatchDependencySnapshotError("invalid-provider-schema", scope, detail);
}

function failPagination(scope, reason, detail) {
  throw new DispatchDependencySnapshotError("pagination-truncates-authoritative-state", scope, detail, reason);
}

function failConsistency(scope, reason, detail) {
  throw new DispatchDependencySnapshotError("inconsistent-authority", scope, detail, reason);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactRecord(value, keys, scope) {
  if (!isRecord(value)) failSchema(scope, "expected an object");
  const expected = new Set(keys);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) failSchema(scope, `missing field ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) failSchema(scope, `unexpected field ${key}`);
  }
  return value;
}

function nonEmptyString(value, scope) {
  if (typeof value !== "string" || value.trim() === "") failSchema(scope, "expected a non-empty string");
  return value;
}

function positiveInteger(value, scope) {
  if (!Number.isSafeInteger(value) || value <= 0) failSchema(scope, "expected a positive safe integer");
  return value;
}

function nonNegativeInteger(value, scope) {
  if (!Number.isSafeInteger(value) || value < 0) failSchema(scope, "expected a non-negative safe integer");
  return value;
}

function issueState(value, scope) {
  if (value !== "OPEN" && value !== "CLOSED") failSchema(scope, 'expected "OPEN" or "CLOSED"');
  return value;
}

function nullableIssueType(value, scope) {
  if (value === null) return null;
  exactRecord(value, ["name"], scope);
  return { name: nonEmptyString(value.name, `${scope}.name`) };
}

function nullableMilestone(value, scope) {
  if (value === null) return null;
  exactRecord(value, ["id", "number", "title", "state"], scope);
  return {
    id: nonEmptyString(value.id, `${scope}.id`),
    number: positiveInteger(value.number, `${scope}.number`),
    title: nonEmptyString(value.title, `${scope}.title`),
    state: issueState(value.state, `${scope}.state`),
  };
}

function pageInfo(value, scope) {
  exactRecord(value, ["hasNextPage", "endCursor"], scope);
  if (typeof value.hasNextPage !== "boolean") failSchema(`${scope}.hasNextPage`, "expected a boolean");
  if (value.endCursor !== null) nonEmptyString(value.endCursor, `${scope}.endCursor`);
  return { hasNextPage: value.hasNextPage, endCursor: value.endCursor };
}

function labelNode(value, scope) {
  exactRecord(value, ["id", "name"], scope);
  return {
    id: nonEmptyString(value.id, `${scope}.id`),
    name: nonEmptyString(value.name, `${scope}.name`),
  };
}

function dependencyNode(value, scope) {
  exactRecord(value, ["id", "number", "state", "repository"], scope);
  exactRecord(value.repository, ["nameWithOwner"], `${scope}.repository`);
  return {
    id: nonEmptyString(value.id, `${scope}.id`),
    number: positiveInteger(value.number, `${scope}.number`),
    state: issueState(value.state, `${scope}.state`),
    repository: {
      nameWithOwner: nonEmptyString(value.repository.nameWithOwner, `${scope}.repository.nameWithOwner`),
    },
  };
}

function connectionPage(value, scope, nodeValidator) {
  exactRecord(value, ["totalCount", "pageInfo", "nodes"], scope);
  const totalCount = nonNegativeInteger(value.totalCount, `${scope}.totalCount`);
  const info = pageInfo(value.pageInfo, `${scope}.pageInfo`);
  if (!Array.isArray(value.nodes)) failSchema(`${scope}.nodes`, "expected an array");
  if (value.nodes.length > PAGE_SIZE) {
    failPagination(scope, "page-size-exceeded", `page returned ${value.nodes.length} nodes for first:${PAGE_SIZE}`);
  }
  const nodes = value.nodes.map((node, index) => nodeValidator(node, `${scope}.nodes[${index}]`));
  if (nodes.length > totalCount) {
    failPagination(scope, "exceeded-total-count", `page has ${nodes.length} nodes for totalCount ${totalCount}`);
  }
  return { totalCount, pageInfo: info, nodes };
}

function dependencySummary(value, scope) {
  exactRecord(value, ["blocking", "totalBlocking", "blockedBy", "totalBlockedBy"], scope);
  return {
    blocking: nonNegativeInteger(value.blocking, `${scope}.blocking`),
    totalBlocking: nonNegativeInteger(value.totalBlocking, `${scope}.totalBlocking`),
    blockedBy: nonNegativeInteger(value.blockedBy, `${scope}.blockedBy`),
    totalBlockedBy: nonNegativeInteger(value.totalBlockedBy, `${scope}.totalBlockedBy`),
  };
}

function issueNode(value, scope) {
  exactRecord(
    value,
    [
      "id",
      "number",
      "state",
      "issueType",
      "milestone",
      "labels",
      "issueDependenciesSummary",
      "blocking",
      "blockedBy",
    ],
    scope,
  );
  const state = issueState(value.state, `${scope}.state`);
  if (state !== "OPEN") failSchema(`${scope}.state`, "root collection returned a non-open issue");
  return {
    id: nonEmptyString(value.id, `${scope}.id`),
    number: positiveInteger(value.number, `${scope}.number`),
    state,
    issueType: nullableIssueType(value.issueType, `${scope}.issueType`),
    milestone: nullableMilestone(value.milestone, `${scope}.milestone`),
    labels: connectionPage(value.labels, `${scope}.labels`, labelNode),
    issueDependenciesSummary: dependencySummary(
      value.issueDependenciesSummary,
      `${scope}.issueDependenciesSummary`,
    ),
    blocking: connectionPage(value.blocking, `${scope}.blocking`, dependencyNode),
    blockedBy: connectionPage(value.blockedBy, `${scope}.blockedBy`, dependencyNode),
  };
}

function rootPage(value, expectedRepository) {
  exactRecord(value, ["repository"], "data");
  exactRecord(value.repository, ["nameWithOwner", "issues"], "data.repository");
  const nameWithOwner = nonEmptyString(value.repository.nameWithOwner, "data.repository.nameWithOwner");
  if (nameWithOwner !== expectedRepository) {
    failSchema("data.repository.nameWithOwner", `expected ${expectedRepository}, received ${nameWithOwner}`);
  }
  return {
    nameWithOwner,
    issues: connectionPage(value.repository.issues, "repository.issues", issueNode),
  };
}

function nestedPage(value, issueId, connectionName, nodeValidator) {
  exactRecord(value, ["node"], "data");
  exactRecord(value.node, ["id", connectionName], "data.node");
  const returnedId = nonEmptyString(value.node.id, "data.node.id");
  if (returnedId !== issueId) failSchema("data.node.id", `expected ${issueId}, received ${returnedId}`);
  return connectionPage(value.node[connectionName], `node.${connectionName}`, nodeValidator);
}

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nextCursor(connection, scope, seenCursors) {
  if (!connection.pageInfo.hasNextPage) return null;
  const cursor = connection.pageInfo.endCursor;
  if (typeof cursor !== "string" || cursor.trim() === "" || seenCursors.has(cursor)) {
    failPagination(scope, "unsafe-cursor", "hasNextPage requires a new non-empty cursor");
  }
  seenCursors.add(cursor);
  return cursor;
}

function appendUnique(target, nodes, seenIdentities, scope, totalCount, identityForNode) {
  for (const node of nodes) {
    const identity = identityForNode(node);
    if (seenIdentities.has(identity)) {
      failPagination(scope, "duplicate-node-identity", `duplicate node identity ${identity}`);
    }
    seenIdentities.add(identity);
    target.push(node);
  }
  if (target.length > totalCount) {
    failPagination(scope, "exceeded-total-count", `collected ${target.length} nodes for totalCount ${totalCount}`);
  }
}

async function invoke(request, query, variables, token) {
  let payload;
  try {
    payload = await request(query, variables, token);
  } catch (error) {
    if (error instanceof DispatchDependencySnapshotError) throw error;
    throw new DispatchDependencySnapshotError(
      "graphql-error",
      "request",
      error instanceof Error ? error.message : "GraphQL request failed",
    );
  }
  if (isRecord(payload) && Object.hasOwn(payload, "errors")) {
    throw new DispatchDependencySnapshotError("graphql-error", "response", "GraphQL returned errors");
  }
  exactRecord(payload, ["data"], "response");
  return payload.data;
}

async function exhaustNested({ firstPage, issueId, connectionName, query, nodeValidator, request, token }) {
  const scope = `${connectionName} for issue ${issueId}`;
  const totalCount = firstPage.totalCount;
  const nodes = [];
  const seenIdentities = new Set();
  const seenCursors = new Set();
  const identityForNode =
    connectionName === "labels"
      ? (node) => node.id
      : (node) => `${node.repository.nameWithOwner}\0${node.id}`;
  let page = firstPage;
  let requestCount = 0;

  appendUnique(nodes, page.nodes, seenIdentities, scope, totalCount, identityForNode);
  let cursor = nextCursor(page, scope, seenCursors);
  while (cursor !== null) {
    const data = await invoke(request, query, { issue: issueId, after: cursor }, token);
    requestCount += 1;
    page = nestedPage(data, issueId, connectionName, nodeValidator);
    if (page.totalCount !== totalCount) {
      failPagination(scope, "changed-total-count", `totalCount changed from ${totalCount} to ${page.totalCount}`);
    }
    appendUnique(nodes, page.nodes, seenIdentities, scope, totalCount, identityForNode);
    cursor = nextCursor(page, scope, seenCursors);
  }
  if (nodes.length !== totalCount) {
    failPagination(scope, "exhausted-count-mismatch", `collected ${nodes.length} of totalCount ${totalCount}`);
  }
  return { totalCount, nodes, requestCount };
}

function retainConsistentFact(facts, identity, fact, scope, reason) {
  const prior = facts.get(identity);
  if (prior === undefined) {
    facts.set(identity, fact);
    return;
  }
  if (JSON.stringify(prior) !== JSON.stringify(fact)) {
    failConsistency(scope, reason, `identity ${identity} repeated with inconsistent facts`);
  }
}

function canonicalIssue(issue, labels, blocking, blockedBy) {
  return {
    id: issue.id,
    number: issue.number,
    state: issue.state,
    issueType: issue.issueType,
    milestone: issue.milestone,
    labels: {
      totalCount: labels.totalCount,
      nodes: [...labels.nodes].sort((left, right) => ordinal(left.id, right.id) || ordinal(left.name, right.name)),
    },
    issueDependenciesSummary: issue.issueDependenciesSummary,
    blocking: {
      totalCount: blocking.totalCount,
      nodes: [...blocking.nodes].sort(
        (left, right) =>
          ordinal(left.repository.nameWithOwner, right.repository.nameWithOwner) ||
          ordinal(left.id, right.id) ||
          left.number - right.number,
      ),
    },
    blockedBy: {
      totalCount: blockedBy.totalCount,
      nodes: [...blockedBy.nodes].sort(
        (left, right) =>
          ordinal(left.repository.nameWithOwner, right.repository.nameWithOwner) ||
          ordinal(left.id, right.id) ||
          left.number - right.number,
      ),
    },
  };
}

function summaryDiagnostics(issues) {
  return issues.flatMap((issue) => {
    const summary = issue.issueDependenciesSummary;
    const connection = {
      blocking: issue.blocking.nodes.filter((edge) => edge.state === "OPEN").length,
      totalBlocking: issue.blocking.totalCount,
      blockedBy: issue.blockedBy.nodes.filter((edge) => edge.state === "OPEN").length,
      totalBlockedBy: issue.blockedBy.totalCount,
    };
    if (
      summary.blocking === connection.blocking &&
      summary.totalBlocking === connection.totalBlocking &&
      summary.blockedBy === connection.blockedBy &&
      summary.totalBlockedBy === connection.totalBlockedBy
    ) {
      return [];
    }
    return [{ issueId: issue.id, issueNumber: issue.number, connection, summary }];
  });
}

function assertLocalEdgeRootClosure(snapshot) {
  const byId = new Map(snapshot.repository.issues.map((issue) => [issue.id, issue]));
  for (const issue of snapshot.repository.issues) {
    for (const connectionName of ["blocking", "blockedBy"]) {
      for (const edge of issue[connectionName].nodes) {
        if (edge.repository.nameWithOwner !== snapshot.repository.nameWithOwner) continue;
        const local = byId.get(edge.id);
        if (edge.state === "OPEN") {
          if (!local || local.number !== edge.number) {
            failConsistency(
              `${connectionName} for issue ${issue.id}`,
              "referential-closure",
              `open local issue ${edge.id} did not join exactly to the open root collection`,
            );
          }
        } else if (local) {
          failConsistency(
            `${connectionName} for issue ${issue.id}`,
            "referential-closure",
            `closed local issue ${edge.id} also appeared in the open root collection`,
          );
        }
      }
    }
  }
}

async function collectCanonicalSnapshot({ request, owner, repository, token }) {
  const expectedRepository = `${owner}/${repository}`;
  const roots = [];
  const seenRootIds = new Set();
  const seenRootNumbers = new Set();
  const seenRootCursors = new Set();
  const labelFacts = new Map();
  const dependencyFacts = new Map();
  let totalCount = null;
  let after = null;
  let requestCount = 0;
  let rootPageCount = 0;
  let overflowRequestCount = 0;

  do {
    const data = await invoke(request, ISSUES_QUERY, { owner, repository, after }, token);
    requestCount += 1;
    rootPageCount += 1;
    const page = rootPage(data, expectedRepository).issues;
    totalCount ??= page.totalCount;
    if (page.totalCount !== totalCount) {
      failPagination("repository.issues", "changed-total-count", `totalCount changed from ${totalCount} to ${page.totalCount}`);
    }

    for (const issue of page.nodes) {
      if (seenRootIds.has(issue.id)) {
        failPagination("repository.issues", "duplicate-node-identity", `duplicate node identity ${issue.id}`);
      }
      if (seenRootNumbers.has(issue.number)) {
        failPagination("repository.issues", "duplicate-issue-number", `duplicate issue number ${issue.number}`);
      }
      seenRootIds.add(issue.id);
      seenRootNumbers.add(issue.number);

      const labels = await exhaustNested({
        firstPage: issue.labels,
        issueId: issue.id,
        connectionName: "labels",
        query: LABELS_QUERY,
        nodeValidator: labelNode,
        request,
        token,
      });
      const blocking = await exhaustNested({
        firstPage: issue.blocking,
        issueId: issue.id,
        connectionName: "blocking",
        query: BLOCKING_QUERY,
        nodeValidator: dependencyNode,
        request,
        token,
      });
      const blockedBy = await exhaustNested({
        firstPage: issue.blockedBy,
        issueId: issue.id,
        connectionName: "blockedBy",
        query: BLOCKED_BY_QUERY,
        nodeValidator: dependencyNode,
        request,
        token,
      });
      overflowRequestCount += labels.requestCount + blocking.requestCount + blockedBy.requestCount;
      requestCount += labels.requestCount + blocking.requestCount + blockedBy.requestCount;

      for (const label of labels.nodes) {
        retainConsistentFact(labelFacts, label.id, { name: label.name }, `labels for issue ${issue.id}`, "repeated-label-facts");
      }
      for (const connection of [blocking, blockedBy]) {
        for (const edge of connection.nodes) {
          const identity = `${edge.repository.nameWithOwner}\0${edge.id}`;
          retainConsistentFact(
            dependencyFacts,
            identity,
            { number: edge.number, state: edge.state },
            `dependencies for issue ${issue.id}`,
            "repeated-target-facts",
          );
        }
      }
      retainConsistentFact(
        dependencyFacts,
        `${expectedRepository}\0${issue.id}`,
        { number: issue.number, state: issue.state },
        `root issue ${issue.id}`,
        "repeated-target-facts",
      );
      roots.push(canonicalIssue(issue, labels, blocking, blockedBy));
    }

    after = nextCursor(page, "repository.issues", seenRootCursors);
  } while (after !== null);

  if (roots.length !== totalCount) {
    failPagination("repository.issues", "exhausted-count-mismatch", `collected ${roots.length} of totalCount ${totalCount}`);
  }

  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    repository: {
      nameWithOwner: expectedRepository,
      totalCount,
      issues: roots.sort((left, right) => ordinal(left.id, right.id)),
    },
  };
  assertLocalEdgeRootClosure(snapshot);
  const serialized = JSON.stringify(snapshot);
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
  return {
    snapshot,
    digest,
    diagnostics: { summaryMismatches: summaryDiagnostics(snapshot.repository.issues) },
    requestCount,
    rootPageCount,
    overflowRequestCount,
  };
}

function predicateInput(value, keys, scope) {
  exactRecord(value, keys, scope);
  if (!Array.isArray(value.labels) || value.labels.some((label) => typeof label !== "string" || label.trim() === "")) {
    throw new TypeError(`${scope}.labels must be a complete array of non-empty strings`);
  }
  return value;
}

export function isLocalEpic(value) {
  predicateInput(value, ["issueTypeName", "labels"], "isLocalEpic");
  if (value.issueTypeName !== null && (typeof value.issueTypeName !== "string" || value.issueTypeName.trim() === "")) {
    throw new TypeError("isLocalEpic.issueTypeName must be a non-empty string or null");
  }
  if (value.issueTypeName !== null) return value.issueTypeName === "Epic";
  return value.labels.includes("kind:epic");
}

export function isLocalTrackingOnly(value) {
  predicateInput(value, ["labels"], "isLocalTrackingOnly");
  return value.labels.includes("status:tracking-only");
}

function snapshotIssues(snapshot) {
  if (
    !isRecord(snapshot) ||
    snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    !isRecord(snapshot.repository) ||
    !Array.isArray(snapshot.repository.issues)
  ) {
    throw new TypeError(`snapshot must use ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  return snapshot.repository.issues;
}

function classification(issue) {
  const labels = issue.labels.nodes.map((label) => label.name);
  return {
    epic: isLocalEpic({ issueTypeName: issue.issueType?.name ?? null, labels }),
    trackingOnly: isLocalTrackingOnly({ labels }),
  };
}

function contributes(issue, kind) {
  return (
    issue.state === "OPEN" &&
    !kind.epic &&
    !kind.trackingOnly &&
    (issue.milestone === null || !NON_EXECUTABLE_MILESTONES.has(issue.milestone.title))
  );
}

export function reduceUnlockCounts(snapshot) {
  const issues = snapshotIssues(snapshot);
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const kinds = new Map(issues.map((issue) => [issue.id, classification(issue)]));
  const counts = [];

  for (const source of issues) {
    if (kinds.get(source.id).epic) continue;
    const visited = new Set([source.id]);
    const pending = [...source.blocking.nodes];
    let unlockCount = 0;

    while (pending.length > 0) {
      const edge = pending.pop();
      if (edge.repository.nameWithOwner !== snapshot.repository.nameWithOwner || edge.state !== "OPEN") continue;
      if (visited.has(edge.id)) continue;
      const target = byId.get(edge.id);
      if (!target) {
        failConsistency(
          `unlock reducer source ${source.id}`,
          "referential-closure",
          `open local target ${edge.id} did not join to the root collection`,
        );
      }
      visited.add(edge.id);
      if (contributes(target, kinds.get(target.id))) unlockCount += 1;
      pending.push(...target.blocking.nodes);
    }
    counts.push({ issueId: source.id, issueNumber: source.number, unlockCount });
  }
  return counts.sort((left, right) => left.issueNumber - right.issueNumber || ordinal(left.issueId, right.issueId));
}

export function reduceOpenBlockerFacts(snapshot) {
  const issues = snapshotIssues(snapshot);
  return issues
    .map((issue) => {
      const openBlockers = issue.blockedBy.nodes
        .filter((edge) => edge.state === "OPEN")
        .map((edge) => ({
          id: edge.id,
          number: edge.number,
          repository: { nameWithOwner: edge.repository.nameWithOwner },
        }));
      return {
        issueId: issue.id,
        issueNumber: issue.number,
        openBlockerCount: openBlockers.length,
        openBlockers,
      };
    })
    .sort((left, right) => left.issueNumber - right.issueNumber || ordinal(left.issueId, right.issueId));
}

function acceptedResult(current, attempts, totals, unlockReducer, blockerReducer) {
  const unlockCounts = unlockReducer(current.snapshot);
  const blockerFacts = blockerReducer(current.snapshot);
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    digest: current.digest,
    attempts,
    requestCount: totals.requestCount,
    rootPageCount: totals.rootPageCount,
    overflowRequestCount: totals.overflowRequestCount,
    unlockCounts,
    blockerFacts,
    diagnostics: current.diagnostics,
  };
}

export async function collectStableDependencyFacts({
  request,
  owner,
  repository,
  token,
  unlockReducer = reduceUnlockCounts,
  blockerReducer = reduceOpenBlockerFacts,
} = {}) {
  if (typeof request !== "function") throw new TypeError("request must be a function");
  nonEmptyString(owner, "owner");
  nonEmptyString(repository, "repository");
  if (typeof unlockReducer !== "function") throw new TypeError("unlockReducer must be a function");
  if (typeof blockerReducer !== "function") throw new TypeError("blockerReducer must be a function");

  let previous = await collectCanonicalSnapshot({ request, owner, repository, token });
  const totals = {
    requestCount: previous.requestCount,
    rootPageCount: previous.rootPageCount,
    overflowRequestCount: previous.overflowRequestCount,
  };

  for (let attempt = 2; attempt <= 3; attempt += 1) {
    const current = await collectCanonicalSnapshot({ request, owner, repository, token });
    totals.requestCount += current.requestCount;
    totals.rootPageCount += current.rootPageCount;
    totals.overflowRequestCount += current.overflowRequestCount;
    if (previous.digest === current.digest) {
      return acceptedResult(current, attempt, totals, unlockReducer, blockerReducer);
    }
    previous = current;
  }

  throw new DispatchDependencySnapshotError(
    "unstable-authority",
    "repository.issues",
    "three complete collections produced no consecutive matching snapshot digests",
  );
}

export async function githubGraphql(query, variables, token, fetchImplementation = globalThis.fetch) {
  if (typeof fetchImplementation !== "function") throw new TypeError("fetchImplementation must be a function");
  const response = await fetchImplementation("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new DispatchDependencySnapshotError("graphql-error", "response", "GraphQL returned invalid JSON");
  }
  if (!response.ok || !isRecord(payload) || Object.hasOwn(payload, "errors") || !Object.hasOwn(payload, "data")) {
    throw new DispatchDependencySnapshotError("graphql-error", "response", `GraphQL failed with status ${response.status}`);
  }
  return payload;
}
