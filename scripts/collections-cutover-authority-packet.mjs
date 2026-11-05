// Collections cutover authority packet. `verifyAuthorityPacket` is the 8933-impl-g1
// `authority-packet-completeness` verifier (sha256 1a214a07d64fb4a512d0e6d2ab3c7b24e7b324124f53c17d57d1435801811b7c)
// ported unchanged: it compares the closed target inventory to the writer-authority, authority-matrix and
// runner-binding captures. A field is complete only as `{ value, source }`;
// `{ status: "unknown", missingAuthority, hostAction }` is a governed bounded unknown; anything else, a
// secret-shaped value, an extra target or a recovery-commit floor is invalid.
// Completeness only: it never proves retirement. `applyProviderCapture` folds one read-only CI capture in.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { containsFloor, deriveFloor } from "./collections-anonymous-owner-redaction.mjs";

export const TARGETS = Object.freeze(["staging", "production"]);
export const WRITER_KINDS = Object.freeze(["serving", "suspended", "dormant", "rollback", "job", "cronjob", "session"]);
export const GATES = Object.freeze([
  "rollout",
  "traffic",
  "job",
  "cronjob",
  "rollback-floor",
  "manual-release-ref",
  "ci-workflow-rerun",
  "credential-session-fence",
]);
const FILES = Object.freeze({
  writerAuthority: {
    schemaVersion: "collections-writer-authority/v1",
    name: "collections-writer-authority-v1.json",
    fields: [
      "environment",
      "databaseIdentityDigest",
      "terraformStateSerial",
      "terraformStateLineage",
      "releaseCommit",
      "imageDigests",
    ],
  },
  authorityMatrix: {
    schemaVersion: "collections-cutover-authority-matrix/v1",
    name: "collections-cutover-authority-matrix.json",
    fields: [],
  },
  runnerBinding: {
    schemaVersion: "collections-redaction-runner-binding/v1",
    name: "collections-redaction-runner-binding.json",
    fields: [
      "runnerInputs",
      "credentialSources",
      "caSource",
      "githubPermissions",
      "environmentProtection",
      "deployedCommitAncestry",
      "legacyRawRowCount",
      "legacyCountQueryPlan",
      "receiptLocation",
      "failureTaxonomy",
    ],
  },
});
const GATE_TEXT = ["source", "commandOrApi", "operationOwner", "approvalBoundary", "negativeDormantCase"];
const SECRET_SHAPES = [
  /:\/\/[^\s/@:]+:[^\s/@]+@/,
  /-----BEGIN [A-Z ]+-----/,
  /\b(?:dop|doo)_v1_[a-f0-9]{16,}/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
];
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const sha40 = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const instant = (value) => (typeof value === "string" ? Date.parse(value) : Number.NaN);

function scanSecrets(value, path, errors) {
  if (typeof value === "string") {
    if (SECRET_SHAPES.some((shape) => shape.test(value))) errors.push(`${path}|secret-value`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => scanSecrets(item, `${path}[${index}]`, errors));
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) scanSecrets(item, `${path}.${key}`, errors);
  }
}

// Returns true when the field is concrete; records a missing entry or an error otherwise.
function field(state, target, file, name, value) {
  if (value === undefined) {
    state.missing.push({
      target,
      file,
      field: name,
      reason: "field-absent",
      missingAuthority: "not captured",
      hostAction: `capture ${name} for ${target}`,
    });
    return false;
  }
  if (isObject(value) && value.status === "unknown") {
    if (!text(value.missingAuthority) || !text(value.hostAction)) {
      state.errors.push(`${target}|${name}|ungoverned-unknown`);
      return false;
    }
    state.missing.push({
      target,
      file,
      field: name,
      reason: "unknown",
      missingAuthority: value.missingAuthority,
      hostAction: value.hostAction,
    });
    return false;
  }
  if (!isObject(value) || !("value" in value) || !text(value.source)) {
    state.errors.push(`${target}|${name}|field-shape`);
    return false;
  }
  return true;
}

function writerSet(state, target, kind, value) {
  const name = `writers.${kind}`;
  if (value === undefined || (isObject(value) && value.status === "unknown"))
    return field(state, target, "writerAuthority", name, value);
  const items = isObject(value) && Array.isArray(value.items) ? value.items : null;
  if (!items || !text(value.source)) {
    state.errors.push(`${target}|${name}|field-shape`);
    return;
  }
  if (
    !integer(value.collected) ||
    !integer(value.authoritativeTotal) ||
    value.collected !== value.authoritativeTotal ||
    items.length !== value.collected
  ) {
    state.missing.push({
      target,
      file: "writerAuthority",
      field: name,
      reason: "writer-set-incomplete",
      missingAuthority: "collected, authoritative total and listed writers disagree",
      hostAction: `re-read every page of ${kind} sources for ${target} until collected equals the authoritative total`,
    });
  }
}

function targetSet(state, file, targets) {
  if (!isObject(targets)) {
    state.errors.push(`*|${file}|targets-shape`);
    return [];
  }
  for (const target of Object.keys(targets))
    if (!TARGETS.includes(target)) state.errors.push(`${target}|${file}|target-unexpected`);
  const present = [];
  for (const target of TARGETS) {
    if (isObject(targets[target])) present.push(target);
    else
      state.missing.push({
        target,
        file,
        field: "*",
        reason: "target-withheld",
        missingAuthority: "target capture absent",
        hostAction: `capture ${target} for ${FILES[file].name}`,
      });
  }
  return present;
}

