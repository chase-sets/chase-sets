// Importing this module performs no queries. Only its closed CLI collects inventory.
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyExposure, exposureRuleIds, invariant, isHash, isRef, scanExposure, sha256 } from "./helpers.mjs";

export const supportPath = "scripts/test-support/10678-ingress-nosend";
export const decisionSha256 = "cd40037db2909c89980c8fdb365a2583cf5ca276122ebcdcda2e7456b30888b5";
export const repairDecisionSha256 = "57f78a21e92c1bcbc8305986d8a868ff32341145bdca2422f0faa4537b93f3ad";
export const retainedPath = `${supportPath}/retained-configmap.yaml`;
export const maximumEnvelopeBytes = 48000;
export const closurePaths = [
  "scripts/render-platform-helm-values.mjs",
  "scripts/lib/repo.mjs",
  "scripts/doks-cluster-addons.mjs",
  "infrastructure/helm/doks-ingress/ingress-nginx-values.yaml",
  "pnpm-lock.yaml",
  ".github/workflows/platform-pr.yml",
  ".github/workflows/ingress-nosend-diagnostic.yml",
  "scripts/release-qualification-scope.mjs",
];
export const stockTools = [
  "node",
  "bash",
  "env",
  "curl",
  "sha256sum",
  "tar",
  "install",
  "cp",
  "chmod",
  "mkdir",
  "readlink",
  "dpkg-query",
  "apt-cache",
  "git",
  "docker",
  "openssl",
  "sudo",
  "iptables",
  "ip6tables",
  "ip",
  "systemctl",
  "containerd",
  "containerd-shim-runc-v2",
  "runc",
  "sh",
];
export const measurementTools = [...new Set([...stockTools, "kind", "helm", "kubectl", "pnpm", "esbuild", "yq"])];

// Opaque per-invocation state. No recorder, observed value or callback is accepted.
export const bootstrapComparisonComponents = Object.freeze([
  "OTHER", "FINGERPRINT", "INTERPRETER", "RUNNER", "ACTIVE_RUNTIME",
  ...stockTools.map((name) => `STOCK_${name.replaceAll("-", "_").toUpperCase()}`),
  "DAEMON_DOCKER", "DAEMON_CONTAINERD", "COMPONENT_CONTAINERD", "COMPONENT_RUNC", "COMPONENT_DOCKER_INIT",
  "SERVICE_DOCKER", "SERVICE_CONTAINERD",
]);
export const bootstrapComparisonPredicates = Object.freeze([
  "OTHER", "PIN_RECORD", "PIN_PATH_TYPE", "PIN_PATH", "PIN_TARGET", "PIN_HASH",
  "DISTRIBUTION_RECORD", "DISTRIBUTION_VERSION_TYPE", "DISTRIBUTION_VERSION", "DISTRIBUTION_ARCH_TYPE",
  "DISTRIBUTION_ARCH", "DISTRIBUTION_REFERENCE", "DISTRIBUTION_HASH", "PIN_FORMAT", "INVOCATION_FORMAT",
  "INVOCATION_NAME", "INVOCATION_MULTICALL", "CLOSURE_DESCRIPTOR", "SCRIPT_TOOL", "SCRIPT_SHEBANG",
  "SCRIPT_ROOT", "STOCK_RESOLVE", "EXECUTABLE_REALPATH", "EXECUTABLE_READ", "EXECUTABLE_FORMAT",
  "DISTRIBUTION_REALPATH", "DISTRIBUTION_ROOT", "DISTRIBUTION_TARGET", "DISTRIBUTION_READ",
  "OBSERVED_PATH", "OBSERVED_TARGET", "OBSERVED_HASH", "OBSERVED_FORMAT", "OBSERVED_PACKAGE",
  "OBSERVED_SHEBANG", "CLOSURE_PAIRS", "CLOSURE_PAIR_ARRAY", "CLOSURE_PAIR_LENGTH", "CLOSURE_PATH_TYPE",
  "CLOSURE_HASH_TYPE", "CLOSURE_PATH_NONEMPTY", "CLOSURE_PATH_CHARACTERS", "CLOSURE_PATH_UTF8",
  "CLOSURE_PATH_SEGMENTS", "CLOSURE_PATH_UNIQUE", "CLOSURE_HASH", "CLOSURE_ORDER", "CLOSURE_COUNT",
  "CLOSURE_DIGEST", "INTERPRETER_SEARCH", "INTERPRETER_PROCESS", "INTERPRETER_PATH",
  "FINGERPRINT_IMAGE_VERSION", "FINGERPRINT_IMAGE_OS", "FINGERPRINT_ARCHITECTURE", "FINGERPRINT_KERNEL",
  "FINGERPRINT_OS_RELEASE", "FINGERPRINT_TOOLS", "FINGERPRINT_VERSIONS", "FINGERPRINT_DAEMON",
  "FINGERPRINT_IDENTITY", "FINGERPRINT_EXPECTED_SERIALIZE", "FINGERPRINT_ACTUAL_SERIALIZE", "FINGERPRINT_EQUAL",
  "ACTIVE_RUNTIME_DEFAULT", "ACTIVE_RUNTIME_PRESENT", "RUNNER_IMAGE", "RUNNER_IMAGE_VERSION", "RUNNER_IMAGE_OS",
  "RUNNER_ARCHITECTURE", "RUNNER_KERNEL", "RUNNER_OS", "RUNNER_CODENAME", "RUNNER_ENGINE_VERSION",
  "RUNNER_ENGINE_API", "RUNNER_ENGINE_COMMIT", "COMPONENT_SELECT", "COMPONENT_COUNT", "COMPONENT_VERSION",
  "COMPONENT_COMMIT", "SERVICE_PINS", "SERVICE_EQUAL",
]);
export const bootstrapComparisonCodes = Object.freeze([
  "REAL_TOOL_PIN_REQUIRED", "REVIEWED_DISTRIBUTION_REQUIRED", "EXECUTABLE_FORMAT_REQUIRED",
  "AUTHENTICATED_INVOCATION_REQUIRED", "FIXED_SCRIPT_CLOSURE_DESCRIPTOR_REQUIRED",
  "SCRIPT_INTERPRETER_CLOSURE_REQUIRED", "STOCK_INVOCATION_PATH_DRIFT",
  "NATIVE_EXECUTABLE_OR_REVIEWED_SCRIPT_REQUIRED", "SCRIPT_DISTRIBUTION_ESCAPE",
  "EXECUTABLE_DRIFT_OR_SHIM", "TOOL_PACKAGE_DRIFT", "INTERPRETER_OR_DISTRIBUTION_DRIFT",
  "SCRIPT_CLOSURE_PAIRS_REQUIRED", "SCRIPT_CLOSURE_PAIR_REQUIRED", "SCRIPT_CLOSURE_PATH_OR_HASH_REFUSED",
  "SCRIPT_CLOSURE_ORDER_REFUSED", "SCRIPT_DISTRIBUTION_DRIFT", "TOOL_INTERPRETER_MISMATCH",
  "RUNNER_OS_DAEMON_OR_TOOL_DRIFT", "ACTIVE_RUNC_IDENTITY_REQUIRED", "REVIEWED_RUNNER_IDENTITY_DRIFT",
  "REVIEWED_DAEMON_IDENTITY_DRIFT", "REVIEWED_SERVICE_FILE_DRIFT",
]);
const comparisonStates = new WeakMap();
const stockComparisonComponents = new Map(stockTools.map((name) => [name, `STOCK_${name.replaceAll("-", "_").toUpperCase()}`]));
const comparisonPredicateCodes = new Map(Object.entries({
  REAL_TOOL_PIN_REQUIRED: ["PIN_RECORD", "PIN_PATH_TYPE", "PIN_PATH", "PIN_TARGET", "PIN_HASH"],
  REVIEWED_DISTRIBUTION_REQUIRED: ["DISTRIBUTION_RECORD", "DISTRIBUTION_VERSION_TYPE", "DISTRIBUTION_VERSION", "DISTRIBUTION_ARCH_TYPE", "DISTRIBUTION_ARCH", "DISTRIBUTION_REFERENCE", "DISTRIBUTION_HASH"],
  EXECUTABLE_FORMAT_REQUIRED: ["PIN_FORMAT"],
  AUTHENTICATED_INVOCATION_REQUIRED: ["INVOCATION_FORMAT", "INVOCATION_NAME", "INVOCATION_MULTICALL"],
  FIXED_SCRIPT_CLOSURE_DESCRIPTOR_REQUIRED: ["CLOSURE_DESCRIPTOR"],
  SCRIPT_INTERPRETER_CLOSURE_REQUIRED: ["SCRIPT_TOOL", "SCRIPT_SHEBANG", "SCRIPT_ROOT"],
  STOCK_INVOCATION_PATH_DRIFT: ["STOCK_RESOLVE"],
  NATIVE_EXECUTABLE_OR_REVIEWED_SCRIPT_REQUIRED: ["EXECUTABLE_FORMAT"],
  SCRIPT_DISTRIBUTION_ESCAPE: ["DISTRIBUTION_ROOT", "DISTRIBUTION_TARGET"],
  EXECUTABLE_DRIFT_OR_SHIM: ["OBSERVED_PATH", "OBSERVED_TARGET", "OBSERVED_HASH", "OBSERVED_FORMAT"],
  TOOL_PACKAGE_DRIFT: ["OBSERVED_PACKAGE"],
  INTERPRETER_OR_DISTRIBUTION_DRIFT: ["OBSERVED_SHEBANG"],
  SCRIPT_CLOSURE_PAIRS_REQUIRED: ["CLOSURE_PAIRS"],
  SCRIPT_CLOSURE_PAIR_REQUIRED: ["CLOSURE_PAIR_ARRAY", "CLOSURE_PAIR_LENGTH", "CLOSURE_PATH_TYPE", "CLOSURE_HASH_TYPE"],
  SCRIPT_CLOSURE_PATH_OR_HASH_REFUSED: ["CLOSURE_PATH_NONEMPTY", "CLOSURE_PATH_CHARACTERS", "CLOSURE_PATH_UTF8", "CLOSURE_PATH_SEGMENTS", "CLOSURE_PATH_UNIQUE", "CLOSURE_HASH"],
  SCRIPT_CLOSURE_ORDER_REFUSED: ["CLOSURE_ORDER"],
  SCRIPT_DISTRIBUTION_DRIFT: ["CLOSURE_COUNT", "CLOSURE_DIGEST"],
  TOOL_INTERPRETER_MISMATCH: ["INTERPRETER_PROCESS", "INTERPRETER_PATH"],
  RUNNER_OS_DAEMON_OR_TOOL_DRIFT: ["FINGERPRINT_EQUAL"],
  ACTIVE_RUNC_IDENTITY_REQUIRED: ["ACTIVE_RUNTIME_DEFAULT", "ACTIVE_RUNTIME_PRESENT"],
  REVIEWED_RUNNER_IDENTITY_DRIFT: ["RUNNER_IMAGE", "RUNNER_IMAGE_VERSION", "RUNNER_IMAGE_OS", "RUNNER_ARCHITECTURE", "RUNNER_KERNEL", "RUNNER_OS", "RUNNER_CODENAME", "RUNNER_ENGINE_VERSION", "RUNNER_ENGINE_API", "RUNNER_ENGINE_COMMIT"],
  REVIEWED_DAEMON_IDENTITY_DRIFT: ["COMPONENT_COUNT", "COMPONENT_VERSION", "COMPONENT_COMMIT"],
  REVIEWED_SERVICE_FILE_DRIFT: ["SERVICE_EQUAL"],
}).flatMap(([code, predicates]) => predicates.map((predicate) => [predicate, code])));
export function createBootstrapComparison() {
  const handle = Object.freeze({});
  try { comparisonStates.set(handle, { component: "OTHER", predicate: "OTHER", fingerprint: null, refusal: null }); } catch {}
  return handle;
}
function comparisonComponent(diagnostic, component) {
  try {
    const state = comparisonStates.get(diagnostic);
    if (state) {
      state.component = bootstrapComparisonComponents.includes(component) ? component : "OTHER";
      state.predicate = "OTHER";
      state.fingerprint = null;
      state.refusal = null;
    }
  } catch {}
}
function comparisonStock(diagnostic, name) {
  try { if (comparisonStates.has(diagnostic)) comparisonComponent(diagnostic, stockComparisonComponents.get(name)); } catch {}
}
function comparisonAt(diagnostic, predicate, operation) {
  try {
    const state = comparisonStates.get(diagnostic);
    if (state) { state.predicate = bootstrapComparisonPredicates.includes(predicate) ? predicate : "OTHER"; state.refusal = null; }
  } catch {}
  const value = operation();
  try {
    const state = comparisonStates.get(diagnostic);
    if (state && !value) state.refusal = comparisonPredicateCodes.get(predicate) ?? null;
  } catch {}
  return value;
}
function comparisonEqual(diagnostic, expected, actual) {
  const left = comparisonAt(diagnostic, "FINGERPRINT_EXPECTED_SERIALIZE", () => canonical(expected));
  const right = comparisonAt(diagnostic, "FINGERPRINT_ACTUAL_SERIALIZE", () => canonical(actual));
  try {
    const state = comparisonStates.get(diagnostic);
    if (state) { state.predicate = "FINGERPRINT_EQUAL"; state.fingerprint = [left, right]; state.refusal = left === right ? null : "RUNNER_OS_DAEMON_OR_TOOL_DRIFT"; }
  } catch {}
  return left === right;
}
export function bootstrapComparisonCategory(diagnostic, error) {
  try {
    const state = comparisonStates.get(diagnostic);
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return state?.refusal && descriptor?.value === state.refusal ? state.refusal : "OTHER";
  } catch { return "OTHER"; }
}
export function bootstrapComparisonResult(diagnostic) {
  try {
    const state = comparisonStates.get(diagnostic);
    if (!state) return "component=OTHER predicate=OTHER";
    let suffix = "";
    if (state.predicate === "FINGERPRINT_EQUAL" && state.fingerprint) {
      const [expected, actual] = state.fingerprint.map((text) => JSON.parse(text));
      const fields = ["imageVersion", "imageOS", "architecture", "kernel", "osReleaseSha256", "toolsSha256", "versionsSha256", "daemonSha256", "identitySha256"];
      const tokens = ["FINGERPRINT_IMAGE_VERSION", "FINGERPRINT_IMAGE_OS", "FINGERPRINT_ARCHITECTURE", "FINGERPRINT_KERNEL", "FINGERPRINT_OS_RELEASE", "FINGERPRINT_TOOLS", "FINGERPRINT_VERSIONS", "FINGERPRINT_DAEMON", "FINGERPRINT_IDENTITY"];
      suffix = ` mismatches=${fields.flatMap((field, i) => expected[field] === actual[field] ? [] : [tokens[i]]).join(",")}`;
    }
    return `component=${state.component} predicate=${state.predicate}${suffix}`;
  } catch { return "component=OTHER predicate=OTHER"; }
}

