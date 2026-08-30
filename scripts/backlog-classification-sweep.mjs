import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { classified, isEpic, isTrackingOnly } from "./backlog-classify.mjs";
import { collectStableIssueAuthority } from "./issue-readiness.mjs";
import { canonicalLabelNames, ENABLED_NATIVE_ISSUE_TYPES } from "./label-registry.mjs";
import { repoRoot } from "./lib/repo.mjs";
import { collectRoadmapWindowAuthority } from "./roadmap-status.mjs";

export const SWEEP_REPOSITORY = "chase-sets/chase-sets";
export const PLAN_SCHEMA_VERSION = "issue-7536-classification-plan/v1";
export const DECISION_SCHEMA_VERSION = "issue-7536-classification-decisions/v1";
export const JOURNAL_SCHEMA_VERSION = "issue-7536-classification-journal/v1";
export const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
export const REST_API_VERSION = "2022-11-28";
export const MAX_LOGICAL_STEPS = 15;
export const MAX_PAGES = 100;
export const MAX_ITEMS = 10_000;
const CONTAINER_ROOT = path.dirname(repoRoot);
export const REVIEW_REDUCER_PATH = path.join(CONTAINER_ROOT, ".orchestrator", "review-head-reducer.ps1");
export const REVIEW_HISTORY_PATH = path.join(CONTAINER_ROOT, ".orchestrator", "dispatch-log.jsonl");
export const PLAN_PATH = "planning-artifacts/issue-7536/plan.json";
export const ROADMAP_PATH = "planning-artifacts/issue-7536/roadmap.md";
export const AUTHORIZED_MILESTONE_NUMBER = 136;
export const AUTHORIZED_MILESTONE_TITLE = "Wave 1 — Platform Foundation & Representative Staging";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OID = /^[a-f0-9]{40}$/;
const PLAN_BRANCH = /^codex\/issue-7536-plan-review-[0-9]{14}-[a-f0-9]{12}-[a-f0-9]{8}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const JOURNAL_MARKER =
  /<!-- chase-sets:issue-7536-classification:v1 plan=([a-f0-9]{64}) attempt=([a-f0-9-]{36}) seq=(\d+) sha=([a-f0-9]{64}) -->/g;
const CLASSIFICATION_FAMILIES = Object.freeze(["priority", "area", "kind"]);

const PLAN_KEYS = Object.freeze([
  "schemaVersion",
  "repository",
  "milestone",
  "implementation",
  "environment",
  "issueBodyAuthority",
  "decisionDigest",
  "capturedAt",
  "roadmapRender",
  "windowAuthorityDigest",
  "labelRegistry",
  "typeRegistry",
  "permission",
  "issueFingerprints",
  "includedNumbers",
  "excludedNumbers",
  "gapNumbers",
  "targets",
  "logicalStepCount",
  "planDigest",
]);