export function verifyAuthorityPacket(packet) {
  const state = { missing: [], errors: [] };
  scanSecrets(packet, "packet", state.errors);
  for (const [file, spec] of Object.entries(FILES)) {
    if (!isObject(packet?.[file]) || packet[file].schemaVersion !== spec.schemaVersion)
      state.errors.push(`*|${file}|schema-version`);
  }
  if (state.errors.some((error) => error.endsWith("|schema-version"))) return finish(state);

  const { writerAuthority, authorityMatrix, runnerBinding } = packet;
  const mergedAt = instant(writerAuthority.activationMerge?.mergedAt);
  if (!sha40(writerAuthority.activationMerge?.commit) || !Number.isFinite(mergedAt))
    state.errors.push("*|activationMerge|field-shape");
  for (const file of Object.keys(FILES)) {
    const capturedAt = instant(packet[file].capturedAt);
    if (!Number.isFinite(capturedAt)) state.errors.push(`*|${file}.capturedAt|field-shape`);
    else if (Number.isFinite(mergedAt) && capturedAt <= mergedAt) {
      state.missing.push({
        target: "*",
        file,
        field: `${file}.capturedAt`,
        reason: "capture-before-activation-merge",
        missingAuthority: "capture predates the activation merge",
        hostAction: "take a fresh capture after the activation merge",
      });
    }
  }

  const floor = runnerBinding.floor;
  if (!isObject(floor) || floor.status !== "derived" || !sha40(floor.commit)) {
    state.missing.push({
      target: "*",
      file: "runnerBinding",
      field: "floor",
      reason: "floor-pending",
      missingAuthority: "no unique first-parent floor commit derived",
      hostAction: "derive the floor from a full-history default-branch checkout after the activation merge",
    });
  } else if (floor.commit === runnerBinding.recoveryCommit) {
    state.errors.push("*|floor|floor-is-recovery-commit");
  } else if (floor.commit !== writerAuthority.activationMerge?.commit) {
    state.errors.push("*|floor|floor-not-activation-merge");
  }

  for (const target of targetSet(state, "writerAuthority", writerAuthority.targets)) {
    const capture = writerAuthority.targets[target];
    for (const name of FILES.writerAuthority.fields) field(state, target, "writerAuthority", name, capture[name]);
    if (!isObject(capture.writers)) {
      field(state, target, "writerAuthority", "writers", capture.writers);
      continue;
    }
    for (const kind of WRITER_KINDS) writerSet(state, target, kind, capture.writers[kind]);
  }
  for (const target of targetSet(state, "authorityMatrix", authorityMatrix.targets)) {
    const gates = authorityMatrix.targets[target].gates ?? {};
    for (const gate of GATES) {
      const entry = gates[gate];
      if (entry === undefined) {
        field(state, target, "authorityMatrix", `gates.${gate}`, undefined);
        continue;
      }
      if (!GATE_TEXT.every((key) => text(entry?.[key]))) state.errors.push(`${target}|gates.${gate}|gate-shape`);
      if (
        field(state, target, "authorityMatrix", `gates.${gate}.observeAuthority`, entry?.observeAuthority) &&
        entry.observeAuthority.value !== "demonstrated"
      ) {
        state.errors.push(`${target}|gates.${gate}.observeAuthority|field-shape`);
      }
    }
  }
  for (const target of targetSet(state, "runnerBinding", runnerBinding.targets)) {
    const binding = runnerBinding.targets[target];
    for (const name of FILES.runnerBinding.fields) field(state, target, "runnerBinding", name, binding[name]);
  }
  return finish(state);
}

function finish(state) {
  const verdict = state.errors.length > 0 ? "invalid" : state.missing.length > 0 ? "bounded-unknown" : "complete";
  return {
    format: "authority-packet-completeness/v1",
    verdict,
    targets: [...TARGETS],
    missing: state.missing,
    errors: state.errors,
  };
}

export function readPacket(directory) {
  return Object.fromEntries(
    Object.entries(FILES).map(([key, spec]) => [key, JSON.parse(readFileSync(join(directory, spec.name), "utf8"))]),
  );
}

export const PROVIDER_CAPTURE_SCHEMA_VERSION = "collections-cutover-provider-capture/v1";
// `manual-release-ref` and `ci-workflow-rerun` stay GitHub reads owned by the Probe, never provider captures.
export const PROVIDER_GATES = Object.freeze([
  "rollout",
  "traffic",
  "job",
  "cronjob",
  "rollback-floor",
  "credential-session-fence",
]);
const PROVIDER_FIELDS = Object.freeze({
  writerAuthority: [...FILES.writerAuthority.fields, ...WRITER_KINDS.map((kind) => `writers.${kind}`)],
  authorityMatrix: PROVIDER_GATES.map((gate) => `gates.${gate}.observeAuthority`),
  runnerBinding: ["deployedCommitAncestry", "legacyRawRowCount", "legacyCountQueryPlan"],
});
export const PROVIDER_CAPTURE_FIELDS = Object.freeze(Object.values(PROVIDER_FIELDS).flat());
const CAPTURE_ENVELOPE = Object.freeze(["schemaVersion", "target", "capturedAt", "head", "codes", "fields"]);
// Names echoed into errors must never carry an untrusted value.
const safeName = (name) => (/^[A-Za-z0-9_.-]{1,80}$/.test(name) ? name : "unnamed");

const BACKEND_ID = /^backend:[1-9][0-9]*$/;
const SESSION_EVIDENCE = Object.freeze(["pool", "pooledRead", "holders"]);
const POOL_MATCH = Object.freeze(["pid", "backendStart", "role"]);
const governedUnknown = (value) =>
  isObject(value) && value.status === "unknown" && text(value.missingAuthority) && text(value.hostAction);
const evidenceShown = (value) =>
  isObject(value) &&
  value.status !== "unknown" &&
  text(value.source) &&
  ("value" in value || Array.isArray(value.items));
const digest64 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
// The exact shape each shown evidence key must carry before a pooler proof may read it.
const EVIDENCE_SHAPE = Object.freeze({
  pool: ({ value }) =>
    isObject(value) &&
    value.context === "collections" &&
    value.name === "collections-runtime" &&
    value.mode === "transaction" &&
    integer(value.size) &&
    value.size > 0 &&
    digest64(value.hostDigest) &&
    digest64(value.userDigest),
  pooledRead: ({ value }) =>
    isObject(value) && integer(value.pid) && value.pid > 0 && Number.isFinite(instant(value.backendStart)),
  holders: (set) =>
    Array.isArray(set.items) &&
    integer(set.collected) &&
    set.authoritativeTotal === set.collected &&
    set.items.length === set.collected,
});