// Categories are made only from this module's fixed roles, never observed names or values.
const operation = (role, invariants = {}) =>
  Object.freeze({
    raw: `INVENTORY_${role}_RAW_FAILED`,
    unavailable: `INVENTORY_${role}_STOCK_TOOL_UNAVAILABLE`,
    ...Object.fromEntries(Object.entries(invariants).map(([field, code]) => [field, `INVENTORY_${role}_${code}`])),
  });
const statusOperation = (role, invariants) =>
  Object.freeze({
    ...operation(role, invariants),
    incomplete: `INVENTORY_${role}_INCOMPLETE`,
    failed: `INVENTORY_${role}_QUERY_FAILED`,
  });
const queryOperation = (role, invariants) =>
  Object.freeze({
    ...statusOperation(role, invariants),
    decode: `INVENTORY_${role}_DECODE_FAILED`,
  });
const executableOperations = (role, rootProcess = false) =>
  Object.freeze({
    process: operation(`${role}_PROCESS`, { realTarget: "REAL_TARGET_UNAVAILABLE" }),
    target: (rootProcess ? queryOperation : operation)(`${role}_TARGET`),
    hash: (rootProcess ? queryOperation : operation)(`${role}_HASH`),
    read: operation(`${role}_READ`),
    package: operation(`${role}_PACKAGE`, { packageIdentity: "PACKAGE_IDENTITY_UNAVAILABLE" }),
    owner: queryOperation(`${role}_PACKAGE_OWNER`),
    packageVersion: queryOperation(`${role}_PACKAGE_VERSION`),
    packageMetadata: queryOperation(`${role}_PACKAGE_METADATA`),
    packagePolicy: queryOperation(`${role}_PACKAGE_POLICY`),
  });
export const inventoryOperations = Object.freeze({
  protocolRead: operation("PROTOCOL_READ"),
  protocolParse: operation("PROTOCOL_PARSE"),
  eventRead: operation("EVENT_READ"),
  eventParse: operation("EVENT_PARSE"),
  eventProcess: operation("EVENT_PROCESS"),
  authorityResolve: operation("AUTHORITY_RESOLVE"),
  authorityRead: operation("AUTHORITY_READ"),
  authorityDecode: operation("AUTHORITY_DECODE"),
  templateRead: operation("TEMPLATE_READ"),
  templateParse: operation("TEMPLATE_PARSE"),
  census: operation("CENSUS"),
  retainedRead: operation("RETAINED_READ"),
  rootSetup: operation("ROOT_SETUP"),
  captureSetup: operation("CAPTURE_SETUP"),
  identitySetup: operation("IDENTITY_SETUP"),
  diskHead: statusOperation("DISK_HEAD"),
  metadataCopy: operation("METADATA_COPY"),
  authorityCopy: operation("AUTHORITY_COPY"),
  processWrite: operation("PROCESS_WRITE"),
  identityRead: operation("IDENTITY_READ"),
  identityWrite: operation("IDENTITY_WRITE"),
  receiptWrite: operation("RECEIPT_WRITE"),
  captureRead: operation("CAPTURE_READ"),
  captureDecode: operation("CAPTURE_DECODE"),
  captureScan: operation("CAPTURE_SCAN"),
  manifestWrite: operation("MANIFEST_WRITE"),
  gateWrite: operation("GATE_WRITE"),
  tools: Object.freeze(
    Object.fromEntries(
      stockTools.map((name) => [name, executableOperations(`TOOL_${name.replaceAll("-", "_").toUpperCase()}`)]),
    ),
  ),
  versions: Object.freeze(
    Object.fromEntries(
      stockTools
        .filter((name) => name !== "sh")
        .map((name) => [name, queryOperation(`VERSION_${name.replaceAll("-", "_").toUpperCase()}`)]),
    ),
  ),
  dockerPid: queryOperation("DOCKER_PID", { daemonIdentity: "ACTIVE_DAEMON_IDENTITY_REQUIRED" }),
  containerdPid: queryOperation("CONTAINERD_PID", { daemonIdentity: "ACTIVE_DAEMON_IDENTITY_REQUIRED" }),
  dockerUnit: queryOperation("DOCKER_UNIT"),
  containerdUnit: queryOperation("CONTAINERD_UNIT"),
  services: Object.freeze(
    Object.fromEntries(
      ["docker", "containerd"].map((name) => [
        name,
        Object.freeze({
          process: operation(`SERVICE_${name.toUpperCase()}_PROCESS`),
          fragment: queryOperation(`SERVICE_${name.toUpperCase()}_FRAGMENT`),
          dropIns: queryOperation(`SERVICE_${name.toUpperCase()}_DROP_INS`),
          read: operation(`SERVICE_${name.toUpperCase()}_READ`, { serviceFile: "SERVICE_FILE_IDENTITY_UNAVAILABLE" }),
        }),
      ]),
    ),
  ),
  server: queryOperation("DOCKER_SERVER"),
  serverParse: operation("DOCKER_SERVER_PARSE"),
  runtimes: queryOperation("DOCKER_RUNTIMES"),
  runtimesParse: operation("DOCKER_RUNTIMES_PARSE"),
  defaultRuntime: queryOperation("DOCKER_DEFAULT_RUNTIME"),
  runtime: executableOperations("ACTIVE_RUNTIME"),
  dockerDaemon: executableOperations("DOCKER_DAEMON", true),
  containerdDaemon: executableOperations("CONTAINERD_DAEMON", true),
  containerdVersion: queryOperation("DAEMON_CONTAINERD_VERSION"),
  runcVersion: queryOperation("DAEMON_RUNC_VERSION"),
});
export const inventoryInvariantCodes = Object.freeze([
  "CANONICAL_UTF8_REQUIRED",
  "MISSING_ENCODED_AUTHORITY",
  "AUTHORITY_BYTES_MISMATCH",
  "MALFORMED_AUTHORITY_JSON",
  "DUPLICATE_AUTHORITY_FIELD",
  "CANONICAL_DISPATCH_REQUIRED",
  "ENVELOPE_SIZE_REFUSED",
  "REVIEWED_FREEZE_DIGEST_REQUIRED",
  "SCHEMA_2_EXTERNAL_ENVELOPE_REQUIRED",
  "FROZEN_HEAD_MISMATCH",
  "AUTHORITY_PHASE_MISMATCH",
  "FRESH_REVIEW_REQUIRED",
  "PAYLOAD_SUBJECT_MISMATCH",
  "CIRCULAR_PAYLOAD_FIELD",
  "AUTHORITY_BINDING_MISMATCH",
  "FIXED_RETAINED_PATH_REQUIRED",
  "FIXED_INVENTORY_PAYLOAD_REQUIRED",
  "FIXED_SUBJECT_KEYS_REQUIRED",
  "CANONICAL_SUBJECT_REQUIRED",
  "STALE_OR_CONTRADICTORY_REVIEW",
  "FIXED_CANONICAL_RECORD_REQUIRED",
  "FIXED_REVIEW_KEYS_REQUIRED",
  "COMPLETE_DETACHED_REVIEW_REQUIRED",
  "CANONICAL_REVIEW_BINDING_MISMATCH",
  "COMPLETION_NOTE_REQUIRED",
  "FIXED_COMPLETION_NOTE_REQUIRED",
  "COMPLETION_NOTE_BINDING_MISMATCH",
  "SOURCE_PINS_CHANGED",
  "INCOMPLETE_FILE_CENSUS",
  "FROZEN_PATH_ESCAPE",
  "FILE_DIGEST_MISMATCH",
  "EXTERNAL_AUTHORITY_REQUIRED",
  "FIXED_EXTERNAL_AUTHORITY_PATH_REQUIRED",
  "PUBLIC_INPUT_CONSTANTS_CHANGED",
  "RETAINED_RAW_HASH_MISMATCH",
  "ZERO_ROW_INVENTORY_REQUIRED",
  "PRIVATE_INVENTORY_PUBLICATION_REFUSED",
  "INVENTORY_METADATA_INCOMPLETE",
  "INVENTORY_METADATA_QUERY_FAILED",
  "ACTIVE_RUNTIME_METADATA_REQUIRED",
  "INVALID_METADATA_PREFIX",
  "METADATA_SYMLINK_REFUSED",
  "HOSTED_INVENTORY_ONLY",
  "INVALID_RUN_IDENTITY",
  "EVENT_NOT_ADMITTED",
  "DISK_EVENT_PAYLOAD_HEAD_MISMATCH",
  "CLOSED_INVENTORY_ARGV_REQUIRED",
  "DISK_HEAD_MISMATCH",
]);
const operationCodes = (value) =>
  Object.values(value).flatMap((entry) => (typeof entry === "string" ? [entry] : operationCodes(entry)));
