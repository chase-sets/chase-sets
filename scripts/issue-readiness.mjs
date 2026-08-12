import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { classified } from "./backlog-classify.mjs";
import { canonicalLabelNames, ENABLED_NATIVE_ISSUE_TYPES } from "./label-registry.mjs";

export const ISSUE_READINESS_SCHEMA_VERSION = "issue-readiness/v1";
export const ISSUE_READINESS_RUN_SCHEMA_VERSION = "issue-readiness-run/v1";
export const PROSPECTIVE_ISSUE_READINESS_RUN_SCHEMA_VERSION = "prospective-issue-readiness-run/v1";
export const COMMENT_MARKER = "<!-- chase-sets:issue-readiness:v1 -->";
export const RECEIPT_START_MARKER = "<!-- chase-sets:issue-readiness-receipt:start -->";
export const RECEIPT_END_MARKER = "<!-- chase-sets:issue-readiness-receipt:end -->";

export const ISSUE_READINESS_RULES = Object.freeze([
  Object.freeze({ id: "ready-00-placed-classified", standardItem: 0 }),
  Object.freeze({ id: "ready-00-dependencies-resolved", standardItem: 0 }),
  Object.freeze({ id: "ready-01-repo-evidence", standardItem: 1 }),
  Object.freeze({ id: "ready-02-explicit-non-goal", standardItem: 2 }),
  Object.freeze({ id: "ready-03-acceptance-evidence", standardItem: 3 }),
  Object.freeze({ id: "ready-04-runnable-verification", standardItem: 4 }),
  Object.freeze({ id: "ready-05-footprint-operators", standardItem: 5 }),
  Object.freeze({ id: "ready-06-decisions-resolved", standardItem: 6 }),
  Object.freeze({ id: "ready-07-terms-declared", standardItem: 7 }),
  Object.freeze({ id: "ready-08-authority-probe-timed", standardItem: 8 }),
  Object.freeze({ id: "ready-09-review-packet", standardItem: 9 }),
]);

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const BOT_LOGIN = "github-actions[bot]";
const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;
const MAX_DEPENDENCIES = 200;
const NO_RESPONSE = "_no response_";
const NON_RUNNABLE_LABELS = new Set(
  canonicalLabelNames("status").filter((label) => /status:(?:needs-replan|tracking-only)$/.test(label)),
);
const REQUIRED_FIELDS = Object.freeze([
  "Context",
  "Scope fence",
  "Decisions already made",
  "Acceptance criteria",
  "Verification plan",
  "Footprint & chain",
  "Operator actions",
  "Glossary impact",
  "External authority probe & evidence timing",
  "Review packet seed",
  "Tier + routing hint",
]);
const RULE_BY_ID = new Map(ISSUE_READINESS_RULES.map((rule) => [rule.id, rule]));
const COMMAND_PREFIX = /^(?:pnpm|npm|npx|node|gh|git|pwsh|powershell|docker|kubectl|helm|terraform|curl)\b/i;
const REPO_POINTER =
  /(?:\.github|\.agents|\.claude|bounded-contexts|contracts|deployables|docs|infrastructure|packages|scripts)\/[\w./*-]+|(?:[\w.-]+\/)+[\w.*-]+\.(?:mjs|cjs|js|ts|tsx|json|ya?ml|md)/g;

const AUTHORITY_QUERY = `
query IssueReadinessAuthority($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    databaseId
    issue(number: $number) {
      id
      number
      state
      updatedAt
      issueType { id name isEnabled }
      parent { number }
      labels(first: 1) { totalCount pageInfo { hasNextPage endCursor } }
      blockedBy(first: 1) { totalCount pageInfo { hasNextPage endCursor } }
      comments(first: 1) { totalCount pageInfo { hasNextPage endCursor } }
    }
  }
}`;

export class IssueReadinessBoundaryError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "IssueReadinessBoundaryError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) {
  throw new IssueReadinessBoundaryError(code, details);
}

function responseHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": API_VERSION,
  };
}

function validTimestamp(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

async function readJson(response, code) {
  if (!response?.ok) fail(code);
  try {
    return await response.json();
  } catch {
    fail(code);
  }
}

function splitRepository(repository) {
  const match = String(repository ?? "").match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) fail("REPOSITORY_INVALID");
  return { owner: match[1], repo: match[2] };
}

function issueUrl(repository, number) {
  return `${API_ORIGIN}/repos/${repository}/issues/${number}`;
}

function projectIssue(raw, repository, expectedNumber) {
  if (
    !raw ||
    typeof raw !== "object" ||
    raw.node_id == null ||
    typeof raw.node_id !== "string" ||
    raw.number !== expectedNumber ||
    !["open", "closed"].includes(raw.state) ||
    !validTimestamp(raw.updated_at) ||
    !nonNegativeInteger(raw.comments) ||
    !raw.issue_dependencies_summary ||
    !nonNegativeInteger(raw.issue_dependencies_summary.blocked_by) ||
    !nonNegativeInteger(raw.issue_dependencies_summary.total_blocked_by)
  ) {
    fail("ISSUE_SHAPE_INVALID");
  }
  if (raw.repository !== null && raw.repository !== undefined && raw.repository?.full_name !== repository) {
    fail("ISSUE_MOVED");
  }
  if (raw.body !== null && typeof raw.body !== "string") fail("ISSUE_BODY_INVALID");
  if (
    raw.type !== null &&
    (typeof raw.type !== "object" ||
      typeof raw.type.name !== "string" ||
      typeof raw.type.node_id !== "string" ||
      typeof raw.type.is_enabled !== "boolean")
  ) {
    fail("ISSUE_TYPE_SHAPE_INVALID");
  }
  if (
    raw.milestone !== null &&
    (typeof raw.milestone !== "object" ||
      typeof raw.milestone.title !== "string" ||
      !nonNegativeInteger(raw.milestone.number) ||
      !["open", "closed"].includes(raw.milestone.state))
  ) {
    fail("ISSUE_MILESTONE_SHAPE_INVALID");
  }
  return {
    nodeId: raw.node_id,
    number: raw.number,
    state: raw.state,
    updatedAt: raw.updated_at,
    body: raw.body ?? "",
    issueType: raw.type ? { nodeId: raw.type.node_id, name: raw.type.name, isEnabled: raw.type.is_enabled } : null,
    milestone: raw.milestone
      ? { number: raw.milestone.number, title: raw.milestone.title, state: raw.milestone.state }
      : null,
    commentsTotal: raw.comments,
    dependenciesTotal: raw.issue_dependencies_summary.total_blocked_by,
    openDependenciesTotal: raw.issue_dependencies_summary.blocked_by,
  };
}

function projectGraphAuthority(raw, repository, expectedNumber) {
  if (Array.isArray(raw?.errors) && raw.errors.length > 0) fail("GRAPH_AUTHORITY_ERRORS");
  const { owner, repo } = splitRepository(repository);
  const repositoryNode = raw?.data?.repository;
  const issue = repositoryNode?.issue;
  if (
    !repositoryNode ||
    !nonNegativeInteger(repositoryNode.databaseId) ||
    !issue ||
    typeof issue.id !== "string" ||
    issue.number !== expectedNumber ||
    !["OPEN", "CLOSED"].includes(issue.state) ||
    !validTimestamp(issue.updatedAt) ||
    !issue.labels ||
    !issue.blockedBy ||
    !issue.comments ||
    !nonNegativeInteger(issue.labels.totalCount) ||
    !nonNegativeInteger(issue.blockedBy.totalCount) ||
    !nonNegativeInteger(issue.comments.totalCount)
  ) {
    fail("GRAPH_AUTHORITY_SHAPE_INVALID");
  }
  if (issue.parent !== null && (!issue.parent || !Number.isInteger(issue.parent.number) || issue.parent.number < 1)) {
    fail("GRAPH_PARENT_SHAPE_INVALID");
  }
  if (
    issue.issueType !== null &&
    (!issue.issueType ||
      typeof issue.issueType.id !== "string" ||
      typeof issue.issueType.name !== "string" ||
      typeof issue.issueType.isEnabled !== "boolean")
  ) {
    fail("GRAPH_ISSUE_TYPE_SHAPE_INVALID");
  }
  return {
    owner,
    repo,
    repositoryDatabaseId: repositoryNode.databaseId,
    nodeId: issue.id,
    number: issue.number,
    state: issue.state.toLowerCase(),
    updatedAt: issue.updatedAt,
    issueType: issue.issueType
      ? { nodeId: issue.issueType.id, name: issue.issueType.name, isEnabled: issue.issueType.isEnabled }
      : null,
    hasParent: issue.parent !== null,
    parentNumber: issue.parent?.number ?? null,
    labelsTotal: issue.labels.totalCount,
    dependenciesTotal: issue.blockedBy.totalCount,
    commentsTotal: issue.comments.totalCount,
  };
}

async function readIssue({ repository, number, token, client }) {
  const expectedUrl = issueUrl(repository, number);
  const response = await client(expectedUrl, { headers: responseHeaders(token) });
  if (typeof response?.url === "string" && response.url.length > 0) {
    let actual;
    try {
      actual = new URL(response.url);
    } catch {
      fail("ISSUE_MOVED");
    }
    if (actual.origin !== API_ORIGIN || actual.pathname !== new URL(expectedUrl).pathname) fail("ISSUE_MOVED");
  }
  return projectIssue(await readJson(response, "ISSUE_READ_FAILED"), repository, number);
}

async function readGraphAuthority({ repository, number, token, client }) {
  const { owner, repo } = splitRepository(repository);
  const response = await client(`${API_ORIGIN}/graphql`, {
    method: "POST",
    headers: { ...responseHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      query: AUTHORITY_QUERY,
      variables: { owner, repo, number },
    }),
  });
  return projectGraphAuthority(await readJson(response, "GRAPH_AUTHORITY_READ_FAILED"), repository, number);
}

function assertInitialIdentity(issue, graph) {
  if (
    issue.nodeId !== graph.nodeId ||
    issue.number !== graph.number ||
    issue.state !== graph.state ||
    issue.updatedAt !== graph.updatedAt ||
    issue.issueType?.nodeId !== graph.issueType?.nodeId ||
    issue.issueType?.name !== graph.issueType?.name ||
    issue.issueType?.isEnabled !== graph.issueType?.isEnabled
  ) {
    fail("ISSUE_REVISION_MISMATCH");
  }
}

function parseNextLink(value) {
  if (!value) return null;
  for (const part of value.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (match?.[2] === "next") return match[1];
  }
  return null;
}

function assertSafeNextUrl(candidate, { repository, repositoryDatabaseId, endpointPath }) {
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    fail("PAGINATION_NEXT_UNSAFE");
  }
  const repoPath = `/repos/${repository}${endpointPath}`;
  const databasePath = `/repositories/${repositoryDatabaseId}${endpointPath}`;
  if (
    parsed.origin !== API_ORIGIN ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (parsed.pathname !== repoPath && parsed.pathname !== databasePath)
  ) {
    fail("PAGINATION_NEXT_UNSAFE");
  }
  const allowed = new Set(["page", "per_page"]);
  if ([...parsed.searchParams.keys()].some((key) => !allowed.has(key))) fail("PAGINATION_NEXT_UNSAFE");
  if (parsed.searchParams.get("per_page") !== "100") fail("PAGINATION_NEXT_UNSAFE");
  const page = parsed.searchParams.get("page");
  if (page !== null && (!/^\d+$/.test(page) || Number(page) < 2)) fail("PAGINATION_NEXT_UNSAFE");
  return parsed.toString();
}

async function collectPages({
  repository,
  repositoryDatabaseId,
  endpointPath,
  token,
  client,
  project,
  maxItems = MAX_ITEMS,
}) {
  let next = `${API_ORIGIN}/repos/${repository}${endpointPath}?per_page=100`;
  const items = [];
  let pages = 0;
  const seen = new Set();
  try {
    while (next) {
      if (pages >= MAX_PAGES || items.length >= maxItems || seen.has(next)) fail("COLLECTION_BOUNDED");
      seen.add(next);
      const response = await client(next, { headers: responseHeaders(token) });
      const page = await readJson(response, "COLLECTION_READ_FAILED");
      if (!Array.isArray(page)) fail("COLLECTION_PAGE_SHAPE_INVALID");
      pages += 1;
      for (const item of page) {
        if (items.length >= maxItems) fail("COLLECTION_BOUNDED");
        items.push(project(item));
      }
      const candidate = parseNextLink(response.headers?.get?.("link"));
      next = candidate ? assertSafeNextUrl(candidate, { repository, repositoryDatabaseId, endpointPath }) : null;
    }
  } catch (error) {
    if (error instanceof IssueReadinessBoundaryError) {
      error.details.collectionCoverage = { pages, collected: items.length };
    }
    throw error;
  }
  return { items, pages };
}

function projectLabel(raw) {
  if (!raw || typeof raw.name !== "string" || raw.name.length === 0) fail("LABEL_SHAPE_INVALID");
  return raw.name;
}

function projectDependency(raw) {
  if (
    !raw ||
    !nonNegativeInteger(raw.number) ||
    !["open", "closed"].includes(raw.state) ||
    typeof raw.node_id !== "string" ||
    !validTimestamp(raw.updated_at) ||
    (raw.type !== null && (typeof raw.type !== "object" || typeof raw.type.name !== "string"))
  ) {
    fail("DEPENDENCY_SHAPE_INVALID");
  }
  return {
    nodeId: raw.node_id,
    number: raw.number,
    state: raw.state,
    updatedAt: raw.updated_at,
    issueTypeName: raw.type?.name ?? null,
  };
}

function projectComment(raw) {
  if (
    !raw ||
    !nonNegativeInteger(raw.id) ||
    typeof raw.node_id !== "string" ||
    typeof raw.body !== "string" ||
    !validTimestamp(raw.created_at) ||
    !validTimestamp(raw.updated_at) ||
    !raw.user ||
    typeof raw.user.login !== "string" ||
    typeof raw.user.type !== "string"
  ) {
    fail("COMMENT_SHAPE_INVALID");
  }
  return {
    id: raw.id,
    nodeId: raw.node_id,
    body: raw.body,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    author: { login: raw.user.login, type: raw.user.type },
  };
}

function emptyCollectionCoverage() {
  return { pages: 0, collected: 0, total: null, complete: false, reasonCode: null };
}

function completeCollectionCoverage(collection, total) {
  return {
    pages: collection.pages,
    collected: collection.items.length,
    total,
    complete: true,
    reasonCode: null,
  };
}

function incompleteCollectionCoverage(error, prior = emptyCollectionCoverage()) {
  return {
    ...prior,
    complete: false,
    reasonCode: error instanceof IssueReadinessBoundaryError ? error.code : "INTERNAL_FAILURE",
  };
}

async function settleCollection(load, total, countMismatchCode) {
  let value = { items: [], pages: 0 };
  try {
    value = await load();
    if (value.items.length !== total) {
      return {
        value,
        coverage: {
          ...completeCollectionCoverage(value, total),
          complete: false,
          reasonCode: countMismatchCode,
        },
        reasonCode: countMismatchCode,
      };
    }
    return { value, coverage: completeCollectionCoverage(value, total), reasonCode: null };
  } catch (error) {
    const partial = error instanceof IssueReadinessBoundaryError ? error.details.collectionCoverage : null;
    return {
      value,
      coverage: incompleteCollectionCoverage(error, {
        pages: partial?.pages ?? value.pages,
        collected: partial?.collected ?? value.items.length,
        total,
        complete: false,
        reasonCode: null,
      }),
      reasonCode: error instanceof IssueReadinessBoundaryError ? error.code : "INTERNAL_FAILURE",
    };
  }
}

function coverageSkeleton() {
  return {
    authorityComplete: false,
    issue: { initialRead: false, finalRead: false, revisionStable: false },
    labels: emptyCollectionCoverage(),
    dependencies: emptyCollectionCoverage(),
    comments: emptyCollectionCoverage(),
    form: { parsed: false, complete: false },
  };
}

export async function collectIssueAuthority({ repository, number, token, client = globalThis.fetch }) {
  const coverage = coverageSkeleton();
  let issue;
  let graph;
  try {
    issue = await readIssue({ repository, number, token, client });
    coverage.issue.initialRead = true;
    graph = await readGraphAuthority({ repository, number, token, client });
    assertInitialIdentity(issue, graph);
    if (issue.commentsTotal !== graph.commentsTotal || issue.dependenciesTotal !== graph.dependenciesTotal) {
      fail("INDEPENDENT_TOTAL_MISMATCH");
    }
  } catch (error) {
    return {
      complete: false,
      issue: issue ?? null,
      graph: graph ?? null,
      labels: [],
      dependencies: [],
      comments: [],
      coverage,
      reasonCodes: [error instanceof IssueReadinessBoundaryError ? error.code : "INTERNAL_FAILURE"],
    };
  }

  const endpoint = (suffix) => `/issues/${number}/${suffix}`;
  const common = {
    repository,
    repositoryDatabaseId: graph.repositoryDatabaseId,
    token,
    client,
  };
  const labelsResult = await settleCollection(
    () => collectPages({ ...common, endpointPath: endpoint("labels"), project: projectLabel }),
    graph.labelsTotal,
    "LABEL_COUNT_MISMATCH",
  );
  const dependenciesResult = await settleCollection(
    () =>
      collectPages({
        ...common,
        endpointPath: endpoint("dependencies/blocked_by"),
        project: projectDependency,
        maxItems: MAX_DEPENDENCIES,
      }),
    graph.dependenciesTotal,
    "DEPENDENCY_COUNT_MISMATCH",
  );
  const commentsResult = await settleCollection(
    () => collectPages({ ...common, endpointPath: endpoint("comments"), project: projectComment }),
    graph.commentsTotal,
    "COMMENT_COUNT_MISMATCH",
  );
  coverage.labels = labelsResult.coverage;
  coverage.dependencies = dependenciesResult.coverage;
  coverage.comments = commentsResult.coverage;

  const reasonCodes = [labelsResult.reasonCode, dependenciesResult.reasonCode, commentsResult.reasonCode].filter(
    Boolean,
  );
  const labelNames = labelsResult.value.items;
  if (new Set(labelNames).size !== labelNames.length) reasonCodes.push("LABEL_DUPLICATE");
  const dependencyIds = dependenciesResult.value.items.map((item) => item.nodeId);
  if (new Set(dependencyIds).size !== dependencyIds.length) reasonCodes.push("DEPENDENCY_DUPLICATE");
  const commentIds = commentsResult.value.items.map((item) => item.id);
  if (new Set(commentIds).size !== commentIds.length) reasonCodes.push("COMMENT_DUPLICATE");
  if (
    dependenciesResult.coverage.complete &&
    dependenciesResult.value.items.filter((item) => item.state === "open").length !== issue.openDependenciesTotal
  ) {
    reasonCodes.push("DEPENDENCY_OPEN_COUNT_MISMATCH");
  }

  try {
    const finalIssue = await readIssue({ repository, number, token, client });
    coverage.issue.finalRead = true;
    coverage.issue.revisionStable =
      finalIssue.nodeId === issue.nodeId &&
      finalIssue.updatedAt === issue.updatedAt &&
      finalIssue.state === issue.state &&
      finalIssue.body === issue.body &&
      finalIssue.issueType?.nodeId === issue.issueType?.nodeId &&
      finalIssue.issueType?.name === issue.issueType?.name &&
      finalIssue.issueType?.isEnabled === issue.issueType?.isEnabled &&
      finalIssue.milestone?.number === issue.milestone?.number &&
      finalIssue.milestone?.title === issue.milestone?.title &&
      finalIssue.milestone?.state === issue.milestone?.state &&
      finalIssue.commentsTotal === issue.commentsTotal &&
      finalIssue.dependenciesTotal === issue.dependenciesTotal &&
      finalIssue.openDependenciesTotal === issue.openDependenciesTotal;
    if (!coverage.issue.revisionStable) reasonCodes.push("ISSUE_REVISION_MOVED");
  } catch (error) {
    reasonCodes.push(error instanceof IssueReadinessBoundaryError ? error.code : "INTERNAL_FAILURE");
  }

  coverage.authorityComplete =
    reasonCodes.length === 0 &&
    coverage.issue.initialRead &&
    coverage.issue.finalRead &&
    coverage.issue.revisionStable &&
    coverage.labels.complete &&
    coverage.dependencies.complete &&
    coverage.comments.complete;

  return {
    complete: coverage.authorityComplete,
    issue,
    graph,
    labels: labelNames,
    dependencies: dependenciesResult.value.items,
    comments: commentsResult.value.items,
    coverage,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}

function normalizeField(value) {
  const trimmed = String(value ?? "").trim();
  return !trimmed || trimmed.toLowerCase() === NO_RESPONSE ? "" : trimmed;
}

export function scanIssueFormStructure(text) {
  const known = new Set(REQUIRED_FIELDS);
  const reasonCodes = [];
  const lines = [];
  const headings = [];
  const acceptedLabels = new Set();
  let fence = null;
  let stringOffset = 0;
  let byteOffset = 0;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const startOffset = byteOffset;
    const endOffset = startOffset + Buffer.byteLength(line);
    const record = { index, startOffset, endOffset, enteringFence: null, leavingFence: null };
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      if (fence === null) {
        fence = { marker: token[0], length: token.length };
        record.enteringFence = { ...fence };
      } else if (fence.marker === token[0] && token.length >= fence.length) {
        record.leavingFence = { ...fence };
        fence = null;
      }
      lines.push(record);
      const delimiterLength = text.startsWith("\r\n", stringOffset + line.length)
        ? 2
        : text.length > stringOffset + line.length
          ? 1
          : 0;
      stringOffset += line.length + delimiterLength;
      byteOffset = endOffset + delimiterLength;
      continue;
    }
    if (!fence) {
      const heading = line.match(/^#{2,3}\s+(.+?)\s*$/);
      if (heading) {
        const label = heading[1];
        const accepted = known.has(label);
        headings.push({ label, lineIndex: index, startOffset, endOffset, accepted });
        if (accepted) {
          if (acceptedLabels.has(label)) {
            reasonCodes.push(`FORM_FIELD_DUPLICATE:${label}`);
          }
          acceptedLabels.add(label);
        }
      }
    }
    lines.push(record);
    const delimiterLength = text.startsWith("\r\n", stringOffset + line.length)
      ? 2
      : text.length > stringOffset + line.length
        ? 1
        : 0;
    stringOffset += line.length + delimiterLength;
    byteOffset = endOffset + delimiterLength;
  }
  if (fence !== null) reasonCodes.push("FORM_FENCE_UNCLOSED");
  return { lines, headings, terminalFence: fence === null ? null : { ...fence }, reasonCodes };
}

export function parseIssueFormBody(body) {
  if (typeof body !== "string") {
    return { status: "malformed", fields: {}, reasonCodes: ["FORM_BODY_INVALID"] };
  }
  const structure = scanIssueFormStructure(body);
  const headingByLine = new Map(structure.headings.map((heading) => [heading.lineIndex, heading]));
  const bytes = Buffer.from(body, "utf8");
  const fields = {};
  let current = null;
  for (const line of structure.lines) {
    const heading = headingByLine.get(line.index);
    if (heading) {
      current = null;
      if (heading.accepted && !Object.hasOwn(fields, heading.label)) {
        fields[heading.label] = [];
        current = heading.label;
      }
      continue;
    }
    if (current) fields[current].push(bytes.subarray(line.startOffset, line.endOffset).toString("utf8"));
  }
  const normalized = Object.fromEntries(
    REQUIRED_FIELDS.map((field) => [field, normalizeField(fields[field]?.join("\n") ?? "")]),
  );
  return {
    status: structure.reasonCodes.length > 0 ? "malformed" : "ok",
    fields: normalized,
    reasonCodes: structure.reasonCodes,
  };
}

function rule(id, passed, reasonCodes) {
  if (!RULE_BY_ID.has(id)) throw new Error(`Unknown readiness rule ${id}`);
  return {
    id,
    status: passed ? "pass" : "fail",
    reasonCodes: passed ? [] : reasonCodes,
  };
}

function unknownRules(reasonCodes) {
  return ISSUE_READINESS_RULES.map(({ id }) => ({
    id,
    status: "unknown",
    reasonCodes,
  }));
}

function evidencePointers(value) {
  const pointers = new Set();
  for (const match of value.matchAll(REPO_POINTER)) pointers.add(match[0]);
  for (const match of value.matchAll(/(?:^|[^\w])#(\d{2,})\b/g)) pointers.add(`#${match[1]}`);
  for (const match of value.matchAll(/`([A-Za-z_$][\w$]*(?:\(\))?)`/g)) pointers.add(match[1]);
  return pointers;
}

function hasExplicitNonGoal(value) {
  const marker = value.match(/\b(?:non-goals?|out of scope)\b\s*:?\s*/i);
  if (!marker) return false;
  const remainder = value
    .slice((marker.index ?? 0) + marker[0].length)
    .replace(/[*_#-]/g, "")
    .trim();
  return remainder.length >= 5;
}

function listEntries(value) {
  const entries = [];
  let current = null;
  for (const line of value.split(/\r?\n/)) {
    const item = line.match(/^\s*(?:[-*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/);
    if (item) {
      current = item[1];
      entries.push(current);
    } else if (current && line.trim()) {
      entries[entries.length - 1] += ` ${line.trim()}`;
    }
  }
  return entries;
}

export function acceptanceEvidenceDiagnostic(entry, index) {
  const match = entry.match(/\bEvidence\s*:\s*(.+)$/i);
  if (!match) return { index, status: "fail", reasonCode: "EVIDENCE_MARKER_MISSING" };
  const evidence = match[1].trim();
  if (evidence.length < 8) return { index, status: "fail", reasonCode: "EVIDENCE_TOO_SHORT" };
  const recognized =
    /`[^`\n]{3,}`/.test(evidence) ||
    /https:\/\/github\.com\/\S+/.test(evidence) ||
    evidencePointers(evidence).size > 0 ||
    /\b(?:named test|test named|screenshot of|captured probe|verifier|ops check|workflow run)\b.{3,}/i.test(evidence);
  return recognized
    ? { index, status: "pass", reasonCode: null }
    : { index, status: "fail", reasonCode: "EVIDENCE_POINTER_UNRECOGNIZED" };
}

function discriminatingEvidence(entry, index) {
  return acceptanceEvidenceDiagnostic(entry, index).status === "pass";
}

function acceptanceDiagnosticsFromBody(body) {
  const parsed = parseIssueFormBody(body);
  if (parsed.status !== "ok") return [];
  return listEntries(parsed.fields["Acceptance criteria"]).map((entry, index) =>
    acceptanceEvidenceDiagnostic(entry, index + 1),
  );
}

function runnableCommands(value) {
  const commands = [];
  let fence = false;
  for (const line of value.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (fence && COMMAND_PREFIX.test(trimmed)) commands.push(trimmed);
    const standalone = trimmed.match(/^(?:[-*]\s+)?`([^`]+)`$/);
    if (standalone && COMMAND_PREFIX.test(standalone[1])) commands.push(standalone[1]);
  }
  return commands.filter((command) => !/[<>]|\.\.\.|(?:TODO|TBD)/i.test(command));
}

function readinessBodyInputs(body) {
  const parsed = parseIssueFormBody(body);
  return {
    parsed,
    verificationCommands: parsed.status === "ok" ? runnableCommands(parsed.fields["Verification plan"]) : [],
  };
}

function prospectiveDecompositionFacts(acceptanceDiagnostics, verificationCommands) {
  return {
    acceptanceCriteriaCount: acceptanceDiagnostics.length,
    verificationCommands,
  };
}

function exactNone(value) {
  return /^none\.?$/i.test(value.trim());
}

function fastReviewNotApplicable(value) {
  return /^not applicable\s*[—-]\s*fast path\.?$/i.test(value.trim());
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function tier(value) {
  const match = value.trim().match(/^(fast|full)\s+path\s*;\s*(presentation|system)\.?$/i);
  return match ? { path: match[1].toLowerCase(), routing: match[2].toLowerCase() } : null;
}

function authorityProbeComplete(value) {
  if (exactNone(value)) return true;
  const evidence = /https:\/\/\S+|`[^`]+`|\b(?:captured|fixture|artifact|probe output|workflow run)\b/i.test(value);
  const timing =
    /\b(?:before|during|after|at|when)\b.{0,80}\b(?:dispatch|queue|merge|run|request|event|webhook|lifecycle|implementation|acceptance)\b/i.test(
      value,
    );
  return evidence && timing;
}

function reviewPacketComplete(value) {
  return (
    /\binvariants?\b/i.test(value) &&
    /\b(?:failure modes?|risks?|false[- ](?:ready|positive|negative))\b/i.test(value) &&
    /\b(?:evidence|artifact|probe|fixture)\b/i.test(value)
  );
}

function evaluateStructuralReadinessFromInputs(authority, { checkedAt, checkerSha }, bodyInputs) {
  const baseReceipt = {
    schemaVersion: ISSUE_READINESS_SCHEMA_VERSION,
    claim: "structural-only",
    status: "unknown",
    subject: {
      repository: authority.repository,
      number: authority.number,
      nodeId: authority.issue?.nodeId ?? null,
      updatedAt: authority.issue?.updatedAt ?? null,
    },
    facts: {
      state: authority.issue?.state ?? null,
      issueType: authority.issue?.issueType ?? null,
      milestone: authority.issue?.milestone ?? null,
      labels: [...(authority.labels ?? [])].sort(),
      hasParent: authority.graph?.hasParent ?? null,
      parentNumber: authority.graph?.parentNumber ?? null,
      dependencies: [...(authority.dependencies ?? [])]
        .map((dependency) => ({ ...dependency }))
        .sort((left, right) => left.number - right.number),
    },
    checkedRules: [],
    reasonCodes: [],
    coverage: authority.coverage ?? coverageSkeleton(),
    provenance: {
      checkedAt,
      checkerSha,
      apiVersion: API_VERSION,
      collector: "github-rest-plus-graphql",
    },
    semanticPressureTest: "not-evaluated",
  };
  if (!authority.complete) {
    const reasonCodes = authority.reasonCodes.length > 0 ? authority.reasonCodes : ["AUTHORITY_UNKNOWN"];
    return {
      ...baseReceipt,
      checkedRules: unknownRules(reasonCodes),
      reasonCodes,
    };
  }

  const { parsed, verificationCommands } = bodyInputs ?? readinessBodyInputs(authority.issue.body);
  authority.coverage.form = {
    parsed: parsed.status === "ok",
    complete: parsed.status === "ok" && REQUIRED_FIELDS.every((field) => parsed.fields[field].length > 0),
  };
  if (parsed.status !== "ok") {
    return {
      ...baseReceipt,
      coverage: authority.coverage,
      checkedRules: unknownRules(parsed.reasonCodes),
      reasonCodes: parsed.reasonCodes,
    };
  }

  const fields = parsed.fields;
  const labels = authority.labels;
  const issueTypeName = authority.issue.issueType?.name ?? null;
  const familyFailures = [];
  for (const family of ["priority", "area", "kind"]) {
    const allowed = new Set(canonicalLabelNames(family));
    const members = labels.filter((label) => allowed.has(label));
    if (members.length !== 1) familyFailures.push(`LABEL_FAMILY_${family.toUpperCase()}_COUNT`);
  }
  const classificationInput = {
    number: authority.issue.number,
    state: authority.issue.state,
    labels,
    issueTypeName,
    milestoneTitle: authority.issue.milestone?.title ?? null,
    blockedByCount: authority.dependencies.filter((dependency) => dependency.state === "open").length,
    hasParent: authority.graph.hasParent,
  };
  const classificationFailures = [...familyFailures];
  if (!classified(classificationInput)) classificationFailures.push("ISSUE_NOT_CLASSIFIED");
  if (
    issueTypeName === null ||
    !ENABLED_NATIVE_ISSUE_TYPES.includes(issueTypeName) ||
    authority.issue.issueType?.isEnabled !== true
  ) {
    classificationFailures.push("ISSUE_TYPE_NOT_DISPATCHABLE");
  }
  if (!/^Wave\s+\d+\b/.test(authority.issue.milestone?.title ?? "")) {
    classificationFailures.push("MILESTONE_NOT_WAVE");
  }
  if (authority.issue.milestone?.state !== "open") classificationFailures.push("MILESTONE_NOT_OPEN");
  if (labels.some((label) => NON_RUNNABLE_LABELS.has(label))) {
    classificationFailures.push("LIFECYCLE_NOT_IMPLEMENTATION_RUNNABLE");
  }

  const dependencies = authority.dependencies.filter((dependency) => dependency.state === "open");
  const acceptanceEntries = listEntries(fields["Acceptance criteria"]);
  const providerContractDeclared =
    /\b(?:external[- ]provider contract|provider contract|payment[- ]provider|webhook payload|third[- ]party API schema)\b/i.test(
      fields["Acceptance criteria"],
    );
  const externalAuthorityDeclared =
    /\b(?:external authority|GitHub API|provider payload|queue association|webhook association|cloud API|provider contract|webhook payload)\b/i.test(
      fields["Acceptance criteria"],
    );
  const footprint = fields["Footprint & chain"];
  const operatorActions = fields["Operator actions"];
  const decisions = fields["Decisions already made"];
  const decisionsUnresolved = /\b(?:TBD|unresolved|undecided|decision needed|open question)\b/i.test(decisions);
  const decisionsComplete =
    decisions.length > 0 && !decisionsUnresolved && (exactNone(decisions) || evidencePointers(decisions).size > 0);
  const glossary = fields["Glossary impact"];
  const routing = tier(fields["Tier + routing hint"]);
  const rules = [
    rule(
      "ready-00-placed-classified",
      classificationFailures.length === 0,
      [...new Set(classificationFailures)].sort(),
    ),
    rule(
      "ready-00-dependencies-resolved",
      dependencies.length === 0,
      dependencies.length === 0 ? [] : ["OPEN_NATIVE_DEPENDENCY"],
    ),
    rule("ready-01-repo-evidence", evidencePointers(fields.Context).size >= 2, ["REPO_EVIDENCE_INSUFFICIENT"]),
    rule("ready-02-explicit-non-goal", hasExplicitNonGoal(fields["Scope fence"]), ["NON_GOAL_MISSING"]),
    rule(
      "ready-03-acceptance-evidence",
      acceptanceEntries.length > 0 &&
        acceptanceEntries.every((entry, index) => discriminatingEvidence(entry, index + 1)) &&
        (!providerContractDeclared || /\btest[- ]mode\b/i.test(fields["Acceptance criteria"])),
      [
        providerContractDeclared && !/\btest[- ]mode\b/i.test(fields["Acceptance criteria"])
          ? "PROVIDER_TEST_MODE_EVIDENCE_MISSING"
          : "AC_EVIDENCE_NOT_DISCRIMINATING",
      ],
    ),
    rule("ready-04-runnable-verification", verificationCommands.length > 0, ["VERIFICATION_COMMAND_NOT_RUNNABLE"]),
    rule(
      "ready-05-footprint-operators",
      evidencePointers(footprint).size > 0 &&
        /\bCallers?\s*:\s*\S+/i.test(footprint) &&
        operatorActions.length > 0 &&
        (exactNone(operatorActions) || operatorActions.length >= 8),
      ["FOOTPRINT_OR_OPERATOR_DECLARATION_MISSING"],
    ),
    rule("ready-06-decisions-resolved", decisionsComplete, [
      decisionsUnresolved ? "UNRESOLVED_DECISION_DECLARED" : "DECISION_RESOLUTION_UNPROVEN",
    ]),
    rule(
      "ready-07-terms-declared",
      glossary.length > 0 && (exactNone(glossary) || /GLOSSARY\.md|(?:^|\b)Terms?\s*:/i.test(glossary)),
      ["GLOSSARY_IMPACT_UNDECLARED"],
    ),
    rule(
      "ready-08-authority-probe-timed",
      authorityProbeComplete(fields["External authority probe & evidence timing"]) &&
        (!externalAuthorityDeclared || !exactNone(fields["External authority probe & evidence timing"])),
      ["AUTHORITY_PROBE_OR_TIMING_MISSING"],
    ),
    rule(
      "ready-09-review-packet",
      routing !== null &&
        (routing.path === "fast"
          ? fastReviewNotApplicable(fields["Review packet seed"])
          : reviewPacketComplete(fields["Review packet seed"])),
      [routing === null ? "TIER_ROUTING_INVALID" : "FULL_PATH_REVIEW_PACKET_MISSING"],
    ),
  ];
  const reasonCodes = [...new Set(rules.flatMap((entry) => entry.reasonCodes))].sort();
  return {
    ...baseReceipt,
    status: reasonCodes.length === 0 ? "ready" : "not-ready",
    coverage: authority.coverage,
    checkedRules: rules,
    reasonCodes,
  };
}

export function evaluateStructuralReadiness(authority, options) {
  return evaluateStructuralReadinessFromInputs(authority, options);
}

function prospectiveAuthority(body, metadata) {
  const required = [
    "repository",
    "number",
    "state",
    "issueType",
    "milestone",
    "labels",
    "parentNumber",
    "dependencies",
  ];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("PROSPECTIVE_METADATA_INVALID");
  if (required.some((key) => !Object.hasOwn(metadata, key))) fail("PROSPECTIVE_METADATA_INCOMPLETE");
  splitRepository(metadata.repository);
  if (!Number.isInteger(metadata.number) || metadata.number < 1) fail("ISSUE_NUMBER_INVALID");
  if (typeof body !== "string") fail("FORM_BODY_INVALID");
  if (!Array.isArray(metadata.labels) || !Array.isArray(metadata.dependencies)) fail("PROSPECTIVE_METADATA_INVALID");
  const coverage = coverageSkeleton();
  coverage.authorityComplete = true;
  coverage.issue = { initialRead: true, finalRead: true, revisionStable: true };
  for (const collection of ["labels", "dependencies", "comments"]) {
    const collected =
      collection === "labels"
        ? metadata.labels.length
        : collection === "dependencies"
          ? metadata.dependencies.length
          : 0;
    coverage[collection] = { pages: collected === 0 ? 0 : 1, collected, total: collected, complete: true };
  }
  return {
    repository: metadata.repository,
    number: metadata.number,
    complete: true,
    issue: {
      nodeId: metadata.nodeId ?? null,
      number: metadata.number,
      state: metadata.state,
      updatedAt: metadata.updatedAt ?? null,
      body,
      issueType: metadata.issueType,
      milestone: metadata.milestone,
    },
    graph: {
      hasParent: metadata.parentNumber !== null,
      parentNumber: metadata.parentNumber,
    },
    labels: metadata.labels,
    dependencies: metadata.dependencies,
    comments: [],
    coverage,
    reasonCodes: [],
  };
}

export function evaluateProspectiveIssueReadiness({ body, metadata, checkedAt, checkerSha }) {
  const authority = prospectiveAuthority(body, metadata);
  const bodyInputs = readinessBodyInputs(body);
  const receipt = evaluateStructuralReadinessFromInputs(authority, { checkedAt, checkerSha }, bodyInputs);
  const acceptanceDiagnostics = acceptanceDiagnosticsFromBody(body);
  return {
    schemaVersion: PROSPECTIVE_ISSUE_READINESS_RUN_SCHEMA_VERSION,
    claim: "structural-only-prospective",
    status: receipt.status,
    subject: receipt.subject,
    facts: receipt.facts,
    checkedRules: receipt.checkedRules,
    reasonCodes: receipt.reasonCodes,
    coverage: receipt.coverage,
    provenance: {
      checkedAt,
      checkerSha,
      source: "explicit-input",
    },
    semanticPressureTest: "not-evaluated",
    acceptanceDiagnostics,
    decompositionFacts: prospectiveDecompositionFacts(acceptanceDiagnostics, bodyInputs.verificationCommands),
  };
}

export function validateIssueReadinessReceipt(receipt) {
  const errors = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return ["receipt-object"];
  if (
    !hasExactKeys(receipt, [
      "schemaVersion",
      "claim",
      "status",
      "subject",
      "facts",
      "checkedRules",
      "reasonCodes",
      "coverage",
      "provenance",
      "semanticPressureTest",
    ])
  ) {
    errors.push("receipt-properties");
  }
  if (receipt.schemaVersion !== ISSUE_READINESS_SCHEMA_VERSION) errors.push("schema-version");
  if (receipt.claim !== "structural-only") errors.push("claim");
  if (!["ready", "not-ready", "unknown"].includes(receipt.status)) errors.push("status");
  if (
    !receipt.subject ||
    !hasExactKeys(receipt.subject, ["repository", "number", "nodeId", "updatedAt"]) ||
    typeof receipt.subject.repository !== "string" ||
    !/^[^/]+\/[^/]+$/.test(receipt.subject.repository) ||
    !Number.isInteger(receipt.subject.number) ||
    receipt.subject.number < 1 ||
    (receipt.subject.nodeId !== null && typeof receipt.subject.nodeId !== "string") ||
    (receipt.subject.updatedAt !== null && !validTimestamp(receipt.subject.updatedAt))
  ) {
    errors.push("subject");
  }
  const issueTypeFactValid =
    receipt.facts?.issueType === null ||
    (receipt.facts?.issueType &&
      hasExactKeys(receipt.facts.issueType, ["nodeId", "name", "isEnabled"]) &&
      typeof receipt.facts.issueType.nodeId === "string" &&
      typeof receipt.facts.issueType.name === "string" &&
      typeof receipt.facts.issueType.isEnabled === "boolean");
  const milestoneFactValid =
    receipt.facts?.milestone === null ||
    (receipt.facts?.milestone &&
      hasExactKeys(receipt.facts.milestone, ["number", "title", "state"]) &&
      Number.isInteger(receipt.facts.milestone.number) &&
      receipt.facts.milestone.number > 0 &&
      typeof receipt.facts.milestone.title === "string" &&
      ["open", "closed"].includes(receipt.facts.milestone.state));
  const dependencyFactsValid =
    Array.isArray(receipt.facts?.dependencies) &&
    receipt.facts.dependencies.every(
      (dependency) =>
        dependency &&
        hasExactKeys(dependency, ["nodeId", "number", "state", "updatedAt", "issueTypeName"]) &&
        typeof dependency.nodeId === "string" &&
        Number.isInteger(dependency.number) &&
        dependency.number > 0 &&
        ["open", "closed"].includes(dependency.state) &&
        validTimestamp(dependency.updatedAt) &&
        (dependency.issueTypeName === null || typeof dependency.issueTypeName === "string"),
    );
  if (
    !receipt.facts ||
    typeof receipt.facts !== "object" ||
    !hasExactKeys(receipt.facts, [
      "state",
      "issueType",
      "milestone",
      "labels",
      "hasParent",
      "parentNumber",
      "dependencies",
    ]) ||
    (receipt.facts.state !== null && !["open", "closed"].includes(receipt.facts.state)) ||
    !issueTypeFactValid ||
    !milestoneFactValid ||
    !Array.isArray(receipt.facts.labels) ||
    receipt.facts.labels.some((label) => typeof label !== "string") ||
    (receipt.facts.hasParent !== null && typeof receipt.facts.hasParent !== "boolean") ||
    (receipt.facts.parentNumber !== null &&
      (!Number.isInteger(receipt.facts.parentNumber) || receipt.facts.parentNumber < 1)) ||
    (receipt.facts.hasParent === true) !== (receipt.facts.parentNumber !== null) ||
    !dependencyFactsValid
  ) {
    errors.push("facts");
  }
  if (!Array.isArray(receipt.checkedRules) || receipt.checkedRules.length !== ISSUE_READINESS_RULES.length) {
    errors.push("checked-rules-count");
  } else {
    const ids = receipt.checkedRules.map((entry) => entry.id);
    const expectedIds = ISSUE_READINESS_RULES.map((entry) => entry.id);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !RULE_BY_ID.has(id)) ||
      ids.some((id, index) => id !== expectedIds[index])
    ) {
      errors.push("checked-rule-id");
    }
    for (const entry of receipt.checkedRules) {
      if (
        !hasExactKeys(entry, ["id", "status", "reasonCodes"]) ||
        !["pass", "fail", "unknown"].includes(entry.status) ||
        !Array.isArray(entry.reasonCodes)
      ) {
        errors.push("checked-rule-shape");
      } else if (
        (entry.status === "pass" && entry.reasonCodes.length !== 0) ||
        (entry.status !== "pass" && entry.reasonCodes.length === 0) ||
        entry.reasonCodes.some((code) => typeof code !== "string" || code.length === 0)
      ) {
        errors.push("checked-rule-reasons");
      }
    }
  }
  if (
    !Array.isArray(receipt.reasonCodes) ||
    receipt.reasonCodes.some((code) => typeof code !== "string" || code.length === 0) ||
    new Set(receipt.reasonCodes).size !== receipt.reasonCodes.length
  ) {
    errors.push("reason-codes");
  }
  if (Array.isArray(receipt.checkedRules) && Array.isArray(receipt.reasonCodes)) {
    const checkedReasonCodes = [
      ...new Set(
        receipt.checkedRules.flatMap((entry) =>
          Array.isArray(entry.reasonCodes) ? entry.reasonCodes.filter((code) => typeof code === "string") : [],
        ),
      ),
    ].sort();
    if (JSON.stringify(checkedReasonCodes) !== JSON.stringify([...receipt.reasonCodes].sort())) {
      errors.push("reason-code-reconciliation");
    }
  }
  const collectionCoverageValid = (value) =>
    value &&
    typeof value === "object" &&
    hasExactKeys(value, ["pages", "collected", "total", "complete", "reasonCode"]) &&
    nonNegativeInteger(value.pages) &&
    nonNegativeInteger(value.collected) &&
    (value.total === null || nonNegativeInteger(value.total)) &&
    typeof value.complete === "boolean" &&
    (value.reasonCode === null || typeof value.reasonCode === "string");
  if (
    !receipt.coverage ||
    typeof receipt.coverage !== "object" ||
    !hasExactKeys(receipt.coverage, ["authorityComplete", "issue", "labels", "dependencies", "comments", "form"]) ||
    typeof receipt.coverage.authorityComplete !== "boolean" ||
    !receipt.coverage.issue ||
    !hasExactKeys(receipt.coverage.issue, ["initialRead", "finalRead", "revisionStable"]) ||
    typeof receipt.coverage.issue.initialRead !== "boolean" ||
    typeof receipt.coverage.issue.finalRead !== "boolean" ||
    typeof receipt.coverage.issue.revisionStable !== "boolean" ||
    !collectionCoverageValid(receipt.coverage.labels) ||
    !collectionCoverageValid(receipt.coverage.dependencies) ||
    !collectionCoverageValid(receipt.coverage.comments) ||
    !receipt.coverage.form ||
    !hasExactKeys(receipt.coverage.form, ["parsed", "complete"]) ||
    typeof receipt.coverage.form.parsed !== "boolean" ||
    typeof receipt.coverage.form.complete !== "boolean"
  ) {
    errors.push("coverage");
  }
  if (
    !receipt.provenance ||
    !hasExactKeys(receipt.provenance, ["checkedAt", "checkerSha", "apiVersion", "collector"]) ||
    !validTimestamp(receipt.provenance.checkedAt) ||
    !/^[a-f0-9]{40}$/i.test(receipt.provenance.checkerSha) ||
    receipt.provenance.apiVersion !== API_VERSION ||
    receipt.provenance.collector !== "github-rest-plus-graphql"
  ) {
    errors.push("provenance");
  }
  if (receipt.semanticPressureTest !== "not-evaluated") errors.push("semantic-pressure-test");
  const reconciledCollection = (value) =>
    collectionCoverageValid(value) &&
    value.complete === true &&
    value.reasonCode === null &&
    value.total !== null &&
    value.collected === value.total;
  const verifiedAuthorityCoverage =
    receipt.coverage?.authorityComplete === true &&
    receipt.coverage?.issue?.initialRead === true &&
    receipt.coverage?.issue?.finalRead === true &&
    receipt.coverage?.issue?.revisionStable === true &&
    reconciledCollection(receipt.coverage?.labels) &&
    reconciledCollection(receipt.coverage?.dependencies) &&
    reconciledCollection(receipt.coverage?.comments) &&
    receipt.coverage?.form?.parsed === true;
  if (Array.isArray(receipt.checkedRules)) {
    const passes = receipt.checkedRules.filter((entry) => entry.status === "pass").length;
    const failures = receipt.checkedRules.filter((entry) => entry.status === "fail").length;
    const unknowns = receipt.checkedRules.filter((entry) => entry.status === "unknown").length;
    if (
      receipt.status === "ready" &&
      (!verifiedAuthorityCoverage ||
        receipt.coverage?.form?.complete !== true ||
        passes !== ISSUE_READINESS_RULES.length ||
        failures !== 0 ||
        unknowns !== 0 ||
        receipt.reasonCodes?.length !== 0 ||
        receipt.subject?.nodeId == null ||
        receipt.subject?.updatedAt == null ||
        receipt.facts?.state !== "open" ||
        receipt.facts?.issueType == null ||
        receipt.facts?.milestone == null)
    ) {
      errors.push("ready-consistency");
    }
    if (receipt.status === "not-ready" && (!verifiedAuthorityCoverage || failures === 0 || unknowns !== 0)) {
      errors.push("not-ready-consistency");
    }
    if (receipt.status === "unknown" && (unknowns === 0 || receipt.reasonCodes?.length === 0)) {
      errors.push("unknown-consistency");
    }
  }
  return [...new Set(errors)];
}

function extractReceipt(commentBody) {
  if (typeof commentBody !== "string") return null;
  const start = commentBody.indexOf(RECEIPT_START_MARKER);
  const end = commentBody.indexOf(RECEIPT_END_MARKER);
  if (start === -1 || end <= start) return null;
  const block = commentBody.slice(start + RECEIPT_START_MARKER.length, end);
  const match = block.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return null;
  try {
    const receipt = JSON.parse(match[1]);
    return validateIssueReadinessReceipt(receipt).length === 0 && receipt.status !== "unknown" ? receipt : null;
  } catch {
    return null;
  }
}

function receiptBlock(receipt) {
  return [RECEIPT_START_MARKER, "```json", JSON.stringify(receipt, null, 2), "```", RECEIPT_END_MARKER].join("\n");
}

export function renderIssueReadinessComment(receipt, previousVerifiedReceipt = null) {
  const revision = receipt.subject.updatedAt ?? "unavailable";
  if (receipt.status === "unknown") {
    return [
      COMMENT_MARKER,
      "### Issue Readiness",
      "",
      "**Current structural evaluation: unknown. No current `ready` claim is published.**",
      "",
      `Safe reason codes: ${receipt.reasonCodes.map((code) => `\`${code}\``).join(", ") || "`AUTHORITY_UNKNOWN`"}.  `,
      `Attempted subject revision: \`${revision}\`.  `,
      "Claim boundary: structural facts only; prose quality remains the planning pressure test.",
      "Dispatch authority is the exact workflow artifact, not this historical comment.",
      "",
      ...(previousVerifiedReceipt
        ? [
            "Last verified receipt (historical evidence only; **not current**):",
            "",
            receiptBlock(previousVerifiedReceipt),
          ]
        : ["Last verified receipt: none."]),
    ].join("\n");
  }
  const passCount = receipt.checkedRules.filter((entry) => entry.status === "pass").length;
  return [
    COMMENT_MARKER,
    "### Issue Readiness",
    "",
    `Structural evaluation at the bound revision: **${receipt.status}**.`,
    "",
    `Subject revision: \`${revision}\`.  `,
    `Rules passed: ${passCount}/${receipt.checkedRules.length}.  `,
    "Claim boundary: structural facts only; prose quality remains the planning pressure test.",
    "Dispatch authority is the exact workflow artifact, not this historical comment.",
    "",
    receiptBlock(receipt),
  ].join("\n");
}

