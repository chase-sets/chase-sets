import { createHash } from "node:crypto";
import process from "node:process";

const REVIEW_PASS_PATTERN = /\b(?:\d+(?:st|nd|rd|th)\s+)?comprehensive\s+review(?:\s+update)?\b/i;
const LEDGER_PATTERNS = [
  /\bevidence\s+(?:update|row|ledger|matrix)\b/i,
  /\blaunch\s+(?:evidence|matrix|register)\b/i,
  /\blatest[- ]main\s+(?:correction|revalidation)\b/i,
  /\bcurrent[- ]main\s+revalidation\b/i,
];
const API = "https://api.github.com";
const DAY_MS = 86_400_000;
const SHELF_LABEL = "status:needs-replan";

export const DEFAULT_REVIEW_PASS_LIMIT = 1;
export const DEFAULT_LEDGER_COMMENT_LIMIT = 10;
export const DEFAULT_DRAIN_THRESHOLD_DAYS = 28;
export const DEFAULT_AUTHORITY_LIMITS = Object.freeze({
  pages: 10,
  connectionNodes: 1_000,
  requests: 1_000,
  nodes: 50_000,
});

class Unavailable extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const ok = (value) => ({ available: true, value });
const no = (reason) => ({ available: false, reason });
const code = (error, fallback) => (error instanceof Unavailable ? error.code : fallback);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const instant = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createAuthorityBudget(overrides = {}) {
  const limits = { ...DEFAULT_AUTHORITY_LIMITS, ...overrides };
  if (Object.values(limits).some((value) => !positive(value)))
    throw new TypeError("Authority limits must be positive integers.");
  const state = { requests: 0, nodes: 0 };
  return {
    limits,
    state,
    request() {
      if (state.requests >= limits.requests) throw new Unavailable("GLOBAL_REQUEST_BUDGET_EXHAUSTED");
      state.requests += 1;
    },
    addNodes(count) {
      if (!Number.isSafeInteger(count) || count < 0 || state.nodes + count > limits.nodes) {
        throw new Unavailable("GLOBAL_NODE_BUDGET_EXHAUSTED");
      }
      state.nodes += count;
    },
  };
}

export function classifyCadenceComment(body) {
  const text = String(body ?? "");
  if (REVIEW_PASS_PATTERN.test(text)) return "review-pass";
  return LEDGER_PATTERNS.some((pattern) => pattern.test(text)) ? "ledger" : "other";
}

export function buildCadenceDigest(comments, options = {}) {
  const reviewPassLimit = options.reviewPassLimit ?? DEFAULT_REVIEW_PASS_LIMIT;
  const ledgerCommentLimit = options.ledgerCommentLimit ?? DEFAULT_LEDGER_COMMENT_LIMIT;
  const reviewPasses = comments.filter((comment) => classifyCadenceComment(comment.body) === "review-pass");
  const ledgerComments = comments.filter((comment) => classifyCadenceComment(comment.body) === "ledger");
  const flagged = reviewPasses.length > reviewPassLimit || ledgerComments.length > ledgerCommentLimit;
  const lines = [
    "## Review cadence digest",
    "",
    `Window: last 7 days. Review passes found: ${reviewPasses.length} (limit ${reviewPassLimit}). Ledger-style comments found: ${ledgerComments.length} (limit ${ledgerCommentLimit}).`,
    "",
  ];
  if (flagged) {
    lines.push(
      "**Flagged.** The anti-ratchet cadence cap was exceeded. Evidence rows belong in the owning GitHub milestone or release record, and comprehensive reviews are capped at one per milestone per week.",
      "",
    );
    for (const comment of [...reviewPasses, ...ledgerComments].slice(0, 20))
      lines.push(`- ${comment.html_url ?? comment.url ?? "(comment)"}`);
  } else lines.push("Clean: cadence within limits.");
  return {
    flagged,
    reviewPassCount: reviewPasses.length,
    ledgerCommentCount: ledgerComments.length,
    markdown: lines.join("\n"),
  };
}

