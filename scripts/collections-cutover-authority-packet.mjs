// Collections cutover authority packet (#10210). `verifyAuthorityPacket` is the 8933-impl-g1
// `authority-packet-completeness` verifier (sha256 1a214a07d64fb4a512d0e6d2ab3c7b24e7b324124f53c17d57d1435801811b7c)
// ported unchanged: it compares the closed target inventory to the three #8933 captures. A field is complete
// only as `{ value, source }`; `{ status: "unknown", missingAuthority, hostAction }` is a governed bounded
// unknown; anything else, a secret-shaped value, an extra target or a recovery-commit floor is invalid.
// Completeness only: it never proves retirement. `applyProviderCapture` folds one read-only CI capture in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

function captureField(state, target, file, name, value) {
  if (name.startsWith("writers.")) return writerSet(state, target, name.slice("writers.".length), value);
  if (field(state, target, file, name, value) && name.startsWith("gates.") && value.value !== "demonstrated") {
    state.errors.push(`${target}|${name}|field-shape`);
  }
}

function slot(parent, key) {
  if (!isObject(parent[key])) parent[key] = {};
  return parent[key];
}

/**
 * Folds one `collections-cutover-provider-capture/v1` into a copy of `packet`. A capture carrying a non-AC1
 * field or target, a capture taken at or before the activation merge, failure codes, a secret-shaped value
 * or a malformed field is refused whole: `errors` is non-empty and `packet` is returned untouched.
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
  for (const [file, names] of Object.entries(PROVIDER_FIELDS)) {
    for (const name of names) {
      if (fields[name] === undefined) state.errors.push(`${target}|${name}|field-absent`);
      else captureField(state, target, file, name, fields[name]);
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
    if (name.startsWith("writers.")) slot(writer, "writers")[name.slice("writers.".length)] = fields[name];
    else writer[name] = fields[name];
  }
  const gates = slot(slot(applied.authorityMatrix.targets, target), "gates");
  for (const gate of PROVIDER_GATES) slot(gates, gate).observeAuthority = fields[`gates.${gate}.observeAuthority`];
  const binding = slot(applied.runnerBinding.targets, target);
  for (const name of PROVIDER_FIELDS.runnerBinding) binding[name] = fields[name];
  return captureResult(applied, state);
}

function captureResult(packet, state) {
  const verdict = state.errors.length > 0 ? "invalid" : state.missing.length > 0 ? "bounded-unknown" : "complete";
  return { packet, verdict, missing: state.missing, errors: state.errors };
}

// Host route: `node scripts/collections-cutover-authority-packet.mjs <packet-dir> [capture.json ...]`.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [directory, ...capturePaths] = process.argv.slice(2);
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