function stableBotComments(comments) {
  return comments.filter(
    (comment) =>
      comment.author.login === BOT_LOGIN && comment.author.type === "Bot" && comment.body.includes(COMMENT_MARKER),
  );
}

function sameStructuralClaim(left, right) {
  const project = (receipt) => ({
    schemaVersion: receipt.schemaVersion,
    claim: receipt.claim,
    status: receipt.status,
    subject: {
      repository: receipt.subject.repository,
      number: receipt.subject.number,
      nodeId: receipt.subject.nodeId,
    },
    facts: receipt.facts,
    checkedRules: receipt.checkedRules,
    reasonCodes: receipt.reasonCodes,
    semanticPressureTest: receipt.semanticPressureTest,
  });
  return JSON.stringify(project(left)) === JSON.stringify(project(right));
}

async function mutateComment({ repository, number, token, client, method, path, body }) {
  const response = await client(`${API_ORIGIN}/repos/${repository}${path}`, {
    method,
    headers: { ...responseHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  await readJson(response, "COMMENT_WRITE_FAILED");
  return method === "POST" ? "created" : "updated";
}

export async function upsertIssueReadinessComment({
  repository,
  number,
  token,
  client,
  receipt,
  comments,
  commentsComplete,
}) {
  if (!commentsComplete) return "skipped-comment-authority-unknown";
  const stable = stableBotComments(comments);
  if (stable.length > 1) return "skipped-duplicate-stable-comments";
  const existing = stable[0] ?? null;
  const previousVerifiedReceipt = existing ? extractReceipt(existing.body) : null;
  if (receipt.status === "unknown" && existing && previousVerifiedReceipt === null) {
    return "skipped-last-verified-unreadable";
  }
  if (
    existing &&
    previousVerifiedReceipt &&
    !existing.body.includes("Current structural evaluation: unknown") &&
    existing.updatedAt === receipt.subject.updatedAt &&
    sameStructuralClaim(previousVerifiedReceipt, receipt)
  ) {
    return "unchanged";
  }
  const body = renderIssueReadinessComment(receipt, previousVerifiedReceipt);
  if (existing?.body === body) return "unchanged";
  if (existing) {
    return mutateComment({
      repository,
      number,
      token,
      client,
      method: "PATCH",
      path: `/issues/comments/${existing.id}`,
      body,
    });
  }
  return mutateComment({
    repository,
    number,
    token,
    client,
    method: "POST",
    path: `/issues/${number}/comments`,
    body,
  });
}

export function consumeIssueReadinessReceipt({
  receipt,
  currentRevision,
  trustedCheckerSha,
  semanticPressureTest = "not-run",
}) {
  if (receipt == null) {
    return { decision: "reject", reasonCode: "RECEIPT_MISSING", structuralStatus: "missing" };
  }
  if (validateIssueReadinessReceipt(receipt).length > 0) {
    return { decision: "reject", reasonCode: "RECEIPT_MALFORMED", structuralStatus: "unknown" };
  }
  if (
    !/^[a-f0-9]{40}$/i.test(String(trustedCheckerSha ?? "")) ||
    receipt.provenance.checkerSha !== String(trustedCheckerSha).toLowerCase()
  ) {
    return {
      decision: "reject",
      reasonCode: "CHECKER_PROVENANCE_MISMATCH",
      structuralStatus: receipt.status,
    };
  }
  if (
    !currentRevision ||
    receipt.subject.repository !== currentRevision.repository ||
    receipt.subject.number !== currentRevision.number ||
    receipt.subject.nodeId !== currentRevision.nodeId ||
    receipt.subject.updatedAt !== currentRevision.updatedAt
  ) {
    return { decision: "reject", reasonCode: "RECEIPT_STALE", structuralStatus: receipt.status };
  }
  if (receipt.status === "unknown") {
    return { decision: "reject", reasonCode: "RECEIPT_UNKNOWN", structuralStatus: receipt.status };
  }
  if (receipt.status === "not-ready") {
    return {
      decision: "dispatch-planning-repair",
      reasonCode: "STRUCTURAL_NOT_READY",
      structuralStatus: receipt.status,
    };
  }
  if (semanticPressureTest === "fail") {
    return {
      decision: "dispatch-planning-repair",
      reasonCode: "SEMANTIC_PRESSURE_TEST_FAILED",
      structuralStatus: receipt.status,
    };
  }
  if (semanticPressureTest !== "pass") {
    return {
      decision: "reject",
      reasonCode: "SEMANTIC_PRESSURE_TEST_MISSING",
      structuralStatus: receipt.status,
    };
  }
  return {
    decision: "dispatch-implementation",
    reasonCode: "READY_RECEIPT_CURRENT",
    structuralStatus: receipt.status,
  };
}

function normalizeCheckerSha(value) {
  return /^[a-f0-9]{40}$/i.test(String(value ?? "")) ? String(value).toLowerCase() : "unavailable";
}

function prospectiveArguments(argv) {
  if (!argv.includes("--prospective-body") && !argv.includes("--prospective-metadata")) return null;
  const allowed = new Set(["--prospective-body", "--prospective-metadata", "--checker-sha"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(option) || !value || value.startsWith("--")) fail("PROSPECTIVE_ARGUMENTS_INVALID");
    if (Object.hasOwn(values, option)) fail("PROSPECTIVE_ARGUMENTS_INVALID");
    values[option] = value;
  }
  if (!values["--prospective-body"] || !values["--prospective-metadata"]) {
    fail("PROSPECTIVE_ARGUMENTS_INCOMPLETE");
  }
  return values;
}

export async function main({
  env = process.env,
  client = globalThis.fetch,
  logger = console,
  now = () => new Date(),
  argv = process.argv.slice(2),
  readTextFile = (file) => readFile(file, "utf8"),
} = {}) {
  let prospective;
  try {
    prospective = prospectiveArguments(argv);
    if (prospective) {
      const checkerSha = prospective["--checker-sha"] ?? env.ISSUE_READINESS_CHECKER_SHA;
      if (!/^[a-f0-9]{40}$/i.test(String(checkerSha ?? ""))) fail("CHECKER_SHA_INVALID");
      const [body, metadataSource] = await Promise.all([
        readTextFile(prospective["--prospective-body"]),
        readTextFile(prospective["--prospective-metadata"]),
      ]);
      let metadata;
      try {
        metadata = JSON.parse(metadataSource);
      } catch {
        fail("PROSPECTIVE_METADATA_INVALID");
      }
      const record = evaluateProspectiveIssueReadiness({
        body,
        metadata,
        checkedAt: now().toISOString(),
        checkerSha: normalizeCheckerSha(checkerSha),
      });
      logger.log(JSON.stringify(record));
      return { exitCode: 0, ...record };
    }
  } catch (error) {
    logger.error(error instanceof IssueReadinessBoundaryError ? error.code : "PROSPECTIVE_INPUT_INVALID");
    return { exitCode: 2, receipt: null, commentAction: "not-attempted" };
  }

  let repository;
  let number;
  try {
    repository = env.GITHUB_REPOSITORY;
    splitRepository(repository);
    if (!env.GITHUB_TOKEN) fail("TOKEN_MISSING");
    number = Number(env.ISSUE_NUMBER);
    if (!Number.isInteger(number) || number < 1) fail("ISSUE_NUMBER_INVALID");
    if (!/^[a-f0-9]{40}$/i.test(String(env.ISSUE_READINESS_CHECKER_SHA ?? ""))) {
      fail("CHECKER_SHA_INVALID");
    }
  } catch (error) {
    logger.error(error instanceof IssueReadinessBoundaryError ? error.code : "ENVIRONMENT_INVALID");
    return { exitCode: 2, receipt: null, commentAction: "not-attempted" };
  }

  let authority = await collectIssueAuthority({
    repository,
    number,
    token: env.GITHUB_TOKEN,
    client,
  });
  authority.repository = repository;
  authority.number = number;
  let receipt = evaluateStructuralReadiness(authority, {
    checkedAt: now().toISOString(),
    checkerSha: normalizeCheckerSha(env.ISSUE_READINESS_CHECKER_SHA),
  });
  let commentAction = "disabled";
  if (env.ISSUE_READINESS_PUBLISH === "true") {
    commentAction = await upsertIssueReadinessComment({
      repository,
      number,
      token: env.GITHUB_TOKEN,
      client,
      receipt,
      comments: authority.comments,
      commentsComplete: authority.coverage.comments.complete,
    });
    // Creating or updating the stable comment changes the issue's provider
    // revision. Re-collect after that known mutation and publish the rebound
    // read-only receipt as the workflow artifact; otherwise every successful
    // comment write would make its own artifact stale immediately.
    if (commentAction === "created" || commentAction === "updated") {
      authority = await collectIssueAuthority({
        repository,
        number,
        token: env.GITHUB_TOKEN,
        client,
      });
      authority.repository = repository;
      authority.number = number;
      receipt = evaluateStructuralReadiness(authority, {
        checkedAt: now().toISOString(),
        checkerSha: normalizeCheckerSha(env.ISSUE_READINESS_CHECKER_SHA),
      });
    }
  }
  const record = {
    schemaVersion: ISSUE_READINESS_RUN_SCHEMA_VERSION,
    receipt,
    commentAction,
    acceptanceDiagnostics: acceptanceDiagnosticsFromBody(authority.issue?.body),
  };
  if (env.ISSUE_READINESS_OUTPUT) {
    await writeFile(env.ISSUE_READINESS_OUTPUT, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }
  logger.log(JSON.stringify(record));
  return { exitCode: 0, ...record };
}

if (process.argv[1] && process.argv[1].endsWith("issue-readiness.mjs")) {
  const result = await main();
  process.exitCode = result.exitCode;
}