function nextLink(header, current, stream) {
  const matches = String(header ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /;\s*rel="next"$/.test(part));
  if (matches.length > 1) throw new Unavailable(`${stream}_NEXT_LINK_AMBIGUOUS`);
  if (!matches.length) return null;
  const match = /^<([^>]+)>;\s*rel="next"$/.exec(matches[0]);
  if (!match) throw new Unavailable(`${stream}_NEXT_LINK_INVALID`);
  const url = new URL(match[1], current);
  if (url.origin !== API || url.protocol !== "https:") throw new Unavailable(`${stream}_NEXT_LINK_UNSAFE`);
  return url.href;
}

async function getJson(url, { token, request, budget, stream, init = {} }) {
  budget.request();
  const response = await request(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!response?.ok) throw new Unavailable(`${stream}_REQUEST_FAILED`);
  try {
    return { response, body: await response.json() };
  } catch {
    throw new Unavailable(`${stream}_JSON_INVALID`);
  }
}

async function restPages({ url, token, request, budget, stream, valid, identity, expected = null }) {
  const nodes = [];
  const identities = new Set();
  const visited = new Set();
  let pages = 0;
  while (url) {
    if (visited.has(url)) throw new Unavailable(`${stream}_NEXT_LINK_REPEATED`);
    if (pages >= budget.limits.pages) throw new Unavailable(`${stream}_PAGE_BUDGET_EXHAUSTED`);
    visited.add(url);
    const current = url;
    const result = await getJson(url, { token, request, budget, stream });
    pages += 1;
    if (!Array.isArray(result.body)) throw new Unavailable(`${stream}_PAGE_INVALID`);
    if (nodes.length + result.body.length > budget.limits.connectionNodes)
      throw new Unavailable(`${stream}_NODE_BUDGET_EXHAUSTED`);
    budget.addNodes(result.body.length);
    for (const node of result.body) {
      if (!valid(node)) throw new Unavailable(`${stream}_NODE_INVALID`);
      const key = identity(node);
      if (identities.has(key)) throw new Unavailable(`${stream}_IDENTITY_REPEATED`);
      identities.add(key);
      nodes.push(node);
    }
    url = nextLink(result.response.headers?.get?.("link"), current, stream);
    if (url && nodes.length >= budget.limits.connectionNodes) throw new Unavailable(`${stream}_NODE_BUDGET_EXHAUSTED`);
  }
  if (expected !== null && nodes.length !== expected) throw new Unavailable(`${stream}_COUNT_MISMATCH`);
  return nodes;
}

function labels(issue) {
  if (!Array.isArray(issue?.labels)) return null;
  const values = issue.labels.map((label) => (typeof label === "string" ? label : label?.name));
  return values.every((label) => typeof label === "string" && label.length > 0) &&
    new Set(values).size === values.length
    ? values.sort()
    : null;
}
function validIssue(issue) {
  return (
    positive(issue?.number) &&
    ["open", "closed"].includes(issue.state) &&
    typeof issue.title === "string" &&
    typeof issue.html_url === "string" &&
    instant(issue.created_at) &&
    instant(issue.updated_at) &&
    labels(issue) !== null &&
    !issue.pull_request
  );
}
function normalizeIssue(issue) {
  if (!validIssue(issue)) throw new Unavailable("ISSUE_NODE_INVALID");
  return {
    number: issue.number,
    state: issue.state,
    title: issue.title,
    url: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    labels: labels(issue),
  };
}
const issueFact = (issue) =>
  digest({ number: issue.number, state: issue.state, updatedAt: issue.updatedAt, labels: issue.labels });
const population = (issues) =>
  digest([...issues].sort((left, right) => left.number - right.number).map((issue) => issueFact(issue)));