export const inventoryRefusalCodes = Object.freeze([
  ...inventoryInvariantCodes,
  ...operationCodes(inventoryOperations),
]);
const refusalCodes = new Map(inventoryRefusalCodes.map((code) => [code, code]));
const registeredOperations = new Set();
const registerOperations = (value) => {
  if (Object.hasOwn(value, "raw")) registeredOperations.add(value);
  else for (const entry of Object.values(value)) registerOperations(entry);
};
registerOperations(inventoryOperations);

export const inventoryPublicationFiles = Object.freeze(
  [
    ["authority-envelope.json", "AUTHORITY_ENVELOPE"],
    ["authority-payload.json", "AUTHORITY_PAYLOAD"],
    ["authority-review.txt", "AUTHORITY_REVIEW"],
    ["authority-subject.json", "AUTHORITY_SUBJECT"],
    ["authority-dispatch.json", "AUTHORITY_DISPATCH"],
    ["authority-completion.json", "AUTHORITY_COMPLETION"],
    ["preparation-receipt.json", "RECEIPT"],
    ["metadata-command-ledger.json", "LEDGER"],
    ["observed-process-identities.json", "PROCESS_IDENTITIES"],
    ["observed-identity.json", "IDENTITY"],
    ["inventory-manifest.json", "MANIFEST"],
    ["inventory-publication-gate.json", "GATE"],
  ].map((entry) => Object.freeze(entry)),
);
export const inventoryPublicationQueries = Object.freeze(
  [...registeredOperations]
    .filter((site) => Object.hasOwn(site, "incomplete"))
    .map((site) => {
      const role = site.raw.slice("INVENTORY_".length, -"_RAW_FAILED".length);
      return Object.freeze({ site, stdout: `${role}_STDOUT`, stderr: `${role}_STDERR` });
    }),
);
const queryPublicationRoles = new Map(inventoryPublicationQueries.map((entry) => [entry.site, entry]));
const identityPublicationRoles = new WeakMap();
const publicationRoles = new Set([
  ...inventoryPublicationFiles.map(([, role]) => role),
  ...inventoryPublicationQueries.flatMap(({ stdout, stderr }) => [stdout, stderr]),
]);

export function inventoryPublicationHitClasses(hits, classified, roles) {
  return publicationHitClasses(hits, classified, roles, publicationRoles, "INVENTORY");
}

export const measurementPublicationRoles = Object.freeze([
  ...inventoryPublicationFiles.slice(0, 6).map(([, role]) => role),
  "MEASUREMENT_JSON",
  "MEASUREMENT_IDENTITY",
  "MEASUREMENT_STDOUT",
  "MEASUREMENT_STDERR",
  "MEASUREMENT_BUNDLE_METADATA",
  "BOOTSTRAP_METADATA",
  "PREPARATION_METADATA",
  "PREPAYLOAD_METADATA",
]);

function publicationHitClasses(hits, classified, roles, allowed, phase) {
  invariant(
    hits.length > 0 &&
      hits.length === classified.length &&
      hits.every(({ file, line }, i) => file === classified[i].file && line === classified[i].line),
    "PRIVATE_INVENTORY_PUBLICATION_REFUSED",
  );
  const tokens = new Set();
  for (const { file, rules } of classified) {
    const role = roles.get(file);
    invariant(
      allowed.has(role) && rules.length > 0 && rules.every((rule) => exposureRuleIds.includes(rule)),
      "PRIVATE_INVENTORY_PUBLICATION_REFUSED",
    );
    for (const rule of rules) tokens.add(`${role}:${rule}`);
  }
  return `${phase}_PUBLICATION_HIT_CLASSES total=${hits.length} classes=${[...tokens].sort().join(",")}`;
}

export function measurementPublicationRehearsal(files, roles, report) {
  const hits = scanExposure(files);
  if (hits.length) {
    report(
      publicationHitClasses(hits, classifyExposure(files), roles, new Set(measurementPublicationRoles), "MEASUREMENT"),
    );
    invariant(false, "PRIVATE_MEASUREMENT_PUBLICATION_REFUSED");
  }
}

export function inventoryCategory(error) {
  try {
    return refusalCodes.get(error?.message) ?? "OTHER";
  } catch {
    return "OTHER";
  }
}

export function inventoryAt(site, run) {
  try {
    return run();
  } catch (error) {
    const recognized = inventoryCategory(error);
    throw new Error(recognized !== "OTHER" ? recognized : registeredOperations.has(site) ? site.raw : "OTHER");
  }
}

export function inventoryQueryResult(site, result, allowFailure = false) {
  const registered = registeredOperations.has(site) && Object.hasOwn(site, "incomplete");
  invariant(!result.error && !result.signal && Number.isInteger(result.status), registered ? site.incomplete : "OTHER");
  invariant(allowFailure || result.status === 0, registered ? site.failed : "OTHER");
  if (result.status !== 0) return null;
  try {
    return utf8(result.stdout).trimEnd();
  } catch {
    // Strict decoding still refuses; the query site, not its private output, is reported.
    throw new Error(registered ? site.decode : "OTHER");
  }
}

export function inventoryDiskHead(result) {
  return inventoryAt(inventoryOperations.diskHead, () => {
    invariant(
      result.status === 0,
      result.error || result.signal || !Number.isInteger(result.status)
        ? inventoryOperations.diskHead.incomplete
        : inventoryOperations.diskHead.failed,
    );
    return result.stdout.trim();
  });
}
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = (v) =>
  JSON.stringify(
    Array.isArray(v)
      ? v.map((x) => JSON.parse(canonical(x)))
      : record(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, JSON.parse(canonical(v[k]))]),
          )
        : v,
  );
const equal = (a, b) => canonical(a) === canonical(b);
const utf8 = (bytes) => {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  invariant(!value.startsWith("\ufeff") && Buffer.from(value).equals(bytes), "CANONICAL_UTF8_REQUIRED");
  return value;
};
const decode = (encoded, hash) => {
  invariant(
    typeof encoded === "string" && encoded.length > 0 && encoded.length <= maximumEnvelopeBytes,
    "MISSING_ENCODED_AUTHORITY",
  );
  const bytes = Buffer.from(encoded, "base64");
  invariant(bytes.toString("base64") === encoded && isHash(hash) && sha256(bytes) === hash, "AUTHORITY_BYTES_MISMATCH");
  utf8(bytes);
  return bytes;
};
const parseAuthorityJson = (bytes) => {
  let value;
  try {
    value = JSON.parse(utf8(bytes));
  } catch {
    throw new Error("MALFORMED_AUTHORITY_JSON");
  }
  // JSON.parse accepts duplicate keys. Reject them at every object depth.
  const tokens = utf8(bytes).match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g);
  let i = 0;
  const visit = () => {
    const token = tokens[i++];
    if (token === "{") {
      const keys = new Set();
      while (tokens[i] !== "}") {
        const key = JSON.parse(tokens[i++]);
        invariant(!keys.has(key), "DUPLICATE_AUTHORITY_FIELD");
        keys.add(key);
        i++; // colon; syntax already validated by JSON.parse
        visit();
        if (tokens[i] !== ",") break;
        i++;
      }
      i++;
    } else if (token === "[") {
      while (tokens[i] !== "]") {
        visit();
        if (tokens[i] !== ",") break;
        i++;
      }
      i++;
    }
  };
  visit();
  return value;
};
const exactKeys = (v, keys, code) => invariant(record(v) && equal(Object.keys(v).sort(), [...keys].sort()), code);

const nonempty = (v) => typeof v === "string" && v.trim().length > 0;
export function validateDispatch(dispatch, head) {
  invariant(
    record(dispatch) &&
      dispatch.kind === "dispatch" &&
      dispatch.issue === 10678 &&
      dispatch.laneRole === "review" &&
      dispatch.head === head &&
      [
        "attemptId",
        "label",
        "lane",
        "transcript",
        "harness",
        "model",
        "effort",
        "row",
        "placement",
        "family",
        "slot",
        "capacityForecastStatus",
      ].every((k) => nonempty(dispatch[k])) &&
      dispatch.dispatchRoutingSchema === "watchdog-dispatch-routing/v3" &&
      Number.isSafeInteger(dispatch.policyGeneration) &&
      dispatch.policyGeneration > 0 &&
      /^[0-9a-f]{16}$/.test(dispatch.registryAuthorityDigest) &&
      /^[0-9a-f]{16}$/.test(dispatch.capacityDecisionDigest) &&
      typeof dispatch.usedLastKnownGood === "boolean" &&
      typeof dispatch.ts === "string" &&
      Number.isFinite(Date.parse(dispatch.ts)),
    "CANONICAL_DISPATCH_REQUIRED",
  );
  return dispatch.attemptId;
}

// The host checks full F before transport; E carries compact reviewer-authored R only.
export function validateReviewReport(reportBytes, review) {
  invariant(sha256(reportBytes) === review.reportSha256, "FULL_REPORT_DIGEST_MISMATCH");
  const footers = utf8(reportBytes)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("10678_REVIEW_SUBJECT_V1: "));
  invariant(footers.length === 1, "ONE_REVIEW_REPORT_FOOTER_REQUIRED");
  const footer = parseAuthorityJson(Buffer.from(footers[0].slice("10678_REVIEW_SUBJECT_V1: ".length)));
  const { schema: _schema, reportSha256: _report, ...tuple } = review;
  exactKeys(footer, Object.keys(tuple), "FIXED_REPORT_FOOTER_REQUIRED");
  invariant(equal(footer, tuple), "REPORT_FOOTER_BINDING_MISMATCH");
}

