#!/usr/bin/env node
import { appendFileSync, chmodSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  classifyDeployedRuntime,
  readExecutedBytes,
  runGit,
  validateExecutedBytes,
} from "./staging-executed-bytes.mjs";
import { readStagingDeployGeneration, selectStagingDeployGeneration } from "./staging-deploy-generation.mjs";
import {
  STAGING_PRODUCT_ORIGIN,
  observeBackendReadiness,
  observeProviderMode,
  observeWebReadiness,
  requestProductHost,
} from "./staging-product-observations.mjs";

export const STAGING_EVIDENCE_AUTHORITY_VERSION = "staging-evidence-authority/v1";
export const STAGING_EVIDENCE_AUTHORITY_RUNNER_PATH = "scripts/staging-evidence-authority.mjs";
const SELF_PATH = STAGING_EVIDENCE_AUTHORITY_RUNNER_PATH;
const REQUIRED_ORIGIN = STAGING_PRODUCT_ORIGIN;
const OPTION_NAMES = new Set([
  "base-url",
  "environment",
  "head",
  "worktree",
  "governed-path",
  "out",
  "log-file",
  "deploy-max-age-seconds",
  "request-timeout-ms",
  "total-budget-ms",
  "runner-path",
]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const HEAD = /^[a-f0-9]{40}$/;
const AUTH_MARKERS =
  /(?<![A-Za-z0-9])(?:pk_|sk_|rk_|acct_|pi_|seti_|cus_|cs_|rfd_|ord_|session[_-][a-z0-9._-]+|bearer\s+[a-z0-9._-]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isInstant = (value) => typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value));
const isAbsolute = (value) => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value;
const isRepoPath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 260 &&
  !/[\\\0-\u001f\u007f]/.test(value) &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
const boundedInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function inputError(input, stop = "input-invalid") {
  const error = new Error(stop);
  error.input = input;
  error.stop = stop;
  return error;
}

function readArgv(argv) {
  const values = new Map();
  const governed = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string" || !token.startsWith("--")) throw inputError("argv", "input-invalid");
    const name = token.slice(2);
    if (["github-token", "marketplace-e2e-email", "marketplace-e2e-password"].includes(name)) {
      throw inputError(name, "input-forbidden-in-argv");
    }
    if (!OPTION_NAMES.has(name) || index + 1 >= argv.length || argv[index + 1].startsWith("--"))
      throw inputError(name, "input-invalid");
    const value = argv[++index];
    if (name === "governed-path") governed.push(value);
    else if (values.has(name)) throw inputError(name, "input-invalid");
    else values.set(name, value);
  }
  return { values, governed };
}

