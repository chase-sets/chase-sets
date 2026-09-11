import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CI_GATE_DEFINITIONS,
  CI_GATE_EXECUTABILITY,
  CI_GATE_MODES,
  CI_GATE_PROVENANCE,
  CI_GATE_SELECTIONS,
  createCiGatePlan,
  normalizeCiGateLabels,
  validateCiGatePlan,
  validateCiGateScope,
} from "./ci-gate-plan.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";

export const CI_LOCAL_RECEIPT_SCHEMA_VERSION = "ci-local-verification-receipt/v1";
export const CI_GATE_EVIDENCE = Object.freeze([
  "PASSED",
  "FAILED",
  "INTERRUPTED",
  "NOT_RUN_NOT_REQUIRED",
  "NOT_RUN_HOSTED_ONLY",
  "NOT_RUN_DRY_RUN",
  "NOT_RUN_UNDECIDABLE",
  "NOT_RUN_ABORTED",
]);
export const CI_LOCAL_DISPOSITIONS = Object.freeze(["PASS", "FAIL", "FAIL_CLOSED", "PLAN_ONLY"]);

const receiptKeys = [
  "schemaVersion",
  "startedAt",
  "finishedAt",
  "durationMs",
  "baseRef",
  "headRef",
  "baseSha",
  "headSha",
  "mode",
  "labels",
  "provenance",
  "dryRun",
  "plan",
  "gates",
  "errors",
  "disposition",
  "hostedAuthorityOutstanding",
];
const receiptGateKeys = [
  "id",
  "name",
  "category",
  "selection",
  "executability",
  "reason",
  "hostedOnlyReason",
  "affectedWorkspaces",
  "e2eBatches",
  "evidence",
];
const receiptErrorKeys = ["code", "message", "gateId"];

function exactKeys(value, expected, pathName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${pathName} must be an object`);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${pathName} has unexpected keys: ${actual.join(", ")}`);
  }
}

function timezoneTimestamp(value) {
  return typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
}

function stringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function receiptError(code, message, gateId = null) {
  return { code, message, gateId };
}

function errorCode(error, fallback = "FAIL_CLOSED_ERROR") {
  const match = String(error?.message ?? error).match(/^([A-Z][A-Z0-9_]+)(?::|$)/);
  return match?.[1] ?? fallback;
}

function resolvePnpmCommand() {
  return "pnpm";
}

function command(commandName, args, { env = {}, clearEnv = [] } = {}) {
  if (
    typeof commandName !== "string" ||
    !commandName ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string")
  ) {
    throw new Error("MISSING_LOCAL_COMMAND_SHAPE");
  }
  return { command: commandName, args, env, clearEnv };
}

export function createLocalCommandPlan({ plan, baseSha, headSha, scope }) {
  validateCiGatePlan(plan);
  validateCiGateScope(scope);
  if (!/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("UNRESOLVED_COMMAND_IDENTITY");
  }
  const workspaceList = scope.affectedWorkspaces.join(",");
  const pnpm = resolvePnpmCommand();
  const matrix = new Map([
    [
      "change-scope",
      [
        command("node", ["./scripts/change-scope.mjs", "json", `--base=${baseSha}`, `--head=${headSha}`], {
          clearEnv: ["CHANGED_FILES_JSON", "GITHUB_OUTPUT"],
        }),
      ],
    ],
    [
      "static",
      [
        command(pnpm, ["run", "verify:metadata"]),
        command(pnpm, ["run", "verify:static"], {
          env: { CHANGED_FILES_JSON: JSON.stringify(scope.changedFiles), FORMAT_CHECK_SCOPE: "full" },
        }),
      ],
    ],
    ["typecheck", [command(pnpm, ["run", "verify:typecheck"])]],
    [
      "unit-tests",
      [
        command("node", [
          "./scripts/run-workspaces.mjs",
          "test",
          "--exclude-test-profile=db",
          "--concurrency=4",
          `--workspace-list=${workspaceList}`,
        ]),
        command("node", [
          "./scripts/run-workspaces.mjs",
          "test:unit",
          "--test-profile=db",
          "--concurrency=4",
          `--workspace-list=${workspaceList}`,
        ]),
      ],
    ],
    [
      "db-tests",
      [
        command("node", ["./scripts/db-test-preflight.mjs"]),
        command("node", [
          "./scripts/run-workspaces.mjs",
          "test:db*",
          "--concurrency=2",
          `--workspace-list=${workspaceList}`,
        ]),
      ],
    ],
    [
      "e2e-tests",
      [
        command(pnpm, ["exec", "playwright", "install", "--with-deps", "chromium"]),
        ...plan.gates
          .find(({ id }) => id === "e2e-tests")
          .e2eBatches.map((batch) => command(pnpm, ["run", "test:e2e:suite", batch])),
      ],
    ],
    [
      "build",
      [
        command("node", [
          "./scripts/run-workspaces.mjs",
          "build",
          "--concurrency=4",
          `--workspace-list=${workspaceList}`,
        ]),
      ],
    ],
  ]);
  validateLocalCommandCoverage(matrix, { baseSha, headSha });
  return matrix;
}