export class BacklogClassificationSweepError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "BacklogClassificationSweepError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message = code, details) {
  throw new BacklogClassificationSweepError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code = "SCHEMA_KEYS_INVALID") {
  if (!isObject(value)) fail(code);
  const actual = Object.keys(value).sort(compareOrdinal);
  const expected = [...keys].sort(compareOrdinal);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  return value;
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveInteger(value, code = "POSITIVE_INTEGER_INVALID") {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function nonNegativeInteger(value, code = "NON_NEGATIVE_INTEGER_INVALID") {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function requiredString(value, code = "STRING_INVALID") {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

function timestamp(value, code = "TIMESTAMP_INVALID") {
  if (typeof value !== "string" || !UTC_MILLISECONDS.test(value) || !Number.isFinite(Date.parse(value))) fail(code);
  return value;
}

function sha(value, code = "SHA256_INVALID") {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function oid(value, code = "GIT_OID_INVALID") {
  if (typeof value !== "string" || !GIT_OID.test(value)) fail(code);
  return value;
}

function strictlyAscending(values, code = "ASCENDING_SET_INVALID") {
  if (!Array.isArray(values)) fail(code);
  let previous = 0;
  for (const value of values) {
    positiveInteger(value, code);
    if (value <= previous) fail(code);
    previous = value;
  }
  return values;
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("CANONICAL_JSON_NUMBER_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort(compareOrdinal)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  fail("CANONICAL_JSON_TYPE_INVALID");
}

export function sha256Utf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeLf(value) {
  return String(value).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function bodySha256(body) {
  return sha256Utf8(normalizeLf(body));
}

export function digestCanonical(value) {
  return sha256Utf8(canonicalJson(value));
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

function validateDecisionEntry(entry) {
  exactKeys(
    entry,
    ["number", "nodeId", "updatedAt", "bodySha256", "addLabels", "setType"],
    "DECISION_ENTRY_KEYS_INVALID",
  );
  positiveInteger(entry.number, "DECISION_NUMBER_INVALID");
  requiredString(entry.nodeId, "DECISION_NODE_INVALID");
  if (typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt)))
    fail("DECISION_REVISION_INVALID");
  sha(entry.bodySha256, "DECISION_BODY_HASH_INVALID");
  if (
    !Array.isArray(entry.addLabels) ||
    entry.addLabels.some((label) => typeof label !== "string" || !/^(priority|area|kind):[^:]+$/.test(label)) ||
    new Set(entry.addLabels).size !== entry.addLabels.length ||
    entry.addLabels.some((label, index) => index > 0 && compareOrdinal(entry.addLabels[index - 1], label) >= 0)
  ) {
    fail("DECISION_LABELS_INVALID");
  }
  if (entry.setType !== null && typeof entry.setType !== "string") fail("DECISION_TYPE_INVALID");
  if (entry.setType !== null && entry.addLabels.length > 0) fail("DECISION_MULTIPLE_STEPS_INVALID");
  if (entry.setType === null && entry.addLabels.length === 0) fail("DECISION_EMPTY_DELTA_INVALID");
  return entry;
}

export function extractReviewedDecisionAuthority(body) {
  const normalized = normalizeLf(body);
  const fences = [];
  const pattern = /```json\n([\s\S]*?)\n```/g;
  for (const match of normalized.matchAll(pattern)) {
    const parsed = (() => {
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    })();
    if (parsed?.schemaVersion === DECISION_SCHEMA_VERSION) fences.push({ bytes: match[1], value: parsed });
  }
  if (fences.length !== 1) fail("DECISION_BLOCK_UNIQUE_INVALID");
  const { bytes, value } = fences[0];
  exactKeys(value, ["schemaVersion", "repository", "milestoneNumber", "entries"], "DECISION_BLOCK_KEYS_INVALID");
  if (value.schemaVersion !== DECISION_SCHEMA_VERSION) fail("DECISION_SCHEMA_INVALID");
  if (value.repository !== SWEEP_REPOSITORY) fail("DECISION_REPOSITORY_INVALID");
  positiveInteger(value.milestoneNumber, "DECISION_MILESTONE_INVALID");
  if (!Array.isArray(value.entries) || value.entries.length > MAX_LOGICAL_STEPS) fail("DECISION_ENTRIES_INVALID");
  value.entries.forEach(validateDecisionEntry);
  const numbers = value.entries.map((entry) => entry.number);
  if (new Set(numbers).size !== numbers.length) fail("DECISION_NUMBER_DUPLICATE");
  return { value, decisionDigest: sha256Utf8(bytes), decisionBytes: bytes };
}

function backlogInputFromFingerprint(issue) {
  return {
    number: issue.number,
    state: issue.state.toLowerCase(),
    labels: issue.labels.map((label) => label.name),
    issueTypeName: issue.issueType?.name ?? null,
    milestoneTitle: issue.milestone?.title ?? null,
    blockedByCount: 0,
    hasParent: false,
  };
}

export function governedFingerprint(issue) {
  const sourceLabels = Array.isArray(issue.labels) ? issue.labels : issue.labels?.nodes;
  if (!Array.isArray(sourceLabels)) fail("FINGERPRINT_LABEL_AUTHORITY_INVALID");
  const labels = [...sourceLabels]
    .map((label) => ({ id: requiredString(label.id ?? label.nodeId), name: requiredString(label.name) }))
    .sort((left, right) => compareOrdinal(`${left.id}\0${left.name}`, `${right.id}\0${right.name}`));
  if (issue.issueType && typeof issue.issueType.isEnabled !== "boolean") fail("FINGERPRINT_TYPE_AUTHORITY_INVALID");
  const issueType = issue.issueType
    ? {
        nodeId: requiredString(issue.issueType.nodeId ?? issue.issueType.id),
        name: requiredString(issue.issueType.name),
        isEnabled: issue.issueType.isEnabled,
      }
    : null;
  const milestone = issue.milestone
    ? {
        id: requiredString(issue.milestone.id),
        number: positiveInteger(issue.milestone.number),
        title: requiredString(issue.milestone.title),
        state: String(issue.milestone.state).toUpperCase(),
      }
    : null;
  if (milestone && !["OPEN", "CLOSED"].includes(milestone.state)) fail("FINGERPRINT_MILESTONE_STATE_INVALID");
  const base = {
    number: positiveInteger(issue.number),
    nodeId: requiredString(issue.nodeId ?? issue.id),
    state: String(issue.state).toUpperCase(),
    issueType,
    milestone,
    labels,
  };
  if (!["OPEN", "CLOSED"].includes(base.state)) fail("FINGERPRINT_STATE_INVALID");
  const input = backlogInputFromFingerprint(base);
  const epic = isEpic(input);
  const tracking = isTrackingOnly(input);
  return {
    ...base,
    isEpic: epic,
    isTrackingOnly: tracking,
    isGap:
      base.state === "OPEN" &&
      !epic &&
      !tracking &&
      (!classified(input) || base.issueType === null || base.issueType.isEnabled !== true),
  };
}

function issueAuthorityMap(authority) {
  const map = new Map();
  for (const entry of authority.issueAuthorities ?? []) {
    if (!entry?.complete) fail("ISSUE_AUTHORITY_INCOMPLETE");
    if (map.has(entry.issue.number)) fail("ISSUE_AUTHORITY_DUPLICATE");
    map.set(entry.issue.number, entry);
  }
  return map;
}

function classificationLabelNames() {
  return CLASSIFICATION_FAMILIES.flatMap((family) => canonicalLabelNames(family)).sort(compareOrdinal);
}

function reconcileLabelRegistry(value) {
  if (!Array.isArray(value)) fail("LABEL_REGISTRY_INVALID");
  const canonical = new Set(classificationLabelNames());
  const observed = new Map();
  for (const label of value) {
    exactKeys(label, ["id", "name"], "LABEL_REGISTRY_ENTRY_INVALID");
    requiredString(label.id, "LABEL_REGISTRY_ID_INVALID");
    requiredString(label.name, "LABEL_REGISTRY_NAME_INVALID");
    if (!canonical.has(label.name) || observed.has(label.name)) fail("LABEL_REGISTRY_RECONCILIATION_INVALID");
    observed.set(label.name, label);
  }
  if (observed.size !== canonical.size) fail("LABEL_REGISTRY_RECONCILIATION_INVALID");
  return [...observed.values()].sort((left, right) =>
    compareOrdinal(`${left.id}\0${left.name}`, `${right.id}\0${right.name}`),
  );
}

function reconcileTypeRegistry(value) {
  if (!Array.isArray(value)) fail("TYPE_REGISTRY_INVALID");
  const names = new Set();
  const nodes = value.map((entry) => {
    exactKeys(entry, ["nodeId", "name", "isEnabled"], "TYPE_REGISTRY_ENTRY_INVALID");
    requiredString(entry.nodeId, "TYPE_REGISTRY_ID_INVALID");
    requiredString(entry.name, "TYPE_REGISTRY_NAME_INVALID");
    if (typeof entry.isEnabled !== "boolean" || names.has(entry.name)) fail("TYPE_REGISTRY_ENTRY_INVALID");
    names.add(entry.name);
    return { ...entry };
  });
  for (const expected of ENABLED_NATIVE_ISSUE_TYPES) {
    const found = nodes.find((entry) => entry.name === expected);
    if (!found || found.isEnabled !== true) fail("TYPE_REGISTRY_REQUIRED_TYPE_INVALID");
  }
  return nodes.sort((left, right) => compareOrdinal(left.nodeId, right.nodeId));
}

function applyDecision(fingerprint, decision, labelsByName, typesByName) {
  const after = structuredClone(fingerprint);
  if (decision.setType !== null) {
    if (after.issueType !== null) fail("DECISION_PREIMAGE_TYPE_INVALID");
    const type = typesByName.get(decision.setType);
    if (!type?.isEnabled) fail("DECISION_TYPE_UNAVAILABLE");
    after.issueType = { ...type };
  }
  const existingNames = new Set(after.labels.map((label) => label.name));
  for (const name of decision.addLabels) {
    if (existingNames.has(name)) fail("DECISION_LABEL_ALREADY_PRESENT");
    const label = labelsByName.get(name);
    if (!label) fail("DECISION_LABEL_UNAVAILABLE");
    after.labels.push(label);
  }
  after.labels.sort((left, right) => compareOrdinal(`${left.id}\0${left.name}`, `${right.id}\0${right.name}`));
  const input = backlogInputFromFingerprint(after);
  after.isEpic = isEpic(input);
  after.isTrackingOnly = isTrackingOnly(input);
  after.isGap =
    after.state === "OPEN" &&
    !after.isEpic &&
    !after.isTrackingOnly &&
    (!classified(input) || after.issueType === null || after.issueType.isEnabled !== true);
  if (after.isGap) fail("DECISION_AFTER_STILL_GAP");
  return after;
}

function reverseDecision(afterImage, decision) {
  const before = structuredClone(afterImage);
  if (decision.setType !== null) {
    if (before.issueType?.name !== decision.setType) fail("DECISION_PARTIAL_AFTER_IMAGE");
    before.issueType = null;
  } else {
    const expected = new Set(decision.addLabels);
    if (decision.addLabels.some((name) => !before.labels.some((label) => label.name === name))) {
      fail("DECISION_PARTIAL_AFTER_IMAGE");
    }
    before.labels = before.labels.filter((label) => !expected.has(label.name));
  }
  const input = backlogInputFromFingerprint(before);
  before.isEpic = isEpic(input);
  before.isTrackingOnly = isTrackingOnly(input);
  before.isGap =
    before.state === "OPEN" &&
    !before.isEpic &&
    !before.isTrackingOnly &&
    (!classified(input) || before.issueType === null || before.issueType.isEnabled !== true);
  if (!before.isGap) fail("DECISION_AFTER_PREIMAGE_INVALID");
  return before;
}

function sameGoverned(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertAuthorizedMilestoneIdentity(milestone) {
  if (
    !milestone ||
    milestone.state !== "OPEN" ||
    (milestone.number === AUTHORIZED_MILESTONE_NUMBER && milestone.title !== AUTHORIZED_MILESTONE_TITLE)
  )
    fail("PLAN_MILESTONE_INVALID");
}

function deriveDecisionTarget(decision, before, labelsByName, typesByName) {
  const after = applyDecision(before, decision, labelsByName, typesByName);
  const step = targetStep(decision, before, after, labelsByName, typesByName);
  return { after, step };
}

function assertDecisionBoundTarget(decision, target, labelsByName, typesByName) {
  const { after, step } = deriveDecisionTarget(decision, target.before, labelsByName, typesByName);
  if (!sameGoverned(after, target.after)) fail("EXPECTED_PREFIX_DECISION_BINDING_INVALID");
  if (step.kind !== target.steps[0].kind || canonicalJson(step.request) !== canonicalJson(target.steps[0].request))
    fail("EXPECTED_PREFIX_DECISION_BINDING_INVALID");
}

function targetStep(decision, before, after, labelsByName, typesByName) {
  const common = {
    index: 0,
    beforeFingerprint: digestCanonical(before),
    afterFingerprint: digestCanonical(after),
  };
  if (decision.setType !== null) {
    return {
      ...common,
      kind: "set-type",
      request: { issueNodeId: before.nodeId, issueTypeId: typesByName.get(decision.setType).nodeId },
    };
  }
  return {
    ...common,
    kind: "add-labels",
    request: {
      labelableId: before.nodeId,
      labelIds: decision.addLabels.map((name) => labelsByName.get(name).id).sort(compareOrdinal),
    },
  };
}

export function renderClassificationPlanningRoadmap(windowAuthority) {
  const rows = windowAuthority.milestones.nodes
    .filter((milestone) => /^(Wave|Mobile)\s+\d+\b/.test(milestone.title))
    .map((milestone) => {
      const gaps = windowAuthority.issues.nodes
        .filter((issue) => issue.milestone?.id === milestone.id)
        .map(governedFingerprint)
        .filter((fingerprint) => fingerprint.isGap)
        .map((fingerprint) => fingerprint.number)
        .sort((left, right) => left - right);
      return { title: milestone.title, gaps };
    });
  return `${[
    "# Executable-horizon classification gaps",
    "",
    ...rows.map(
      ({ title, gaps }) =>
        `- ${title}: **${gaps.length}** — ${gaps.length === 0 ? "none" : gaps.map((number) => `#${number}`).join(", ")}`,
    ),
  ].join("\n")}\n`;
}

export function buildClassificationPlan({
  authority,
  issueNumber,
  milestoneNumber,
  landedMainSha,
  planBranch,
  capturedAt,
  roadmapPath = ROADMAP_PATH,
  roadmapBytes,
}) {
  positiveInteger(issueNumber, "PLAN_SCOPE_INVALID");
  if (authority.repository !== SWEEP_REPOSITORY) fail("PLAN_SCOPE_INVALID");
  oid(landedMainSha, "PLAN_MAIN_INVALID");
  if (!PLAN_BRANCH.test(planBranch)) fail("PLAN_BRANCH_INVALID");
  timestamp(capturedAt, "PLAN_CAPTURED_AT_INVALID");
  const issueAuthorities = issueAuthorityMap(authority);
  const issueBody = issueAuthorities.get(issueNumber);
  if (!issueBody) fail("ISSUE_BODY_AUTHORITY_MISSING");
  const decisions = extractReviewedDecisionAuthority(issueBody.issue.body);
  if (decisions.value.milestoneNumber !== milestoneNumber) fail("DECISION_MILESTONE_INVALID");
  const milestone = authority.window.authority.milestones.nodes.find((entry) => entry.number === milestoneNumber);
  assertAuthorizedMilestoneIdentity(milestone);
  const labels = reconcileLabelRegistry(authority.labelRegistry);
  const types = reconcileTypeRegistry(authority.typeRegistry);
  if (authority.permission?.repository !== SWEEP_REPOSITORY || authority.permission?.viewerPermission !== "ADMIN") {
    fail("PLAN_PERMISSION_INVALID");
  }
  requiredString(authority.permission.viewerLogin, "PLAN_VIEWER_INVALID");
  const labelsByName = new Map(labels.map((label) => [label.name, label]));
  const typesByName = new Map(types.map((type) => [type.name, type]));
  const fingerprints = authority.window.authority.issues.nodes
    .filter((issue) => issue.milestone?.number === milestoneNumber)
    .map(governedFingerprint)
    .sort((left, right) => left.number - right.number);
  const excluded = fingerprints.filter((entry) => entry.isEpic || entry.isTrackingOnly);
  const included = fingerprints.filter((entry) => !entry.isEpic && !entry.isTrackingOnly);
  const gaps = included.filter((entry) => entry.isGap);
  const fingerprintByNumber = new Map(fingerprints.map((entry) => [entry.number, entry]));
  const targets = [];
  const matchedEntries = new Set();

  for (const decision of decisions.value.entries) {
    const live = fingerprintByNumber.get(decision.number);
    const stable = issueAuthorities.get(decision.number);
    if (!live || !stable) fail("DECISION_ENTRY_UNMATCHED");
    if (stable.issue.nodeId !== decision.nodeId || bodySha256(stable.issue.body) !== decision.bodySha256) {
      fail("DECISION_IDENTITY_DRIFT");
    }
    const stableFingerprint = governedFingerprint({
      ...live,
      labels: stable.labels.map((label) => ({ id: label.nodeId, name: label.name })),
      issueType: stable.issue.issueType,
      milestone: { ...live.milestone },
    });
    if (!sameGoverned(live, stableFingerprint)) fail("DECISION_GLOBAL_AUTHORITY_MISMATCH");
    if (live.isGap) {
      if (stable.issue.updatedAt !== decision.updatedAt) fail("DECISION_PREIMAGE_REVISION_DRIFT");
      const { after, step } = deriveDecisionTarget(decision, live, labelsByName, typesByName);
      targets.push({
        number: live.number,
        nodeId: live.nodeId,
        decisionUpdatedAt: decision.updatedAt,
        bodySha256: decision.bodySha256,
        before: live,
        after,
        steps: [step],
      });
      matchedEntries.add(decision.number);
    } else {
      if (Date.parse(stable.issue.updatedAt) <= Date.parse(decision.updatedAt)) fail("DECISION_AFTER_REVISION_INVALID");
      const before = reverseDecision(live, decision);
      const after = applyDecision(before, decision, labelsByName, typesByName);
      if (!sameGoverned(live, after)) fail("DECISION_PARTIAL_AFTER_IMAGE");
      matchedEntries.add(decision.number);
    }
  }

  targets.sort((left, right) => left.number - right.number);

  if (matchedEntries.size !== decisions.value.entries.length) fail("DECISION_ENTRY_UNMATCHED");
  if (canonicalJson(gaps.map((entry) => entry.number)) !== canonicalJson(targets.map((entry) => entry.number))) {
    fail("PLAN_GAP_DECISION_MISMATCH");
  }
  if (targets.length > MAX_LOGICAL_STEPS) fail("PLAN_REQUEST_CAP_EXCEEDED");
  if (typeof roadmapBytes !== "string" || !roadmapBytes.endsWith("\n")) fail("ROADMAP_BYTES_INVALID");

  const issueBodyAuthority = {
    number: issueNumber,
    nodeId: issueBody.issue.nodeId,
    updatedAt: issueBody.issue.updatedAt,
    sha256: bodySha256(issueBody.issue.body),
  };
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    repository: SWEEP_REPOSITORY,
    milestone: { id: milestone.id, number: milestone.number, title: milestone.title, state: milestone.state },
    implementation: { landedMainSha, planBranch },
    environment: { repository: SWEEP_REPOSITORY, graphqlEndpoint: GRAPHQL_ENDPOINT, restApiVersion: REST_API_VERSION },
    issueBodyAuthority,
    decisionDigest: decisions.decisionDigest,
    capturedAt,
    roadmapRender: {
      path: roadmapPath,
      sha256: sha256Utf8(roadmapBytes),
      windowAuthorityDigest: authority.window.digest,
    },
    windowAuthorityDigest: authority.window.digest,
    labelRegistry: { value: labels, digest: digestCanonical(labels) },
    typeRegistry: { value: types, digest: digestCanonical(types) },
    permission: {
      ...authority.permission,
      digest: digestCanonical({
        repository: authority.permission.repository,
        viewerLogin: authority.permission.viewerLogin,
        viewerPermission: authority.permission.viewerPermission,
      }),
    },
    issueFingerprints: fingerprints,
    includedNumbers: included.map((entry) => entry.number),
    excludedNumbers: excluded.map((entry) => entry.number),
    gapNumbers: gaps.map((entry) => entry.number),
    targets,
    logicalStepCount: targets.length,
    planDigest: "",
  };
  plan.planDigest = digestCanonical(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "planDigest")));
  validateClassificationPlan(plan);
  return plan;
}

function validateLabel(label) {
  exactKeys(label, ["id", "name"], "PLAN_LABEL_KEYS_INVALID");
  requiredString(label.id, "PLAN_LABEL_ID_INVALID");
  requiredString(label.name, "PLAN_LABEL_NAME_INVALID");
}

function validateMilestone(value, code = "PLAN_MILESTONE_INVALID") {
  exactKeys(value, ["id", "number", "title", "state"], code);
  requiredString(value.id, code);
  positiveInteger(value.number, code);
  requiredString(value.title, code);
  if (!["OPEN", "CLOSED"].includes(value.state)) fail(code);
}

function validateFingerprint(value) {
  exactKeys(
    value,
    ["number", "nodeId", "state", "issueType", "milestone", "labels", "isEpic", "isTrackingOnly", "isGap"],
    "PLAN_FINGERPRINT_KEYS_INVALID",
  );
  positiveInteger(value.number, "PLAN_FINGERPRINT_NUMBER_INVALID");
  requiredString(value.nodeId, "PLAN_FINGERPRINT_NODE_INVALID");
  if (!["OPEN", "CLOSED"].includes(value.state)) fail("PLAN_FINGERPRINT_STATE_INVALID");
  if (value.issueType !== null) {
    exactKeys(value.issueType, ["nodeId", "name", "isEnabled"], "PLAN_FINGERPRINT_TYPE_INVALID");
    requiredString(value.issueType.nodeId, "PLAN_FINGERPRINT_TYPE_INVALID");
    requiredString(value.issueType.name, "PLAN_FINGERPRINT_TYPE_INVALID");
    if (typeof value.issueType.isEnabled !== "boolean") fail("PLAN_FINGERPRINT_TYPE_INVALID");
  }
  if (value.milestone !== null) validateMilestone(value.milestone, "PLAN_FINGERPRINT_MILESTONE_INVALID");
  if (!Array.isArray(value.labels)) fail("PLAN_FINGERPRINT_LABELS_INVALID");
  value.labels.forEach(validateLabel);
  if (
    new Set(value.labels.map((label) => label.id)).size !== value.labels.length ||
    new Set(value.labels.map((label) => label.name)).size !== value.labels.length
  )
    fail("PLAN_FINGERPRINT_LABELS_INVALID");
  if ([value.isEpic, value.isTrackingOnly, value.isGap].some((entry) => typeof entry !== "boolean")) {
    fail("PLAN_FINGERPRINT_FLAGS_INVALID");
  }
  if (!sameGoverned(value, governedFingerprint(value))) fail("PLAN_FINGERPRINT_SEMANTICS_INVALID");
}

export function validateClassificationPlan(plan) {
  exactKeys(plan, PLAN_KEYS, "PLAN_KEYS_INVALID");
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION || plan.repository !== SWEEP_REPOSITORY) fail("PLAN_IDENTITY_INVALID");
  validateMilestone(plan.milestone);
  assertAuthorizedMilestoneIdentity(plan.milestone);
  exactKeys(plan.implementation, ["landedMainSha", "planBranch"], "PLAN_IMPLEMENTATION_INVALID");
  oid(plan.implementation.landedMainSha, "PLAN_MAIN_INVALID");
  if (!PLAN_BRANCH.test(plan.implementation.planBranch)) fail("PLAN_BRANCH_INVALID");
  exactKeys(plan.environment, ["repository", "graphqlEndpoint", "restApiVersion"], "PLAN_ENVIRONMENT_INVALID");
  if (
    plan.environment.repository !== SWEEP_REPOSITORY ||
    plan.environment.graphqlEndpoint !== GRAPHQL_ENDPOINT ||
    plan.environment.restApiVersion !== REST_API_VERSION
  )
    fail("PLAN_ENVIRONMENT_INVALID");
  exactKeys(plan.issueBodyAuthority, ["number", "nodeId", "updatedAt", "sha256"], "PLAN_BODY_AUTHORITY_INVALID");
  positiveInteger(plan.issueBodyAuthority.number, "PLAN_BODY_AUTHORITY_INVALID");
  requiredString(plan.issueBodyAuthority.nodeId, "PLAN_BODY_AUTHORITY_INVALID");
  if (!Number.isFinite(Date.parse(plan.issueBodyAuthority.updatedAt))) fail("PLAN_BODY_AUTHORITY_INVALID");
  sha(plan.issueBodyAuthority.sha256, "PLAN_BODY_AUTHORITY_INVALID");
  sha(plan.decisionDigest, "PLAN_DECISION_DIGEST_INVALID");
  timestamp(plan.capturedAt, "PLAN_CAPTURED_AT_INVALID");
  exactKeys(plan.roadmapRender, ["path", "sha256", "windowAuthorityDigest"], "PLAN_ROADMAP_INVALID");
  if (plan.roadmapRender.path !== ROADMAP_PATH) fail("PLAN_ROADMAP_PATH_INVALID");
  sha(plan.roadmapRender.sha256, "PLAN_ROADMAP_INVALID");
  sha(plan.roadmapRender.windowAuthorityDigest, "PLAN_ROADMAP_INVALID");
  sha(plan.windowAuthorityDigest, "PLAN_WINDOW_DIGEST_INVALID");
  if (plan.roadmapRender.windowAuthorityDigest !== plan.windowAuthorityDigest) fail("PLAN_WINDOW_DIGEST_MISMATCH");
  for (const [registryName, entry] of [
    ["LABEL", plan.labelRegistry],
    ["TYPE", plan.typeRegistry],
  ]) {
    exactKeys(entry, ["value", "digest"], `PLAN_${registryName}_REGISTRY_INVALID`);
    sha(entry.digest, `PLAN_${registryName}_REGISTRY_INVALID`);
    if (entry.digest !== digestCanonical(entry.value)) fail(`PLAN_${registryName}_REGISTRY_DIGEST_INVALID`);
  }
  if (canonicalJson(reconcileLabelRegistry(plan.labelRegistry.value)) !== canonicalJson(plan.labelRegistry.value))
    fail("PLAN_LABEL_REGISTRY_ORDER_INVALID");
  if (canonicalJson(reconcileTypeRegistry(plan.typeRegistry.value)) !== canonicalJson(plan.typeRegistry.value))
    fail("PLAN_TYPE_REGISTRY_ORDER_INVALID");
  exactKeys(plan.permission, ["repository", "viewerLogin", "viewerPermission", "digest"], "PLAN_PERMISSION_INVALID");
  if (plan.permission.repository !== SWEEP_REPOSITORY || plan.permission.viewerPermission !== "ADMIN")
    fail("PLAN_PERMISSION_INVALID");
  requiredString(plan.permission.viewerLogin, "PLAN_PERMISSION_INVALID");
  sha(plan.permission.digest, "PLAN_PERMISSION_INVALID");
  if (
    plan.permission.digest !==
    digestCanonical({
      repository: plan.permission.repository,
      viewerLogin: plan.permission.viewerLogin,
      viewerPermission: plan.permission.viewerPermission,
    })
  )
    fail("PLAN_PERMISSION_DIGEST_INVALID");
  if (!Array.isArray(plan.issueFingerprints)) fail("PLAN_FINGERPRINTS_INVALID");
  plan.issueFingerprints.forEach(validateFingerprint);
  strictlyAscending(
    plan.issueFingerprints.map((entry) => entry.number),
    "PLAN_FINGERPRINT_ORDER_INVALID",
  );
  if (
    plan.issueFingerprints.some(
      (entry) =>
        entry.state !== "OPEN" ||
        entry.milestone === null ||
        entry.milestone.id !== plan.milestone.id ||
        entry.milestone.number !== plan.milestone.number ||
        entry.milestone.title !== plan.milestone.title ||
        entry.milestone.state !== plan.milestone.state,
    )
  )
    fail("PLAN_FINGERPRINT_SCOPE_INVALID");
  strictlyAscending(plan.includedNumbers, "PLAN_INCLUDED_INVALID");
  strictlyAscending(plan.excludedNumbers, "PLAN_EXCLUDED_INVALID");
  strictlyAscending(plan.gapNumbers, "PLAN_GAPS_INVALID");
  const fingerprintNumbers = plan.issueFingerprints.map((entry) => entry.number);
  const combined = [...plan.includedNumbers, ...plan.excludedNumbers].sort((left, right) => left - right);
  if (canonicalJson(combined) !== canonicalJson(fingerprintNumbers)) fail("PLAN_PARTITION_INVALID");
  if (plan.includedNumbers.some((number) => plan.excludedNumbers.includes(number))) fail("PLAN_PARTITION_INVALID");
  const derivedIncluded = plan.issueFingerprints
    .filter((entry) => !entry.isEpic && !entry.isTrackingOnly)
    .map((entry) => entry.number);
  const derivedExcluded = plan.issueFingerprints
    .filter((entry) => entry.isEpic || entry.isTrackingOnly)
    .map((entry) => entry.number);
  if (
    canonicalJson(derivedIncluded) !== canonicalJson(plan.includedNumbers) ||
    canonicalJson(derivedExcluded) !== canonicalJson(plan.excludedNumbers)
  )
    fail("PLAN_PARTITION_INVALID");
  const derivedGaps = plan.issueFingerprints.filter((entry) => entry.isGap).map((entry) => entry.number);
  if (canonicalJson(derivedGaps) !== canonicalJson(plan.gapNumbers)) fail("PLAN_GAPS_INVALID");
  if (!Array.isArray(plan.targets)) fail("PLAN_TARGETS_INVALID");
  strictlyAscending(
    plan.targets.map((target) => target.number),
    "PLAN_TARGET_ORDER_INVALID",
  );
  let steps = 0;
  const requestDigests = new Set();
  const planFingerprintByNumber = new Map(plan.issueFingerprints.map((entry) => [entry.number, entry]));
  for (const target of plan.targets) {
    exactKeys(
      target,
      ["number", "nodeId", "decisionUpdatedAt", "bodySha256", "before", "after", "steps"],
      "PLAN_TARGET_KEYS_INVALID",
    );
    positiveInteger(target.number, "PLAN_TARGET_INVALID");
    requiredString(target.nodeId, "PLAN_TARGET_INVALID");
    if (!Number.isFinite(Date.parse(target.decisionUpdatedAt))) fail("PLAN_TARGET_INVALID");
    sha(target.bodySha256, "PLAN_TARGET_INVALID");
    validateFingerprint(target.before);
    validateFingerprint(target.after);
    if (
      target.before.number !== target.number ||
      target.after.number !== target.number ||
      target.nodeId !== target.before.nodeId ||
      target.before.isGap !== true ||
      target.after.isGap !== false
    )
      fail("PLAN_TARGET_STATE_INVALID");
    for (const key of ["number", "nodeId", "state", "milestone", "isEpic", "isTrackingOnly"]) {
      if (canonicalJson(target.before[key]) !== canonicalJson(target.after[key])) fail("PLAN_TARGET_STATE_INVALID");
    }
    if (!sameGoverned(planFingerprintByNumber.get(target.number), target.before)) fail("PLAN_TARGET_PREIMAGE_INVALID");
    if (!Array.isArray(target.steps) || target.steps.length !== 1) fail("PLAN_TARGET_STEPS_INVALID");
    const step = target.steps[0];
    exactKeys(step, ["index", "kind", "request", "beforeFingerprint", "afterFingerprint"], "PLAN_STEP_KEYS_INVALID");
    if (step.index !== 0 || !["set-type", "add-labels"].includes(step.kind)) fail("PLAN_STEP_INVALID");
    if (step.kind === "set-type") {
      exactKeys(step.request, ["issueNodeId", "issueTypeId"], "PLAN_STEP_REQUEST_INVALID");
      requiredString(step.request.issueNodeId, "PLAN_STEP_REQUEST_INVALID");
      requiredString(step.request.issueTypeId, "PLAN_STEP_REQUEST_INVALID");
      if (
        target.before.issueType !== null ||
        target.after.issueType?.nodeId !== step.request.issueTypeId ||
        step.request.issueNodeId !== target.nodeId ||
        canonicalJson(target.before.labels) !== canonicalJson(target.after.labels)
      )
        fail("PLAN_STEP_TRANSITION_INVALID");
    } else {
      exactKeys(step.request, ["labelableId", "labelIds"], "PLAN_STEP_REQUEST_INVALID");
      requiredString(step.request.labelableId, "PLAN_STEP_REQUEST_INVALID");
      if (
        !Array.isArray(step.request.labelIds) ||
        step.request.labelIds.length === 0 ||
        new Set(step.request.labelIds).size !== step.request.labelIds.length ||
        step.request.labelIds.some((id) => typeof id !== "string" || id.length === 0)
      )
        fail("PLAN_STEP_REQUEST_INVALID");
      if ([...step.request.labelIds].sort(compareOrdinal).join("\0") !== step.request.labelIds.join("\0"))
        fail("PLAN_STEP_REQUEST_INVALID");
      const beforeIds = new Set(target.before.labels.map((label) => label.id));
      const addedIds = target.after.labels
        .filter((label) => !beforeIds.has(label.id))
        .map((label) => label.id)
        .sort(compareOrdinal);
      if (
        step.request.labelableId !== target.nodeId ||
        canonicalJson(addedIds) !== canonicalJson(step.request.labelIds) ||
        target.after.labels.length !== target.before.labels.length + step.request.labelIds.length ||
        canonicalJson(target.before.issueType) !== canonicalJson(target.after.issueType)
      )
        fail("PLAN_STEP_TRANSITION_INVALID");
    }
    if (
      step.beforeFingerprint !== digestCanonical(target.before) ||
      step.afterFingerprint !== digestCanonical(target.after)
    )
      fail("PLAN_STEP_FINGERPRINT_INVALID");
    const requestDigest = digestCanonical(step.request);
    if (requestDigests.has(requestDigest)) fail("PLAN_REQUEST_DUPLICATE");
    requestDigests.add(requestDigest);
    steps += 1;
  }
  if (canonicalJson(plan.targets.map((target) => target.number)) !== canonicalJson(plan.gapNumbers))
    fail("PLAN_TARGET_GAP_MISMATCH");
  nonNegativeInteger(plan.logicalStepCount, "PLAN_STEP_COUNT_INVALID");
  if (plan.logicalStepCount !== steps || steps > MAX_LOGICAL_STEPS) fail("PLAN_STEP_COUNT_INVALID");
  sha(plan.planDigest, "PLAN_DIGEST_INVALID");
  const computed = digestCanonical(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "planDigest")));
  if (plan.planDigest !== computed) fail("PLAN_DIGEST_INVALID");
  return plan;
}

export function serializePlan(plan) {
  validateClassificationPlan(plan);
  return `${canonicalJson(plan)}\n`;
}

const JOURNAL_COMMON_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "planDigest",
  "attemptId",
  "sequence",
  "predecessorSha256",
  "planPr",
  "planHead",
  "landedMainSha",
  "createdAt",
]);