/**
 * Per-backend session evidence. A set without one `backend:<pid>` item per backend and its pool, pooled-read and
 * holder evidence is aggregate-only attribution: it folds in as a governed unknown, never as a complete session set.
 * A `pooler` item must carry its own proof (the pooled read's PID and backend_start, the pool user's role digest
 * and a shown holder census); an unproven pooler claim refuses the capture.
 */
function sessionEvidence(state, target, value) {
  if (!isObject(value) || value.status === "unknown" || !Array.isArray(value.items)) return value;
  const perBackend =
    value.items.every(
      (item) =>
        isObject(item) &&
        BACKEND_ID.test(item.id ?? "") &&
        item.id === `backend:${item.pid}` &&
        ["pooler", "unknown"].includes(item.classification),
    ) && SESSION_EVIDENCE.every((key) => governedUnknown(value[key]) || evidenceShown(value[key]));
  if (!perBackend) {
    const unknown = {
      status: "unknown",
      missingAuthority: "aggregate-only session attribution without per-backend pool and holder evidence",
      hostAction: `re-dispatch the capture for ${target} at a head that records per-backend sessions`,
    };
    state.missing.push({
      target,
      file: "writerAuthority",
      field: "writers.session",
      reason: "session-evidence-aggregate",
      missingAuthority: unknown.missingAuthority,
      hostAction: unknown.hostAction,
    });
    return unknown;
  }
  // Shown evidence of the wrong shape refuses the capture whether or not any backend claims pooler.
  const malformed = SESSION_EVIDENCE.filter((key) => evidenceShown(value[key]) && !EVIDENCE_SHAPE[key](value[key]));
  for (const key of malformed) state.errors.push(`${target}|writers.session|${key}-malformed`);
  const proven = (item) =>
    malformed.length === 0 &&
    SESSION_EVIDENCE.every((key) => evidenceShown(value[key])) &&
    value.pooledRead.value.pid === item.pid &&
    value.pooledRead.value.backendStart === item.backendStart &&
    value.pool.value.userDigest === item.roleDigest &&
    POOL_MATCH.every((key) => item.poolMatch?.[key] === true);
  if (value.items.some((item) => item.classification === "pooler" && !proven(item)))
    state.errors.push(`${target}|writers.session|pooler-unproven`);
  return value;
}

// Returns the value to fold: the capture's own, or the governed unknown an aggregate-only session set becomes.
function captureField(state, target, file, name, value) {
  if (name === "writers.session") {
    const folded = sessionEvidence(state, target, value);
    if (folded !== value) return folded;
  }
  if (name.startsWith("writers.")) {
    writerSet(state, target, name.slice("writers.".length), value);
    return value;
  }
  if (field(state, target, file, name, value) && name.startsWith("gates.") && value.value !== "demonstrated") {
    state.errors.push(`${target}|${name}|field-shape`);
  }
  return value;
}

function slot(parent, key) {
  if (!isObject(parent[key])) parent[key] = {};
  return parent[key];
}

/**
 * Folds one `collections-cutover-provider-capture/v1` into a copy of `packet`. A capture carrying a non-AC1
 * field or target, a capture taken at or before the activation merge, failure codes, a secret-shaped value,
 * a malformed field, malformed pool, pooled-read or holder evidence or an unproven `pooler` session is refused
 * whole, never thrown: `errors` is non-empty and `packet` is
 * returned untouched. An aggregate-only session set folds in as a governed unknown.
 */
export function applyProviderCapture(packet, capture) {
  const state = { missing: [], errors: [] };
  if (!isObject(capture) || capture.schemaVersion !== PROVIDER_CAPTURE_SCHEMA_VERSION) {
    state.errors.push("*|capture|schema-version");
    return captureResult(packet, state);
  }
  const target = TARGETS.includes(capture.target) ? capture.target : "*";
  if (target === "*") state.errors.push("*|target|target-unexpected");
  for (const [file, spec] of Object.entries(FILES)) {
    if (!isObject(packet?.[file]) || packet[file].schemaVersion !== spec.schemaVersion) {
      state.errors.push(`*|${file}|schema-version`);
    } else if (!isObject(packet[file].targets)) state.errors.push(`*|${file}|targets-shape`);
  }
  scanSecrets(capture, "capture", state.errors);
  for (const key of Object.keys(capture)) {
    if (!CAPTURE_ENVELOPE.includes(key)) state.errors.push(`${target}|${safeName(key)}|field-unexpected`);
  }
  const capturedAt = instant(capture.capturedAt);
  const mergedAt = instant(packet?.writerAuthority?.activationMerge?.mergedAt);
  if (!Number.isFinite(capturedAt)) state.errors.push(`${target}|capturedAt|field-shape`);
  else if (!Number.isFinite(mergedAt)) state.errors.push("*|activationMerge|field-shape");
  else if (capturedAt <= mergedAt) state.errors.push(`${target}|capturedAt|capture-before-activation-merge`);
  if (!sha40(capture.head)) state.errors.push(`${target}|head|field-shape`);
  if (!Array.isArray(capture.codes) || capture.codes.length > 0) state.errors.push(`${target}|codes|capture-failed`);
  const fields = isObject(capture.fields) ? capture.fields : {};
  if (!isObject(capture.fields)) state.errors.push(`${target}|fields|field-shape`);
  for (const name of Object.keys(fields)) {
    if (!PROVIDER_CAPTURE_FIELDS.includes(name)) state.errors.push(`${target}|${safeName(name)}|field-unexpected`);
  }
  const folded = {};
  for (const [file, names] of Object.entries(PROVIDER_FIELDS)) {
    for (const name of names) {
      if (fields[name] === undefined) state.errors.push(`${target}|${name}|field-absent`);
      else folded[name] = captureField(state, target, file, name, fields[name]);
    }
  }
  const floor = packet?.runnerBinding?.floor;
  const ancestry = fields.deployedCommitAncestry;
  if (
    isObject(ancestry) &&
    "value" in ancestry &&
    floor?.status === "derived" &&
    ancestry.value?.floor !== floor.commit
  ) {
    state.errors.push(`${target}|deployedCommitAncestry|floor-mismatch`);
  }
  if (state.errors.length > 0) return captureResult(packet, state);

  const applied = structuredClone(packet);
  const writer = slot(applied.writerAuthority.targets, target);
  for (const name of PROVIDER_FIELDS.writerAuthority) {
    if (name.startsWith("writers.")) slot(writer, "writers")[name.slice("writers.".length)] = folded[name];
    else writer[name] = folded[name];
  }
  const gates = slot(slot(applied.authorityMatrix.targets, target), "gates");
  for (const gate of PROVIDER_GATES) slot(gates, gate).observeAuthority = folded[`gates.${gate}.observeAuthority`];
  const binding = slot(applied.runnerBinding.targets, target);
  for (const name of PROVIDER_FIELDS.runnerBinding) binding[name] = folded[name];
  return captureResult(applied, state);
}