export function validateChangeScopeCommandShape(spec, { baseSha, headSha }) {
  const expected = {
    command: "node",
    args: ["./scripts/change-scope.mjs", "json", `--base=${baseSha}`, `--head=${headSha}`],
    env: {},
    clearEnv: ["CHANGED_FILES_JSON", "GITHUB_OUTPUT"],
  };
  if (JSON.stringify(spec) !== JSON.stringify(expected)) throw new Error("CHANGE_SCOPE_COMMAND_IDENTITY_MISMATCH");
  return spec;
}

export function validateLocalCommandCoverage(matrix, identity) {
  if (!(matrix instanceof Map)) throw new Error("LOCAL_COMMAND_MATRIX_REQUIRED");
  const localIds = CI_GATE_DEFINITIONS.filter(({ executability }) => executability === "REPOSITORY_LOCAL").map(
    ({ id }) => id,
  );
  if (JSON.stringify([...matrix.keys()]) !== JSON.stringify(localIds)) {
    throw new Error("LOCAL_COMMAND_EXECUTABILITY_MISMATCH");
  }
  for (const [gateId, commands] of matrix) {
    if (!Array.isArray(commands) || commands.length === 0) throw new Error(`MISSING_LOCAL_COMMAND_SHAPE: ${gateId}`);
    for (const spec of commands) {
      if (
        !spec ||
        typeof spec.command !== "string" ||
        !spec.command ||
        !Array.isArray(spec.args) ||
        spec.args.some((arg) => typeof arg !== "string")
      ) {
        throw new Error(`MISSING_LOCAL_COMMAND_SHAPE: ${gateId}`);
      }
    }
  }
  validateChangeScopeCommandShape(matrix.get("change-scope")[0], identity);
  return matrix;
}