const JOURNAL_VARIANT_KEYS = Object.freeze({
  genesis: [],
  intent: ["targetNumber", "stepIndex", "beforeFingerprint", "requestDigest"],
  result: ["targetNumber", "stepIndex", "requestDigest", "observedFingerprint", "responseClass", "outcome"],
  "apply-receipt": ["logicalStepCount", "targetNumbers", "finalPrefixSha256", "completedAt"],
  "verify-receipt": [
    "logicalStepCount",
    "targetNumbers",
    "finalPrefixSha256",
    "applyReceiptSha256",
    "postAuthorityDigest",
    "postRoadmapSha256",
    "emptyPlanDigest",
    "emptyPlanArtifactSha256",
    "zeroGapNumbers",
    "completedAt",
  ],
});

export function journalRecordSha(record) {
  return digestCanonical(record);
}

export function renderJournalComment(record) {
  validateJournalRecord(record);
  const recordSha = journalRecordSha(record);
  return `\`\`\`json\n${canonicalJson(record)}\n\`\`\`\n<!-- chase-sets:issue-7536-classification:v1 plan=${record.planDigest} attempt=${record.attemptId} seq=${record.sequence} sha=${recordSha} -->`;
}

function validateObservedFingerprint(value) {
  exactKeys(value, ["governed", "updatedAt", "bodySha256"], "JOURNAL_OBSERVED_INVALID");
  validateFingerprint(value.governed);
  if (!Number.isFinite(Date.parse(value.updatedAt))) fail("JOURNAL_OBSERVED_INVALID");
  sha(value.bodySha256, "JOURNAL_OBSERVED_INVALID");
}