function captureResult(packet, state) {
  const verdict = state.errors.length > 0 ? "invalid" : state.missing.length > 0 ? "bounded-unknown" : "complete";
  return { packet, verdict, missing: state.missing, errors: state.errors };
}

const ASSEMBLY_FORMAT = "collections-cutover-authority-assembly/v1";
const ACTIVATION_MIGRATION = "20261016_collections_anonymous_owner_activation";
const INPUT_LIMIT = 2 * 1024 * 1024;
const WINDOW_MS = 30 * 60_000;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exactKeys = (value, names) => isObject(value) && same(Object.keys(value).sort(), [...names].sort());
const sortedUnique = (values) => [...new Set(values)].sort();
const utc = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(instant(value));
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value);
const requireProof = (condition, code) => {
  if (!condition) throw new Error(code);
};
const boundJson = (value, code) => {
  requireProof(
    isObject(value) &&
      typeof value.text === "string" &&
      digest64(value.sha256) &&
      Buffer.byteLength(value.text, "utf8") <= 512 * 1024 &&
      sha256(value.text) === value.sha256,
    code,
  );
  try {
    return JSON.parse(value.text);
  } catch {
    throw new Error(code);
  }
};
const shownValue = (value) => {
  requireProof(evidenceShown(value) && "value" in value, "capture-incomplete");
  return value.value;
};

// These are the capture's closed source sets, not caller-selected coverage keys.
const WRITER_SOURCES = Object.freeze({
  serving: ["rollouts", "deployments", "replicasets", "pods"],
  suspended: ["jobs", "cronjobs"],
  dormant: ["rollouts", "deployments", "replicasets"],
  rollback: ["replicasets", "helm"],
  job: ["jobs"],
  cronjob: ["cronjobs"],
  session: ["sessions"],
});