export function defaultCommandExecutor(spec) {
  const env = { ...process.env, ...spec.env };
  for (const name of spec.clearEnv) delete env[name];
  const result = spawnSync(spec.command, spec.args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status === null) {
    return {
      outcome: "interrupted",
      exitCode: null,
      signal: result.signal ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
  return {
    outcome: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    signal: null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function staticEvidence(entry, dryRun) {
  if (entry.selection === "NOT_REQUIRED") return "NOT_RUN_NOT_REQUIRED";
  if (entry.selection === "UNDECIDABLE") return "NOT_RUN_UNDECIDABLE";
  if (entry.executability === "HOSTED_ONLY") return "NOT_RUN_HOSTED_ONLY";
  if (dryRun) return "NOT_RUN_DRY_RUN";
  return null;
}

function resultEvidence(result) {
  if (result?.outcome === "passed") return "PASSED";
  if (result?.outcome === "failed") return "FAILED";
  if (result?.outcome === "interrupted") return "INTERRUPTED";
  throw new Error(`UNKNOWN_EXECUTOR_OUTCOME: ${String(result?.outcome)}`);
}

function gateRecord(entry, evidence) {
  return { ...entry, evidence };
}

function dispositionFor(gates, errors, dryRun) {
  const evidence = gates.map((gateEntry) => gateEntry.evidence);
  if (
    errors.length > 0 ||
    evidence.some((value) => ["INTERRUPTED", "NOT_RUN_UNDECIDABLE", "NOT_RUN_ABORTED"].includes(value))
  ) {
    return "FAIL_CLOSED";
  }
  if (evidence.includes("FAILED")) return "FAIL";
  if (dryRun && evidence.includes("NOT_RUN_DRY_RUN")) return "PLAN_ONLY";
  return "PASS";
}

export function executeGatePlan({
  plan,
  commandPlan,
  executor = defaultCommandExecutor,
  dryRun = false,
  initialEvidence = new Map(),
  abortBeforeExecution = false,
}) {
  validateCiGatePlan(plan);
  return executeGateEntries({
    entries: plan.gates,
    commandPlan,
    executor,
    dryRun,
    initialEvidence,
    abortBeforeExecution,
  });
}

export function executeGateEntries({
  entries,
  commandPlan,
  executor = defaultCommandExecutor,
  dryRun = false,
  initialEvidence = new Map(),
  abortBeforeExecution = false,
}) {
  const gates = [];
  const errors = [];
  let aborted = abortBeforeExecution;
  for (const entry of entries) {
    const resolved = staticEvidence(entry, dryRun);
    if (resolved) {
      gates.push(gateRecord(entry, resolved));
      continue;
    }
    if (initialEvidence.has(entry.id)) {
      gates.push(gateRecord(entry, initialEvidence.get(entry.id)));
      continue;
    }
    if (aborted) {
      gates.push(gateRecord(entry, "NOT_RUN_ABORTED"));
      continue;
    }
    const commands = commandPlan.get(entry.id);
    if (!commands?.length) {
      errors.push(receiptError("MISSING_LOCAL_COMMAND_SHAPE", `No command shape for ${entry.id}`, entry.id));
      gates.push(gateRecord(entry, "NOT_RUN_ABORTED"));
      aborted = true;
      continue;
    }
    let evidence = "PASSED";
    for (const spec of commands) {
      try {
        const result = executor(spec, entry);
        evidence = resultEvidence(result);
      } catch (error) {
        errors.push(receiptError("EXECUTOR_FAILURE", String(error?.message ?? error), entry.id));
        evidence = "INTERRUPTED";
      }
      if (evidence !== "PASSED") break;
    }
    gates.push(gateRecord(entry, evidence));
    if (evidence === "INTERRUPTED") aborted = true;
  }
  const result = { gates, errors, disposition: dispositionFor(gates, errors, dryRun) };
  validateExecutionResult(entries, result, dryRun);
  return result;
}

export function validateExecutionResult(entries, result, dryRun = false) {
  if (!Array.isArray(result?.gates) || result.gates.length !== entries.length) {
    throw new Error("EXECUTION_GATE_COVERAGE_MISMATCH");
  }
  if (JSON.stringify(result.gates.map(({ id }) => id)) !== JSON.stringify(entries.map(({ id }) => id))) {
    throw new Error("EXECUTION_GATE_ORDER_MISMATCH");
  }
  if (result.gates.some(({ evidence }) => !CI_GATE_EVIDENCE.includes(evidence))) {
    throw new Error("UNKNOWN_EXECUTION_EVIDENCE");
  }
  const expected = dispositionFor(result.gates, result.errors, dryRun);
  if (result.disposition !== expected) throw new Error("EXECUTION_DISPOSITION_MISMATCH");
  return result;
}

function resolveIdentity(baseRef, headRef, gitExec) {
  try {
    const headSha = gitExec("git", ["rev-parse", "--verify", `${headRef}^{commit}`])
      .trim()
      .toLowerCase();
    const baseCandidate = gitExec("git", ["rev-parse", "--verify", `${baseRef}^{commit}`])
      .trim()
      .toLowerCase();
    const baseSha = gitExec("git", ["merge-base", baseCandidate, headSha]).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(headSha)) throw new Error("invalid object id");
    return { baseSha, headSha };
  } catch (error) {
    throw new Error(`REF_RESOLUTION_FAILED: ${String(error?.message ?? error)}`);
  }
}

function defaultGitExec(commandName, args) {
  return execFileSync(commandName, args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function baseReceipt({
  startedAt,
  finishedAt,
  baseRef,
  headRef,
  baseSha,
  headSha,
  mode,
  labels,
  provenance,
  dryRun,
  plan,
  gates,
  errors,
  disposition,
}) {
  return {
    schemaVersion: CI_LOCAL_RECEIPT_SCHEMA_VERSION,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    baseRef,
    headRef,
    baseSha,
    headSha,
    mode,
    labels,
    provenance,
    dryRun,
    plan,
    gates,
    errors,
    disposition,
    hostedAuthorityOutstanding: true,
  };
}

export function validateCiLocalReceipt(receipt) {
  exactKeys(receipt, receiptKeys, "receipt");
  if (receipt.schemaVersion !== CI_LOCAL_RECEIPT_SCHEMA_VERSION) throw new Error("UNKNOWN_RECEIPT_SCHEMA");
  if (!timezoneTimestamp(receipt.startedAt) || !timezoneTimestamp(receipt.finishedAt)) {
    throw new Error("RECEIPT_TIMESTAMP_WITHOUT_TIMEZONE");
  }
  if (!Number.isInteger(receipt.durationMs) || receipt.durationMs < 0 || receipt.durationMs > 86_400_000) {
    throw new Error("RECEIPT_DURATION_OUT_OF_RANGE");
  }
  for (const [key, value] of [
    ["baseSha", receipt.baseSha],
    ["headSha", receipt.headSha],
  ]) {
    if (value !== null && !/^[0-9a-f]{40}$/.test(value)) throw new Error(`INVALID_RECEIPT_${key.toUpperCase()}`);
  }
  if (receipt.mode !== null && !CI_GATE_MODES.includes(receipt.mode)) throw new Error("UNKNOWN_RECEIPT_MODE");
  if (!stringArray(receipt.labels)) throw new Error("INVALID_RECEIPT_LABELS");
  if (receipt.provenance !== null && !CI_GATE_PROVENANCE.includes(receipt.provenance)) {
    throw new Error("UNKNOWN_RECEIPT_PROVENANCE");
  }
  if (typeof receipt.dryRun !== "boolean") throw new Error("INVALID_RECEIPT_DRY_RUN");
  if (receipt.plan !== null) validateCiGatePlan(receipt.plan);
  if (!Array.isArray(receipt.gates)) throw new Error("INVALID_RECEIPT_GATES");
  for (const [index, entry] of receipt.gates.entries()) {
    exactKeys(entry, receiptGateKeys, `receipt.gates[${index}]`);
    if (!CI_GATE_SELECTIONS.includes(entry.selection)) throw new Error("UNKNOWN_RECEIPT_SELECTION");
    if (!CI_GATE_EXECUTABILITY.includes(entry.executability)) throw new Error("UNKNOWN_RECEIPT_EXECUTABILITY");
    if (!CI_GATE_EVIDENCE.includes(entry.evidence)) throw new Error("UNKNOWN_RECEIPT_EVIDENCE");
    if (!stringArray(entry.affectedWorkspaces) || !stringArray(entry.e2eBatches))
      throw new Error("INVALID_RECEIPT_TARGETS");
  }
  if (
    receipt.plan !== null &&
    JSON.stringify(receipt.gates.map(({ evidence: _evidence, ...entry }) => entry)) !==
      JSON.stringify(receipt.plan.gates)
  ) {
    throw new Error("RECEIPT_PLAN_GATE_MISMATCH");
  }
  if (!Array.isArray(receipt.errors)) throw new Error("INVALID_RECEIPT_ERRORS");
  for (const [index, entry] of receipt.errors.entries()) {
    exactKeys(entry, receiptErrorKeys, `receipt.errors[${index}]`);
    if (typeof entry.code !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(entry.code)) throw new Error("INVALID_ERROR_CODE");
    if (typeof entry.message !== "string" || !entry.message) throw new Error("INVALID_ERROR_MESSAGE");
    if (entry.gateId !== null && typeof entry.gateId !== "string") throw new Error("INVALID_ERROR_GATE_ID");
  }
  if (!CI_LOCAL_DISPOSITIONS.includes(receipt.disposition)) throw new Error("UNKNOWN_RECEIPT_DISPOSITION");
  if (receipt.hostedAuthorityOutstanding !== true) throw new Error("HOSTED_AUTHORITY_MUST_REMAIN_OUTSTANDING");
  const expectedDisposition = dispositionFor(receipt.gates, receipt.errors, receipt.dryRun);
  if (receipt.disposition !== expectedDisposition) throw new Error("RECEIPT_DISPOSITION_MISMATCH");
  if (
    receipt.disposition !== "FAIL_CLOSED" &&
    (receipt.plan === null || receipt.baseSha === null || receipt.headSha === null)
  ) {
    throw new Error("SUCCESS_RECEIPT_WITHOUT_IDENTITY_OR_PLAN");
  }
  return receipt;
}

export function createFailClosedReceipt({
  error,
  baseRef = "origin/main",
  headRef = "HEAD",
  mode = null,
  labels = [],
  provenance = null,
  dryRun = false,
  startedAt = new Date().toISOString(),
  now = () => new Date(),
}) {
  const finishedAt = now().toISOString();
  const receipt = baseReceipt({
    startedAt,
    finishedAt,
    baseRef,
    headRef,
    baseSha: null,
    headSha: null,
    mode: CI_GATE_MODES.includes(mode) ? mode : null,
    labels: stringArray(labels) ? labels : [],
    provenance: CI_GATE_PROVENANCE.includes(provenance) ? provenance : null,
    dryRun: Boolean(dryRun),
    plan: null,
    gates: [],
    errors: [receiptError(errorCode(error), String(error?.message ?? error))],
    disposition: "FAIL_CLOSED",
  });
  validateCiLocalReceipt(receipt);
  return receipt;
}

export function runCiLocalVerification(
  { baseRef = "origin/main", headRef = "HEAD", mode, labels = [], provenance, dryRun = false },
  { gitExec = defaultGitExec, executor = defaultCommandExecutor, now = () => new Date() } = {},
) {
  const startedAt = now().toISOString();
  let normalizedLabels = [];
  let normalizedProvenance = null;
  let identity = { baseSha: null, headSha: null };
  let plan = null;
  try {
    if (!CI_GATE_MODES.includes(mode)) throw new Error(`MALFORMED_MODE: ${String(mode)}`);
    normalizedLabels = normalizeCiGateLabels(labels);
    if (provenance !== undefined && provenance !== null && !CI_GATE_PROVENANCE.includes(provenance)) {
      throw new Error(`MALFORMED_PROVENANCE: ${String(provenance)}`);
    }
    normalizedProvenance = mode === "merge-group" ? null : (provenance ?? null);
    identity = resolveIdentity(baseRef, headRef, gitExec);
    const scopeCommand = command(
      "node",
      ["./scripts/change-scope.mjs", "json", `--base=${identity.baseSha}`, `--head=${identity.headSha}`],
      { clearEnv: ["CHANGED_FILES_JSON", "GITHUB_OUTPUT"] },
    );
    let scopeResult;
    try {
      scopeResult = executor(scopeCommand, { id: "change-scope", name: "Change Scope" });
    } catch (error) {
      throw new Error(`CLASSIFIER_EXECUTOR_FAILURE: ${String(error?.message ?? error)}`);
    }
    if (scopeResult?.outcome === "interrupted") throw new Error("CLASSIFIER_INTERRUPTED");
    if (scopeResult?.outcome !== "passed") throw new Error("CLASSIFIER_FAILED");
    let scope;
    try {
      scope = JSON.parse(scopeResult.stdout);
    } catch {
      throw new Error("CLASSIFIER_OUTPUT_MALFORMED");
    }
    validateCiGateScope(scope);
    plan = createCiGatePlan({ mode, labels: normalizedLabels, provenance: normalizedProvenance, scope });
    const commandPlan = createLocalCommandPlan({ plan, ...identity, scope });
    const missingProvenance = mode === "pull-request" && normalizedProvenance === null;
    const execution = executeGatePlan({
      plan,
      commandPlan,
      executor,
      dryRun,
      initialEvidence: dryRun ? new Map() : new Map([["change-scope", "PASSED"]]),
      abortBeforeExecution: missingProvenance && !dryRun,
    });
    if (missingProvenance) {
      execution.errors.unshift(
        receiptError(
          "MISSING_PULL_REQUEST_PROVENANCE",
          "pull-request mode requires --provenance",
          "preview-deploy-smoke",
        ),
      );
      execution.disposition = "FAIL_CLOSED";
    }
    const finishedAt = now().toISOString();
    const receipt = baseReceipt({
      startedAt,
      finishedAt,
      baseRef,
      headRef,
      ...identity,
      mode,
      labels: normalizedLabels,
      provenance: normalizedProvenance,
      dryRun,
      plan,
      gates: execution.gates,
      errors: execution.errors,
      disposition: execution.disposition,
    });
    validateCiLocalReceipt(receipt);
    return receipt;
  } catch (error) {
    const finishedAt = now().toISOString();
    const receipt = baseReceipt({
      startedAt,
      finishedAt,
      baseRef,
      headRef,
      ...identity,
      mode: CI_GATE_MODES.includes(mode) ? mode : null,
      labels: normalizedLabels,
      provenance: normalizedProvenance,
      dryRun,
      plan,
      gates: [],
      errors: [receiptError(errorCode(error), String(error?.message ?? error))],
      disposition: "FAIL_CLOSED",
    });
    validateCiLocalReceipt(receipt);
    return receipt;
  }
}

export function parseCiLocalArgs(argv) {
  const options = { baseRef: "origin/main", headRef: "HEAD", labels: [], dryRun: false, json: false };
  const seen = new Set();
  const forwardedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  for (const arg of forwardedArgv) {
    if (arg.startsWith("--mode=")) {
      if (seen.has("mode")) throw new Error("DUPLICATE_ARGUMENT: mode");
      seen.add("mode");
      options.mode = arg.slice("--mode=".length);
    } else if (arg.startsWith("--provenance=")) {
      if (seen.has("provenance")) throw new Error("DUPLICATE_ARGUMENT: provenance");
      seen.add("provenance");
      options.provenance = arg.slice("--provenance=".length);
    } else if (arg.startsWith("--base=")) {
      if (seen.has("base")) throw new Error("DUPLICATE_ARGUMENT: base");
      seen.add("base");
      options.baseRef = arg.slice("--base=".length);
    } else if (arg.startsWith("--head=")) {
      if (seen.has("head")) throw new Error("DUPLICATE_ARGUMENT: head");
      seen.add("head");
      options.headRef = arg.slice("--head=".length);
    } else if (arg.startsWith("--label=")) options.labels.push(arg.slice("--label=".length));
    else if (arg.startsWith("--labels="))
      options.labels.push(...arg.slice("--labels=".length).split(",").filter(Boolean));
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`UNKNOWN_ARGUMENT: ${arg}`);
  }
  if (!options.baseRef || !options.headRef) throw new Error("MISSING_REF_ARGUMENT");
  return options;
}

function printHumanReceipt(receipt) {
  console.log(`CI local verification: ${receipt.disposition}`);
  console.log(`Base: ${receipt.baseSha ?? "unresolved"}`);
  console.log(`Head: ${receipt.headSha ?? "unresolved"}`);
  for (const gateEntry of receipt.gates) {
    console.log(`${gateEntry.name}: ${gateEntry.selection} / ${gateEntry.executability} / ${gateEntry.evidence}`);
  }
  for (const error of receipt.errors) console.error(`${error.code}: ${error.message}`);
}

function main() {
  let options;
  let receipt;
  const jsonRequested = process.argv.slice(2).includes("--json");
  try {
    options = parseCiLocalArgs(process.argv.slice(2));
    receipt = runCiLocalVerification(options);
  } catch (error) {
    receipt = createFailClosedReceipt({ error });
  }
  if (options?.json || jsonRequested) console.log(JSON.stringify(receipt, null, 2));
  else printHumanReceipt(receipt);
  process.exitCode = receipt.disposition === "FAIL" ? 1 : receipt.disposition === "FAIL_CLOSED" ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  acquireHeavySlot("script-battery");
  main();
}