export function decodeAuthority(raw, expectedHash, { head, phase, protocol }) {
  invariant(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= maximumEnvelopeBytes, "ENVELOPE_SIZE_REFUSED");
  invariant(isHash(expectedHash) && sha256(raw) === expectedHash, "REVIEWED_FREEZE_DIGEST_REQUIRED");
  const envelope = parseAuthorityJson(raw);
  exactKeys(
    envelope,
    [
      "schema",
      "head",
      "phase",
      "verdict",
      "payloadUtf8Base64",
      "payloadSha256",
      "reviewUtf8Base64",
      "reviewSha256",
      "subjectBindingUtf8Base64",
      "subjectBindingSha256",
    ],
    "SCHEMA_2_EXTERNAL_ENVELOPE_REQUIRED",
  );
  invariant(envelope.schema === 2 && isRef(head) && envelope.head === head, "FROZEN_HEAD_MISMATCH");
  invariant(
    ["inventory", "measurement"].includes(envelope.phase) && (!phase || envelope.phase === phase),
    "AUTHORITY_PHASE_MISMATCH",
  );
  invariant(envelope.verdict === "PASS", "FRESH_REVIEW_REQUIRED");
  const payloadBytes = decode(envelope.payloadUtf8Base64, envelope.payloadSha256);
  const reviewBytes = decode(envelope.reviewUtf8Base64, envelope.reviewSha256);
  const subjectBytes = decode(envelope.subjectBindingUtf8Base64, envelope.subjectBindingSha256);
  const config = parseAuthorityJson(payloadBytes);
  invariant(
    record(config) && config.schema === 2 && config.head === head && config.phase === envelope.phase,
    "PAYLOAD_SUBJECT_MISMATCH",
  );
  for (const key of ["review", "verdict", "payloadSha256", "envelopeSha256", "receiptSha256"])
    invariant(!Object.hasOwn(config, key), "CIRCULAR_PAYLOAD_FIELD");
  invariant(
    config.briefSha256 === protocol.briefSha256 &&
      config.methodSha256 === protocol.methodSha256 &&
      config.decisionSha256 === decisionSha256 &&
      config.repairDecisionSha256 === repairDecisionSha256,
    "AUTHORITY_BINDING_MISMATCH",
  );
  invariant(config.retainedConfigMap?.path === retainedPath, "FIXED_RETAINED_PATH_REQUIRED");
  if (config.phase === "inventory")
    exactKeys(
      config,
      [
        "schema",
        "head",
        "phase",
        "briefSha256",
        "methodSha256",
        "decisionSha256",
        "repairDecisionSha256",
        "files",
        "sources",
        "publicInputs",
        "retainedConfigMap",
      ],
      "FIXED_INVENTORY_PAYLOAD_REQUIRED",
    );
  const binding = parseAuthorityJson(subjectBytes);
  exactKeys(
    binding,
    [
      "schema",
      "issue",
      "head",
      "phase",
      "payloadSha256",
      "verdict",
      "reviewSha256",
      "reportSha256",
      "dispatch",
      "completion",
    ],
    "FIXED_SUBJECT_KEYS_REQUIRED",
  );
  invariant(binding.schema === "10678-review-subject/v2" && binding.issue === 10678, "CANONICAL_SUBJECT_REQUIRED");
  invariant(
    binding.head === head &&
      binding.phase === config.phase &&
      binding.payloadSha256 === envelope.payloadSha256 &&
      binding.verdict === "PASS" &&
      binding.reviewSha256 === envelope.reviewSha256 &&
      isHash(binding.reportSha256),
    "STALE_OR_CONTRADICTORY_REVIEW",
  );
  for (const key of ["dispatch", "completion"])
    exactKeys(binding[key], ["utf8Base64", "sha256"], "FIXED_CANONICAL_RECORD_REQUIRED");
  const dispatchBytes = decode(binding.dispatch?.utf8Base64, binding.dispatch?.sha256);
  const completionBytes = decode(binding.completion?.utf8Base64, binding.completion?.sha256);
  const dispatch = parseAuthorityJson(dispatchBytes);
  const completion = parseAuthorityJson(completionBytes);
  const dispatchIdentity = validateDispatch(dispatch, head);
  const completionIdentity = binding.completion.sha256;
  const review = parseAuthorityJson(reviewBytes);
  const reviewKeys = [
    "issue",
    "head",
    "phase",
    "payloadSha256",
    "dispatchRawSha256",
    "reviewerAttempt",
    "authorAttempt",
    "verdict",
    "reviewScope",
    "blocking",
    "candidates",
    "nonBlocking",
  ];
  exactKeys(review, ["schema", ...reviewKeys, "reportSha256"], "FIXED_REVIEW_KEYS_REQUIRED");
  invariant(
    review.schema === "10678-detached-review/v1" &&
      review.issue === 10678 &&
      review.head === head &&
      review.phase === config.phase &&
      review.payloadSha256 === envelope.payloadSha256 &&
      review.dispatchRawSha256 === binding.dispatch.sha256 &&
      review.reviewerAttempt === dispatchIdentity &&
      nonempty(review.authorAttempt) &&
      review.authorAttempt !== review.reviewerAttempt &&
      review.verdict === "PASS" &&
      review.reviewScope === "COMPLETE" &&
      review.blocking === 0 &&
      review.candidates === 0 &&
      Number.isSafeInteger(review.nonBlocking) &&
      review.nonBlocking >= 0 &&
      review.reportSha256 === binding.reportSha256,
    "COMPLETE_DETACHED_REVIEW_REQUIRED",
  );
  invariant(
    binding.dispatch.sha256 !== completionIdentity &&
      !/[\r\n]/.test(utf8(dispatchBytes)) &&
      !/[\r\n]/.test(utf8(completionBytes)) &&
      completion.kind === "lane-complete" &&
      completion.issue === 10678 &&
      typeof completion.ts === "string" &&
      Date.parse(completion.ts) >= Date.parse(dispatch.ts) &&
      completion.lane === dispatchIdentity &&
      completion.laneRole === "review" &&
      completion.outcome === review.verdict &&
      ["harness", "model", "effort", "row", "placement", "transcript"].every((k) => completion[k] === dispatch[k]),
    "CANONICAL_REVIEW_BINDING_MISMATCH",
  );
  invariant(typeof completion.note === "string", "COMPLETION_NOTE_REQUIRED");
  const note = parseAuthorityJson(Buffer.from(completion.note));
  exactKeys(
    note,
    [
      "schema",
      "dispatchRawSha256",
      "head",
      "phase",
      "payloadSha256",
      "reviewSha256",
      "reportSha256",
      "reviewerAttempt",
      "authorAttempt",
      "reviewScope",
    ],
    "FIXED_COMPLETION_NOTE_REQUIRED",
  );
  invariant(
    completion.note === JSON.stringify(note) &&
      note.schema === "10678-review-completion/v1" &&
      note.reviewSha256 === envelope.reviewSha256 &&
      [
        "dispatchRawSha256",
        "head",
        "phase",
        "payloadSha256",
        "reportSha256",
        "reviewerAttempt",
        "authorAttempt",
        "reviewScope",
      ].every((k) => note[k] === review[k]),
    "COMPLETION_NOTE_BINDING_MISMATCH",
  );
  invariant(equal(config.sources, protocol.stacks), "SOURCE_PINS_CHANGED");
  const runtimeConfig = config.phase === "measurement" ? measurementConfig(config) : config;
  return {
    config: runtimeConfig,
    envelope,
    payloadBytes,
    reviewBytes,
    subjectBytes,
    dispatchBytes,
    completionBytes,
    identity: {
      envelopeSha256: expectedHash,
      payloadSha256: envelope.payloadSha256,
      reviewSha256: envelope.reviewSha256,
      subjectBindingSha256: envelope.subjectBindingSha256,
      dispatchIdentity,
      completionIdentity,
      dispatchRawSha256: binding.dispatch.sha256,
      reportSha256: binding.reportSha256,
      reviewerAttempt: review.reviewerAttempt,
      authorAttempt: review.authorAttempt,
      head,
      phase: config.phase,
    },
  };
}

export function validateCensus(files, required, read) {
  invariant(record(files) && equal(Object.keys(files).sort(), [...required].sort()), "INCOMPLETE_FILE_CENSUS");
  for (const [relative, hash] of Object.entries(files)) {
    invariant(
      !path.posix.isAbsolute(relative) &&
        path.posix.normalize(relative) === relative &&
        !relative.startsWith("../") &&
        !relative.includes("\\") &&
        isHash(hash),
      "FROZEN_PATH_ESCAPE",
    );
    invariant(sha256(read(relative)) === hash, "FILE_DIGEST_MISMATCH");
  }
}

export function validateAuthorityPath(actual, realRepo, temp) {
  invariant(!actual.startsWith(`${realRepo}${path.sep}`) && actual !== realRepo, "EXTERNAL_AUTHORITY_REQUIRED");
  invariant(actual === path.join(temp, "10678-authority", "freeze.json"), "FIXED_EXTERNAL_AUTHORITY_PATH_REQUIRED");
}

export function readAuthority(file, expectedHash, { head, phase, protocol, root = repo }) {
  const realRepo = inventoryAt(inventoryOperations.authorityResolve, () => realpathSync(root));
  const actual = inventoryAt(inventoryOperations.authorityResolve, () => realpathSync(file));
  invariant(path.isAbsolute(file), "EXTERNAL_AUTHORITY_REQUIRED");
  const temp = inventoryAt(inventoryOperations.authorityResolve, () => realpathSync(process.env.RUNNER_TEMP));
  validateAuthorityPath(actual, realRepo, temp);
  const result = inventoryAt(inventoryOperations.authorityDecode, () =>
    decodeAuthority(
      inventoryAt(inventoryOperations.authorityRead, () => readFileSync(actual)),
      expectedHash,
      { head, phase, protocol },
    ),
  );
  const template = inventoryAt(inventoryOperations.templateParse, () =>
    JSON.parse(
      inventoryAt(inventoryOperations.templateRead, () =>
        readFileSync(path.join(root, supportPath, "inputs.template.json"), "utf8"),
      ),
    ),
  );
  invariant(equal(result.config.publicInputs, template), "PUBLIC_INPUT_CONSTANTS_CHANGED");
  if (result.config.phase === "measurement") {
    invariant(
      equal(result.config.chart, template.chart) && equal(result.config.images, template.images),
      "CHART_OR_IMAGE_PINS_CHANGED",
    );
    for (const [name, pin] of Object.entries(template.publicExecutables))
      invariant(
        result.config.tools[name]?.path === pin.path && result.config.tools[name]?.sha256 === pin.sha256,
        "PUBLIC_EXECUTABLE_PIN_CHANGED",
      );
  }
  const names = inventoryAt(inventoryOperations.census, () => readdirSync(path.join(root, supportPath)));
  const required = [...names.map((name) => `${supportPath}/${name}`), ...closurePaths];
  inventoryAt(inventoryOperations.census, () =>
    validateCensus(result.config.files, required, (relative) => {
      const target = path.join(root, relative);
      invariant(
        lstatSync(target).isFile() &&
          !lstatSync(target).isSymbolicLink() &&
          realpathSync(target).startsWith(`${realRepo}${path.sep}`),
        "FROZEN_PATH_ESCAPE",
      );
      return readFileSync(target);
    }),
  );
  validateScriptAuthority(result.config, (relative) => readFileSync(path.join(root, relative)));
  invariant(
    inventoryAt(inventoryOperations.retainedRead, () => sha256(readFileSync(path.join(root, retainedPath)))) ===
      protocol.retainedConfigMapSha256,
    "RETAINED_RAW_HASH_MISMATCH",
  );
  return result;
}

function distribution(pin, diagnostic) {
  invariant(
    comparisonAt(diagnostic, "DISTRIBUTION_RECORD", () => record(pin)) &&
      comparisonAt(diagnostic, "DISTRIBUTION_VERSION_TYPE", () => typeof pin.version === "string") &&
      comparisonAt(diagnostic, "DISTRIBUTION_VERSION", () => pin.version.length > 0) &&
      comparisonAt(diagnostic, "DISTRIBUTION_ARCH_TYPE", () => typeof pin.architecture === "string") &&
      comparisonAt(diagnostic, "DISTRIBUTION_ARCH", () => pin.architecture.length > 0) &&
      comparisonAt(diagnostic, "DISTRIBUTION_REFERENCE", () => /^https:\/\/[^\s?]+$/.test(pin.publicReference)) &&
      comparisonAt(diagnostic, "DISTRIBUTION_HASH", () => isHash(pin.archiveSha256)),
    "REVIEWED_DISTRIBUTION_REQUIRED",
  );
}