export function validateJournalRecord(record) {
  if (!isObject(record) || !Object.hasOwn(JOURNAL_VARIANT_KEYS, record.kind)) fail("JOURNAL_KIND_INVALID");
  exactKeys(record, [...JOURNAL_COMMON_KEYS, ...JOURNAL_VARIANT_KEYS[record.kind]], "JOURNAL_KEYS_INVALID");
  if (record.schemaVersion !== JOURNAL_SCHEMA_VERSION) fail("JOURNAL_SCHEMA_INVALID");
  sha(record.planDigest, "JOURNAL_PLAN_INVALID");
  if (!UUID_V4.test(record.attemptId)) fail("JOURNAL_ATTEMPT_INVALID");
  nonNegativeInteger(record.sequence, "JOURNAL_SEQUENCE_INVALID");
  if (record.predecessorSha256 !== null) sha(record.predecessorSha256, "JOURNAL_PREDECESSOR_INVALID");
  positiveInteger(record.planPr, "JOURNAL_PR_INVALID");
  oid(record.planHead, "JOURNAL_HEAD_INVALID");
  oid(record.landedMainSha, "JOURNAL_MAIN_INVALID");
  timestamp(record.createdAt, "JOURNAL_CREATED_AT_INVALID");
  if (record.kind === "genesis") {
    if (record.sequence !== 0 || record.predecessorSha256 !== null) fail("JOURNAL_GENESIS_INVALID");
  } else if (record.predecessorSha256 === null) fail("JOURNAL_PREDECESSOR_INVALID");
  if (record.kind === "intent") {
    positiveInteger(record.targetNumber, "JOURNAL_TARGET_INVALID");
    nonNegativeInteger(record.stepIndex, "JOURNAL_STEP_INVALID");
    sha(record.beforeFingerprint, "JOURNAL_BEFORE_INVALID");
    sha(record.requestDigest, "JOURNAL_REQUEST_INVALID");
  }
  if (record.kind === "result") {
    positiveInteger(record.targetNumber, "JOURNAL_TARGET_INVALID");
    nonNegativeInteger(record.stepIndex, "JOURNAL_STEP_INVALID");
    sha(record.requestDigest, "JOURNAL_REQUEST_INVALID");
    validateObservedFingerprint(record.observedFingerprint);
    if (!["success", "ambiguous"].includes(record.responseClass) || record.outcome !== "after-observed") {
      fail("JOURNAL_RESULT_INVALID");
    }
  }
  if (record.kind === "apply-receipt" || record.kind === "verify-receipt") {
    nonNegativeInteger(record.logicalStepCount, "JOURNAL_STEP_COUNT_INVALID");
    strictlyAscending(record.targetNumbers, "JOURNAL_TARGETS_INVALID");
    sha(record.finalPrefixSha256, "JOURNAL_PREFIX_INVALID");
    timestamp(record.completedAt, "JOURNAL_COMPLETED_AT_INVALID");
  }
  if (record.kind === "verify-receipt") {
    sha(record.applyReceiptSha256, "JOURNAL_APPLY_RECEIPT_INVALID");
    sha(record.postAuthorityDigest, "JOURNAL_POST_AUTHORITY_INVALID");
    sha(record.postRoadmapSha256, "JOURNAL_POST_ROADMAP_INVALID");
    sha(record.emptyPlanDigest, "JOURNAL_EMPTY_PLAN_INVALID");
    sha(record.emptyPlanArtifactSha256, "JOURNAL_EMPTY_PLAN_INVALID");
    if (!Array.isArray(record.zeroGapNumbers) || record.zeroGapNumbers.length !== 0) fail("JOURNAL_ZERO_GAPS_INVALID");
  }
  return record;
}

function parseJournalComment(body) {
  if (typeof body !== "string") return null;
  const markers = [...body.matchAll(JOURNAL_MARKER)];
  if (markers.length === 0) return null;
  if (markers.length !== 1) fail("JOURNAL_MARKER_DUPLICATE");
  const match =
    /^```json\n([^\n]+)\n```\n<!-- chase-sets:issue-7536-classification:v1 plan=([a-f0-9]{64}) attempt=([a-f0-9-]{36}) seq=(\d+) sha=([a-f0-9]{64}) -->$/.exec(
      normalizeLf(body),
    );
  if (!match) fail("JOURNAL_COMMENT_SHAPE_INVALID");
  const record = parseJson(match[1], "JOURNAL_JSON_INVALID");
  validateJournalRecord(record);
  if (
    record.planDigest !== match[2] ||
    record.attemptId !== match[3] ||
    String(record.sequence) !== match[4] ||
    journalRecordSha(record) !== match[5]
  )
    fail("JOURNAL_MARKER_MISMATCH");
  return { record, sha256: match[5] };
}

export function validateJournalPrefix(comments, plan, { allowTerminal = true } = {}) {
  validateClassificationPlan(plan);
  if (!Array.isArray(comments)) fail("JOURNAL_COLLECTION_INVALID");
  const records = [];
  const logicalKeys = new Set();
  for (const comment of comments) {
    if (typeof comment?.body !== "string" || !comment.body.includes(`plan=${plan.planDigest}`)) continue;
    const parsed = parseJournalComment(comment?.body);
    if (!parsed || parsed.record.planDigest !== plan.planDigest) continue;
    const logicalKey = `${parsed.record.planDigest}\0${parsed.record.attemptId}\0${parsed.record.sequence}`;
    if (logicalKeys.has(logicalKey)) fail("JOURNAL_LOGICAL_KEY_COLLISION");
    logicalKeys.add(logicalKey);
    records.push(parsed);
  }
  records.sort((left, right) => left.record.sequence - right.record.sequence);
  if (records.length === 0) return { records: [], attemptId: null, terminal: null, pendingIntent: null };
  const attemptId = records[0].record.attemptId;
  const genesisIdentity = records[0].record;
  if (records.some(({ record }) => record.attemptId !== attemptId)) fail("JOURNAL_MULTIPLE_ATTEMPTS");
  for (const [index, entry] of records.entries()) {
    const record = entry.record;
    if (record.sequence !== index) fail("JOURNAL_SEQUENCE_GAP");
    if (
      record.planDigest !== plan.planDigest ||
      record.landedMainSha !== plan.implementation.landedMainSha ||
      record.planPr !== genesisIdentity.planPr ||
      record.planHead !== genesisIdentity.planHead ||
      (index > 0 && Date.parse(record.createdAt) < Date.parse(records[index - 1].record.createdAt)) ||
      (index === 0 ? record.predecessorSha256 !== null : record.predecessorSha256 !== records[index - 1].sha256)
    )
      fail("JOURNAL_LINEAGE_INVALID");
    const expectedKind =
      index === 0
        ? "genesis"
        : index <= plan.logicalStepCount * 2
          ? index % 2 === 1
            ? "intent"
            : "result"
          : index === plan.logicalStepCount * 2 + 1
            ? "apply-receipt"
            : index === plan.logicalStepCount * 2 + 2
              ? "verify-receipt"
              : null;
    if (record.kind !== expectedKind) fail("JOURNAL_TRANSITION_INVALID");
    if (record.kind === "intent" || record.kind === "result") {
      const stepOrdinal = Math.floor((index - 1) / 2);
      const target = plan.targets[stepOrdinal];
      const step = target?.steps[0];
      if (
        !target ||
        record.targetNumber !== target.number ||
        record.stepIndex !== step.index ||
        record.requestDigest !== digestCanonical(step.request) ||
        (record.kind === "intent" && record.beforeFingerprint !== step.beforeFingerprint) ||
        (record.kind === "result" && digestCanonical(record.observedFingerprint.governed) !== step.afterFingerprint)
      )
        fail("JOURNAL_TARGET_TRANSITION_INVALID");
    }
    if (record.kind === "apply-receipt") {
      if (
        record.logicalStepCount !== plan.logicalStepCount ||
        canonicalJson(record.targetNumbers) !== canonicalJson(plan.targets.map((target) => target.number)) ||
        record.finalPrefixSha256 !== records[index - 1].sha256
      )
        fail("JOURNAL_APPLY_RECEIPT_INVALID");
    }
    if (
      record.kind === "verify-receipt" &&
      (record.applyReceiptSha256 !== records[index - 1].sha256 ||
        record.finalPrefixSha256 !== records[index - 1].sha256 ||
        record.logicalStepCount !== plan.logicalStepCount ||
        canonicalJson(record.targetNumbers) !== canonicalJson(plan.targets.map((target) => target.number)))
    ) {
      fail("JOURNAL_VERIFY_RECEIPT_INVALID");
    }
  }
  const terminal = records.at(-1).record.kind;
  if (!allowTerminal && ["apply-receipt", "verify-receipt"].includes(terminal)) fail("JOURNAL_TERMINAL_UNEXPECTED");
  const pendingIntent = terminal === "intent" ? records.at(-1).record : null;
  return { records, attemptId, terminal, pendingIntent };
}

function journalCommon({ plan, planPr, planHead, attemptId, sequence, predecessorSha256, createdAt }) {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    kind: "",
    planDigest: plan.planDigest,
    attemptId,
    sequence,
    predecessorSha256,
    planPr,
    planHead,
    landedMainSha: plan.implementation.landedMainSha,
    createdAt,
  };
}

export function createJournalRecord(kind, context, fields = {}) {
  const record = { ...journalCommon(context), kind, ...fields };
  validateJournalRecord(record);
  return record;
}