async function search({ repo, qualifier, token, request, budget, stream, countOnly = false }) {
  let url = `${API}/search/issues?q=${encodeURIComponent(`repo:${repo} is:issue ${qualifier}`)}&per_page=${countOnly ? 1 : 100}&page=1`;
  const items = [];
  const ids = new Set();
  const visited = new Set();
  let total = null;
  let pages = 0;
  while (url) {
    if (visited.has(url)) throw new Unavailable(`${stream}_NEXT_LINK_REPEATED`);
    if (pages >= budget.limits.pages) throw new Unavailable(`${stream}_PAGE_BUDGET_EXHAUSTED`);
    visited.add(url);
    const current = url;
    const result = await getJson(url, { token, request, budget, stream });
    pages += 1;
    const body = result.body;
    if (
      !Number.isSafeInteger(body?.total_count) ||
      body.total_count < 0 ||
      typeof body.incomplete_results !== "boolean" ||
      !Array.isArray(body.items)
    )
      throw new Unavailable(`${stream}_PAGE_INVALID`);
    if (body.incomplete_results) throw new Unavailable(`${stream}_INCOMPLETE_RESULTS`);
    if (body.total_count > 1_000) throw new Unavailable(`${stream}_SEARCH_CAP_EXCEEDED`);
    if (total === null) total = body.total_count;
    if (total !== body.total_count) throw new Unavailable(`${stream}_TOTAL_CHANGED`);
    if (countOnly) return { total, items: [] };
    if (items.length + body.items.length > budget.limits.connectionNodes)
      throw new Unavailable(`${stream}_NODE_BUDGET_EXHAUSTED`);
    budget.addNodes(body.items.length);
    for (const item of body.items) {
      if (!validIssue(item) || ids.has(item.number)) throw new Unavailable(`${stream}_NODE_INVALID`);
      ids.add(item.number);
      items.push(normalizeIssue(item));
    }
    url = nextLink(result.response.headers?.get?.("link"), current, stream);
  }
  if (items.length !== total) throw new Unavailable(`${stream}_COUNT_MISMATCH`);
  return { total, items };
}

async function currentShelf(args, stream) {
  const count = await search({
    ...args,
    qualifier: `is:open label:"${SHELF_LABEL}"`,
    stream: `${stream}_SEARCH`,
    countOnly: true,
  });
  const nodes = await restPages({
    ...args,
    stream: `${stream}_LIST`,
    url: `${API}/repos/${args.repo}/issues?state=open&labels=${encodeURIComponent(SHELF_LABEL)}&per_page=100&page=1`,
    valid: validIssue,
    identity: (issue) => issue.number,
    expected: count.total,
  });
  const issues = nodes.map(normalizeIssue).sort((a, b) => a.number - b.number);
  if (issues.some((issue) => issue.state !== "open" || !issue.labels.includes(SHELF_LABEL)))
    throw new Unavailable(`${stream}_ACTIVE_STATE_INVALID`);
  return issues;
}

const validComment = (comment) =>
  positive(comment?.id) && typeof comment.body === "string" && instant(comment.updated_at);
async function comments(args, number, stream) {
  const values = await restPages({
    ...args,
    stream,
    url: `${API}/repos/${args.repo}/issues/${number}/comments?per_page=100&page=1`,
    valid: validComment,
    identity: (comment) => comment.id,
  });
  return {
    values,
    snapshot: values
      .map((comment) => ({
        id: comment.id,
        updatedAt: comment.updated_at,
        body: createHash("sha256").update(comment.body).digest("hex"),
      }))
      .sort((a, b) => a.id - b.id),
  };
}

const DEPENDENCIES_QUERY = `# REVIEW_CADENCE_DEPENDENCIES
query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){issue(number:$number){blockedBy(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{id number repository{nameWithOwner}}}}}}`;
const LIFECYCLE_QUERY = `# REVIEW_CADENCE_LIFECYCLE
query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){issue(number:$number){number state title url createdAt updatedAt labels(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{name}} timelineItems(first:100,after:$after,itemTypes:[LABELED_EVENT,UNLABELED_EVENT,CLOSED_EVENT,REOPENED_EVENT]){totalCount pageInfo{hasNextPage endCursor} nodes{__typename ... on LabeledEvent{id createdAt label{name}} ... on UnlabeledEvent{id createdAt label{name}} ... on ClosedEvent{id createdAt} ... on ReopenedEvent{id createdAt}}}}}}`;