export const scriptClosureDescriptor = Object.freeze({
  schema: "10678-script-closure/v1",
  algorithm: "sha256",
  canonicalization: "posix-path-sha256-pairs-json-v1",
  fileCount: 448,
  sha256: "99aa5fa37093261917e32dfdaee917eafa784011e116e2d707ba55f33e0c15d5",
  path: `${supportPath}/pnpm-11.0.9.closure.json`,
});

export function validateClosureDescriptor(descriptor, diagnostic) {
  invariant(comparisonAt(diagnostic, "CLOSURE_DESCRIPTOR", () => equal(descriptor, scriptClosureDescriptor)), "FIXED_SCRIPT_CLOSURE_DESCRIPTOR_REQUIRED");
}

const compareClosurePaths = (a, b) => Buffer.compare(Buffer.from(a[0], "utf8"), Buffer.from(b[0], "utf8"));

export function scriptClosureFingerprint(pairs, stored = false, diagnostic) {
  invariant(comparisonAt(diagnostic, "CLOSURE_PAIRS", () => Array.isArray(pairs)), "SCRIPT_CLOSURE_PAIRS_REQUIRED");
  const names = new Set();
  for (const pair of pairs) {
    invariant(
      comparisonAt(diagnostic, "CLOSURE_PAIR_ARRAY", () => Array.isArray(pair)) && comparisonAt(diagnostic, "CLOSURE_PAIR_LENGTH", () => pair.length === 2) && comparisonAt(diagnostic, "CLOSURE_PATH_TYPE", () => typeof pair[0] === "string") && comparisonAt(diagnostic, "CLOSURE_HASH_TYPE", () => typeof pair[1] === "string"),
      "SCRIPT_CLOSURE_PAIR_REQUIRED",
    );
    const [relative, hash] = pair;
    invariant(
      comparisonAt(diagnostic, "CLOSURE_PATH_NONEMPTY", () => relative.length > 0) &&
        comparisonAt(diagnostic, "CLOSURE_PATH_CHARACTERS", () => !/[\\\x00-\x1f\x7f]/.test(relative)) &&
        comparisonAt(diagnostic, "CLOSURE_PATH_UTF8", () => Buffer.from(relative, "utf8").toString("utf8") === relative) &&
        comparisonAt(diagnostic, "CLOSURE_PATH_SEGMENTS", () => relative.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")) &&
        comparisonAt(diagnostic, "CLOSURE_PATH_UNIQUE", () => !names.has(relative)) &&
        comparisonAt(diagnostic, "CLOSURE_HASH", () => /^[a-f0-9]{64}$/.test(hash)),
      "SCRIPT_CLOSURE_PATH_OR_HASH_REFUSED",
    );
    names.add(relative);
  }
  if (stored)
    invariant(
      comparisonAt(diagnostic, "CLOSURE_ORDER", () => pairs.every((pair, i) => i === 0 || compareClosurePaths(pairs[i - 1], pair) < 0)),
      "SCRIPT_CLOSURE_ORDER_REFUSED",
    );
  const ordered = [...pairs].sort(compareClosurePaths);
  return { fileCount: ordered.length, sha256: sha256(JSON.stringify(ordered)) };
}

export function validateScriptClosure(pairs, descriptor, stored = false, diagnostic) {
  validateClosureDescriptor(descriptor, diagnostic);
  const actual = scriptClosureFingerprint(pairs, stored, diagnostic);
  invariant(
    comparisonAt(diagnostic, "CLOSURE_COUNT", () => actual.fileCount === descriptor.fileCount) && comparisonAt(diagnostic, "CLOSURE_DIGEST", () => actual.sha256 === descriptor.sha256),
    "SCRIPT_DISTRIBUTION_DRIFT",
  );
  return actual;
}

export function validateScriptAuthority(config, read) {
  const descriptor = config.publicInputs.publicExecutables.pnpm.closure;
  validateClosureDescriptor(descriptor);
  invariant(isHash(config.files[descriptor.path]), "SCRIPT_CLOSURE_CENSUS_REQUIRED");
  const raw = read(descriptor.path);
  invariant(sha256(raw) === config.files[descriptor.path], "FILE_DIGEST_MISMATCH");
  validateScriptClosure(parseAuthorityJson(raw), descriptor, true);
  if (config.phase === "measurement")
    invariant(equal(config.tools.pnpm.closure, descriptor), "SCRIPT_CLOSURE_AUTHORITY_CHANGED");
}

// P carries each reviewed value once, under publicInputs. These are references, not fallback pins.
export function measurementConfig(payload) {
  exactKeys(
    payload,
    [
      "schema",
      "head",
      "phase",
      "briefSha256",
      "methodSha256",
      "decisionSha256",
      "repairDecisionSha256",
      "files",
      "sources",
      "publicInputs",
      "retainedConfigMap",
    ],
    "FIXED_MEASUREMENT_PAYLOAD_REQUIRED",
  );
  const input = payload.publicInputs;
  const m = input?.measurement;
  invariant(record(m) && m.schema === "10678-reviewed-measurement/v1", "MEASUREMENT_PINS_REQUIRED");
  exactKeys(
    m,
    [
      "schema",
      "distributions",
      "packages",
      "pins",
      "runnerIdentity",
      "bootstrapIdentity",
      "expectedIdentity",
      "inventoryAuthority",
    ],
    "FIXED_MEASUREMENT_CONSTANTS_REQUIRED",
  );
  const ids = [
    ...stockTools.map((name) => `tools.${name}`),
    "daemon.executable",
    "daemon.containerdExecutable",
    "daemon.activeRuntime",
    "daemon.unitFiles.0",
    "daemon.containerdUnitFiles.0",
  ];
  exactKeys(m.pins, ids, "COMPLETE_REVIEWED_PUBLIC_PINS_REQUIRED");
  const expand = (id) => {
    const pin = m.pins[id];
    const source = m.distributions?.[pin.distribution];
    distribution(source);
    invariant(source.signatureStatus === "SIGNATURE_VERIFIED", "PUBLIC_PIN_PROVENANCE_REQUIRED");
    const owner = pin.package === undefined ? undefined : m.packages?.[pin.package];
    invariant(pin.package === undefined || record(owner), "REVIEWED_PACKAGE_REFERENCE_REQUIRED");
    return { ...pin, distribution: source, ...(owner ? { package: owner } : {}) };
  };
  const all = Object.fromEntries(ids.map((id) => [id, expand(id)]));
  const tools = Object.fromEntries(stockTools.map((name) => [name, all[`tools.${name}`]]));
  const stockNode = tools.node;
  exactKeys(
    input.publicExecutables,
    ["node", "kind", "helm", "kubectl", "pnpm", "esbuild", "yq"],
    "COMPLETE_PUBLIC_EXECUTABLES_REQUIRED",
  );
  for (const [name, pin] of Object.entries(input.publicExecutables)) {
    const source = input.publicDistributions[name];
    invariant(record(source), "REVIEWED_DISTRIBUTION_REQUIRED");
    tools[name] = {
      ...pin,
      package: m.packages["stock-node"],
      distribution: {
        version: pin.version,
        architecture: pin.architecture,
        publicReference: source.url,
        archiveSha256: source.sha256,
      },
      ...(name === "pnpm"
        ? { interpreter: { tool: "node", shebang: "#!/usr/bin/env node" }, distributionRoot: "/opt/10678-pnpm" }
        : {}),
    };
  }
  invariant(equal(all["daemon.activeRuntime"], all["tools.runc"]), "ACTIVE_RUNTIME_PIN_CHANGED");
  const config = {
    ...payload,
    tools,
    bootstrapTools: { node: stockNode },
    daemonTools: { docker: all["daemon.executable"], containerd: all["daemon.containerdExecutable"] },
    bootstrapIdentity: m.bootstrapIdentity,
    expectedIdentity: m.expectedIdentity,
    inventoryAuthority: m.inventoryAuthority,
    chart: input.chart,
    images: input.images,
    runnerIdentity: m.runnerIdentity,
    servicePins: { docker: all["daemon.unitFiles.0"], containerd: all["daemon.containerdUnitFiles.0"] },
  };
  validateMeasurementPins(config);
  return config;
}

export function validateMeasurementPins(config) {
  for (const field of [
    "bootstrapIdentity",
    "expectedIdentity",
    "inventoryAuthority",
    "bootstrapTools",
    "daemonTools",
    "runnerIdentity",
    "servicePins",
  ])
    invariant(record(config[field]), "MEASUREMENT_PINS_REQUIRED");
  const runner = config.runnerIdentity;
  exactKeys(
    runner,
    [
      "image",
      "imageVersion",
      "imageOS",
      "architecture",
      "os",
      "codename",
      "kernel",
      "engine",
      "containerd",
      "runc",
      "dockerInit",
    ],
    "RUNNER_IDENTITY_REQUIRED",
  );
  invariant(
    runner.image === "ubuntu-24.04" &&
      runner.imageOS === "ubuntu24" &&
      runner.architecture === "x64" &&
      ["imageVersion", "os", "codename", "kernel"].every(
        (key) => typeof runner[key] === "string" && runner[key].length > 0 && runner[key] !== "UNKNOWN",
      ),
    "RUNNER_IDENTITY_REQUIRED",
  );
  for (const name of ["engine", "containerd", "runc", "dockerInit"]) {
    const component = runner[name];
    exactKeys(
      component,
      name === "engine"
        ? ["version", "apiVersion", "gitCommit"]
        : name === "dockerInit"
          ? ["version", "gitCommit", "bytePin"]
          : ["version", "gitCommit"],
      "DAEMON_IDENTITY_REQUIRED",
    );
    invariant(
      Object.entries(component).every(([key, value]) =>
        key === "bytePin" ? value === false : typeof value === "string" && value.length > 0 && value !== "UNKNOWN",
      ),
      "DAEMON_IDENTITY_REQUIRED",
    );
  }
  exactKeys(config.servicePins, ["docker", "containerd"], "SERVICE_PINS_REQUIRED");
  for (const pin of Object.values(config.servicePins)) {
    invariant(
      record(pin) &&
        path.posix.isAbsolute(pin.path ?? "") &&
        path.posix.isAbsolute(pin.realTarget ?? "") &&
        isHash(pin.sha256),
      "SERVICE_PINS_REQUIRED",
    );
    distribution(pin.distribution);
    invariant(pin.distribution.signatureStatus === "SIGNATURE_VERIFIED", "PUBLIC_PIN_PROVENANCE_REQUIRED");
  }
  for (const identity of [config.bootstrapIdentity, config.expectedIdentity]) {
    invariant(
      typeof identity.imageVersion === "string" &&
        /^\d{8}\.\d+\.\d+$/.test(identity.imageVersion) &&
        identity.imageOS === "ubuntu24" &&
        identity.architecture === "x64" &&
        typeof identity.kernel === "string" &&
        identity.kernel.length > 0 &&
        identity.kernel !== "UNKNOWN",
      "RUNNER_OS_PINS_REQUIRED",
    );
    invariant(
      ["identitySha256", "osReleaseSha256", "toolsSha256", "versionsSha256", "daemonSha256"].every((k) =>
        isHash(identity[k]),
      ),
      "OS_DAEMON_TOOL_FINGERPRINTS_REQUIRED",
    );
  }
  exactKeys(config.bootstrapTools, ["node"], "BOOTSTRAP_NODE_OVERRIDE_REQUIRED");
  for (const name of stockTools) validateToolPin(bootstrapTools(config)[name]);
  for (const name of ["docker", "containerd"]) validateToolPin(config.daemonTools[name]);
  for (const name of measurementTools) validateToolPin(config.tools?.[name]);
  const a = config.inventoryAuthority;
  invariant(
    ["run", "attempt", "job", "artifactId"].every((k) => /^\d+$/.test(a[k])) &&
      ["artifactSha256", "receiptSha256", "envelopeSha256", "manifestSha256"].every((k) => isHash(a[k])) &&
      isRef(a.head),
    "INVENTORY_CUSTODY_REQUIRED",
  );
}

export function validateToolPin(pin, diagnostic) {
  invariant(
    comparisonAt(diagnostic, "PIN_RECORD", () => record(pin)) &&
      comparisonAt(diagnostic, "PIN_PATH_TYPE", () => typeof pin.path === "string") &&
      comparisonAt(diagnostic, "PIN_PATH", () => path.posix.isAbsolute(pin.path)) &&
      comparisonAt(diagnostic, "PIN_TARGET", () => path.posix.isAbsolute(pin.realTarget ?? "")) &&
      comparisonAt(diagnostic, "PIN_HASH", () => isHash(pin.sha256)),
    "REAL_TOOL_PIN_REQUIRED",
  );
  distribution(pin.distribution, diagnostic);
  invariant(comparisonAt(diagnostic, "PIN_FORMAT", () => ["native", "script"].includes(pin.format)), "EXECUTABLE_FORMAT_REQUIRED");
  if (pin.path !== pin.realTarget)
    invariant(
      comparisonAt(diagnostic, "INVOCATION_FORMAT", () => pin.format === "native") && comparisonAt(diagnostic, "INVOCATION_NAME", () => pin.invocation === path.posix.basename(pin.path)) && comparisonAt(diagnostic, "INVOCATION_MULTICALL", () => pin.multicall === true),
      "AUTHENTICATED_INVOCATION_REQUIRED",
    );
  if (pin.format === "script") {
    validateClosureDescriptor(pin.closure, diagnostic);
    invariant(
      comparisonAt(diagnostic, "SCRIPT_TOOL", () => pin.interpreter?.tool === "node") &&
        comparisonAt(diagnostic, "SCRIPT_SHEBANG", () => pin.interpreter.shebang === "#!/usr/bin/env node") &&
        comparisonAt(diagnostic, "SCRIPT_ROOT", () => path.posix.isAbsolute(pin.distributionRoot ?? "")),
      "SCRIPT_INTERPRETER_CLOSURE_REQUIRED",
    );
  }
}

export function validateToolObservation(pin, actual, diagnostic) {
  validateToolPin(pin, diagnostic);
  invariant(
    comparisonAt(diagnostic, "OBSERVED_PATH", () => actual.path === pin.path) &&
      comparisonAt(diagnostic, "OBSERVED_TARGET", () => actual.realTarget === pin.realTarget) &&
      comparisonAt(diagnostic, "OBSERVED_HASH", () => actual.sha256 === pin.sha256) &&
      comparisonAt(diagnostic, "OBSERVED_FORMAT", () => actual.format === pin.format),
    "EXECUTABLE_DRIFT_OR_SHIM",
  );
  invariant(comparisonAt(diagnostic, "OBSERVED_PACKAGE", () => equal(actual.package, pin.package)), "TOOL_PACKAGE_DRIFT");
  if (pin.format === "script") {
    invariant(comparisonAt(diagnostic, "OBSERVED_SHEBANG", () => actual.shebang === pin.interpreter.shebang), "INTERPRETER_OR_DISTRIBUTION_DRIFT");
    validateScriptClosure(actual.closure, pin.closure, false, diagnostic);
  }
}

export function compareIdentity(expected, actual, diagnostic) {
  comparisonComponent(diagnostic, "FINGERPRINT");
  invariant(comparisonEqual(diagnostic, expected, identityFingerprint(actual, diagnostic)), "RUNNER_OS_DAEMON_OR_TOOL_DRIFT");
}

export const bootstrapTools = (config) => ({ ...config.tools, ...config.bootstrapTools });

export function identityFingerprint(actual, diagnostic) {
  return {
    imageVersion: comparisonAt(diagnostic, "FINGERPRINT_IMAGE_VERSION", () => actual.imageVersion),
    imageOS: comparisonAt(diagnostic, "FINGERPRINT_IMAGE_OS", () => actual.imageOS),
    architecture: comparisonAt(diagnostic, "FINGERPRINT_ARCHITECTURE", () => actual.architecture),
    kernel: comparisonAt(diagnostic, "FINGERPRINT_KERNEL", () => actual.kernel),
    osReleaseSha256: comparisonAt(diagnostic, "FINGERPRINT_OS_RELEASE", () => sha256(canonical(actual.osRelease))),
    toolsSha256: comparisonAt(diagnostic, "FINGERPRINT_TOOLS", () => sha256(canonical(actual.tools))),
    versionsSha256: comparisonAt(diagnostic, "FINGERPRINT_VERSIONS", () => sha256(canonical(actual.versions))),
    daemonSha256: comparisonAt(diagnostic, "FINGERPRINT_DAEMON", () => sha256(canonical(actual.daemon))),
    identitySha256: comparisonAt(diagnostic, "FINGERPRINT_IDENTITY", () => sha256(canonical(actual))),
  };
}

export function compareConfigMaps(documents, local) {
  invariant(Array.isArray(documents) && documents.length === 1, "ONE_RETAINED_DOCUMENT_REQUIRED");
  const retained = documents[0];
  invariant(
    retained?.apiVersion === "v1" &&
      retained.kind === "ConfigMap" &&
      retained.metadata?.name === "ingress-nginx-controller" &&
      retained.metadata?.namespace === "ingress-nginx" &&
      record(retained.data) &&
      Object.values(retained.data).every((v) => typeof v === "string"),
    "EXACT_RETAINED_CONFIGMAP_REQUIRED",
  );
  invariant(
    record(local) && local["error-log-path"] === "/dev/stderr" && local["error-log-level"] === "info",
    "APPROVED_LOCAL_LOGGING_REQUIRED",
  );
  const normalized = { ...local, "error-log-path": "/dev/null" };
  delete normalized["error-log-level"];
  invariant(equal(normalized, retained.data), "RETAINED_CONFIGMAP_MISMATCH");
}

export function validateInventoryPublication(receipt, gate) {
  invariant(
    receipt?.schema === "10678-inventory-receipt/v1" &&
      receipt.phase === "inventory" &&
      receipt.measurementDisposition === "NOT_EXECUTED" &&
      receipt.rowCount === 0 &&
      Array.isArray(receipt.rows) &&
      receipt.rows.length === 0 &&
      receipt.complete === true &&
      !Object.hasOwn(receipt, "protocolStart") &&
      !Object.hasOwn(receipt, "armed") &&
      equal(receipt.phases, ["inventoryStart", "inventoryComplete"]),
    "ZERO_ROW_INVENTORY_REQUIRED",
  );
  invariant(
    gate?.schema === "10678-inventory-publication/v1" &&
      gate.phase === "inventory" &&
      gate.publish === true &&
      gate.complete === true &&
      gate.scan === "NO_HITS" &&
      equal(gate.hits, []),
    "PRIVATE_INVENTORY_PUBLICATION_REFUSED",
  );
}

const writeJson = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

export function projectIdentity(identity) {
  return { ...identity, versions: Object.entries(identity.versions).map(([tool, banner]) => ({ tool, banner })) };
}

export function serializeIdentity(identity, authority) {
  const serialized = projectIdentity(identity);
  return `${JSON.stringify(authority === undefined ? serialized : { authority, actualIdentity: serialized }, null, 2)}\n`;
}
const cleanEnvironment = (home) => ({
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: home,
  DOCKER_CONFIG: path.join(home, "docker"),
  LANG: "C.UTF-8",
  TZ: "UTC",
});
const resolveTool = (site, name) => {
  const candidates = cleanEnvironment("")
    .PATH.split(":")
    .map((dir) => path.join(dir, name));
  const found = candidates.find((file) => {
    try {
      return lstatSync(file).isFile() || lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  });
  invariant(found, site.unavailable);
  return found;
};

// All subprocess queries below are fixed read-only local metadata queries, never arbitrary caller argv.
export function observeIdentity(directory, pins) {
  const publicationFiles = new Map(inventoryPublicationFiles);
  const home = inventoryAt(inventoryOperations.identitySetup, () => {
    mkdirSync(directory, { mode: 0o700 });
    const home = path.join(directory, "empty-home");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(path.join(home, "docker"), { mode: 0o700 });
    return home;
  });
  let sequence = 0;
  const commands = [];
  const query = (site, tool, args, allowFailure = false) =>
    inventoryAt(site, () => {
      const executable = pins?.[tool]?.path ?? resolveTool(site, tool);
      const startedAt = new Date().toISOString();
      const result = spawnSync(executable, args, {
        env: cleanEnvironment(home),
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
      });
      const name = `${String(++sequence).padStart(4, "0")}-${tool}`;
      publicationFiles.set(`${name}.stdout`, queryPublicationRoles.get(site).stdout);
      publicationFiles.set(`${name}.stderr`, queryPublicationRoles.get(site).stderr);
      writeFileSync(path.join(directory, `${name}.stdout`), result.stdout ?? Buffer.alloc(0), {
        flag: "wx",
        mode: 0o600,
      });
      writeFileSync(path.join(directory, `${name}.stderr`), result.stderr ?? Buffer.alloc(0), {
        flag: "wx",
        mode: 0o600,
      });
      commands.push({
        tool,
        executable,
        args,
        startedAt,
        completedAt: new Date().toISOString(),
        status: result.status,
        signal: result.signal,
        output: `${name}.stdout`,
        error: `${name}.stderr`,
      });
      writeFileSync(path.join(directory, "metadata-command-ledger.json"), `${JSON.stringify(commands, null, 2)}\n`, {
        mode: 0o600,
      });
      return inventoryQueryResult(site, result, allowFailure);
    });
  const owningPackage = (executableSite, file) =>
    inventoryAt(executableSite.package, () => {
      const owner = query(executableSite.owner, "dpkg-query", ["-S", file], true);
      if (!owner) return { disposition: "UNOWNED_PUBLIC_DISTRIBUTION_RECONCILIATION_REQUIRED" };
      const owners = owner.split("\n").filter((line) => line.endsWith(`: ${file}`));
      if (owners.length !== 1) return { disposition: "AMBIGUOUS_PACKAGE_OWNER" };
      const name = owners[0].slice(0, -(file.length + 2));
      const version = query(executableSite.packageVersion, "dpkg-query", [
        "-W",
        "-f=${Package}\t${Version}\t${Architecture}\n",
        name,
      ]);
      const fields = version.trim().split("\t");
      invariant(fields.length === 3 && fields.every(Boolean), executableSite.package.packageIdentity);
      const metadata = query(executableSite.packageMetadata, "apt-cache", ["show", `${name}=${fields[1]}`], true);
      const policy = query(executableSite.packagePolicy, "apt-cache", ["policy", name], true);
      return {
        name: fields[0],
        version: fields[1],
        architecture: fields[2],
        metadataSha256: metadata === null ? null : sha256(metadata),
        policySha256: policy === null ? null : sha256(policy),
      };
    });
  const executable = (executableSite, logical, rootProcess = false) =>
    inventoryAt(executableSite.process, () => {
      const target = inventoryAt(executableSite.target, () =>
        rootProcess
          ? query(executableSite.target, "sudo", ["-n", resolveTool(executableSite.target, "readlink"), "-f", logical])
          : realpathSync(logical),
      );
      invariant(target && path.isAbsolute(target), executableSite.process.realTarget);
      const hash = inventoryAt(executableSite.hash, () =>
        rootProcess
          ? query(executableSite.hash, "sudo", ["-n", resolveTool(executableSite.hash, "sha256sum"), target]).split(
              /\s+/,
            )[0]
          : sha256(readFileSync(target)),
      );
      const bytes = inventoryAt(executableSite.read, () => readFileSync(target));
      const script = bytes.subarray(0, 2).toString() === "#!";
      return {
        path: rootProcess ? target : logical,
        realTarget: target,
        sha256: hash,
        format: script ? "script" : "native",
        ...(script ? { shebang: bytes.toString("utf8").split("\n")[0] } : {}),
        package: owningPackage(executableSite, target),
      };
    });
  const tools = Object.fromEntries(
    stockTools.map((name) => [
      name,
      inventoryAt(inventoryOperations.tools[name].process, () =>
        executable(
          inventoryOperations.tools[name],
          pins?.[name]?.path ??
            (name === "node" ? process.execPath : resolveTool(inventoryOperations.tools[name].process, name)),
        ),
      ),
    ]),
  );
  const versions = {};
  for (const name of stockTools) {
    if (name === "sh") {
      versions.sh = "NO_VERSION_SWITCH_PACKAGE_VERSION_CAPTURED";
      continue;
    }
    versions[name] = inventoryAt(inventoryOperations.versions[name], () => {
      const args =
        name === "openssl"
          ? ["version", "-a"]
          : name === "ip"
            ? ["-Version"]
            : name === "containerd-shim-runc-v2"
              ? ["-v"]
              : ["--version"];
      return query(inventoryOperations.versions[name], name, args);
    });
  }
  const pid = query(inventoryOperations.dockerPid, "systemctl", ["show", "docker", "--property", "MainPID", "--value"]);
  const containerdPid = query(inventoryOperations.containerdPid, "systemctl", [
    "show",
    "containerd",
    "--property",
    "MainPID",
    "--value",
  ]);
  invariant(/^[1-9]\d*$/.test(pid), inventoryOperations.dockerPid.daemonIdentity);
  invariant(/^[1-9]\d*$/.test(containerdPid), inventoryOperations.containerdPid.daemonIdentity);
  const unit = query(inventoryOperations.dockerUnit, "systemctl", [
    "show",
    "docker",
    "--property=Id,LoadState,FragmentPath,UnitFileState",
  ]);
  const containerdUnit = query(inventoryOperations.containerdUnit, "systemctl", [
    "show",
    "containerd",
    "--property=Id,LoadState,FragmentPath,UnitFileState",
  ]);
  const unitFiles = (serviceSite, service) =>
    inventoryAt(serviceSite.process, () => {
      const fragment = query(serviceSite.fragment, "systemctl", [
        "show",
        service,
        "--property",
        "FragmentPath",
        "--value",
      ]);
      const dropIns = query(serviceSite.dropIns, "systemctl", [
        "show",
        service,
        "--property",
        "DropInPaths",
        "--value",
      ]);
      return [fragment, ...dropIns.split(/\s+/).filter(Boolean)].map((file) =>
        inventoryAt(serviceSite.read, () => {
          invariant(path.isAbsolute(file) && lstatSync(realpathSync(file)).isFile(), serviceSite.read.serviceFile);
          return { path: file, realTarget: realpathSync(file), sha256: sha256(readFileSync(file)) };
        }),
      );
    });
  const server = inventoryAt(inventoryOperations.serverParse, () =>
    JSON.parse(query(inventoryOperations.server, "docker", ["version", "--format", "{{json .Server}}"])),
  );
  const runtimes = inventoryAt(inventoryOperations.runtimesParse, () =>
    JSON.parse(query(inventoryOperations.runtimes, "docker", ["info", "--format", "{{json .Runtimes}}"])),
  );
  const defaultRuntime = query(inventoryOperations.defaultRuntime, "docker", [
    "info",
    "--format",
    "{{.DefaultRuntime}}",
  ]);
  invariant(record(runtimes) && record(runtimes[defaultRuntime]), "ACTIVE_RUNTIME_METADATA_REQUIRED");
  const runtimePath = runtimes[defaultRuntime].path;
  const activeRuntime =
    typeof runtimePath === "string" && runtimePath.length > 0
      ? inventoryAt(inventoryOperations.runtime.process, () =>
          executable(
            inventoryOperations.runtime,
            path.isAbsolute(runtimePath) ? runtimePath : resolveTool(inventoryOperations.runtime.process, runtimePath),
          ),
        )
      : null;
  const daemon = {
    unit,
    containerdUnit,
    server,
    runtimes,
    defaultRuntime,
    activeRuntime,
    unitFiles: unitFiles(inventoryOperations.services.docker, "docker"),
    containerdUnitFiles: unitFiles(inventoryOperations.services.containerd, "containerd"),
    executable: executable(inventoryOperations.dockerDaemon, `/proc/${pid}/exe`, true),
    containerdExecutable: executable(inventoryOperations.containerdDaemon, `/proc/${containerdPid}/exe`, true),
    containerdVersion: query(inventoryOperations.containerdVersion, "containerd", ["--version"]),
    runcVersion: query(inventoryOperations.runcVersion, "runc", ["--version"]),
  };
  inventoryAt(inventoryOperations.processWrite, () =>
    writeJson(path.join(directory, "observed-process-identities.json"), {
      dockerMainPID: pid,
      containerdMainPID: containerdPid,
    }),
  );
  const identity = inventoryAt(inventoryOperations.identityRead, () => ({
    imageVersion: process.env.ImageVersion ?? "UNKNOWN",
    imageOS: process.env.ImageOS ?? "UNKNOWN",
    architecture: os.arch(),
    kernel: os.release(),
    osRelease: readFileSync("/etc/os-release", "utf8"),
    tools,
    versions,
    daemon,
  }));
  inventoryAt(inventoryOperations.identityWrite, () =>
    writeFileSync(path.join(directory, "observed-identity.json"), serializeIdentity(identity), {
      flag: "wx",
      mode: 0o600,
    }),
  );
  identityPublicationRoles.set(identity, publicationFiles);
  return identity;
}

export function scriptDistribution(root, io = { readdirSync, lstatSync, realpathSync, readFileSync }) {
  const base = io.realpathSync(root);
  invariant(
    base === root && io.lstatSync(root).isDirectory() && !io.lstatSync(root).isSymbolicLink(),
    "SCRIPT_DISTRIBUTION_ESCAPE",
  );
  const pairs = [];
  const visit = (directory) => {
    for (const entry of io.readdirSync(directory, { withFileTypes: true })) {
      invariant(
        typeof entry.name === "string" &&
          entry.name.length > 0 &&
          !/[\/\\\x00-\x1f\x7f]/.test(entry.name) &&
          ![".", ".."].includes(entry.name),
        "SCRIPT_DISTRIBUTION_ESCAPE",
      );
      const file = path.posix.join(directory, entry.name);
      const stat = io.lstatSync(file);
      invariant(!stat.isSymbolicLink(), "SCRIPT_DISTRIBUTION_SYMLINK_REFUSED");
      invariant(io.realpathSync(file) === file && file.startsWith(`${base}/`), "SCRIPT_DISTRIBUTION_ESCAPE");
      if (stat.isDirectory()) visit(file);
      else {
        invariant(stat.isFile(), "SCRIPT_DISTRIBUTION_SPECIAL_FILE_REFUSED");
        pairs.push([path.posix.relative(base, file), sha256(io.readFileSync(file))]);
      }
    }
  };
  visit(base);
  scriptClosureFingerprint(pairs);
  return pairs;
}

export function enforceExecutables(tools, names = measurementTools, verifyPathNode = true, diagnostic) {
  for (const name of names) {
    comparisonStock(diagnostic, name);
    const pin = tools?.[name];
    validateToolPin(pin, diagnostic);
    if (stockTools.includes(name) && name !== "node")
      invariant(comparisonAt(diagnostic, "STOCK_RESOLVE", () => resolveTool(inventoryOperations.tools[name].process, name) === pin.path), "STOCK_INVOCATION_PATH_DRIFT");
    const target = comparisonAt(diagnostic, "EXECUTABLE_REALPATH", () => realpathSync(pin.path));
    const bytes = comparisonAt(diagnostic, "EXECUTABLE_READ", () => readFileSync(target));
    const script = bytes.subarray(0, 2).toString() === "#!";
    invariant(
      comparisonAt(diagnostic, "EXECUTABLE_FORMAT", () => script || bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))),
      "NATIVE_EXECUTABLE_OR_REVIEWED_SCRIPT_REQUIRED",
    );
    const actual = {
      path: pin.path,
      realTarget: target,
      sha256: sha256(bytes),
      format: script ? "script" : "native",
      package: pin.package,
    };
    if (script) {
      actual.shebang = bytes.toString("utf8").split("\n")[0];
      const root = comparisonAt(diagnostic, "DISTRIBUTION_REALPATH", () => realpathSync(pin.distributionRoot));
      invariant(comparisonAt(diagnostic, "DISTRIBUTION_ROOT", () => root === pin.distributionRoot), "SCRIPT_DISTRIBUTION_ESCAPE");
      invariant(comparisonAt(diagnostic, "DISTRIBUTION_TARGET", () => target.startsWith(`${root}/`)), "SCRIPT_DISTRIBUTION_ESCAPE");
      actual.closure = comparisonAt(diagnostic, "DISTRIBUTION_READ", () => scriptDistribution(root));
    }
    validateToolObservation(pin, actual, diagnostic);
  }
  comparisonComponent(diagnostic, "INTERPRETER");
  const pathNode = ["/usr/local/bin/node", "/usr/bin/node", "/bin/node"].find((file) => {
    try {
      comparisonAt(diagnostic, "INTERPRETER_SEARCH", () => realpathSync(file));
      return true;
    } catch {
      return false;
    }
  });
  invariant(
    comparisonAt(diagnostic, "INTERPRETER_PROCESS", () => realpathSync(process.execPath) === tools.node.realTarget) &&
      (!verifyPathNode || comparisonAt(diagnostic, "INTERPRETER_PATH", () => realpathSync(pathNode) === tools.node.realTarget)),
    "TOOL_INTERPRETER_MISMATCH",
  );
}