function projectedStableIssue(value) {
  if (!value?.complete) fail("ISSUE_AUTHORITY_INCOMPLETE");
  return {
    complete: true,
    issue: {
      nodeId: value.issue.nodeId,
      number: value.issue.number,
      state: value.issue.state,
      updatedAt: value.issue.updatedAt,
      body: value.issue.body,
      issueType: value.issue.issueType,
      milestone: value.issue.milestone,
    },
    graph: {
      repositoryDatabaseId: value.graph.repositoryDatabaseId,
      nodeId: value.graph.nodeId,
      number: value.graph.number,
      state: value.graph.state,
      updatedAt: value.graph.updatedAt,
      issueType: value.graph.issueType,
      hasParent: value.graph.hasParent,
      parentNumber: value.graph.parentNumber,
      labelsTotal: value.graph.labelsTotal,
    },
    labels: value.labels.map((label) => ({ nodeId: label.nodeId, name: label.name })),
  };
}

async function collectCompositeAttempt(client, issueNumber, milestoneNumber, decisionIssueNumbers) {
  const root = projectedStableIssue(await client.collectStableIssue(issueNumber));
  const decisions = extractReviewedDecisionAuthority(root.issue.body);
  if (decisions.value.milestoneNumber !== milestoneNumber) fail("DECISION_MILESTONE_INVALID");
  const decisionNumbers = decisions.value.entries.map((entry) => entry.number);
  const selectedDecisionNumbers =
    decisionIssueNumbers === null
      ? decisionNumbers
      : decisionNumbers.filter((number) => decisionIssueNumbers.includes(number));
  const [window, registry, ...targetAuthorities] = await Promise.all([
    client.collectWindow(),
    client.collectRegistries(),
    ...selectedDecisionNumbers.map((number) => client.collectStableIssue(number).then(projectedStableIssue)),
  ]);
  const issueAuthorities = [root, ...targetAuthorities]
    .filter(
      (entry, index, entries) =>
        entries.findIndex((candidate) => candidate.issue.number === entry.issue.number) === index,
    )
    .sort((left, right) => left.issue.number - right.issue.number);
  const result = {
    repository: SWEEP_REPOSITORY,
    window,
    labelRegistry: registry.labelRegistry,
    typeRegistry: registry.typeRegistry,
    permission: registry.permission,
    issueAuthorities,
  };
  return { ...result, compositeDigest: digestCanonical(result) };
}

export async function collectCompleteSweepAuthority({
  client,
  issueNumber = 7536,
  milestoneNumber = 136,
  decisionIssueNumbers = null,
}) {
  if (
    !client ||
    typeof client.collectWindow !== "function" ||
    typeof client.collectStableIssue !== "function" ||
    typeof client.collectRegistries !== "function"
  ) {
    fail("GITHUB_CLIENT_INVALID");
  }
  if (
    decisionIssueNumbers !== null &&
    (!Array.isArray(decisionIssueNumbers) || decisionIssueNumbers.some((number) => !Number.isSafeInteger(number)))
  )
    fail("DECISION_ISSUE_SELECTION_INVALID");
  const first = await collectCompositeAttempt(client, issueNumber, milestoneNumber, decisionIssueNumbers);
  const second = await collectCompositeAttempt(client, issueNumber, milestoneNumber, decisionIssueNumbers);
  if (first.compositeDigest === second.compositeDigest) return second;
  const third = await collectCompositeAttempt(client, issueNumber, milestoneNumber, decisionIssueNumbers);
  if (second.compositeDigest === third.compositeDigest) return third;
  fail("SWEEP_AUTHORITY_UNSTABLE");
}

function apiHeaders(token, extra = {}) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": REST_API_VERSION,
    ...extra,
  };
}

async function responseJson(response, code) {
  if (!response?.ok)
    fail(code, `${code}: ${response?.status ?? "NO_RESPONSE"} ${await response?.text?.()}`, {
      status: response?.status,
    });
  try {
    return await response.json();
  } catch {
    fail(`${code}_JSON_INVALID`);
  }
}

function parseNextLink(value, expectedPath, expectedPage, expectedState) {
  if (!value) return null;
  let next = null;
  for (const member of value.split(",")) {
    const match = member.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (!match) fail("REST_PAGINATION_LINK_INVALID");
    if (!match[2].split(/\s+/).includes("next")) continue;
    if (next !== null) fail("REST_PAGINATION_LINK_INVALID");
    const parsed = new URL(match[1]);
    if (
      parsed.origin !== "https://api.github.com" ||
      parsed.pathname !== expectedPath ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.searchParams.get("per_page") !== "100" ||
      !/^\d+$/.test(parsed.searchParams.get("page") ?? "") ||
      Number(parsed.searchParams.get("page")) !== expectedPage ||
      (expectedState === null
        ? parsed.searchParams.has("state")
        : parsed.searchParams.get("state") !== expectedState) ||
      [...parsed.searchParams.keys()].some(
        (key) => !["per_page", "page", ...(expectedState === null ? [] : ["state"])].includes(key),
      )
    )
      fail("REST_PAGINATION_NEXT_UNSAFE");
    next = parsed.toString();
  }
  return next;
}

async function collectRestPages({
  request,
  token,
  initialUrl,
  expectedPath,
  expectedState = null,
  project,
  maxItems = MAX_ITEMS,
}) {
  const values = [];
  const visited = new Set();
  let next = initialUrl;
  let pages = 0;
  while (next) {
    if (visited.has(next) || pages >= MAX_PAGES || values.length >= maxItems) fail("REST_COLLECTION_BOUNDED");
    visited.add(next);
    const response = await request(next, { headers: apiHeaders(token) });
    const page = await responseJson(response, "REST_PAGE_FAILED");
    if (!Array.isArray(page)) fail("REST_PAGE_SHAPE_INVALID");
    pages += 1;
    for (const entry of page) {
      if (values.length >= maxItems) fail("REST_COLLECTION_BOUNDED");
      values.push(project(entry));
    }
    next = parseNextLink(response.headers?.get?.("link"), expectedPath, pages + 1, expectedState);
  }
  return { values, pages };
}

export function reconcileIssueIdentities(restNumbers, graphNumbers) {
  const rest = strictlyAscending(
    [...restNumbers].sort((left, right) => left - right),
    "ISSUE_SOURCE_RECONCILIATION_INVALID",
  );
  const graph = strictlyAscending(
    [...graphNumbers].sort((left, right) => left - right),
    "ISSUE_SOURCE_RECONCILIATION_INVALID",
  );
  if (canonicalJson(rest) !== canonicalJson(graph)) fail("ISSUE_SOURCE_RECONCILIATION_INVALID");
  return rest;
}

function validateGraphPage(page, code) {
  if (
    !isObject(page) ||
    !Number.isSafeInteger(page.totalCount) ||
    page.totalCount < 0 ||
    !Array.isArray(page.nodes) ||
    !isObject(page.pageInfo) ||
    typeof page.pageInfo.hasNextPage !== "boolean" ||
    !(page.pageInfo.endCursor === null || typeof page.pageInfo.endCursor === "string") ||
    (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
  )
    fail(code);
}

async function collectGraphConnection(loadPage, { identity, project, code }) {
  const values = [];
  const identities = new Set();
  const cursors = new Set();
  let expectedTotal = null;
  let after = null;
  let pages = 0;
  do {
    if (pages >= MAX_PAGES || values.length >= MAX_ITEMS) fail(`${code}_BOUNDED`);
    const page = await loadPage(after);
    validateGraphPage(page, `${code}_PAGE_INVALID`);
    if (expectedTotal === null) expectedTotal = page.totalCount;
    if (page.totalCount !== expectedTotal) fail(`${code}_TOTAL_CHANGED`);
    const before = values.length;
    for (const node of page.nodes) {
      const value = project(node);
      const key = identity(value);
      if (identities.has(key)) fail(`${code}_DUPLICATE`);
      identities.add(key);
      values.push(value);
    }
    pages += 1;
    if (page.pageInfo.hasNextPage) {
      if (values.length === before || values.length >= expectedTotal || cursors.has(page.pageInfo.endCursor))
        fail(`${code}_CURSOR_INVALID`);
      cursors.add(page.pageInfo.endCursor);
      after = page.pageInfo.endCursor;
    } else after = null;
  } while (after !== null);
  if (expectedTotal === null || values.length !== expectedTotal) fail(`${code}_COUNT_MISMATCH`);
  return { values, totalCount: expectedTotal, pages };
}

const WINDOW_MILESTONES_QUERY = `query SweepMilestones($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){milestones(first:100,after:$after,states:[OPEN]){totalCount pageInfo{hasNextPage endCursor} nodes{id number title state}}}}`;
const WINDOW_ISSUES_QUERY = `query SweepIssues($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){issues(first:100,after:$after,states:[OPEN]){totalCount pageInfo{hasNextPage endCursor} nodes{id number state issueType{id name isEnabled} milestone{id number title state} issueDependenciesSummary{blockedBy totalBlockedBy} labels(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{id name}} blockedBy(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{id number state repository{nameWithOwner}}}}}}}`;
const WINDOW_LABELS_QUERY = `query SweepIssueLabels($id:ID!,$after:String){node(id:$id){... on Issue{labels(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{id name}}}}}`;
const WINDOW_BLOCKED_QUERY = `query SweepIssueBlocked($id:ID!,$after:String){node(id:$id){... on Issue{blockedBy(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{id number state repository{nameWithOwner}}}}}}`;
const REGISTRY_QUERY = `query SweepRegistry($owner:String!,$name:String!,$afterLabels:String,$afterTypes:String){repository(owner:$owner,name:$name){viewerPermission labels(first:100,after:$afterLabels){totalCount pageInfo{hasNextPage endCursor} nodes{id name}}} organization(login:$owner){issueTypes(first:100,after:$afterTypes){totalCount pageInfo{hasNextPage endCursor} nodes{id name isEnabled}}} viewer{login}}`;
const PLAN_PR_QUERY = `query SweepPlanPr($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number state isDraft merged mergedAt baseRefOid headRefOid headRefName mergeQueueEntry{id} autoMergeRequest{enabledAt} files(first:1){totalCount pageInfo{hasNextPage endCursor}}}}}`;
const PLAN_PR_BY_BRANCH_QUERY = `query SweepPlanPrByBranch($owner:String!,$name:String!,$head:String!){repository(owner:$owner,name:$name){pullRequests(first:2,states:[OPEN],headRefName:$head){totalCount nodes{number}}}}`;
const COMMENT_TOTAL_QUERY = `query SweepCommentTotal($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id comments(first:1){totalCount pageInfo{hasNextPage endCursor} nodes{id}}}}}`;

export function createProductionGitHubClient({
  repository = SWEEP_REPOSITORY,
  token,
  request = globalThis.fetch,
} = {}) {
  if (
    repository !== SWEEP_REPOSITORY ||
    typeof token !== "string" ||
    token.length === 0 ||
    typeof request !== "function"
  )
    fail("GITHUB_CLIENT_CONFIG_INVALID");
  const [owner, name] = repository.split("/");
  const graphql = async (query, variables) => {
    const response = await request(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: apiHeaders(token, { "content-type": "application/json" }),
      body: JSON.stringify({ query, variables }),
    });
    const payload = await responseJson(response, "GRAPHQL_REQUEST_FAILED");
    if (Array.isArray(payload.errors) && payload.errors.length > 0) fail("GRAPHQL_AUTHORITY_ERROR");
    return payload.data;
  };
  const graphLoad = async (query, variables, select) => select(await graphql(query, variables));

  return {
    authorityKind: "github-production",
    repository,
    token,
    request,
    graphql,
    async collectStableIssue(number) {
      return collectStableIssueAuthority({ repository, number, token, client: request });
    },
    async collectWindow() {
      const window = await collectRoadmapWindowAuthority({
        loadMilestones: (after) =>
          graphLoad(WINDOW_MILESTONES_QUERY, { owner, name, after }, (data) => data.repository?.milestones),
        loadIssues: (after) =>
          graphLoad(WINDOW_ISSUES_QUERY, { owner, name, after }, (data) => data.repository?.issues),
        loadLabels: (id, after) => graphLoad(WINDOW_LABELS_QUERY, { id, after }, (data) => data.node?.labels),
        loadBlockedBy: (id, after) => graphLoad(WINDOW_BLOCKED_QUERY, { id, after }, (data) => data.node?.blockedBy),
      });
      const expectedPath = `/repos/${repository}/issues`;
      const rest = await collectRestPages({
        request,
        token,
        initialUrl: `https://api.github.com${expectedPath}?state=open&per_page=100`,
        expectedPath,
        expectedState: "open",
        project: (entry) => {
          if (!positiveInteger(entry?.number, "REST_ISSUE_INVALID")) fail("REST_ISSUE_INVALID");
          return entry.pull_request ? null : entry.number;
        },
      });
      const restNumbers = rest.values.filter((number) => number !== null).sort((left, right) => left - right);
      if (new Set(restNumbers).size !== restNumbers.length) fail("REST_ISSUE_DUPLICATE");
      const graphNumbers = window.authority.issues.nodes
        .map((issue) => issue.number)
        .sort((left, right) => left - right);
      reconcileIssueIdentities(restNumbers, graphNumbers);
      return { ...window, restIssueNumbers: restNumbers, restPages: rest.pages };
    },
    async collectRegistries() {
      const labels = await collectGraphConnection(
        (after) =>
          graphLoad(
            REGISTRY_QUERY,
            { owner, name, afterLabels: after, afterTypes: null },
            (data) => data.repository?.labels,
          ),
        {
          identity: (entry) => `${entry.id}\0${entry.name}`,
          project: (entry) => ({
            id: requiredString(entry?.id, "LABEL_REGISTRY_ENTRY_INVALID"),
            name: requiredString(entry?.name, "LABEL_REGISTRY_ENTRY_INVALID"),
          }),
          code: "LABEL_REGISTRY",
        },
      );
      const types = await collectGraphConnection(
        (after) =>
          graphLoad(
            REGISTRY_QUERY,
            { owner, name, afterLabels: null, afterTypes: after },
            (data) => data.organization?.issueTypes,
          ),
        {
          identity: (entry) => entry.nodeId,
          project: (entry) => ({
            nodeId: requiredString(entry?.id, "TYPE_REGISTRY_ENTRY_INVALID"),
            name: requiredString(entry?.name, "TYPE_REGISTRY_ENTRY_INVALID"),
            isEnabled: entry?.isEnabled,
          }),
          code: "TYPE_REGISTRY",
        },
      );
      const identity = await graphql(REGISTRY_QUERY, { owner, name, afterLabels: null, afterTypes: null });
      const labelNames = new Set(classificationLabelNames());
      return {
        labelRegistry: labels.values.filter((entry) => labelNames.has(entry.name)),
        typeRegistry: types.values,
        permission: {
          repository,
          viewerLogin: requiredString(identity.viewer?.login, "VIEWER_IDENTITY_INVALID"),
          viewerPermission: identity.repository?.viewerPermission,
        },
      };
    },
    async getRef(branch) {
      if (typeof branch !== "string" || branch.length === 0) fail("GITHUB_REF_INVALID");
      const response = await request(
        `https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
        {
          headers: apiHeaders(token),
        },
      );
      const value = await responseJson(response, "GITHUB_REF_READ_FAILED");
      return oid(value?.object?.sha, "GITHUB_REF_INVALID");
    },
    async getPlanPr(number) {
      positiveInteger(number, "PLAN_PR_INVALID");
      const data = await graphql(PLAN_PR_QUERY, { owner, name, number });
      const value = data.repository?.pullRequest;
      if (!value || value.number !== number) fail("PLAN_PR_INVALID");
      return value;
    },
    async findPlanPr(branch) {
      const data = await graphql(PLAN_PR_BY_BRANCH_QUERY, {
        owner,
        name,
        head: requiredString(branch, "PLAN_BRANCH_INVALID"),
      });
      const connection = data.repository?.pullRequests;
      if (connection?.totalCount !== 1 || connection.nodes?.length !== 1) fail("PLAN_PR_LOOKUP_INVALID");
      return positiveInteger(connection.nodes[0].number, "PLAN_PR_LOOKUP_INVALID");
    },
    async listPlanFiles(number) {
      const expectedPath = `/repos/${repository}/pulls/${positiveInteger(number, "PLAN_PR_INVALID")}/files`;
      const result = await collectRestPages({
        request,
        token,
        initialUrl: `https://api.github.com${expectedPath}?per_page=100`,
        expectedPath,
        maxItems: 300,
        project: (entry) => {
          if (typeof entry?.filename !== "string" || entry.filename.length === 0) fail("PLAN_PR_FILE_INVALID");
          return entry.filename;
        },
      });
      if (new Set(result.values).size !== result.values.length) fail("PLAN_PR_FILE_DUPLICATE");
      return result.values.sort(compareOrdinal);
    },
    async listComments(issueNumber = 7536) {
      const number = positiveInteger(issueNumber, "COMMENT_ISSUE_INVALID");
      const readTotal = async () => {
        const data = await graphql(COMMENT_TOTAL_QUERY, { owner, name, number });
        const connection = data.repository?.issue?.comments;
        validateGraphPage(connection, "COMMENT_TOTAL_INVALID");
        return connection.totalCount;
      };
      const totalBefore = await readTotal();
      const expectedPath = `/repos/${repository}/issues/${number}/comments`;
      const result = await collectRestPages({
        request,
        token,
        initialUrl: `https://api.github.com${expectedPath}?per_page=100`,
        expectedPath,
        project: (entry) => {
          if (!positiveInteger(entry?.id, "COMMENT_INVALID") || typeof entry?.body !== "string")
            fail("COMMENT_INVALID");
          return { id: entry.id, body: entry.body };
        },
      });
      if (new Set(result.values.map((entry) => entry.id)).size !== result.values.length) fail("COMMENT_DUPLICATE");
      const totalAfter = await readTotal();
      if (totalBefore !== totalAfter || result.values.length !== totalAfter) fail("COMMENT_TOTAL_MISMATCH");
      return result.values;
    },
    async createComment(issueNumber, body) {
      const response = await request(
        `https://api.github.com/repos/${repository}/issues/${positiveInteger(issueNumber)}/comments`,
        {
          method: "POST",
          headers: apiHeaders(token, { "content-type": "application/json" }),
          body: JSON.stringify({ body }),
        },
      );
      return responseJson(response, "COMMENT_CREATE_FAILED");
    },
    async executeStep(step) {
      const mutation =
        step.kind === "add-labels"
          ? `mutation AddSweepLabels($labelableId:ID!,$labelIds:[ID!]!){addLabelsToLabelable(input:{labelableId:$labelableId,labelIds:$labelIds}){clientMutationId}}`
          : `mutation SetSweepType($issueNodeId:ID!,$issueTypeId:ID!){updateIssue(input:{id:$issueNodeId,issueTypeId:$issueTypeId}){clientMutationId}}`;
      await graphql(mutation, step.request);
      return { ok: true };
    },
  };
}