async function connection({ query, variables, select, observe = () => {}, valid, identity, ...args }) {
  const nodes = [];
  const ids = new Set();
  const cursors = new Set();
  let total = null;
  let after = null;
  let pages = 0;
  do {
    if (pages >= args.budget.limits.pages) throw new Unavailable(`${args.stream}_PAGE_BUDGET_EXHAUSTED`);
    const result = await getJson(`${API}/graphql`, {
      ...args,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables: { ...variables, after } }),
      },
    });
    pages += 1;
    if (result.body.errors || !result.body.data) throw new Unavailable(`${args.stream}_GRAPHQL_INVALID`);
    observe(result.body.data);
    const page = select(result.body.data);
    if (
      !Number.isSafeInteger(page?.totalCount) ||
      page.totalCount < 0 ||
      !Array.isArray(page.nodes) ||
      typeof page.pageInfo?.hasNextPage !== "boolean" ||
      (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
    )
      throw new Unavailable(`${args.stream}_PAGE_INVALID`);
    if (total === null) total = page.totalCount;
    if (total !== page.totalCount) throw new Unavailable(`${args.stream}_TOTAL_CHANGED`);
    if (nodes.length + page.nodes.length > args.budget.limits.connectionNodes)
      throw new Unavailable(`${args.stream}_NODE_BUDGET_EXHAUSTED`);
    args.budget.addNodes(page.nodes.length);
    for (const node of page.nodes) {
      if (!valid(node) || ids.has(identity(node))) throw new Unavailable(`${args.stream}_NODE_INVALID`);
      ids.add(identity(node));
      nodes.push(node);
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (after && (cursors.has(after) || nodes.length >= args.budget.limits.connectionNodes))
      throw new Unavailable(
        cursors.has(after) ? `${args.stream}_CURSOR_REPEATED` : `${args.stream}_NODE_BUDGET_EXHAUSTED`,
      );
    if (after) cursors.add(after);
  } while (after);
  if (nodes.length !== total) throw new Unavailable(`${args.stream}_COUNT_MISMATCH`);
  return nodes;
}