export function enforceIdentityPins(config, actual, bootstrap = false, diagnostic) {
  compareIdentity(bootstrap ? config.bootstrapIdentity : config.expectedIdentity, actual, diagnostic);
  const tools = bootstrap ? bootstrapTools(config) : config.tools;
  for (const name of stockTools) {
    comparisonStock(diagnostic, name);
    validateToolObservation(tools[name], actual.tools[name], diagnostic);
  }
  comparisonComponent(diagnostic, "DAEMON_DOCKER");
  validateToolObservation(config.daemonTools.docker, actual.daemon.executable, diagnostic);
  comparisonComponent(diagnostic, "DAEMON_CONTAINERD");
  validateToolObservation(config.daemonTools.containerd, actual.daemon.containerdExecutable, diagnostic);
  comparisonComponent(diagnostic, "ACTIVE_RUNTIME");
  invariant(comparisonAt(diagnostic, "ACTIVE_RUNTIME_DEFAULT", () => actual.daemon.defaultRuntime === "runc") && comparisonAt(diagnostic, "ACTIVE_RUNTIME_PRESENT", () => actual.daemon.activeRuntime), "ACTIVE_RUNC_IDENTITY_REQUIRED");
  validateToolObservation(tools.runc, actual.daemon.activeRuntime, diagnostic);
  comparisonComponent(diagnostic, "RUNNER");
  const r = config.runnerIdentity;
  invariant(
    comparisonAt(diagnostic, "RUNNER_IMAGE", () => r.image === "ubuntu-24.04") &&
      ["imageVersion", "imageOS", "architecture", "kernel"].every((key) => comparisonAt(diagnostic, ({ imageVersion: "RUNNER_IMAGE_VERSION", imageOS: "RUNNER_IMAGE_OS", architecture: "RUNNER_ARCHITECTURE", kernel: "RUNNER_KERNEL" })[key], () => actual[key] === r[key])) &&
      comparisonAt(diagnostic, "RUNNER_OS", () => actual.osRelease.includes(`PRETTY_NAME="${r.os}"\n`)) &&
      comparisonAt(diagnostic, "RUNNER_CODENAME", () => actual.osRelease.includes(`VERSION_CODENAME=${r.codename}\n`)) &&
      comparisonAt(diagnostic, "RUNNER_ENGINE_VERSION", () => actual.daemon.server.Version === r.engine.version) &&
      comparisonAt(diagnostic, "RUNNER_ENGINE_API", () => actual.daemon.server.ApiVersion === r.engine.apiVersion) &&
      comparisonAt(diagnostic, "RUNNER_ENGINE_COMMIT", () => actual.daemon.server.GitCommit === r.engine.gitCommit),
    "REVIEWED_RUNNER_IDENTITY_DRIFT",
  );
  for (const [name, expected] of [
    ["containerd", r.containerd],
    ["runc", r.runc],
    ["docker-init", r.dockerInit],
  ]) {
    comparisonComponent(diagnostic, ({ containerd: "COMPONENT_CONTAINERD", runc: "COMPONENT_RUNC", "docker-init": "COMPONENT_DOCKER_INIT" })[name]);
    const components = comparisonAt(diagnostic, "COMPONENT_SELECT", () => actual.daemon.server.Components.filter((component) => component.Name === name));
    invariant(
      comparisonAt(diagnostic, "COMPONENT_COUNT", () => components.length === 1) &&
        comparisonAt(diagnostic, "COMPONENT_VERSION", () => components[0].Version === expected.version) &&
        comparisonAt(diagnostic, "COMPONENT_COMMIT", () => components[0].Details.GitCommit === expected.gitCommit),
      "REVIEWED_DAEMON_IDENTITY_DRIFT",
    );
  }
  for (const [name, files] of [
    ["docker", actual.daemon.unitFiles],
    ["containerd", actual.daemon.containerdUnitFiles],
  ]) {
    comparisonComponent(diagnostic, ({ docker: "SERVICE_DOCKER", containerd: "SERVICE_CONTAINERD" })[name]);
    const { path: logical, realTarget, sha256: hash } = comparisonAt(diagnostic, "SERVICE_PINS", () => config.servicePins[name]);
    invariant(comparisonAt(diagnostic, "SERVICE_EQUAL", () => equal(files, [{ path: logical, realTarget, sha256: hash }])), "REVIEWED_SERVICE_FILE_DRIFT");
  }
}

