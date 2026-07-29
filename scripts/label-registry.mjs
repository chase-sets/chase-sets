/**
 * Canonical repository label registry.
 *
 * Implementation-head capture date: 2026-07-29
 * Member capture (read-only, paginated to exhaustion):
 *   gh api --paginate '/repos/chase-sets/chase-sets/labels?per_page=100' --jq '.[].name'
 * Independent total:
 *   gh api graphql -f query='query { repository(owner:"chase-sets", name:"chase-sets") { labels(first:1) { totalCount } } }' --jq '.data.repository.labels.totalCount'
 * Observed reconciliation: 81 REST members / 81 GraphQL total.
 * Enabled type capture (read-only):
 *   gh api graphql -f query='query { organization(login:"chase-sets") { issueTypes(first:20) { nodes { name isEnabled } } } }'
 *
 * This file is the source of truth. Issue forms, the form labeler, the label
 * charter, and the scheduled live audit are derived from or asserted against
 * this registry.
 */

import { appendFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const LABEL_STATUSES = Object.freeze(["canonical", "grandfathered-frozen"]);
export const BANNED_LABEL_PREFIXES = Object.freeze(["phase:", "stage:", "series:", "tier:"]);
export const ENABLED_NATIVE_ISSUE_TYPES = Object.freeze([
  "Task",
  "Bug",
  "Feature",
  "Epic",
  "Slice",
  "Decision",
  "Probe",
]);

const CLEANUP_POINTER = "Cleanup owner: #6174.";
const SLICE_FORM_FAMILIES = new Set(["priority", "area", "kind"]);
const LEGACY_EPIC_LABEL = "kind:epic";
const API_ORIGIN = "https://api.github.com";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function entries(status, family, purpose, names) {
  return names.map((name) => Object.freeze({ name, family, purpose, status }));
}

const canonicalEntries = [
  ...entries("canonical", "area", "Owning context used for dispatch and collision avoidance.", [
    "area:auth",
    "area:catalog",
    "area:checkout",
    "area:collections",
    "area:commercial-terms",
    "area:design-system",
    "area:discovery",
    "area:fulfillment",
    "area:identity",
    "area:infrastructure",
    "area:inventory",
    "area:marketplace",
    "area:marketplace-web",
    "area:notifications",
    "area:ops",
    "area:ordering",
    "area:payments",
    "area:platform-runtime",
    "area:pricing",
    "area:public-presence",
    "area:settlement",
    "area:support",
    "area:tax",
  ]),
  ...entries("canonical", "kind", "Nature of slice work selected by the issue form.", [
    "kind:product",
    "kind:tech-debt",
    "kind:security",
    "kind:test",
    "kind:ops",
  ]),
  ...entries("canonical", "kind", "Legacy Epic classification fallback retained for existing untyped issues.", [
    "kind:epic",
  ]),
  ...entries("canonical", "priority", "Dispatch rank selected by the slice issue form.", [
    "priority:p0",
    "priority:p1",
    "priority:p2",
    "priority:p3",
  ]),
  ...entries("canonical", "risk", "Named delivery or product risk.", [
    "risk:data-quality",
    "risk:policy",
    "risk:provider",
    "risk:semantic-authority",
  ]),
  ...entries("canonical", "status", "Lifecycle exception with repository-wide meaning.", [
    "status:follow-up-after-first-slice",
    "status:needs-operator",
    "status:needs-replan",
    "status:tracking-only",
  ]),
  ...entries("canonical", "control", "Repository workflow control.", ["ci-circuit-repair", "full-ci", "preview"]),
  ...entries("canonical", "control", "Native Decision issue compatibility label.", ["decision"]),
  ...entries("canonical", "control", "Orchestrator scheduling constraint for a drained PR flush window.", [
    "dispatch:flush-window",
  ]),
];

const frozenEntries = [
  ...entries(
    "grandfathered-frozen",
    "phase",
    `Retained only on existing workstream issues; never apply or recreate. ${CLEANUP_POINTER}`,
    [
      "phase:api-runtime",
      "phase:architecture-fitness",
      "phase:audit-evidence",
      "phase:compatibility",
      "phase:consistency",
      "phase:data-governance",
      "phase:data-migration",
      "phase:domain-model",
      "phase:external-provider-validation",
      "phase:integration-engine",
      "phase:launch",
      "phase:legal-review",
      "phase:observability",
      "phase:operator-acceptance",
      "phase:performance",
      "phase:persistence",
      "phase:rbac",
      "phase:readiness",
      "phase:rollout-controls",
      "phase:sequencing",
      "phase:test-docs",
      "phase:ui-composition",
      "phase:ux-acceptance",
    ],
  ),
  ...entries(
    "grandfathered-frozen",
    "series",
    `Retained only on existing workstream issues; never apply or recreate. ${CLEANUP_POINTER}`,
    ["series:mobile-app-stores"],
  ),
  ...entries(
    "grandfathered-frozen",
    "tier",
    `Retained only on existing workstream issues; never apply or recreate. ${CLEANUP_POINTER}`,
    ["tier:2-pipeline", "tier:4-structural"],
  ),
  ...entries(
    "grandfathered-frozen",
    "legacy",
    `Unregistered legacy label retained only on existing issues; never apply or recreate. ${CLEANUP_POINTER}`,
    [
      "bug",
      "checkout",
      "device:mobile",
      "documentation",
      "integration:google-shopping",
      "qa",
      "release-process-evolution",
      "staging-qa",
      "stripe-connect",
    ],
  ),
];

export const LABEL_REGISTRY = Object.freeze([...canonicalEntries, ...frozenEntries]);

export function validateLabelRegistry(registry = LABEL_REGISTRY) {
  const diagnostics = [];
  const names = new Set();

  for (const [index, entry] of registry.entries()) {
    if (!entry || typeof entry !== "object") {
      diagnostics.push(`LABEL_REGISTRY_ENTRY_INVALID: entry ${index} is not an object.`);
      continue;
    }

    const { name, family, purpose, status } = entry;
    if (typeof name !== "string" || name.trim() !== name || name.length === 0) {
      diagnostics.push(`LABEL_REGISTRY_NAME_INVALID: entry ${index} must have an exact non-empty name.`);
    } else if (names.has(name)) {
      diagnostics.push(`LABEL_REGISTRY_DUPLICATE: ${name}`);
    } else {
      names.add(name);
    }
    if (typeof family !== "string" || family.trim().length === 0) {
      diagnostics.push(`LABEL_REGISTRY_FAMILY_MISSING: ${String(name)}`);
    }
    if (typeof purpose !== "string" || purpose.trim().length === 0) {
      diagnostics.push(`LABEL_REGISTRY_PURPOSE_MISSING: ${String(name)}`);
    }

    switch (status) {
      case "canonical":
        if (BANNED_LABEL_PREFIXES.some((prefix) => String(name).startsWith(prefix))) {
          diagnostics.push(`LABEL_REGISTRY_BANNED_CANONICAL: ${String(name)}`);
        }
        break;
      case "grandfathered-frozen":
        if (typeof name !== "string" || name.includes("*") || name.includes("?") || name.endsWith(":")) {
          diagnostics.push(`LABEL_REGISTRY_FROZEN_NOT_EXACT: ${String(name)}`);
        }
        if (typeof purpose !== "string" || !/#6174\b/.test(purpose)) {
          diagnostics.push(`LABEL_REGISTRY_FROZEN_CLEANUP_MISSING: ${String(name)}`);
        }
        break;
      default:
        diagnostics.push(`LABEL_REGISTRY_STATUS_UNKNOWN: ${String(name)} (${String(status)})`);
    }
  }

  return diagnostics;
}

export function canonicalLabelNames(family) {
  return LABEL_REGISTRY.filter((entry) => entry.status === "canonical" && entry.family === family).map(
    (entry) => entry.name,
  );
}

export function sliceFormValues(family) {
  if (!SLICE_FORM_FAMILIES.has(family)) {
    throw new Error(`Unsupported slice form label family: ${family}`);
  }
  return canonicalLabelNames(family)
    .filter((name) => name !== LEGACY_EPIC_LABEL)
    .map((name) => name.slice(name.indexOf(":") + 1));
}

function diagnostic(code, message) {
  return `${code}: ${message}`;
}

export function auditLabelInventory(liveNames, registry = LABEL_REGISTRY) {
  const failures = validateLabelRegistry(registry);
  const byName = new Map(registry.map((entry) => [entry.name, entry]));
  const observed = new Set();
  const observedFrozen = [];

  for (const name of liveNames) {
    if (observed.has(name)) {
      failures.push(diagnostic("LABEL_LIVE_DUPLICATE", `Live collection repeated ${name}.`));
      continue;
    }
    observed.add(name);

    const entry = byName.get(name);
    const bannedPrefix = BANNED_LABEL_PREFIXES.find((prefix) => name.startsWith(prefix));
    if (!entry) {
      failures.push(
        bannedPrefix
          ? diagnostic(
              "LABEL_BANNED_NOT_FROZEN",
              `${name} uses banned prefix ${bannedPrefix} without an exact grandfathered-frozen entry.`,
            )
          : diagnostic("LABEL_UNREGISTERED", `${name} is live but absent from the registry.`),
      );
      continue;
    }

    switch (entry.status) {
      case "canonical":
        if (bannedPrefix) {
          failures.push(
            diagnostic(
              "LABEL_BANNED_NOT_FROZEN",
              `${name} uses banned prefix ${bannedPrefix} but is not grandfathered-frozen.`,
            ),
          );
        }
        break;
      case "grandfathered-frozen":
        observedFrozen.push(name);
        break;
      default:
        failures.push(
          diagnostic("LABEL_STATUS_UNHANDLED", `${name} has unhandled registry status ${String(entry.status)}.`),
        );
    }
  }

  const missingCanonical = registry
    .filter((entry) => entry.status === "canonical" && !observed.has(entry.name))
    .map((entry) => entry.name);
  for (const name of missingCanonical) {
    failures.push(diagnostic("LABEL_CANONICAL_MISSING", `${name} is canonical but not live.`));
  }

  const missingFrozen = registry
    .filter((entry) => entry.status === "grandfathered-frozen" && !observed.has(entry.name))
    .map((entry) => entry.name);

  return {
    ok: failures.length === 0,
    failures,
    missingCanonical,
    missingFrozen,
    observedFrozen: observedFrozen.sort(),
  };
}

export class LabelCollectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LabelCollectionError";
    this.code = code;
  }
}