function git(args, { cwd = process.cwd() } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    fail("GIT_COMMAND_FAILED", `git ${args.join(" ")} failed: ${error.stderr?.toString?.().trim() ?? error.message}`);
  }
}

function gitRefExists(ref, cwd) {
  const result = spawnSync("git", ["show-ref", "--verify", ref], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  if (result.status === 128 && result.stderr?.includes(`'${ref}' - not a valid ref`)) return false;
  fail("GIT_COMMAND_FAILED", result.stderr || `git show-ref failed for ${ref}`);
}

function sameWindowsPath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export function invokeCanonicalReviewReducer({ planPr, planHead, reducerPath, historyPath }) {
  if (!sameWindowsPath(reducerPath, REVIEW_REDUCER_PATH) || !sameWindowsPath(historyPath, REVIEW_HISTORY_PATH)) {
    fail("REVIEW_REDUCER_IDENTITY_INVALID");
  }
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      REVIEW_REDUCER_PATH,
      "-Pr",
      String(planPr),
      "-CurrentHead",
      planHead,
      "-HistoryPath",
      REVIEW_HISTORY_PATH,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0 || result.error)
    fail("REVIEW_REDUCER_EXECUTION_FAILED", result.stderr || result.error?.message);
  const reduction = parseJson(result.stdout, "REVIEW_REDUCER_OUTPUT_INVALID");
  if (
    reduction?.schema !== "exact-head-review-reducer/v1" ||
    reduction?.pr !== planPr ||
    reduction?.currentHead !== planHead ||
    reduction?.state !== "authorized"
  )
    fail("REVIEW_NOT_AUTHORIZED", `Review reducer state: ${String(reduction?.state)}`);
  return reduction;
}

export async function assertPlanExecutionIdentity({
  client,
  plan,
  planPr,
  reducerPath = REVIEW_REDUCER_PATH,
  historyPath = REVIEW_HISTORY_PATH,
  cwd = process.cwd(),
  invokeReducer = invokeCanonicalReviewReducer,
}) {
  validateClassificationPlan(plan);
  positiveInteger(planPr, "PLAN_PR_INVALID");
  git(["fetch", "origin", "refs/heads/main:refs/remotes/origin/main"], { cwd });
  const localMain = git(["rev-parse", "refs/remotes/origin/main"], { cwd });
  const githubMain = await client.getRef("main");
  if (localMain !== githubMain || localMain !== plan.implementation.landedMainSha) fail("MAIN_AUTHORITY_MISMATCH");
  if (gitRefExists("refs/heads/origin/main", cwd)) fail("SHADOW_MAIN_REF_INVALID");
  const branch = plan.implementation.planBranch;
  git(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd });
  const head = git(["rev-parse", "HEAD"], { cwd });
  if (git(["branch", "--show-current"], { cwd }) !== branch) fail("PLAN_EXECUTION_IDENTITY_INVALID");
  const identities = [
    head,
    git(["rev-parse", `refs/heads/${branch}`], { cwd }),
    git(["rev-parse", `refs/remotes/origin/${branch}`], { cwd }),
    await client.getRef(branch),
  ];
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
  if (status.length !== 0 || new Set(identities).size !== 1) fail("PLAN_EXECUTION_IDENTITY_INVALID");
  const pr = await client.getPlanPr(planPr);
  identities.push(pr.headRefOid);
  if (
    new Set(identities).size !== 1 ||
    pr.headRefOid !== head ||
    pr.baseRefOid !== localMain ||
    pr.headRefName !== branch ||
    pr.state !== "OPEN" ||
    pr.isDraft !== true ||
    pr.merged !== false ||
    pr.mergedAt !== null ||
    pr.mergeQueueEntry !== null ||
    pr.autoMergeRequest !== null
  )
    fail("PLAN_PR_STATE_INVALID");
  if (git(["rev-parse", `${head}^`], { cwd }) !== localMain) fail("PLAN_PR_PARENT_INVALID");
  const files = await client.listPlanFiles(planPr);
  if (pr.files?.totalCount !== files.length || canonicalJson(files) !== canonicalJson([PLAN_PATH, ROADMAP_PATH]))
    fail("PLAN_PR_PATH_SET_INVALID");
  const prAfterFiles = await client.getPlanPr(planPr);
  const projectPrIdentity = (value) => ({
    number: value.number,
    state: value.state,
    isDraft: value.isDraft,
    merged: value.merged,
    mergedAt: value.mergedAt,
    baseRefOid: value.baseRefOid,
    headRefOid: value.headRefOid,
    headRefName: value.headRefName,
    mergeQueueEntry: value.mergeQueueEntry,
    autoMergeRequest: value.autoMergeRequest,
    filesTotal: value.files?.totalCount,
  });
  if (canonicalJson(projectPrIdentity(pr)) !== canonicalJson(projectPrIdentity(prAfterFiles)))
    fail("PLAN_PR_MOVED_DURING_CAPTURE");
  const planText = await readFile(path.join(cwd, PLAN_PATH), "utf8");
  const roadmapText = await readFile(path.join(cwd, ROADMAP_PATH), "utf8");
  if (planText !== serializePlan(plan) || sha256Utf8(roadmapText) !== plan.roadmapRender.sha256)
    fail("PLAN_ARTIFACT_BYTES_INVALID");
  for (const artifactPath of [PLAN_PATH, ROADMAP_PATH]) {
    const reviewedBlob = git(["rev-parse", `${head}:${artifactPath}`], { cwd });
    const localBlob = git(["hash-object", "--no-filters", "--", artifactPath], { cwd });
    if (reviewedBlob !== localBlob) fail("PLAN_ARTIFACT_BLOB_INVALID");
  }
  const reduction = invokeReducer({ planPr, planHead: head, reducerPath, historyPath });
  return { planHead: head, localMain, pr, reduction };
}

function expectedFingerprintMap(plan, prefix) {
  const expected = new Map(plan.issueFingerprints.map((entry) => [entry.number, entry]));
  for (const { record } of prefix.records) {
    if (record.kind !== "result") continue;
    const target = plan.targets.find((entry) => entry.number === record.targetNumber);
    expected.set(target.number, target.after);
  }
  return expected;
}