export function invocation(tools, name, args) {
  const pin = tools[name];
  validateToolPin(pin);
  return pin.format === "script"
    ? { executable: tools.node.path, args: [pin.path, ...args] }
    : { executable: pin.path, args };
}

export function preserveAuthority(directory, authority, raw) {
  for (const [file, bytes] of [
    ["authority-envelope.json", raw],
    ["authority-payload.json", authority.payloadBytes],
    ["authority-review.txt", authority.reviewBytes],
    ["authority-subject.json", authority.subjectBytes],
    ["authority-dispatch.json", authority.dispatchBytes],
    ["authority-completion.json", authority.completionBytes],
  ])
    writeFileSync(path.join(directory, file), bytes, { flag: "wx", mode: 0o600 });
}

export function preserveMetadata(directory, capture, prefix = "") {
  invariant(/^[a-z-]*$/.test(prefix), "INVALID_METADATA_PREFIX");
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    invariant(!lstatSync(file).isSymbolicLink(), "METADATA_SYMLINK_REFUSED");
    if (lstatSync(file).isFile())
      writeFileSync(path.join(capture, `${prefix}${name}`), readFileSync(file), { flag: "wx", mode: 0o600 });
  }
}

export function hostedContext(protocol) {
  invariant(
    process.platform === "linux" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.env.GITHUB_JOB === protocol.job &&
      process.getuid() !== 0,
    "HOSTED_INVENTORY_ONLY",
  );
  const event = inventoryAt(inventoryOperations.eventParse, () =>
    JSON.parse(inventoryAt(inventoryOperations.eventRead, () => readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))),
  );
  invariant(
    /^\d+$/.test(process.env.GITHUB_RUN_ID) && /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT),
    "INVALID_RUN_IDENTITY",
  );
  return inventoryAt(inventoryOperations.eventProcess, () =>
    normalizePushEvent(
      event,
      {
        eventName: process.env.GITHUB_EVENT_NAME,
        ref: process.env.GITHUB_REF,
        sha: process.env.GITHUB_SHA,
      },
      protocol,
    ),
  );
}