function completeSet(set, code) {
  requireProof(
    evidenceShown(set) &&
      Array.isArray(set.items) &&
      integer(set.collected) &&
      set.collected <= 8192 &&
      set.collected === set.authoritativeTotal &&
      set.items.length === set.collected,
    code,
  );
  const ids = set.items.map((item) => item?.id);
  requireProof(
    ids.every((id) => typeof id === "string" && /^[A-Za-z0-9_.:/#-]{1,240}$/.test(id)) &&
      new Set(ids).size === ids.length,
    code,
  );
  return set.items;
}

function captureInventory(capture) {
  const totals = new Map();
  const ids = new Set();
  for (const kind of WRITER_KINDS) {
    const set = capture.fields[`writers.${kind}`];
    const items = completeSet(set, "inventory-incomplete");
    requireProof(exactKeys(set.coverage, WRITER_SOURCES[kind]), "inventory-incomplete");
    for (const [source, coverage] of Object.entries(set.coverage)) {
      requireProof(
        (coverage?.status === "notServed" && source === "rollouts" && exactKeys(coverage, ["status"])) ||
          (coverage?.status === "complete" && integer(coverage.listed) && coverage.listed <= 100_000),
        "inventory-incomplete",
      );
      if (totals.has(source)) requireProof(same(totals.get(source), coverage), "inventory-incomplete");
      totals.set(source, coverage);
    }
    for (const item of items) {
      requireProof(!ids.has(item.id), "inventory-incomplete");
      ids.add(item.id);
      const source = item.id.split(":")[0];
      requireProof(safeId(item.id), "writer-source");
      requireProof(
        WRITER_SOURCES[kind].includes(source) || (kind === "session" && ["backend", "session"].includes(source)),
        "writer-source",
      );
    }
  }
  for (const [source, coverage] of totals) {
    const count = [...ids].filter((id) =>
      source === "sessions" ? /^(backend|session):/.test(id) : id.startsWith(`${source}:`),
    ).length;
    requireProof(coverage.status === "notServed" ? count === 0 : count <= coverage.listed, "inventory-incomplete");
    if (source === "sessions") requireProof(count === coverage.listed && count <= 256, "inventory-incomplete");
    if (source === "helm") requireProof(coverage.listed < 256 && count + 1 === coverage.listed, "inventory-incomplete");
  }
}

// A successful enclosing workflow is not evidence that its owning step executed.
function executedEvidence(evidence, head, code, packetless = false) {
  requireProof(
    integer(evidence?.jobId) && evidence.jobId > 0 && integer(evidence.stepNumber) && evidence.stepNumber > 0,
    code,
  );
  const record = boundJson(evidence?.execution, code);
  const conclusion = packetless ? "failure" : "success";
  requireProof(
    sha40(record.headSha) &&
      record.headSha === head &&
      integer(record.databaseId) &&
      record.databaseId > 0 &&
      record.status === "completed" &&
      record.conclusion === conclusion &&
      Array.isArray(record.jobs),
    code,
  );
  const jobs = record.jobs.filter((job) => job.databaseId === evidence.jobId);
  requireProof(jobs.length === 1, code);
  const job = jobs[0];
  requireProof(job.status === "completed" && job.conclusion === conclusion && Array.isArray(job.steps), code);
  const steps = job.steps.filter((step) => step.number === evidence.stepNumber);
  requireProof(steps.length === 1, code);
  const step = steps[0];
  const start = instant(step.startedAt),
    end = instant(step.completedAt);
  requireProof(
    step.status === "completed" &&
      step.conclusion === conclusion &&
      Number.isFinite(start) &&
      end >= start &&
      start >= instant(job.startedAt) &&
      end <= instant(job.completedAt),
    code,
  );
  if (code === "schema-source")
    requireProof(
      step.name === "Run protected Collections cutover" &&
        job.steps.filter((entry) => entry.conclusion === "failure").length === (packetless ? 1 : 0),
      code,
    );
  return { start, end };
}

function provenImages(item, capture, captureSha256, supplementary, floor, ancestry) {
  requireProof(Array.isArray(item.revisions) && item.revisions.every(sha40), "image-provenance");
  if (item.id.startsWith("helm:")) {
    requireProof(item.revisions.length === 1, "image-provenance");
    const recorded = shownValue(capture.fields.deployedCommitAncestry).revisions;
    const match = recorded.filter((entry) => `helm:chase-sets-platform/${entry.revision}` === item.id);
    requireProof(
      match.length === 1 && match[0].commit === item.revisions[0] && match[0].containsFloor === item.containsFloor,
      "image-provenance",
    );
    return item.revisions;
  }
  requireProof(
    Array.isArray(item.images) &&
      item.images.length > 0 &&
      item.images.length <= 64 &&
      sortedUnique(item.images).length === item.images.length,
    "image-provenance",
  );
  const revisions = item.images.map((image) => {
    requireProof(
      typeof image === "string" && image.length <= 512 && /^[a-zA-Z0-9._/:@-]+$/.test(image),
      "image-provenance",
    );
    const tag = /:([a-f0-9]{40})(?:@sha256:[a-f0-9]{64})?$/.exec(image)?.[1];
    if (tag && item.revisions.includes(tag)) {
      const digest = /@(sha256:[a-f0-9]{64})$/.exec(image)?.[1];
      const conflicts = shownValue(capture.fields.deployedCommitAncestry).revisions.filter(
        (entry) => digest && entry.digest === digest && entry.commit !== tag,
      );
      requireProof(
        conflicts.length === 0 &&
          supplementary.images.every(
            (proof) => proof.sourceId !== item.id || proof.image !== image || proof.commit === tag,
          ),
        "image-provenance",
      );
      return tag;
    }
    requireProof(/@sha256:[a-f0-9]{64}$/.test(image), "image-provenance");
    const captured = shownValue(capture.fields.deployedCommitAncestry).revisions.filter(
      (entry) => entry.digest === image.slice(image.lastIndexOf("@") + 1),
    );
    if (captured.length > 0 && item.revisions.length > 0) {
      const commits = sortedUnique(captured.map((entry) => entry.commit));
      requireProof(
        commits.length === 1 && sha40(commits[0]) && item.revisions.includes(commits[0]),
        "image-provenance",
      );
      return commits[0];
    }
    const proofs = supplementary.images.filter((proof) => proof.sourceId === item.id && proof.image === image);
    requireProof(proofs.length === 1, "image-provenance");
    const proof = proofs[0];
    requireProof(
      proof.captureSha256 === captureSha256 && sha40(proof.commit) && (!tag || proof.commit === tag),
      "image-provenance",
    );
    const window = executedEvidence(proof, proof.commit, "image-provenance");
    requireProof(window.end <= instant(capture.capturedAt), "image-provenance");
    requireProof(Array.isArray(proof.lines) && proof.lines.length === 2, "image-provenance");
    const digest = image.slice(image.lastIndexOf("@") + 1);
    for (const [index, binding] of [`RELEASE_COMMIT: ${proof.commit}`, `RELEASE_IMAGE_DIGEST: ${digest}`].entries()) {
      const line = proof.lines[index];
      requireProof(
        integer(line?.number) &&
          line.number > 0 &&
          typeof line.text === "string" &&
          line.text.length <= 2048 &&
          sha256(line.text) === line.sha256 &&
          line.text.endsWith(binding),
        "image-provenance",
      );
      const time = /\t(\d{4}-\d{2}-\d{2}T[^ ]+Z) /.exec(line.text)?.[1];
      requireProof(instant(time) >= window.start && instant(time) <= window.end, "image-provenance");
    }
    const compare = proof.compare;
    requireProof(
      exactKeys(compare, ["artifactSha256", "status", "ahead_by", "behind_by", "base", "mergeBase", "head"]) &&
        digest64(compare.artifactSha256) &&
        ["ahead", "identical"].includes(compare.status) &&
        integer(compare.ahead_by) &&
        compare.behind_by === 0 &&
        compare.base === floor &&
        compare.mergeBase === floor &&
        compare.head === proof.commit &&
        (compare.status === "ahead"
          ? compare.ahead_by > 0 && proof.commit !== floor
          : compare.ahead_by === 0 && proof.commit === floor) &&
        ancestry(proof.commit),
      "image-provenance",
    );
    return proof.commit;
  });
  requireProof(
    item.revisions.every((revision) => revisions.includes(revision)),
    "image-provenance",
  );
  return sortedUnique(revisions);
}

function exactReceipt(kind, item, context) {
  const { supplementary, capture, captureSha256, floor } = context;
  const code = kind === "session" ? "session-proof" : "writer-authority";
  const receipts = supplementary[kind === "session" ? "terminations" : "retirements"];
  const matches = receipts.filter((entry) => entry.sourceId === item.id);
  requireProof(matches.length === 1, code);
  const evidence = matches[0];
  const receipt = boundJson(evidence.receipt, code);
  const window = executedEvidence(evidence, evidence.head, code);
  requireProof(
    receipt.format ===
      (kind === "session" ? "collections-session-termination/v1" : "collections-writer-retirement/v1") &&
      receipt.captureSha256 === captureSha256 &&
      receipt.sourceId === item.id &&
      receipt.target === capture.target &&
      receipt.dbIdentityDigest === shownValue(capture.fields.databaseIdentityDigest) &&
      receipt.floorCommit === floor &&
      text(receipt.authorizedBy) &&
      receipt.recreationPrevented === true &&
      utc(receipt.executedAt) &&
      instant(receipt.executedAt) >= window.start &&
      instant(receipt.executedAt) <= window.end &&
      instant(receipt.executedAt) >= instant(capture.capturedAt) &&
      window.end <= instant(context.startedAt),
    code,
  );
  if (kind === "session") {
    const set = capture.fields["writers.session"];
    requireProof(
      !(
        set.pooledRead?.value?.pid === item.pid &&
        set.pooledRead?.value?.backendStart === item.backendStart &&
        set.pool?.value?.userDigest === item.roleDigest
      ),
      code,
    );
    requireProof(
      item.classification === "unknown" &&
        BACKEND_ID.test(item.id) &&
        item.id === `backend:${item.pid}` &&
        utc(item.backendStart) &&
        digest64(item.roleDigest) &&
        receipt.pid === item.pid &&
        receipt.backendStart === item.backendStart &&
        receipt.roleDigest === item.roleDigest &&
        receipt.reconnectionPrevented === true,
      code,
    );
  } else {
    const owner = boundJson(evidence.owner, code);
    requireProof(
      owner.format === "collections-writer-owner/v1" &&
        owner.captureSha256 === captureSha256 &&
        owner.sourceId === item.id &&
        safeId(owner.objectUid) &&
        owner.objectUid === receipt.objectUid &&
        owner.target === capture.target &&
        owner.dbIdentityDigest === receipt.dbIdentityDigest &&
        utc(owner.observedAt) &&
        instant(owner.observedAt) >= window.start &&
        instant(owner.observedAt) <= instant(receipt.executedAt) &&
        same(owner.images, item.images ?? []) &&
        (item.uid === undefined || item.uid === owner.objectUid),
      code,
    );
  }
  return [{ id: item.id, state: kind === "session" ? "terminated" : "retired", revision: null }];
}

function deployedWriters(id, revisions) {
  return revisions.map((revision, index) => ({
    id: index === 0 ? id : `${id}/revision/${revision}`,
    state: "deployed",
    revision,
  }));
}

function sessionRevisions(set, context) {
  const state = { errors: [], missing: [] };
  requireProof(
    sessionEvidence(state, context.capture.target, set) === set &&
      state.errors.length === 0 &&
      state.missing.length === 0,
    "session-proof",
  );
  requireProof(
    SESSION_EVIDENCE.every((key) => evidenceShown(set[key]) && EVIDENCE_SHAPE[key](set[key])),
    "session-proof",
  );
  const holders = completeSet(set.holders, "session-proof");
  requireProof(
    holders.length > 0 && exactKeys(set.holders.coverage, ["workflows", "runs", "kubernetes"]),
    "session-proof",
  );
  const coverage = set.holders.coverage;
  requireProof(
    coverage.workflows?.status === "complete" &&
      integer(coverage.workflows.listed) &&
      integer(coverage.workflows.pooledSteps) &&
      coverage.kubernetes?.status === "complete" &&
      integer(coverage.kubernetes.listed) &&
      isObject(coverage.runs) &&
      Array.isArray(set.holders.exclusions),
    "session-proof",
  );
  const exclusions = set.holders.exclusions;
  requireProof(
    exclusions.every((entry) =>
      ["contexts-exclude-collections", "target-mismatch", "direct-bootstrap-credential"].includes(entry.reason),
    ),
    "session-proof",
  );
  requireProof(
    holders.filter((holder) => holder.source === "kubernetes").length +
      exclusions.filter((entry) => entry.reason === "direct-bootstrap-credential").length ===
      coverage.kubernetes.listed,
    "session-proof",
  );
  const steps = [...holders, ...exclusions].filter((holder) => holder.id?.startsWith("workflow:"));
  const workflows = sortedUnique(steps.map((holder) => holder.workflow));
  requireProof(
    steps.length === coverage.workflows.pooledSteps &&
      workflows.length <= coverage.workflows.listed &&
      holders.filter((holder) => holder.source === "capture").length === 1 &&
      same(
        Object.keys(coverage.runs).sort(),
        sortedUnique(holders.filter((holder) => holder.source === "workflow-step").map((holder) => holder.workflow)),
      ),
    "session-proof",
  );
  for (const [workflow, runCoverage] of Object.entries(coverage.runs)) {
    const executing = [...holders, ...exclusions].filter(
      (holder) => holder.workflow === workflow && integer(holder.runId),
    ).length;
    requireProof(
      runCoverage?.status === "complete" &&
        integer(runCoverage.listed) &&
        integer(runCoverage.executing) &&
        executing === runCoverage.executing &&
        executing <= runCoverage.listed,
      "session-proof",
    );
  }
  for (const holder of holders) {
    requireProof(
      ["capture", "workflow-step", "workflow-run", "kubernetes"].includes(holder.source) &&
        holder.credentialSource === "DATABASE_URL_COLLECTIONS" &&
        holder.containsFloor === true &&
        Array.isArray(holder.revisions) &&
        holder.revisions.length > 0 &&
        holder.revisions.every((revision) => sha40(revision) && context.ancestry(revision)),
      "session-proof",
    );
    if (["capture", "workflow-step"].includes(holder.source))
      requireProof(same(holder.revisions, [context.capture.head]), "session-proof");
    if (holder.source === "capture")
      requireProof(/^capture:[1-9][0-9]*\/[1-9][0-9]*$/.test(holder.id), "session-proof");
    if (holder.source === "workflow-run")
      requireProof(
        holder.id === `run:${holder.runId}/${holder.attempt}` &&
          holder.revisions.length === 1 &&
          integer(holder.runId) &&
          holder.runId > 0 &&
          integer(holder.attempt) &&
          holder.attempt > 0 &&
          coverage.runs[holder.workflow]?.status === "complete" &&
          Array.isArray(holder.jobIds) &&
          holder.jobIds.length > 0 &&
          holder.jobIds.every((id) => integer(id) && id > 0),
        "session-proof",
      );
    if (holder.source === "kubernetes") {
      const matches = WRITER_KINDS.filter((kind) => kind !== "session")
        .flatMap((kind) => context.capture.fields[`writers.${kind}`].items)
        .filter((writer) => writer.id === holder.id);
      requireProof(
        matches.length === 1 && same(sortedUnique(matches[0].revisions), sortedUnique(holder.revisions)),
        "session-proof",
      );
    }
  }
  return sortedUnique(holders.flatMap((holder) => holder.revisions));
}

function schemaLedger(supplementary, context) {
  const evidence = supplementary.schemaObservation;
  const receipt = boundJson(evidence?.receipt, "schema-source");
  const packetless = same(receipt.codes, ["packet-digest"]);
  const window = executedEvidence(evidence, context.capture.head, "schema-source", packetless);
  requireProof(
    evidence.captureSha256 === context.captureSha256 &&
      evidence.artifactJobId === evidence.jobId &&
      safeId(evidence.artifactName) &&
      receipt.format === "collections-privacy-cutover-receipt/v1" &&
      receipt.mode === "dry-run" &&
      receipt.target === context.capture.target &&
      receipt.dbIdentityDigest === shownValue(context.capture.fields.databaseIdentityDigest) &&
      receipt.floorCommit === context.floor &&
      utc(receipt.startedAt) &&
      utc(receipt.endedAt) &&
      instant(receipt.startedAt) >= instant(context.capture.capturedAt) &&
      instant(receipt.startedAt) >= window.start &&
      instant(receipt.endedAt) >= instant(receipt.startedAt) &&
      instant(receipt.endedAt) <= window.end &&
      window.end <= instant(context.startedAt) &&
      instant(context.startedAt) - instant(receipt.startedAt) <= WINDOW_MS,
    "schema-source",
  );
  requireProof(
    Array.isArray(receipt.codes) &&
      (same(receipt.codes, []) || same(receipt.codes, ["packet-digest"])) &&
      receipt.fencePresent === true &&
      Array.isArray(receipt.schemaLedger) &&
      receipt.schemaLedger.length > 0 &&
      receipt.schemaLedger.length <= 512 &&
      receipt.schemaLedger.every((id) => typeof id === "string" && /^[a-z0-9_]{1,200}$/.test(id)) &&
      same(receipt.schemaLedger, sortedUnique(receipt.schemaLedger)) &&
      receipt.schemaLedger.includes(ACTIVATION_MIGRATION) &&
      receipt.schemaVersion === sha256(JSON.stringify(receipt.schemaLedger)),
    "schema-source",
  );
  if (same(receipt.codes, ["packet-digest"]))
    requireProof(
      receipt.packet === null &&
        receipt.packetText === null &&
        receipt.packetSha256 === null &&
        isObject(receipt.gates) &&
        Object.values(receipt.gates).length > 0 &&
        Object.values(receipt.gates).every((value) => value === false),
      "schema-source",
    );
  else {
    const packet = boundJson({ text: receipt.packetText, sha256: receipt.packetSha256 }, "schema-source");
    requireProof(
      same(packet, receipt.packet) &&
        packet.target === receipt.target &&
        packet.floorCommit === receipt.floorCommit &&
        packet.dbIdentityDigest === receipt.dbIdentityDigest &&
        same(packet.schemaLedger, receipt.schemaLedger) &&
        receipt.gates?.packet === true &&
        receipt.gates?.schema === true,
      "schema-source",
    );
  }
  return receipt.schemaLedger;
}

/** Offline evidence derivation only. A separate packet-bearing dry-run remains mandatory before mutation. */
export function assembleAuthorityPacket(input, dependencies = {}) {
  const mapped = Object.fromEntries(WRITER_KINDS.map((kind) => [kind, { deployed: 0, retired: 0, terminated: 0 }]));
  const codes = new Set();
  try {
    requireProof(isObject(input) && Buffer.byteLength(JSON.stringify(input), "utf8") <= INPUT_LIMIT, "assembly-input");
    const capture = boundJson(input.capture, "capture-binding");
    requireProof(
      exactKeys(capture, CAPTURE_ENVELOPE) &&
        capture.schemaVersion === PROVIDER_CAPTURE_SCHEMA_VERSION &&
        TARGETS.includes(input.target) &&
        capture.target === input.target &&
        sha40(capture.head) &&
        same(capture.codes, []) &&
        exactKeys(capture.fields, PROVIDER_CAPTURE_FIELDS),
      "capture-incomplete",
    );
    requireProof(
      utc(capture.capturedAt) &&
        utc(input.startedAt) &&
        utc(input.activationMergedAt) &&
        instant(capture.capturedAt) > instant(input.activationMergedAt) &&
        instant(input.startedAt) >= instant(capture.capturedAt) &&
        instant(input.startedAt) - instant(capture.capturedAt) <= WINDOW_MS,
      "capture-stale",
    );
    requireProof(sha40(input.floorCommit), "floor-mismatch");
    const floor = (dependencies.deriveFloor ?? deriveFloor)(input.root);
    requireProof(floor === input.floorCommit, "floor-mismatch");
    const ancestryCache = new Map();
    const ancestry = (revision) => {
      if (!ancestryCache.has(revision))
        ancestryCache.set(revision, (dependencies.containsFloor ?? containsFloor)(input.root, floor, revision));
      return ancestryCache.get(revision);
    };
    const supplementary = input.supplementary;
    requireProof(
      exactKeys(supplementary, ["images", "retirements", "terminations", "schemaObservation"]) &&
        [supplementary.images, supplementary.retirements, supplementary.terminations].every(
          (set) => Array.isArray(set) && set.length <= 8192,
        ),
      "assembly-input",
    );
    const secretErrors = [];
    scanSecrets(input, "input", secretErrors);
    requireProof(secretErrors.length === 0, "assembly-input");
    for (const name of PROVIDER_CAPTURE_FIELDS.filter((name) => !name.startsWith("writers.")))
      shownValue(capture.fields[name]);
    requireProof(
      shownValue(capture.fields.environment) === input.target &&
        digest64(shownValue(capture.fields.databaseIdentityDigest)) &&
        shownValue(capture.fields.deployedCommitAncestry).floor === floor &&
        Array.isArray(shownValue(capture.fields.deployedCommitAncestry).revisions) &&
        PROVIDER_GATES.every((gate) => shownValue(capture.fields[`gates.${gate}.observeAuthority`]) === "demonstrated"),
      "capture-incomplete",
    );
    captureInventory(capture);
    const context = {
      capture,
      captureSha256: input.capture.sha256,
      supplementary,
      floor,
      ancestry,
      startedAt: input.startedAt,
    };
    const writers = {};
    for (const kind of WRITER_KINDS) {
      const set = capture.fields[`writers.${kind}`];
      let pooledRevisions;
      if (kind === "session" && set.items.some((item) => item.classification === "pooler")) {
        try {
          pooledRevisions = sessionRevisions(set, context);
        } catch {
          codes.add("session-proof");
        }
      }
      writers[kind] = [];
      for (const item of set.items) {
        try {
          let derived;
          if (kind === "session") {
            if (item.classification === "pooler") {
              requireProof(
                pooledRevisions && item.containsFloor === true && same(sortedUnique(item.revisions), pooledRevisions),
                "session-proof",
              );
              derived = deployedWriters(item.id, pooledRevisions);
            } else {
              requireProof(item.containsFloor !== true, "session-proof");
              derived = exactReceipt(kind, item, context);
            }
          } else {
            const revisions = provenImages(item, capture, input.capture.sha256, supplementary, floor, ancestry);
            if (revisions.every(ancestry)) {
              requireProof(item.containsFloor !== false, "writer-authority");
              derived = deployedWriters(item.id, revisions);
            } else {
              requireProof(item.containsFloor !== true, "writer-authority");
              derived = exactReceipt(kind, item, context);
            }
          }
          for (const writer of derived) {
            requireProof(safeId(writer.id), "writer-authority");
            mapped[kind][writer.state]++;
          }
          writers[kind].push(...derived);
        } catch (error) {
          codes.add(
            ["image-provenance", "session-proof", "writer-authority"].includes(error.message)
              ? error.message
              : "writer-authority",
          );
        }
      }
      writers[kind].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    let ledger;
    try {
      ledger = schemaLedger(supplementary, context);
    } catch {
      codes.add("schema-source");
    }
    if (codes.size) return { format: ASSEMBLY_FORMAT, verdict: "refused", codes: [...codes].sort(), mapped };
    const ids = Object.values(writers)
      .flat()
      .map((writer) => writer.id);
    requireProof(ids.length === new Set(ids).size, "inventory-incomplete");
    const packet = {
      schemaVersion: "collections-cutover-gate/v1",
      target: capture.target,
      capturedAt: capture.capturedAt,
      floorCommit: floor,
      dbIdentityDigest: shownValue(capture.fields.databaseIdentityDigest),
      schemaLedger: ledger,
      inventory: { collected: ids.length, authoritativeTotal: ids.length },
      writers,
    };
    const packetText = `${JSON.stringify(packet)}\n`;
    requireProof(Buffer.byteLength(packetText, "utf8") <= 16 * 1024, "packet-size");
    return {
      format: ASSEMBLY_FORMAT,
      verdict: "complete",
      codes: [],
      packet,
      packetText,
      packetSha256: sha256(packetText),
      mapped,
    };
  } catch (error) {
    const allowed = [
      "assembly-input",
      "capture-binding",
      "capture-incomplete",
      "capture-stale",
      "floor-ambiguous",
      "floor-mismatch",
      "inventory-incomplete",
      "writer-source",
      "packet-size",
    ];
    return {
      format: ASSEMBLY_FORMAT,
      verdict: "refused",
      codes: [allowed.includes(error.message) ? error.message : "assembly-input"],
      mapped,
    };
  }
}

// Host route: `node scripts/collections-cutover-authority-packet.mjs <packet-dir> [capture.json ...]`.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [directory, ...capturePaths] = process.argv.slice(2);
  if (directory === "--assemble") {
    let result;
    try {
      requireProof(capturePaths.length === 1 && statSync(capturePaths[0]).size <= INPUT_LIMIT, "assembly-input");
      result = assembleAuthorityPacket(JSON.parse(readFileSync(capturePaths[0], "utf8")));
    } catch {
      result = { format: ASSEMBLY_FORMAT, verdict: "refused", codes: ["assembly-input"] };
    }
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.verdict === "complete" ? 0 : 2;
  } else {
    let packet = readPacket(directory);
    const applied = capturePaths.map((path) => {
      const result = applyProviderCapture(packet, JSON.parse(readFileSync(path, "utf8")));
      packet = result.packet;
      return { capture: path, verdict: result.verdict, missing: result.missing.length, errors: result.errors };
    });
    const result = verifyAuthorityPacket(packet);
    console.log(JSON.stringify({ applied, verification: result }, null, 2));
    const refused = applied.some((entry) => entry.errors.length > 0);
    process.exitCode = refused || result.verdict === "invalid" ? 2 : result.verdict === "bounded-unknown" ? 3 : 0;
  }
}