const repoVars = (repo, number) => {
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra) throw new TypeError("Invalid repository.");
  return { owner, name, number };
};
async function dependencies(args, number, stream) {
  const nodes = await connection({
    ...args,
    stream,
    query: DEPENDENCIES_QUERY,
    variables: repoVars(args.repo, number),
    select: (data) => data.repository?.issue?.blockedBy,
    valid: (node) =>
      typeof node?.id === "string" && positive(node.number) && typeof node.repository?.nameWithOwner === "string",
    identity: (node) => node.id,
  });
  return nodes
    .map((node) => ({ id: node.id, number: node.number, repo: node.repository.nameWithOwner }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
async function lifecycle(args, number, stream) {
  const types = new Set(["LabeledEvent", "UnlabeledEvent", "ClosedEvent", "ReopenedEvent"]);
  let issue = null;
  const nodes = await connection({
    ...args,
    stream,
    query: LIFECYCLE_QUERY,
    variables: repoVars(args.repo, number),
    observe: (data) => {
      const node = data.repository?.issue;
      const page = node?.labels;
      if (
        !positive(node?.number) ||
        !["OPEN", "CLOSED"].includes(node.state) ||
        typeof node.title !== "string" ||
        typeof node.url !== "string" ||
        !instant(node.createdAt) ||
        !instant(node.updatedAt) ||
        !Number.isSafeInteger(page?.totalCount) ||
        page.totalCount < 0 ||
        !Array.isArray(page.nodes) ||
        page.pageInfo?.hasNextPage ||
        page.nodes.length !== page.totalCount ||
        page.nodes.some((label) => typeof label?.name !== "string")
      )
        throw new Unavailable(`${stream}_ISSUE_FACT_INVALID`);
      const candidate = {
        number: node.number,
        state: node.state.toLowerCase(),
        title: node.title,
        url: node.url,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        labels: page.nodes.map((label) => label.name).sort(),
      };
      if (issue && issueFact(issue) !== issueFact(candidate)) throw new Unavailable(`${stream}_ISSUE_FACT_MOVED`);
      issue = candidate;
    },
    select: (data) => data.repository?.issue?.timelineItems,
    valid: (node) =>
      typeof node?.id === "string" &&
      types.has(node.__typename) &&
      instant(node.createdAt) &&
      (!["LabeledEvent", "UnlabeledEvent"].includes(node.__typename) || typeof node.label?.name === "string"),
    identity: (node) => node.id,
  });
  return {
    issue,
    events: nodes
      .map((node) => ({
        id: node.id,
        type: node.__typename,
        createdAt: node.createdAt,
        label: node.label?.name ?? null,
      }))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)),
  };
}

function lines(body, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...body.matchAll(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, "gim"))].map((match) => match[1]);
}
export function parseSuccessorAuthority(commentValues, dependencyValues, original, repo) {
  const receipts = [];
  let malformed = false;
  for (const comment of commentValues) {
    const body = comment.body;
    if (!/planning-repair\/v1|\b(?:DISPOSITION|ORIGINAL_ISSUE|REPLACEMENTS?)\s*:/i.test(body)) continue;
    const version = lines(body, "PLANNING_CONTRACT_VERSION");
    const disposition = lines(body, "DISPOSITION");
    const source = lines(body, "ORIGINAL_ISSUE");
    const replacement = lines(body, "REPLACEMENTS");
    const canonical = version.length + disposition.length + source.length + replacement.length > 0;
    let targets = null;
    if (
      canonical &&
      version.length === 1 &&
      version[0] === "planning-repair/v1" &&
      disposition.length === 1 &&
      disposition[0] === "REPLACED" &&
      source.length === 1 &&
      source[0] === `#${original}` &&
      replacement.length === 1 &&
      /^(?:#\d+)(?:[\s,]+#\d+)*$/.test(replacement[0])
    )
      targets = [...replacement[0].matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
    if (!canonical) {
      const dispositions = [...body.matchAll(/\bdisposition REPLACED \(planning-repair\/v1\)/gi)];
      const replacements = [...body.matchAll(/^Replacement:\s*#(\d+)\s*$/gim)];
      if (dispositions.length === 1 && replacements.length === 1) targets = [Number(replacements[0][1])];
    }
    if (!targets?.length || new Set(targets).size !== targets.length || targets.includes(original)) malformed = true;
    else receipts.push(targets.sort((a, b) => a - b));
  }
  if (malformed) return no("SUCCESSOR_RECEIPT_MALFORMED_OR_PARTIAL");
  if (receipts.length > 1) return no("SUCCESSOR_RECEIPT_DUPLICATE_OR_CONFLICTING");
  if (!receipts.length) return ok({ classification: "confirmed-none", replacements: [] });
  const linked = new Set(dependencyValues.filter((item) => item.repo === repo).map((item) => item.number));
  return receipts[0].every((number) => linked.has(number))
    ? ok({ classification: "qualified", replacements: receipts[0] })
    : no("SUCCESSOR_RECEIPT_NATIVE_LINK_MISSING");
}

function membership(issue, events, at) {
  if (Date.parse(issue.createdAt) > at) return { member: false, start: null };
  let open = true;
  let labeled = false;
  let start = null;
  for (const event of events) {
    if (Date.parse(event.createdAt) > at) break;
    if (event.type === "ClosedEvent") open = false;
    else if (event.type === "ReopenedEvent") open = true;
    else if (event.label === SHELF_LABEL && event.type === "LabeledEvent") {
      labeled = true;
      start = event.createdAt;
    } else if (event.label === SHELF_LABEL && event.type === "UnlabeledEvent") {
      labeled = false;
      start = null;
    }
  }
  return { member: open && labeled, start: labeled ? start : null };
}
const allUnavailable = (reason, digestAt = null, cadenceComments = no(reason)) => ({
  digestAt,
  cadenceComments,
  currentCount: no(reason),
  ageBuckets: no(reason),
  weeklyDelta: no(reason),
  escalations: no(reason),
  budget: null,
});

export async function collectDigestAuthority({
  repo,
  token,
  request = globalThis.fetch,
  clock = () => new Date(),
  limits,
  thresholdDays = DEFAULT_DRAIN_THRESHOLD_DAYS,
}) {
  const budget = createAuthorityBudget(limits);
  const args = { repo, token, request, budget };
  let current;
  try {
    current = await currentShelf(args, "CURRENT_INITIAL");
  } catch (error) {
    return allUnavailable(code(error, "CURRENT_INITIAL_UNAVAILABLE"));
  }
  const successors = new Map();
  for (const issue of current) {
    try {
      successors.set(
        issue.number,
        ok({
          comments: await comments(args, issue.number, `ISSUE_${issue.number}_COMMENTS_INITIAL`),
          dependencies: await dependencies(args, issue.number, `ISSUE_${issue.number}_DEPENDENCIES_INITIAL`),
        }),
      );
    } catch (error) {
      const reason = code(error, `ISSUE_${issue.number}_SUCCESSOR_INITIAL_UNAVAILABLE`);
      if (reason.startsWith("GLOBAL_")) return allUnavailable(reason);
      successors.set(issue.number, no(reason));
    }
  }
  const now = clock();
  const digestAtMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(digestAtMs)) return allUnavailable("DIGEST_AT_INVALID");
  const digestAt = new Date(digestAtMs).toISOString();
  const cutoffMs = digestAtMs - 7 * DAY_MS;
  const cutoff = new Date(cutoffMs).toISOString();
  let updated;
  try {
    updated = ok((await search({ ...args, qualifier: `updated:>=${cutoff}`, stream: "UPDATED_INITIAL" })).items);
  } catch (error) {
    const reason = code(error, "UPDATED_INITIAL_UNAVAILABLE");
    if (reason.startsWith("GLOBAL_")) return allUnavailable(reason, digestAt);
    updated = no(reason);
  }
  let cadenceComments;
  try {
    cadenceComments = ok(
      await restPages({
        ...args,
        stream: "RECENT_REPOSITORY_COMMENTS",
        url: `${API}/repos/${repo}/issues/comments?since=${encodeURIComponent(cutoff)}&per_page=100&sort=created&direction=desc`,
        valid: validComment,
        identity: (comment) => comment.id,
      }),
    );
  } catch (error) {
    const reason = code(error, "RECENT_REPOSITORY_COMMENTS_UNAVAILABLE");
    if (reason.startsWith("GLOBAL_")) return allUnavailable(reason, digestAt, no(reason));
    cadenceComments = no(reason);
  }
  const union = new Map(current.map((issue) => [issue.number, issue]));
  if (updated.available)
    for (const issue of updated.value) {
      const prior = union.get(issue.number);
      if (prior && issueFact(prior) !== issueFact(issue)) {
        updated = no("CURRENT_UPDATED_SOURCE_MISMATCH");
        break;
      }
      union.set(issue.number, prior ?? issue);
    }
  const events = new Map();
  for (const issue of union.values()) {
    try {
      events.set(issue.number, ok(await lifecycle(args, issue.number, `ISSUE_${issue.number}_LIFECYCLE_INITIAL`)));
    } catch (error) {
      const reason = code(error, `ISSUE_${issue.number}_LIFECYCLE_INITIAL_UNAVAILABLE`);
      if (reason.startsWith("GLOBAL_")) return allUnavailable(reason, digestAt, cadenceComments);
      events.set(issue.number, no(reason));
    }
  }
  let currentReason = null;
  try {
    if (population(current) !== population(await currentShelf(args, "CURRENT_FINAL")))
      currentReason = "CURRENT_POPULATION_MOVED";
  } catch (error) {
    const reason = code(error, "CURRENT_FINAL_UNAVAILABLE");
    if (reason.startsWith("GLOBAL_")) return allUnavailable(reason, digestAt, cadenceComments);
    currentReason = reason;
  }
  let updatedReason = updated.available ? null : updated.reason;
  if (updated.available)
    try {
      if (
        population(updated.value) !==
        population((await search({ ...args, qualifier: `updated:>=${cutoff}`, stream: "UPDATED_FINAL" })).items)
      )
        updatedReason = "UPDATED_POPULATION_MOVED";
    } catch (error) {
      const reason = code(error, "UPDATED_FINAL_UNAVAILABLE");
      if (reason.startsWith("GLOBAL_")) return allUnavailable(reason, digestAt, cadenceComments);
      updatedReason = reason;
    }
  for (const issue of union.values()) {
    try {
      const finalAuthority = await lifecycle(args, issue.number, `ISSUE_${issue.number}_LIFECYCLE_FINAL`);
      if (
        issueFact(issue) !== issueFact(finalAuthority.issue) ||
        !events.get(issue.number)?.available ||
        digest(events.get(issue.number).value) !== digest(finalAuthority)
      ) {
        const reason = `ISSUE_${issue.number}_AUTHORITY_MOVED`;
        events.set(issue.number, no(reason));
        if (current.some((row) => row.number === issue.number)) currentReason ??= reason;
        if (updated.available && updated.value.some((row) => row.number === issue.number)) updatedReason ??= reason;
      }
    } catch (error) {
      const reason = code(error, `ISSUE_${issue.number}_FINAL_UNAVAILABLE`);
      if (reason.startsWith("GLOBAL_")) return allUnavailable(reason, digestAt, cadenceComments);
      events.set(issue.number, no(reason));
      if (current.some((row) => row.number === issue.number)) currentReason ??= reason;
      if (updated.available && updated.value.some((row) => row.number === issue.number)) updatedReason ??= reason;
    }
  }
  for (const issue of current) {
    const first = successors.get(issue.number);
    if (!first?.available) continue;
    try {
      const final = {
        comments: await comments(args, issue.number, `ISSUE_${issue.number}_COMMENTS_FINAL`),
        dependencies: await dependencies(args, issue.number, `ISSUE_${issue.number}_DEPENDENCIES_FINAL`),
      };
      if (digest(first.value) !== digest(final))
        successors.set(issue.number, no(`ISSUE_${issue.number}_SUCCESSOR_AUTHORITY_MOVED`));
      else successors.set(issue.number, ok(final));
    } catch (error) {
      const reason = code(error, `ISSUE_${issue.number}_SUCCESSOR_FINAL_UNAVAILABLE`);
      if (reason.startsWith("GLOBAL_")) return allUnavailable(reason, digestAt, cadenceComments);
      successors.set(issue.number, no(reason));
    }
  }
  const currentCount = currentReason ? no(currentReason) : ok(current.length);
  const currentMembership = new Map();
  let agesReason = currentReason;
  if (!agesReason)
    for (const issue of current) {
      const history = events.get(issue.number);
      const state = history?.available ? membership(issue, history.value.events, digestAtMs) : null;
      if (!state?.member || !state.start) {
        agesReason = history?.reason ?? `ISSUE_${issue.number}_CONTINUOUS_SHELF_UNPROVEN`;
        break;
      }
      currentMembership.set(issue.number, state);
    }
  let ageBuckets;
  if (agesReason) ageBuckets = no(agesReason);
  else {
    const buckets = { "[0,7)": 0, "[7,14)": 0, "[14,28)": 0, "[28,∞)": 0 };
    for (const state of currentMembership.values()) {
      const age = (digestAtMs - Date.parse(state.start)) / DAY_MS;
      buckets[age < 7 ? "[0,7)" : age < 14 ? "[7,14)" : age < 28 ? "[14,28)" : "[28,∞)"] += 1;
    }
    ageBuckets = ok(buckets);
  }
  let weeklyDelta;
  if (currentReason || updatedReason || !updated.available)
    weeklyDelta = no(currentReason ?? updatedReason ?? updated.reason);
  else {
    let prior = 0;
    let reason = null;
    for (const issue of union.values()) {
      const history = events.get(issue.number);
      if (!history?.available) {
        reason = history?.reason;
        break;
      }
      if (membership(issue, history.value.events, cutoffMs).member) prior += 1;
    }
    weeklyDelta = reason ? no(reason) : ok(current.length - prior);
  }
  let escalations;
  if (agesReason) escalations = no(agesReason);
  else {
    const eligible = [];
    const unavailableRows = [];
    for (const issue of current) {
      const ageDays = (digestAtMs - Date.parse(currentMembership.get(issue.number).start)) / DAY_MS;
      if (ageDays < thresholdDays) continue;
      const authority = successors.get(issue.number);
      if (!authority?.available) {
        unavailableRows.push({ issue, ageDays, reason: authority?.reason ?? "SUCCESSOR_AUTHORITY_MISSING" });
        continue;
      }
      const classification = parseSuccessorAuthority(
        authority.value.comments.values,
        authority.value.dependencies,
        issue.number,
        repo,
      );
      if (!classification.available) unavailableRows.push({ issue, ageDays, reason: classification.reason });
      else if (classification.value.classification === "confirmed-none") eligible.push({ issue, ageDays });
    }
    const order = (a, b) => b.ageDays - a.ageDays || a.issue.number - b.issue.number;
    eligible.sort(order);
    unavailableRows.sort(order);
    escalations = ok({ eligible, unavailable: unavailableRows });
  }
  return { digestAt, cadenceComments, currentCount, ageBuckets, weeklyDelta, escalations, budget: { ...budget.state } };
}

const renderMetric = (metric, format = String) =>
  metric.available ? format(metric.value) : `unavailable (${metric.reason})`;
export function renderShelfDigest(result) {
  const lines = [
    "## Needs-replan shelf",
    "",
    `Digest at: ${result.digestAt ?? "unavailable"}`,
    `Current count: ${renderMetric(result.currentCount)}`,
    `Continuous-shelf age buckets: ${renderMetric(result.ageBuckets, (value) =>
      Object.entries(value)
        .map(([bucket, count]) => `${bucket}: ${count}`)
        .join(" · "),
    )}`,
    `Week-over-week delta: ${renderMetric(result.weeklyDelta, (value) => `${value >= 0 ? "+" : ""}${value}`)}`,
    "",
    "### Weekly drain",
    "",
  ];
  if (!result.escalations.available) {
    lines.push(`unavailable (${result.escalations.reason})`);
    return lines.join("\n");
  }
  const rows = result.escalations.value;
  if (!rows.eligible.length) lines.push("No issue currently qualifies for the weekly drain target.");
  for (const [index, row] of rows.eligible.entries())
    lines.push(
      `- **${index === 0 ? "This week's drain target" : "Escalation"}:** [#${row.issue.number}](${row.issue.url}) ${row.issue.title} — ${row.ageDays.toFixed(1)} days`,
      "  Required disposition: REPAIR_IN_PLACE | REPLACED | RECOMMEND_NOT_COMPLETING",
    );
  if (rows.unavailable.length) {
    lines.push("", "### Successor authority unavailable", "");
    for (const row of rows.unavailable)
      lines.push(`- [#${row.issue.number}](${row.issue.url}) — unavailable (${row.reason})`);
  }
  return lines.join("\n");
}

export async function runReviewCadenceDigest({
  env = process.env,
  request = globalThis.fetch,
  clock = () => new Date(),
  collectAuthority = collectDigestAuthority,
  writeOutput = console.log,
  appendSummary,
} = {}) {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN) {
    writeOutput("GITHUB_REPOSITORY and GITHUB_TOKEN are required.");
    return 2;
  }
  let authority;
  try {
    authority = await collectAuthority({ repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, request, clock });
  } catch (error) {
    writeOutput(`Digest authority collection failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (!["currentCount", "ageBuckets", "weeklyDelta", "escalations"].every((field) => authority?.[field])) {
    writeOutput("Digest authority collection omitted the live needs-replan shelf source.");
    return 2;
  }
  const cadence = authority.cadenceComments?.available
    ? buildCadenceDigest(authority.cadenceComments.value)
    : {
        flagged: true,
        markdown: `## Review cadence digest\n\nunavailable (${authority.cadenceComments?.reason ?? "CADENCE_COMMENTS_MISSING"})`,
      };
  const markdown = `${cadence.markdown}\n\n${renderShelfDigest(authority)}`;
  writeOutput(markdown);
  if (appendSummary) await appendSummary(markdown);
  else if (env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
  const shelfFlagged =
    !authority.currentCount.available ||
    !authority.ageBuckets.available ||
    !authority.weeklyDelta.available ||
    !authority.escalations.available ||
    authority.escalations.value.eligible.length > 0 ||
    authority.escalations.value.unavailable.length > 0;
  return cadence.flagged || shelfFlagged ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("review-cadence-digest.mjs"))
  process.exitCode = await runReviewCadenceDigest();