export function normalizePushEvent(event, identity, protocol) {
  const ref = `refs/heads/${protocol.branch}`;
  invariant(
    identity.eventName === "push" &&
      identity.ref === ref &&
      event.repository?.full_name === "chase-sets/chase-sets" &&
      event.ref === ref &&
      event.deleted === false &&
      !Object.hasOwn(event, "pull_request") &&
      isRef(event.before) &&
      isRef(event.after) &&
      event.after !== "0".repeat(40) &&
      event.after === identity.sha,
    "EVENT_NOT_ADMITTED",
  );
  return Object.freeze({
    eventName: "push",
    ref,
    before: event.before,
    after: event.after,
    head: event.after,
    base: null,
    merge: null,
  });
}

export function validateExecutionHead(event, diskHead, payloadHead) {
  invariant(event.head === diskHead && event.head === payloadHead, "DISK_EVENT_PAYLOAD_HEAD_MISMATCH");
}

async function collect() {
  invariant(process.argv.length === 3, "CLOSED_INVENTORY_ARGV_REQUIRED");
  const protocol = inventoryAt(inventoryOperations.protocolParse, () =>
    JSON.parse(
      inventoryAt(inventoryOperations.protocolRead, () => readFileSync(path.join(here, "protocol.json"), "utf8")),
    ),
  );
  const event = inventoryAt(inventoryOperations.eventProcess, () => hostedContext(protocol));
  const authority = readAuthority(process.argv[2], process.env.DIAGNOSTIC_FREEZE_SHA256, {
    head: event.head,
    phase: "inventory",
    protocol,
  });
  const run = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  const root = inventoryAt(inventoryOperations.rootSetup, () => {
    const root = path.join(realpathSync(process.env.RUNNER_TEMP), "10678-inventory", `${run}-${attempt}`);
    mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
    mkdirSync(root, { mode: 0o700 });
    return root;
  });
  const capture = inventoryAt(inventoryOperations.captureSetup, () => {
    const capture = path.join(root, "inventory");
    mkdirSync(capture, { mode: 0o700 });
    return capture;
  });
  const startedAt = new Date().toISOString();
  const disk = inventoryAt(inventoryOperations.diskHead, () =>
    spawnSync(resolveTool(inventoryOperations.diskHead, "git"), ["rev-parse", "HEAD"], {
      env: cleanEnvironment(path.join(root, "private", "empty-home")),
      encoding: "utf8",
      shell: false,
    }),
  );
  validateExecutionHead(event, inventoryDiskHead(disk), authority.config.head);
  const identity = observeIdentity(path.join(root, "private"));
  // Raw metadata stays flat in this exact upload directory; empty credential homes never do.
  inventoryAt(inventoryOperations.metadataCopy, () => preserveMetadata(path.join(root, "private"), capture));
  inventoryAt(inventoryOperations.authorityCopy, () =>
    preserveAuthority(capture, authority, readFileSync(process.argv[2])),
  );
  const receipt = inventoryAt(inventoryOperations.receiptWrite, () => ({
    schema: "10678-inventory-receipt/v1",
    phase: "inventory",
    measurementDisposition: "NOT_EXECUTED",
    rowCount: 0,
    rows: [],
    complete: true,
    phases: ["inventoryStart", "inventoryComplete"],
    startedAt,
    completedAt: new Date().toISOString(),
    run,
    attempt,
    jobIdentity: {
      key: protocol.job,
      numericId: "PENDING_HOST_ATTEMPT_SPECIFIC_JOB_AUTHORITY",
      steps: "PENDING_HOST_COMPLETE_JOB_STEP_AND_SETUP_IMAGE_LOG_CUSTODY",
    },
    ...event,
    authority: authority.identity,
    identitySha256: sha256(Buffer.from(canonical(identity))),
    setupJob: {
      imageVersion: identity.imageVersion,
      release: `https://github.com/actions/runner-images/releases/tag/ubuntu24%2F${identity.imageVersion}`,
      authority: "PENDING_HOST_SETUP_JOB_LOG_RECONCILIATION",
    },
    disposal: "PENDING_HOST_RUNNER_COMPLETION",
  }));
  inventoryAt(inventoryOperations.receiptWrite, () =>
    writeJson(path.join(capture, "preparation-receipt.json"), receipt),
  );
  const files = inventoryAt(inventoryOperations.captureRead, () =>
    readdirSync(capture)
      .sort()
      .map((file) => {
        const bytes = readFileSync(path.join(capture, file));
        return {
          file,
          bytes: bytes.length,
          sha256: sha256(bytes),
          text: inventoryAt(inventoryOperations.captureDecode, () => utf8(bytes)),
        };
      }),
  );
  const hits = inventoryAt(inventoryOperations.captureScan, () => scanExposure(files));
  inventoryAt(inventoryOperations.manifestWrite, () =>
    writeJson(path.join(capture, "inventory-manifest.json"), {
      schema: "10678-inventory-manifest/v1",
      phase: "inventory",
      run,
      attempt,
      files: files.map(({ text: _text, ...entry }) => entry),
      receiptSha256: sha256(readFileSync(path.join(capture, "preparation-receipt.json"))),
    }),
  );
  const gate = inventoryAt(inventoryOperations.gateWrite, () => ({
    schema: "10678-inventory-publication/v1",
    phase: "inventory",
    complete: true,
    publish: hits.length === 0,
    scan: hits.length ? "HITS" : "NO_HITS",
    hits,
    manifestSha256: sha256(readFileSync(path.join(capture, "inventory-manifest.json"))),
  }));
  inventoryAt(inventoryOperations.gateWrite, () =>
    writeJson(path.join(capture, "inventory-publication-gate.json"), gate),
  );
  try {
    validateInventoryPublication(receipt, gate);
  } catch (error) {
    if (inventoryCategory(error) === "PRIVATE_INVENTORY_PUBLICATION_REFUSED")
      console.log(
        inventoryAt(inventoryOperations.captureScan, () =>
          inventoryPublicationHitClasses(hits, classifyExposure(files), identityPublicationRoles.get(identity)),
        ),
      );
    throw error;
  }
  console.log("INVENTORY_CAPTURE_COMPLETE_MEASUREMENT_NOT_EXECUTED");
}

export function inventoryRefusal(error) {
  return `INVENTORY_REFUSED_MEASUREMENT_NOT_EXECUTED category=${inventoryCategory(error)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await collect();
  } catch (error) {
    console.log(inventoryRefusal(error));
    process.exitCode = 1;
  }
}