function envValue(env, name) {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function existingParent(file) {
  try {
    return statSync(path.dirname(file)).isDirectory();
  } catch {
    return false;
  }
}

function resolveValue(name, argvValue, env, envName, required = true) {
  const value = argvValue ?? envValue(env, envName);
  if (required && value === undefined) throw inputError(name, "input-missing");
  return value;
}

export function parseInputs(argv = [], env = process.env, cwd = process.cwd()) {
  const { values, governed } = readArgv(argv);
  const baseUrl = resolveValue("base-url", values.get("base-url"), env, "PROBE_BASE_URL");
  const environment = resolveValue("environment", values.get("environment"), env, "PROBE_ENVIRONMENT");
  const head = resolveValue("head", values.get("head"), env, "PROBE_HEAD");
  const worktree = resolveValue("worktree", values.get("worktree"), env, "PROBE_WORKTREE");
  const envPaths = envValue(env, "PROBE_GOVERNED_PATHS")?.split(",").filter(Boolean) ?? [];
  const governedPaths = governed.length ? governed : envPaths;
  if (baseUrl !== REQUIRED_ORIGIN) throw inputError("base-url", "base-url-not-governed");
  if (environment !== "staging") throw inputError("environment", "environment-not-staging");
  if (!HEAD.test(head)) throw inputError("head", "input-invalid");
  if (!isAbsolute(worktree)) throw inputError("worktree", "input-invalid");
  if (governedPaths.length < 1) throw inputError("governed-path", "input-missing");
  if (
    governedPaths.length > 32 ||
    new Set(governedPaths).size !== governedPaths.length ||
    !governedPaths.every(isRepoPath)
  )
    throw inputError("governed-path", "input-invalid");
  const out = resolveValue("out", values.get("out"), env, "PROBE_OUT_FILE");
  const logFile = resolveValue("log-file", values.get("log-file"), env, "PROBE_LOG_FILE");
  for (const [name, file, mustBeAbsent] of [
    ["out", out, true],
    ["log-file", logFile, false],
  ]) {
    if (!isAbsolute(file) || !existingParent(file))
      throw inputError(name, name === "out" ? "out-file-path-invalid" : "log-file-path-invalid");
    if (mustBeAbsent && existsSync(file)) throw inputError(name, "out-file-exists");
  }
  const number = (name, value, min, max) => {
    const parsed = Number(value);
    if (!/^[0-9]+$/.test(String(value)) || !boundedInt(parsed, min, max))
      throw inputError(name, name === "total-budget-ms" ? "probe-budget-exhausted" : "input-invalid");
    return parsed;
  };
  const deployMaxAgeSeconds = number(
    "deploy-max-age-seconds",
    resolveValue("deploy-max-age-seconds", values.get("deploy-max-age-seconds"), env, "DEPLOY_MAX_AGE_SECONDS"),
    1,
    604800,
  );
  const requestTimeoutMs = number(
    "request-timeout-ms",
    resolveValue("request-timeout-ms", values.get("request-timeout-ms"), env, "PROBE_REQUEST_TIMEOUT_MS"),
    1000,
    60000,
  );
  const totalBudgetMs = number(
    "total-budget-ms",
    resolveValue("total-budget-ms", values.get("total-budget-ms"), env, "PROBE_TOTAL_BUDGET_MS"),
    5000,
    600000,
  );
  const runnerPath = resolveValue("runner-path", values.get("runner-path"), env, "PROBE_RUNNER_PATH");
  if (runnerPath !== SELF_PATH || !isRepoPath(runnerPath)) throw inputError("runner-path", "input-invalid");
  const githubToken = envValue(env, "GITHUB_TOKEN");
  const email = envValue(env, "MARKETPLACE_E2E_EMAIL");
  const password = envValue(env, "MARKETPLACE_E2E_PASSWORD");
  if (!githubToken || !email || !password) throw inputError("auth", "auth-source-missing");
  return Object.freeze({
    baseUrl,
    environment,
    head,
    worktree,
    cwd,
    governedPaths: Object.freeze(governedPaths),
    out,
    logFile,
    deployMaxAgeSeconds,
    requestTimeoutMs,
    totalBudgetMs,
    runnerPath,
    githubToken,
    email,
    password,
  });
}

function duplicateKeys(text) {
  const scopes = [];
  let previous = null;
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g)) {
    if (token === "{") scopes.push(new Set());
    else if (token === "[") scopes.push(null);
    else if (token === "}" || token === "]") scopes.pop();
    else if (token === ":" && scopes.at(-1) instanceof Set && typeof previous === "string") {
      const key = JSON.parse(previous);
      if (scopes.at(-1).has(key)) return true;
      scopes.at(-1).add(key);
    }
    previous = token;
  }
  return false;
}