function collectionError(code, message) {
  return new LabelCollectionError(code, message);
}

function requestHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
}

async function readJson(response, code, description) {
  if (!response.ok) {
    throw collectionError(code, `${description} failed: ${response.status} ${await response.text()}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw collectionError(code, `${description} returned invalid JSON: ${error.message}`);
  }
}

async function fetchIndependentTotal({ repo, token, client }) {
  const query =
    "query LabelRegistryTotal($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { databaseId labels(first: 1) { totalCount pageInfo { hasNextPage endCursor } } } }";
  const [owner, name] = repo.split("/");
  const response = await client(`${API_ORIGIN}/graphql`, {
    method: "POST",
    headers: { ...requestHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { owner, name } }),
  });
  const payload = await readJson(response, "LABEL_TOTAL_REQUEST_FAILED", "Independent label total query");
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw collectionError("LABEL_TOTAL_GRAPHQL_ERROR", JSON.stringify(payload.errors));
  }
  const repository = payload.data?.repository;
  const labels = repository?.labels;
  if (!Number.isInteger(repository?.databaseId) || repository.databaseId <= 0) {
    throw collectionError("LABEL_REPOSITORY_ID_INVALID", "Repository database ID is not a positive integer.");
  }
  if (!Number.isInteger(labels?.totalCount) || labels.totalCount < 0) {
    throw collectionError("LABEL_TOTAL_INVALID", "Independent label total is not a non-negative integer.");
  }
  if (labels.pageInfo?.hasNextPage === true && !labels.pageInfo.endCursor) {
    throw collectionError(
      "LABEL_TOTAL_PAGE_UNFINISHED",
      "Independent total query reported another page without an end cursor.",
    );
  }
  return { repositoryDatabaseId: repository.databaseId, totalCount: labels.totalCount };
}

function nextLink(headerValue) {
  if (!headerValue) return null;
  let next = null;
  for (const part of headerValue.split(",")) {
    const match = part.trim().match(/^<([^>]+)>\s*;\s*rel="([^"]+)"$/);
    if (!match) {
      throw collectionError("LABEL_PAGINATION_LINK_INVALID", `Unparseable Link member: ${part.trim()}`);
    }
    if (match[2].split(/\s+/).includes("next")) {
      if (next) {
        throw collectionError("LABEL_PAGINATION_LINK_INVALID", "Multiple rel=next links were returned.");
      }
      next = match[1];
    }
  }
  return next;
}

function assertSafeNextUrl(candidate, repo, repositoryDatabaseId) {
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw collectionError("LABEL_PAGINATION_NEXT_UNSAFE", `Invalid next URL: ${candidate}`);
  }
  const expectedPath = `/repos/${repo}/labels`;
  const expectedDatabasePath = `/repositories/${repositoryDatabaseId}/labels`;
  const page = parsed.searchParams.get("page");
  const parameterNames = [...parsed.searchParams.keys()];
  if (
    parsed.origin !== API_ORIGIN ||
    (parsed.pathname !== expectedPath && parsed.pathname !== expectedDatabasePath) ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.searchParams.get("per_page") !== "100" ||
    !/^[1-9]\d*$/.test(page ?? "") ||
    parameterNames.some((name) => name !== "page" && name !== "per_page")
  ) {
    throw collectionError("LABEL_PAGINATION_NEXT_UNSAFE", `Refused unsafe next URL: ${candidate}`);
  }
  return parsed.toString();
}

export async function collectLiveLabels({ repo, token, client = globalThis.fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) {
    throw collectionError("LABEL_REPOSITORY_INVALID", `Expected owner/name, received ${String(repo)}.`);
  }

  const { repositoryDatabaseId, totalCount } = await fetchIndependentTotal({ repo, token, client });
  let url = `${API_ORIGIN}/repos/${repo}/labels?per_page=100`;
  const visited = new Set();
  const names = [];
  let pages = 0;

  while (url) {
    if (visited.has(url)) {
      throw collectionError("LABEL_PAGINATION_CYCLE", `Pagination repeated ${url}.`);
    }
    visited.add(url);
    const response = await client(url, { headers: requestHeaders(token) });
    const payload = await readJson(response, "LABEL_PAGE_REQUEST_FAILED", `Label page ${pages + 1}`);
    if (!Array.isArray(payload)) {
      throw collectionError("LABEL_PAGE_INVALID", `Label page ${pages + 1} is not an array.`);
    }
    for (const entry of payload) {
      if (typeof entry?.name !== "string" || entry.name.length === 0) {
        throw collectionError("LABEL_PAGE_MEMBER_INVALID", `Label page ${pages + 1} contains an invalid member.`);
      }
      names.push(entry.name);
    }
    pages += 1;

    const candidate = nextLink(response.headers?.get?.("link"));
    url = candidate ? assertSafeNextUrl(candidate, repo, repositoryDatabaseId) : null;
  }

  const uniqueCount = new Set(names).size;
  if (uniqueCount !== names.length) {
    throw collectionError(
      "LABEL_COLLECTION_DUPLICATE",
      `Collected ${names.length} rows but only ${uniqueCount} unique label names.`,
    );
  }
  if (names.length !== totalCount) {
    throw collectionError(
      "LABEL_COLLECTION_COUNT_MISMATCH",
      `Collected ${names.length} labels across ${pages} page(s), independent total ${totalCount}.`,
    );
  }

  return { names: names.sort(), pages, totalCount };
}

export async function collectFrozenUsageCounts({ repo, token, frozenNames, client = globalThis.fetch }) {
  if (frozenNames.length === 0) return new Map();
  const fields = frozenNames.map((_, index) => `l${index}: search(type: ISSUE, query: $q${index}) { issueCount }`);
  const variableDefinitions = frozenNames.map((_, index) => `$q${index}: String!`);
  const variables = Object.fromEntries(
    frozenNames.map((name, index) => [`q${index}`, `repo:${repo} is:issue is:open label:"${name}"`]),
  );
  const query = `query FrozenLabelUsage(${variableDefinitions.join(", ")}) { ${fields.join(" ")} }`;
  const response = await client(`${API_ORIGIN}/graphql`, {
    method: "POST",
    headers: { ...requestHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await readJson(response, "LABEL_USAGE_REQUEST_FAILED", "Frozen-label usage query");
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw collectionError("LABEL_USAGE_GRAPHQL_ERROR", JSON.stringify(payload.errors));
  }

  const counts = new Map();
  for (const [index, name] of frozenNames.entries()) {
    const count = payload.data?.[`l${index}`]?.issueCount;
    if (!Number.isInteger(count) || count < 0) {
      throw collectionError("LABEL_USAGE_INVALID", `No valid open-issue count returned for ${name}.`);
    }
    counts.set(name, count);
  }
  return counts;
}

export function inspectAreaContextCoverage(root = repoRoot) {
  const contexts = readdirSync(path.join(root, "bounded-contexts"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const areas = canonicalLabelNames("area")
    .map((name) => name.slice("area:".length))
    .sort();
  return {
    contextCount: contexts.length,
    areaCount: areas.length,
    contextsWithoutArea: contexts.filter((name) => !areas.includes(name)),
    areasWithoutContext: areas.filter((name) => !contexts.includes(name)),
  };
}

export function renderLabelAuditReport({ inventory, audit, usageCounts = new Map(), coverage }) {
  const lines = [
    `Label inventory scanned: ${inventory.names.length}/${inventory.totalCount} across ${inventory.pages} REST page(s); independent GraphQL total reconciled.`,
  ];

  if (audit.ok) {
    lines.push("Label registry enforcement passed: every live label is partitioned.");
  } else {
    lines.push("Label registry enforcement failed:");
    lines.push(...audit.failures.map((failure) => `- ${failure}`));
  }

  lines.push(
    audit.observedFrozen.length === 0
      ? "Grandfathered (frozen), observed: none."
      : `Grandfathered (frozen), observed: ${audit.observedFrozen.length} exact label(s).`,
  );
  if (usageCounts === null) {
    lines.push("Grandfathered (frozen) open-issue usage unavailable (advisory collection indeterminate).");
  } else {
    const nonzeroUsage = [...usageCounts].filter(([, count]) => count > 0);
    lines.push(
      nonzeroUsage.length === 0
        ? "Grandfathered (frozen) open-issue usage observed: none."
        : `Grandfathered (frozen) open-issue usage observed: ${nonzeroUsage
            .map(([name, count]) => `${name}=${count}`)
            .join(", ")}.`,
    );
  }
  if (audit.missingFrozen.length > 0) {
    lines.push(
      `Ratchet-down candidates observed (registered frozen label no longer live): ${audit.missingFrozen.join(", ")}.`,
    );
  }
  if (coverage === null) {
    lines.push("Context coverage unavailable (advisory collection indeterminate).");
  } else if (coverage) {
    lines.push(
      `Context coverage observed (advisory, not applied policy): ${coverage.contextCount} contexts / ${coverage.areaCount} areas; contexts without area: ${coverage.contextsWithoutArea.join(", ") || "none"}; areas without context: ${coverage.areasWithoutContext.join(", ") || "none"}.`,
    );
  }
  return lines;
}

export async function main({
  env = process.env,
  client = globalThis.fetch,
  logger = console,
  root = repoRoot,
  summaryWriter = (text) => appendFileSync(env.GITHUB_STEP_SUMMARY, text),
} = {}) {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repo || !token) {
    logger.error("LABEL_AUDIT_ENV_MISSING: GITHUB_REPOSITORY and GITHUB_TOKEN are required.");
    return 2;
  }

  let inventory;
  try {
    inventory = await collectLiveLabels({ repo, token, client });
  } catch (error) {
    logger.error(`${error.name ?? "Error"}[${error.code ?? "LABEL_COLLECTION_FAILED"}]: ${error.message}`);
    return 1;
  }

  const audit = auditLabelInventory(inventory.names);
  let usageCounts = null;
  try {
    usageCounts = await collectFrozenUsageCounts({
      repo,
      token,
      frozenNames: audit.observedFrozen,
      client,
    });
  } catch (error) {
    logger.warn(`Grandfathered (frozen) usage count unavailable (advisory collection indeterminate): ${error.message}`);
  }

  let coverage = null;
  try {
    coverage = inspectAreaContextCoverage(root);
  } catch (error) {
    logger.warn(`Context coverage unavailable (advisory collection indeterminate): ${error.message}`);
  }

  const report = renderLabelAuditReport({ inventory, audit, usageCounts, coverage });
  for (const line of report) logger.log(line);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      summaryWriter(`## Canonical label registry audit\n\n${report.join("\n\n")}\n`);
    } catch (error) {
      logger.warn(`Step summary unavailable (advisory write failed): ${error.message}`);
    }
  }
  return audit.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