function assertExpectedAuthority(plan, authority, prefix) {
  const body = authority.issueAuthorities.find((entry) => entry.issue.number === plan.issueBodyAuthority.number);
  const decisionAuthority = body ? extractReviewedDecisionAuthority(body.issue.body) : null;
  if (
    !body ||
    body.issue.nodeId !== plan.issueBodyAuthority.nodeId ||
    bodySha256(body.issue.body) !== plan.issueBodyAuthority.sha256 ||
    decisionAuthority.decisionDigest !== plan.decisionDigest
  )
    fail("EXPECTED_PREFIX_BODY_DRIFT");
  if (prefix.records.length === 0 && body.issue.updatedAt !== plan.issueBodyAuthority.updatedAt)
    fail("EXPECTED_PREFIX_BODY_REVISION_DRIFT");
  if (digestCanonical(reconcileLabelRegistry(authority.labelRegistry)) !== plan.labelRegistry.digest)
    fail("EXPECTED_PREFIX_LABEL_DRIFT");
  if (digestCanonical(reconcileTypeRegistry(authority.typeRegistry)) !== plan.typeRegistry.digest)
    fail("EXPECTED_PREFIX_TYPE_DRIFT");
  if (
    authority.permission?.repository !== plan.permission.repository ||
    authority.permission?.viewerLogin !== plan.permission.viewerLogin ||
    authority.permission?.viewerPermission !== plan.permission.viewerPermission
  )
    fail("EXPECTED_PREFIX_PERMISSION_DRIFT");
  const labelsByName = new Map(plan.labelRegistry.value.map((label) => [label.name, label]));
  const typesByName = new Map(plan.typeRegistry.value.map((type) => [type.name, type]));
  for (const decision of decisionAuthority.value.entries) {
    const stable = authority.issueAuthorities.find((entry) => entry.issue.number === decision.number);
    const target = plan.targets.find((entry) => entry.number === decision.number);
    if (!stable) continue;
    if (!stable || stable.issue.nodeId !== decision.nodeId || bodySha256(stable.issue.body) !== decision.bodySha256)
      fail("EXPECTED_PREFIX_DECISION_DRIFT");
    if (target) {
      assertDecisionBoundTarget(decision, target, labelsByName, typesByName);
      const mayBeAfter =
        prefix.pendingIntent?.targetNumber === target.number ||
        prefix.records.some(({ record }) => record.kind === "result" && record.targetNumber === target.number);
      if (
        (!mayBeAfter && stable.issue.updatedAt !== target.decisionUpdatedAt) ||
        (mayBeAfter &&
          stable.issue.updatedAt !== target.decisionUpdatedAt &&
          Date.parse(stable.issue.updatedAt) <= Date.parse(target.decisionUpdatedAt))
      )
        fail("EXPECTED_PREFIX_DECISION_DRIFT");
    } else if (Date.parse(stable.issue.updatedAt) <= Date.parse(decision.updatedAt)) {
      fail("EXPECTED_PREFIX_DECISION_DRIFT");
    }
  }
  const expected = expectedFingerprintMap(plan, prefix);
  const current = authority.window.authority.issues.nodes
    .filter((issue) => issue.milestone?.number === plan.milestone.number)
    .map(governedFingerprint);
  if (current.length !== expected.size) fail("EXPECTED_PREFIX_WINDOW_DRIFT");
  for (const fingerprint of current) {
    const value = expected.get(fingerprint.number);
    if (!value) fail("EXPECTED_PREFIX_WINDOW_DRIFT");
    if (prefix.pendingIntent?.targetNumber === fingerprint.number) {
      const target = plan.targets.find((entry) => entry.number === fingerprint.number);
      if (!sameGoverned(fingerprint, target.before) && !sameGoverned(fingerprint, target.after))
        fail("EXPECTED_PREFIX_PENDING_DRIFT");
    } else if (!sameGoverned(fingerprint, value)) fail("EXPECTED_PREFIX_WINDOW_DRIFT");
  }
  for (const target of plan.targets) {
    const stable = authority.issueAuthorities.find((entry) => entry.issue.number === target.number);
    if (!stable) continue;
    if (stable.issue.nodeId !== target.nodeId || bodySha256(stable.issue.body) !== target.bodySha256)
      fail("EXPECTED_PREFIX_TARGET_DRIFT");
    const currentFingerprint = expected.get(target.number);
    if (
      sameGoverned(currentFingerprint, target.before) &&
      prefix.pendingIntent?.targetNumber !== target.number &&
      stable.issue.updatedAt !== target.decisionUpdatedAt
    )
      fail("EXPECTED_PREFIX_TARGET_REVISION_DRIFT");
  }
}

export async function admitExpectedPrefix({
  client,
  plan,
  planPr,
  reducerPath,
  historyPath,
  cwd = process.cwd(),
  invokeReducer = invokeCanonicalReviewReducer,
}) {
  const identity = await assertPlanExecutionIdentity({
    client,
    plan,
    planPr,
    reducerPath,
    historyPath,
    cwd,
    invokeReducer,
  });
  const firstComments = await client.listComments(plan.issueBodyAuthority.number);
  const comments = await client.listComments(plan.issueBodyAuthority.number);
  if (digestCanonical(firstComments) !== digestCanonical(comments)) fail("JOURNAL_COLLECTION_UNSTABLE");
  const prefix = validateJournalPrefix(comments, plan);
  if (
    prefix.records.length > 0 &&
    (prefix.records[0].record.planPr !== planPr || prefix.records[0].record.planHead !== identity.planHead)
  )
    fail("JOURNAL_PLAN_PR_IDENTITY_INVALID");
  const nextTarget = plan.targets.find(
    (target) => !prefix.records.some(({ record }) => record.kind === "result" && record.targetNumber === target.number),
  );
  const decisionIssueNumbers =
    prefix.records.length === 0 || prefix.terminal === "apply-receipt" ? null : nextTarget ? [nextTarget.number] : [];
  const authority = await collectCompleteSweepAuthority({
    client,
    issueNumber: plan.issueBodyAuthority.number,
    milestoneNumber: plan.milestone.number,
    decisionIssueNumbers,
  });
  assertExpectedAuthority(plan, authority, prefix);
  const finalIdentity = await assertPlanExecutionIdentity({
    client,
    plan,
    planPr,
    reducerPath,
    historyPath,
    cwd,
    invokeReducer,
  });
  if (identity.planHead !== finalIdentity.planHead || identity.localMain !== finalIdentity.localMain)
    fail("ADMISSION_IDENTITY_UNSTABLE");
  const finalCommentsFirst = await client.listComments(plan.issueBodyAuthority.number);
  const finalComments = await client.listComments(plan.issueBodyAuthority.number);
  if (
    digestCanonical(finalCommentsFirst) !== digestCanonical(finalComments) ||
    digestCanonical(comments) !== digestCanonical(finalComments)
  )
    fail("JOURNAL_COLLECTION_UNSTABLE");
  const finalPrefix = validateJournalPrefix(finalComments, plan);
  if (digestCanonical(prefix.records) !== digestCanonical(finalPrefix.records)) fail("JOURNAL_PREFIX_MOVED");
  return { identity: finalIdentity, comments: finalComments, prefix: finalPrefix, authority };
}

function observedTarget(target, stableValue) {
  const stable = projectedStableIssue(stableValue);
  const governed = governedFingerprint({
    number: stable.issue.number,
    nodeId: stable.issue.nodeId,
    state: stable.issue.state,
    issueType: stable.issue.issueType,
    milestone: target.before.milestone,
    labels: stable.labels.map((label) => ({ id: label.nodeId, name: label.name })),
  });
  return { governed, updatedAt: stable.issue.updatedAt, bodySha256: bodySha256(stable.issue.body) };
}

async function scanForJournalRecord(client, issueNumber, record) {
  const expectedBody = renderJournalComment(record);
  const expectedSha = journalRecordSha(record);
  const comments = await client.listComments(issueNumber);
  const matches = comments.filter((comment) => {
    if (typeof comment?.body !== "string" || !comment.body.includes(`plan=${record.planDigest}`)) return false;
    const parsed = parseJournalComment(comment.body);
    return parsed.record.attemptId === record.attemptId && parsed.record.sequence === record.sequence;
  });
  if (
    matches.length > 1 ||
    (matches.length === 1 && (matches[0].body !== expectedBody || !matches[0].body.includes(`sha=${expectedSha}`)))
  )
    fail("JOURNAL_CREATE_RECONCILIATION_INVALID");
  return matches.length;
}

async function appendJournalRecord({ client, issueNumber, record }) {
  if ((await scanForJournalRecord(client, issueNumber, record)) !== 0) fail("JOURNAL_RECORD_ALREADY_EXISTS");
  let ambiguous = false;
  try {
    await client.createComment(issueNumber, renderJournalComment(record));
  } catch (error) {
    ambiguous = error?.status === 503 || error?.details?.status === 503;
    if (!ambiguous) throw error;
  }
  const matches = await scanForJournalRecord(client, issueNumber, record);
  if (matches === 1) return { record, ambiguous };
  if (ambiguous) fail("JOURNAL_CREATE_EXTERNAL_MECHANICAL");
  fail("JOURNAL_CREATE_NOT_OBSERVED");
}

function nextContext(plan, planPr, planHead, prefix, now, attemptId = prefix.attemptId ?? randomUUID()) {
  const previous = prefix.records.at(-1);
  return {
    plan,
    planPr,
    planHead,
    attemptId,
    sequence: prefix.records.length,
    predecessorSha256: previous?.sha256 ?? null,
    createdAt: now(),
  };
}