function parseJson(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return duplicateKeys(text) ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function failureDetail(input = null, result = null, degraded = []) {
  return {
    input,
    path: typeof result?.path === "string" ? result.path.slice(0, 260) : null,
    httpStatus: Number.isInteger(result?.httpStatus) ? result.httpStatus : null,
    degradedCheckNames: [...new Set(degraded)].sort().slice(0, 200),
  };
}

function resultFor(outcome, stop, startedAt, finishedAt, detail) {
  return Object.freeze({
    version: STAGING_EVIDENCE_AUTHORITY_VERSION,
    result: outcome,
    ready: false,
    stop,
    startedAt,
    finishedAt,
    detail: failureDetail(detail?.input ?? null, detail, detail?.degradedCheckNames),
  });
}

function markerFound(text, secrets) {
  const source = String(text ?? "");
  return secrets.some((secret) => secret && source.includes(secret)) || AUTH_MARKERS.test(source);
}

function validBoundedInstant(value, startedAt, finishedAt) {
  return isInstant(value) && Date.parse(value) >= Date.parse(startedAt) && Date.parse(value) <= Date.parse(finishedAt);
}

function validateAuthorityOk(value, input) {
  if (
    !exact(value, [
      "version",
      "result",
      "ready",
      "stop",
      "startedAt",
      "finishedAt",
      "environment",
      "executedBytes",
      "deployment",
      "deployGeneration",
      "compatibility",
      "readiness",
      "providerMode",
    ])
  )
    return false;
  if (
    value.version !== STAGING_EVIDENCE_AUTHORITY_VERSION ||
    value.result !== "ok" ||
    value.ready !== true ||
    value.stop !== null ||
    value.environment !== "staging"
  )
    return false;
  if (
    !isInstant(value.startedAt) ||
    !isInstant(value.finishedAt) ||
    Date.parse(value.finishedAt) < Date.parse(value.startedAt) ||
    Date.parse(value.finishedAt) - Date.parse(value.startedAt) > 600_000
  )
    return false;
  if (
    validateExecutedBytes(value.executedBytes, {
      governedPaths: input.governedPaths,
      runnerPath: input.runnerPath,
      selfPath: SELF_PATH,
    }).length > 0
  )
    return false;
  try {
    readStagingDeployGeneration(
      JSON.stringify({ deployment: value.deployment, deployGeneration: value.deployGeneration }),
    );
  } catch {
    return false;
  }
  if (
    !exact(value.compatibility, ["deployablePathsChanged", "deployedHead", "intendedHead", "relation"]) ||
    !boundedInt(value.compatibility.deployablePathsChanged, 0, 32) ||
    !HEAD.test(value.compatibility.deployedHead) ||
    !HEAD.test(value.compatibility.intendedHead) ||
    !["identical", "deployed-is-ancestor", "deployed-is-descendant"].includes(value.compatibility.relation)
  )
    return false;
  if (
    !exact(value.readiness, ["web", "backend"]) ||
    !exact(value.readiness.web, ["url", "httpStatus", "ok", "service"]) ||
    !exact(value.readiness.backend, ["url", "httpStatus", "aggregateStatus", "checkCount", "degradedCheckNames"])
  )
    return false;
  const { web, backend } = value.readiness;
  if (
    web.url !== `${REQUIRED_ORIGIN}/health/ready` ||
    web.httpStatus !== 200 ||
    web.ok !== true ||
    web.service !== "marketplace"
  )
    return false;
  if (
    backend.url !== `${REQUIRED_ORIGIN}/api/health/ready` ||
    backend.httpStatus !== 200 ||
    backend.aggregateStatus !== "ok" ||
    !boundedInt(backend.checkCount, 1, 100) ||
    !Array.isArray(backend.degradedCheckNames) ||
    backend.degradedCheckNames.length !== 0
  )
    return false;
  if (
    !exact(value.providerMode, [
      "url",
      "httpStatus",
      "mode",
      "paymentProcessorKind",
      "moneyMovementKind",
      "deploymentEnvironment",
      "observedAt",
    ]) ||
    value.providerMode.url !== `${REQUIRED_ORIGIN}/api/marketplace/payment-provider-mode` ||
    value.providerMode.httpStatus !== 200 ||
    value.providerMode.mode !== "test" ||
    value.providerMode.deploymentEnvironment !== "staging" ||
    !validBoundedInstant(value.providerMode.observedAt, value.startedAt, value.finishedAt)
  )
    return false;
  return true;
}

function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    if (existsSync(file)) throw new Error("out-file-exists");
    writeFileSync(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    if (existsSync(file)) throw new Error("out-file-exists");
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } finally {
    try {
      if (existsSync(temp)) {
        unlinkSync(temp);
      }
    } catch {}
  }
}

function writeLog(file, entry, secrets) {
  const line = `${JSON.stringify(entry)}\n`;
  if (markerFound(line, secrets)) return;
  appendFileSync(file, line, { encoding: "utf8", mode: 0o600, flag: "a" });
  chmodSync(file, 0o600);
}

export async function runStagingEvidenceAuthority(options = {}) {
  const clock = options.clock ?? (() => Date.now());
  const startedMs = clock();
  const startedAt = new Date(startedMs).toISOString();
  let input;
  try {
    input =
      options.input ??
      parseInputs(options.argv ?? process.argv.slice(2), options.env ?? process.env, options.cwd ?? process.cwd());
  } catch (error) {
    const finishedAt = new Date(clock()).toISOString();
    const detail = { input: OPTION_NAMES.has(error.input) ? error.input : null };
    const parseStop = typeof error?.stop === "string" ? error.stop : "unexpected-internal-error";
    const parseOutcome = typeof error?.stop === "string" ? "refused" : "failed";
    let value = resultFor(parseOutcome, parseStop, startedAt, finishedAt, detail);
    let parseSecrets = [];
    try {
      const source = options.env ?? process.env;
      parseSecrets = [source.GITHUB_TOKEN, source.MARKETPLACE_E2E_EMAIL, source.MARKETPLACE_E2E_PASSWORD].filter(
        (secret) => typeof secret === "string",
      );
    } catch {
      // A hostile environment getter is itself an internal failure; keep the
      // closed result and never expose the getter's exception text.
    }
    if (markerFound(JSON.stringify(value), parseSecrets))
      value = resultFor("failed", "redaction-scan-finding", startedAt, finishedAt, null);
    return { value, exitCode: value.result === "refused" ? 2 : 1, stdout: `${JSON.stringify(value)}\n`, input: null };
  }
  const log = (step, outcome, httpStatus = null) => {
    try {
      writeLog(input.logFile, { step, outcome, httpStatus, elapsedMs: Math.max(0, clock() - startedMs) }, secrets);
    } catch {
      // The receipt/stdout result is authoritative; an unavailable append-only audit path
      // cannot be allowed to expose an exception or change the closed result shape.
    }
  };
  const secrets = [input.githubToken, input.email, input.password];
  const withinBudget = () => clock() - startedMs <= input.totalBudgetMs;
  const budgetStop = (step) => stopResult("probe-budget-exhausted", "failed", { step });
  const stopResult = async (stopCode, outcome = "failed", detail = {}) => {
    const finishedAt = new Date(clock()).toISOString();
    log(detail.step ?? "authority", outcome, detail.httpStatus);
    let value = resultFor(outcome, stopCode, startedAt, finishedAt, detail);
    if (markerFound(JSON.stringify(value), secrets)) {
      value = resultFor("failed", "redaction-scan-finding", startedAt, finishedAt, null);
    }
    return { value, exitCode: value.result === "refused" ? 2 : 1, stdout: `${JSON.stringify(value)}\n` };
  };
  try {
    if (!withinBudget()) return await stopResult("probe-budget-exhausted", "refused", { step: "authority" });
    const common = {
      token: input.githubToken,
      requestTimeoutMs: input.requestTimeoutMs,
      now: startedAt,
      maxAgeSeconds: input.deployMaxAgeSeconds,
    };
    log("executed-bytes", "started");
    const executed = await (options.readExecutedBytes ?? readExecutedBytes)(
      {
        cwd: input.cwd,
        governedPaths: input.governedPaths,
        head: input.head,
        runnerPath: input.runnerPath,
        selfPath: SELF_PATH,
        worktree: input.worktree,
      },
      options.gitRunner ?? runGit,
    );
    if (executed?.outcome !== "ok")
      return await stopResult(
        executed?.stop ?? "unexpected-internal-error",
        executed?.outcome === "refused" ? "refused" : "failed",
        { ...executed, step: "executed-bytes" },
      );
    if (!withinBudget()) return await budgetStop("executed-bytes");
    log("provider-mode", "started");
    const transport = options.transport;
    const mode = await (options.observeProviderMode ?? observeProviderMode)({
      timeoutMs: input.requestTimeoutMs,
      transport,
    });
    if (mode?.stop) return await stopResult(mode.stop, "failed", { ...mode, step: "provider-mode" });
    if (!withinBudget()) return await budgetStop("provider-mode");
    log("deploy-generation", "started");
    const generation = await (options.selectGeneration ?? selectStagingDeployGeneration)({ ...common, transport });
    if (generation?.stop)
      return await stopResult(generation.stop, "failed", { ...generation, step: "deploy-generation" });
    if (!withinBudget()) return await budgetStop("deploy-generation");
    log("runtime-compatibility", "started");
    const compatibility = await (options.classifyRuntime ?? classifyDeployedRuntime)(
      { worktree: input.worktree, intendedHead: input.head, deployedHead: generation.deployGeneration.deployedHead },
      options.gitRunner ?? runGit,
    );
    if (compatibility?.outcome !== "ok")
      return await stopResult(compatibility?.stop ?? "unexpected-internal-error", "failed", {
        ...compatibility,
        step: "runtime-compatibility",
      });
    if (!withinBudget()) return await budgetStop("runtime-compatibility");
    log("web-readiness", "started");
    const web = await (options.observeWebReadiness ?? observeWebReadiness)({
      timeoutMs: input.requestTimeoutMs,
      transport,
    });
    if (web?.stop) return await stopResult(web.stop, "failed", { ...web, step: "web-readiness" });
    if (!withinBudget()) return await budgetStop("web-readiness");
    log("backend-readiness", "started");
    const backend = await (options.observeBackendReadiness ?? observeBackendReadiness)({
      timeoutMs: input.requestTimeoutMs,
      transport,
    });
    if (backend?.stop) return await stopResult(backend.stop, "failed", { ...backend, step: "backend-readiness" });
    if (!withinBudget()) return await budgetStop("backend-readiness");
    log("password-sign-in", "started");
    const auth = await (options.requestProductHost ?? requestProductHost)({
      method: "POST",
      path: "/api/auth/password-sign-in",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: input.email, password: input.password }),
      timeoutMs: input.requestTimeoutMs,
      transport,
    });
    if (auth.failure)
      return await stopResult("auth-failed", "failed", {
        ...auth,
        step: "password-sign-in",
      });
    const authBody = parseJson(auth.body);
    if (auth.httpStatus !== 200)
      return await stopResult("auth-failed", "failed", { httpStatus: auth.httpStatus, step: "password-sign-in" });
    if (!isRecord(authBody) || typeof authBody.sessionToken !== "string" || authBody.sessionToken.length === 0)
      return await stopResult("auth-session-token-absent", "failed", { httpStatus: 200, step: "password-sign-in" });
    if (!withinBudget()) return await budgetStop("password-sign-in");
    const finishedAt = new Date(clock()).toISOString();
    const value = {
      version: STAGING_EVIDENCE_AUTHORITY_VERSION,
      result: "ok",
      ready: true,
      stop: null,
      startedAt,
      finishedAt,
      environment: "staging",
      executedBytes: executed.executedBytes,
      deployment: generation.deployment,
      deployGeneration: generation.deployGeneration,
      compatibility: compatibility.compatibility,
      readiness: { web, backend },
      providerMode: mode,
    };
    const serialized = JSON.stringify(value);
    if (!validateAuthorityOk(value, input))
      return await stopResult("closed-schema-shallow-validation", "failed", { step: "result" });
    if (
      markerFound(serialized, secrets) ||
      !isInstant(startedAt) ||
      !isInstant(finishedAt) ||
      Date.parse(finishedAt) < Date.parse(startedAt)
    )
      return await stopResult("redaction-scan-finding", "failed", { step: "result" });
    try {
      writeAtomic(input.out, serialized);
    } catch {
      return await stopResult("receipt-write-failed", "failed", { step: "receipt" });
    }
    log("authority", "ok", null);
    return { value: Object.freeze(value), exitCode: 0, stdout: `${serialized}\n`, input };
  } catch {
    return await stopResult("unexpected-internal-error", "failed", { step: "authority" });
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const run = await runStagingEvidenceAuthority({ argv, env });
  if (run.stdout) process.stdout.write(`${run.stdout.endsWith("\n") ? run.stdout : `${run.stdout}\n`}`);
  process.exitCode = run.exitCode;
  return run;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