async function writeAtomic(filePath, bytes) {
  const absolute = path.resolve(filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { encoding: "utf8", flag: "wx" });
    await rename(temporary, absolute);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function applyClassificationPlan({
  client,
  plan,
  planPr,
  reducerPath = REVIEW_REDUCER_PATH,
  historyPath = REVIEW_HISTORY_PATH,
  out,
  cwd = process.cwd(),
  now = () => new Date().toISOString(),
  onBoundary = async () => {},
  admit = admitExpectedPrefix,
}) {
  if (admit !== admitExpectedPrefix && client?.authorityKind !== "synthetic-test")
    fail("TEST_ADMISSION_SEAM_FORBIDDEN");
  validateClassificationPlan(plan);
  let admission = await admit({ client, plan, planPr, reducerPath, historyPath, cwd });
  if (admission.prefix.terminal === "verify-receipt") fail("APPLY_ALREADY_VERIFIED");
  if (admission.prefix.terminal === "apply-receipt") {
    const receipt = admission.prefix.records.at(-1).record;
    if (out) await writeAtomic(out, `${canonicalJson(receipt)}\n`);
    return receipt;
  }
  if (admission.prefix.records.length === 0) {
    await onBoundary("pre-genesis", admission);
    admission = await admit({ client, plan, planPr, reducerPath, historyPath, cwd });
    const context = nextContext(plan, planPr, admission.identity.planHead, admission.prefix, now);
    const genesis = createJournalRecord("genesis", context);
    await appendJournalRecord({ client, issueNumber: plan.issueBodyAuthority.number, record: genesis });
    admission = await admit({ client, plan, planPr, reducerPath, historyPath, cwd });
  }

  for (let ordinal = 0; ordinal < plan.targets.length; ordinal += 1) {
    const target = plan.targets[ordinal];
    const step = target.steps[0];
    admission = await admit({ client, plan, planPr, reducerPath, historyPath, cwd });
    const resultSequence = ordinal * 2 + 2;
    if (admission.prefix.records.some(({ record }) => record.sequence === resultSequence && record.kind === "result"))
      continue;
    let pending = admission.prefix.pendingIntent;
    if (!pending) {
      const observed = observedTarget(target, await client.collectStableIssue(target.number));
      if (
        !sameGoverned(observed.governed, target.before) ||
        observed.updatedAt !== target.decisionUpdatedAt ||
        observed.bodySha256 !== target.bodySha256
      )
        fail("TARGET_PRE_INTENT_DRIFT");
      await onBoundary("pre-intent", { admission, target, observed });
      admission = await admit({ client, plan, planPr, reducerPath, historyPath, cwd });
      const context = nextContext(plan, planPr, admission.identity.planHead, admission.prefix, now);
      const intent = createJournalRecord("intent", context, {
        targetNumber: target.number,
        stepIndex: step.index,
        beforeFingerprint: step.beforeFingerprint,
        requestDigest: digestCanonical(step.request),
      });
      await appendJournalRecord({ client, issueNumber: plan.issueBodyAuthority.number, record: intent });
      admission = await admit({ client, plan, planPr, reducerPath, historyPath, cwd });
      pending = admission.prefix.pendingIntent;
    }
    if (!pending || pending.targetNumber !== target.number) fail("PENDING_INTENT_INVALID");
    let observed = observedTarget(target, await client.collectStableIssue(target.number));
    let responseClass = "ambiguous";
    if (sameGoverned(observed.governed, target.before)) {
      if (observed.updatedAt !== target.decisionUpdatedAt || observed.bodySha256 !== target.bodySha256)
        fail("TARGET_PRE_REQUEST_DRIFT");
      await onBoundary("post-intent-pre-request", { admission, target, observed });
      admission = await admit({ client, plan, planPr, reducerPath, historyPath, cwd });
      observed = observedTarget(target, await client.collectStableIssue(target.number));
      if (sameGoverned(observed.governed, target.before)) {
        if (observed.updatedAt !== target.decisionUpdatedAt || observed.bodySha256 !== target.bodySha256)
          fail("TARGET_PRE_REQUEST_DRIFT");
        let succeeded = false;
        try {
          await client.executeStep(step);
          succeeded = true;
        } catch (error) {
          if (!(error?.status === 503 || error?.details?.status === 503)) throw error;
        }
        observed = observedTarget(target, await client.collectStableIssue(target.number));
        responseClass = succeeded ? "success" : "ambiguous";
      } else if (!sameGoverned(observed.governed, target.after)) {
        fail("PENDING_INTENT_STATE_CONFLICT");
      }
    } else if (!sameGoverned(observed.governed, target.after)) {
      fail("PENDING_INTENT_STATE_CONFLICT");
    }
    if (!sameGoverned(observed.governed, target.after) || observed.bodySha256 !== target.bodySha256)
      fail("TARGET_AFTER_NOT_OBSERVED");
    await onBoundary("post-read-pre-result", { admission, target, observed, responseClass });
    admission = await admit({ client, plan, planPr, reducerPath, historyPath, cwd });
    const context = nextContext(plan, planPr, admission.identity.planHead, admission.prefix, now);
    const result = createJournalRecord("result", context, {
      targetNumber: target.number,
      stepIndex: step.index,
      requestDigest: digestCanonical(step.request),
      observedFingerprint: observed,
      responseClass,
      outcome: "after-observed",
    });
    await appendJournalRecord({ client, issueNumber: plan.issueBodyAuthority.number, record: result });
    await onBoundary("post-result", { target, result });
  }

  admission = await admit({ client, plan, planPr, reducerPath, historyPath, cwd });
  if (admission.prefix.records.length !== plan.logicalStepCount * 2 + 1) fail("APPLY_PREFIX_INCOMPLETE");
  const context = nextContext(plan, planPr, admission.identity.planHead, admission.prefix, now);
  const receipt = createJournalRecord("apply-receipt", context, {
    logicalStepCount: plan.logicalStepCount,
    targetNumbers: plan.targets.map((target) => target.number),
    finalPrefixSha256: admission.prefix.records.at(-1).sha256,
    completedAt: now(),
  });
  await appendJournalRecord({ client, issueNumber: plan.issueBodyAuthority.number, record: receipt });
  if (out) await writeAtomic(out, `${canonicalJson(receipt)}\n`);
  return receipt;
}

export async function verifyClassificationPlan({
  client,
  plan,
  planPr,
  reducerPath = REVIEW_REDUCER_PATH,
  historyPath = REVIEW_HISTORY_PATH,
  roadmapOut,
  emptyPlanOut,
  out,
  cwd = process.cwd(),
  now = () => new Date().toISOString(),
  admit = admitExpectedPrefix,
}) {
  if (admit !== admitExpectedPrefix && client?.authorityKind !== "synthetic-test")
    fail("TEST_ADMISSION_SEAM_FORBIDDEN");
  validateClassificationPlan(plan);
  let admission = await admit({ client, plan, planPr, reducerPath, historyPath, cwd });
  if (admission.prefix.terminal === "verify-receipt") {
    const receipt = admission.prefix.records.at(-1).record;
    if (out) await writeAtomic(out, `${canonicalJson(receipt)}\n`);
    return receipt;
  }
  if (admission.prefix.terminal !== "apply-receipt") fail("VERIFY_APPLY_RECEIPT_REQUIRED");
  const postAuthority = admission.authority;
  const roadmapBytes = renderClassificationPlanningRoadmap(postAuthority.window.authority);
  const emptyPlan = buildClassificationPlan({
    authority: postAuthority,
    issueNumber: plan.issueBodyAuthority.number,
    milestoneNumber: plan.milestone.number,
    landedMainSha: plan.implementation.landedMainSha,
    planBranch: plan.implementation.planBranch,
    capturedAt: now(),
    roadmapPath: ROADMAP_PATH,
    roadmapBytes,
  });
  if (emptyPlan.gapNumbers.length !== 0 || emptyPlan.targets.length !== 0 || emptyPlan.logicalStepCount !== 0) {
    fail("VERIFY_NONZERO_GAPS");
  }
  const emptyPlanBytes = serializePlan(emptyPlan);
  await writeAtomic(roadmapOut, roadmapBytes);
  await writeAtomic(emptyPlanOut, emptyPlanBytes);

  admission = await admit({ client, plan, planPr, reducerPath, historyPath, cwd });
  if (admission.prefix.terminal !== "apply-receipt") fail("VERIFY_PREFIX_MOVED");
  const applyEntry = admission.prefix.records.at(-1);
  const context = nextContext(plan, planPr, admission.identity.planHead, admission.prefix, now);
  const receipt = createJournalRecord("verify-receipt", context, {
    logicalStepCount: plan.logicalStepCount,
    targetNumbers: plan.targets.map((target) => target.number),
    finalPrefixSha256: applyEntry.sha256,
    applyReceiptSha256: applyEntry.sha256,
    postAuthorityDigest: postAuthority.compositeDigest,
    postRoadmapSha256: sha256Utf8(roadmapBytes),
    emptyPlanDigest: emptyPlan.planDigest,
    emptyPlanArtifactSha256: sha256Utf8(emptyPlanBytes),
    zeroGapNumbers: [],
    completedAt: now(),
  });
  await appendJournalRecord({ client, issueNumber: plan.issueBodyAuthority.number, record: receipt });
  if (out) await writeAtomic(out, `${canonicalJson(receipt)}\n`);
  return receipt;
}

function parseCli(argv) {
  const allowed = new Set([
    "mode",
    "issue-number",
    "milestone-number",
    "out",
    "roadmap-out",
    "empty-plan-out",
    "plan",
    "plan-pr",
    "review-reducer",
    "review-history",
    "github-client",
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) fail("CLI_ARGUMENT_INVALID");
    const name = flag.slice(2);
    if (!allowed.has(name) || Object.hasOwn(options, name)) fail("CLI_ARGUMENT_INVALID");
    options[name] = value;
  }
  if (!["plan", "apply", "verify"].includes(options.mode)) fail("CLI_MODE_INVALID");
  const integer = (name) => {
    if (!/^[1-9]\d*$/.test(options[name] ?? "")) fail("CLI_ARGUMENT_INVALID");
    return Number(options[name]);
  };
  return {
    ...options,
    issueNumber: integer("issue-number"),
    milestoneNumber: integer("milestone-number"),
    planPr: options["plan-pr"] === undefined ? null : integer("plan-pr"),
  };
}

async function resolveClient(options, env) {
  if (options["github-client"] !== undefined) {
    if (!path.isAbsolute(options["github-client"])) fail("GITHUB_CLIENT_PATH_NOT_ABSOLUTE");
    const module = await import(pathToFileURL(options["github-client"]).href);
    if (typeof module.createGitHubClient !== "function") fail("GITHUB_CLIENT_MODULE_INVALID");
    return module.createGitHubClient({
      repository: SWEEP_REPOSITORY,
      token: env.GITHUB_TOKEN ?? "synthetic-test-token",
    });
  }
  if (env.VITEST || env.NODE_ENV === "test") fail("TEST_GITHUB_CLIENT_REQUIRED");
  return createProductionGitHubClient({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN });
}

async function readPlanFile(filePath) {
  const bytes = await readFile(path.resolve(filePath), "utf8");
  if (!bytes.endsWith("\n") || bytes.endsWith("\n\n")) fail("PLAN_FILE_BYTES_INVALID");
  const plan = parseJson(bytes, "PLAN_FILE_JSON_INVALID");
  validateClassificationPlan(plan);
  if (bytes !== serializePlan(plan)) fail("PLAN_FILE_CANONICAL_INVALID");
  return plan;
}

async function assertPlanGeneratorIdentity(client, cwd) {
  git(["fetch", "origin", "refs/heads/main:refs/remotes/origin/main"], { cwd });
  const localMain = git(["rev-parse", "refs/remotes/origin/main"], { cwd });
  const githubMain = await client.getRef("main");
  const branch = git(["branch", "--show-current"], { cwd });
  if (
    localMain !== githubMain ||
    !PLAN_BRANCH.test(branch) ||
    git(["rev-parse", "HEAD"], { cwd }) !== localMain ||
    git(["rev-parse", `refs/heads/${branch}`], { cwd }) !== localMain ||
    git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd }).length !== 0
  )
    fail("PLAN_GENERATOR_IDENTITY_INVALID");
  return { landedMainSha: localMain, planBranch: branch };
}

export async function main({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  const options = parseCli(argv);
  if (options.issueNumber !== 7536 || options.milestoneNumber !== 136) fail("CLI_SCOPE_INVALID");
  if (env.GITHUB_REPOSITORY !== SWEEP_REPOSITORY) fail("GITHUB_REPOSITORY_INVALID");
  const client = await resolveClient(options, env);
  if (options.mode === "plan") {
    if (!options.out || !options["roadmap-out"] || options.plan || options.planPr !== null)
      fail("CLI_PLAN_ARGUMENTS_INVALID");
    if (
      path.resolve(cwd, options.out) !== path.resolve(cwd, PLAN_PATH) ||
      path.resolve(cwd, options["roadmap-out"]) !== path.resolve(cwd, ROADMAP_PATH)
    )
      fail("CLI_PLAN_PATHS_INVALID");
    const identity = await assertPlanGeneratorIdentity(client, cwd);
    const authority = await collectCompleteSweepAuthority({
      client,
      issueNumber: options.issueNumber,
      milestoneNumber: options.milestoneNumber,
    });
    const roadmapBytes = renderClassificationPlanningRoadmap(authority.window.authority);
    const plan = buildClassificationPlan({
      authority,
      issueNumber: options.issueNumber,
      milestoneNumber: options.milestoneNumber,
      landedMainSha: identity.landedMainSha,
      planBranch: identity.planBranch,
      capturedAt: new Date().toISOString(),
      roadmapBytes,
    });
    await writeAtomic(path.join(cwd, options["roadmap-out"]), roadmapBytes);
    await writeAtomic(path.join(cwd, options.out), serializePlan(plan));
    return plan;
  }

  if (!options.plan || !options.out) fail("CLI_EXECUTION_ARGUMENTS_INVALID");
  const plan = await readPlanFile(path.join(cwd, options.plan));
  if (plan.issueBodyAuthority.number !== options.issueNumber || plan.milestone.number !== options.milestoneNumber) {
    fail("CLI_PLAN_SCOPE_MISMATCH");
  }
  if (options.mode === "apply") {
    if (
      options.planPr === null ||
      !options["review-reducer"] ||
      !options["review-history"] ||
      options["roadmap-out"] ||
      options["empty-plan-out"]
    )
      fail("CLI_APPLY_ARGUMENTS_INVALID");
    return applyClassificationPlan({
      client,
      plan,
      planPr: options.planPr,
      reducerPath: options["review-reducer"],
      historyPath: options["review-history"],
      out: options.out,
      cwd,
    });
  }
  if (!options["roadmap-out"] || !options["empty-plan-out"]) fail("CLI_VERIFY_ARGUMENTS_INVALID");
  const planPr = options.planPr ?? (await client.findPlanPr(plan.implementation.planBranch));
  return verifyClassificationPlan({
    client,
    plan,
    planPr,
    reducerPath: options["review-reducer"] ?? REVIEW_REDUCER_PATH,
    historyPath: options["review-history"] ?? REVIEW_HISTORY_PATH,
    roadmapOut: options["roadmap-out"],
    emptyPlanOut: options["empty-plan-out"],
    out: options.out,
    cwd,
  });
}

export async function runSweep(run = main, writeError = (message) => console.error(message)) {
  try {
    await run();
    return 0;
  } catch (error) {
    writeError(`${error.code ?? error.name}: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("backlog-classification-sweep.mjs")) {
  process.exitCode = await runSweep();
}
