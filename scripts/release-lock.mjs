#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const RELEASE_LOCK_CHECK_VERSION = "release-lock-check/v2";
export const RELEASE_LOCK_ARTIFACT_VERSION = "production-release-lock/v2";
export const LOCK_EXIT_ROUTE_MAX_BYTES = 2048;
export const LOCK_EXIT_ROUTE_REFERENCE_PATTERN = /^https:\/\/github\.com\/chase-sets\/chase-sets\/issues\/[1-9][0-9]*$/;
const RFC3339_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseReleaseLockOptions(argv, env = process.env) {
  return {
    environmentName: readOption(argv, "--environment") ?? readEnv("RELEASE_ENVIRONMENT", env) ?? "production",
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env) ?? "",
    releaseLocked: normalizeBooleanString(
      readOption(argv, "--locked") ?? readEnv("PRODUCTION_RELEASE_LOCKED", env) ?? "false",
      "PRODUCTION_RELEASE_LOCKED",
    ),
    lockReason: readOption(argv, "--lock-reason") ?? readEnv("PRODUCTION_RELEASE_LOCK_REASON", env) ?? "",
    lockReference: readOption(argv, "--lock-reference") ?? readEnv("PRODUCTION_RELEASE_LOCK_REFERENCE", env) ?? "",
    lockExitRoute: readOption(argv, "--exit-route") ?? env.PRODUCTION_RELEASE_LOCK_EXIT_ROUTE ?? "",
    lockDeadline: readOption(argv, "--deadline") ?? readEnv("PRODUCTION_RELEASE_LOCK_DEADLINE", env) ?? "",
    emergencyBypass: normalizeBooleanString(
      readOption(argv, "--emergency-bypass") ?? readEnv("EMERGENCY_RELEASE_BYPASS", env) ?? "false",
      "EMERGENCY_RELEASE_BYPASS",
    ),
    emergencyReference: readOption(argv, "--emergency-reference") ?? readEnv("EMERGENCY_RELEASE_REFERENCE", env) ?? "",
    githubRepository: readOption(argv, "--github-repository") ?? readEnv("GITHUB_REPOSITORY", env) ?? "",
    githubToken: readOption(argv, "--github-token") ?? readEnv("GITHUB_TOKEN", env) ?? readEnv("GH_TOKEN", env) ?? "",
    githubApiUrl: readOption(argv, "--github-api-url") ?? readEnv("GITHUB_API_URL", env) ?? "https://api.github.com",
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env) ?? "",
    outPath: readOption(argv, "--out") ?? "",
  };
}

export function evaluateReleaseLock(options) {
  const errors = [];
  const locked = options.releaseLocked === "true";
  const emergencyBypass = options.emergencyBypass === "true";
  const routeValidation = locked ? validateLockExitRoute(options.lockExitRoute) : { value: null, errors: [] };
  const deadlineValidation = locked ? validateLockDeadline(options.lockDeadline) : { value: null, errors: [] };

  if (locked && !isNonEmptyString(options.lockReason)) {
    errors.push("PRODUCTION_RELEASE_LOCK_REASON is required when PRODUCTION_RELEASE_LOCKED=true.");
  }
  errors.push(...routeValidation.errors);
  errors.push(...deadlineValidation.errors);
  const invalidLock = locked && errors.length > 0;

  const deadlineOverdue = Boolean(
    deadlineValidation.value &&
    Date.parse(deadlineValidation.value) <= Date.parse(options.checkedAt ?? new Date().toISOString()),
  );
  if (locked && deadlineOverdue && errors.length === 0 && !emergencyBypass) {
    errors.push(
      `Production release lock deadline ${deadlineValidation.value} has passed; host escalation via ${formatExitRoute(routeValidation.value)} is required before unlock.`,
    );
  }

  if (emergencyBypass && !isNonEmptyString(options.emergencyReference)) {
    errors.push("EMERGENCY_RELEASE_REFERENCE is required when EMERGENCY_RELEASE_BYPASS=true.");
  }

  const emergencyReference = normalizeEmergencyReference(options.emergencyReference);
  if (emergencyBypass && isNonEmptyString(options.emergencyReference) && !emergencyReference) {
    errors.push(
      "EMERGENCY_RELEASE_REFERENCE must be an incident reference or a GitHub issue/PR reference when EMERGENCY_RELEASE_BYPASS=true.",
    );
  }

  const deploymentAllowed = errors.length === 0 && (!locked || emergencyBypass);
  const releaseMode = emergencyBypass ? "emergency" : "normal";

  return {
    schemaVersion: RELEASE_LOCK_CHECK_VERSION,
    environmentName: options.environmentName,
    releaseCommit: options.releaseCommit,
    releaseLocked: locked,
    locked,
    lockState: !locked ? "unlocked" : invalidLock ? "invalid" : deadlineOverdue ? "overdue" : "pending",
    deploymentAllowed,
    releaseMode,
    lockExitRoute: routeValidation.value,
    lockDeadline: deadlineValidation.value,
    lockDeadlineOverdue: deadlineOverdue,
    lockReason: locked && isNonEmptyString(options.lockReason) ? options.lockReason.trim() : null,
    lockReference: locked && isNonEmptyString(options.lockReference) ? options.lockReference.trim() : null,
    ...(isNonEmptyString(options.emergencyReference) ? { emergencyReference: options.emergencyReference.trim() } : {}),
    ...(emergencyReference
      ? { validatedEmergencyReference: emergencyReference.reference, emergencyReferenceKind: emergencyReference.kind }
      : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export function validateLockExitRoute(value) {
  if (!isNonEmptyString(value)) {
    return {
      value: null,
      errors: ["PRODUCTION_RELEASE_LOCK_EXIT_ROUTE is required when PRODUCTION_RELEASE_LOCKED=true."],
    };
  }
  const raw = value.trim();
  if (Buffer.byteLength(value, "utf8") > LOCK_EXIT_ROUTE_MAX_BYTES) {
    return {
      value: null,
      errors: [`PRODUCTION_RELEASE_LOCK_EXIT_ROUTE must be at most ${LOCK_EXIT_ROUTE_MAX_BYTES} bytes.`],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: null, errors: ["PRODUCTION_RELEASE_LOCK_EXIT_ROUTE must be a JSON object."] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: null, errors: ["PRODUCTION_RELEASE_LOCK_EXIT_ROUTE must be a JSON object."] };
  }
  const keys = Object.keys(parsed);
  const allowed = parsed.kind === "staging-workflow" ? ["kind", "reference", "workflow"] : ["kind", "reference"];
  if (keys.some((key) => !allowed.includes(key)) || keys.length !== allowed.length) {
    return { value: null, errors: ["PRODUCTION_RELEASE_LOCK_EXIT_ROUTE contains unknown or missing keys."] };
  }
  if (!["staging-workflow", "host-revert"].includes(parsed.kind)) {
    return {
      value: null,
      errors: ["PRODUCTION_RELEASE_LOCK_EXIT_ROUTE.kind must be staging-workflow or host-revert."],
    };
  }
  if (parsed.kind === "staging-workflow" && parsed.workflow !== "platform-staging-cluster-addons.yml") {
    return {
      value: null,
      errors: ["PRODUCTION_RELEASE_LOCK_EXIT_ROUTE.workflow must be platform-staging-cluster-addons.yml."],
    };
  }
  if (typeof parsed.reference !== "string" || !LOCK_EXIT_ROUTE_REFERENCE_PATTERN.test(parsed.reference)) {
    return { value: null, errors: ["PRODUCTION_RELEASE_LOCK_EXIT_ROUTE.reference must be a Chase Sets issue URL."] };
  }
  return { value: parsed, errors: [] };
}

export function validateLockDeadline(value) {
  if (!isNonEmptyString(value)) {
    return {
      value: null,
      errors: ["PRODUCTION_RELEASE_LOCK_DEADLINE is required when PRODUCTION_RELEASE_LOCKED=true."],
    };
  }
  const trimmed = value.trim();
  const [year, month, day, hour, minute, second] = trimmed.slice(0, 19).split(/[-T:]/).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    !RFC3339_INSTANT_PATTERN.test(trimmed) ||
    Number.isNaN(Date.parse(trimmed)) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return { value: null, errors: ["PRODUCTION_RELEASE_LOCK_DEADLINE must be an RFC3339 timestamp with timezone."] };
  }
  return { value: trimmed, errors: [] };
}

export function validateLockCreationDeadline(value, { now = new Date() } = {}) {
  const result = validateLockDeadline(value);
  if (result.errors.length > 0) return result;
  const deadline = Date.parse(result.value);
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs) || deadline <= nowMs) {
    return { value: null, errors: ["PRODUCTION_RELEASE_LOCK_DEADLINE must be in the future when creating a lock."] };
  }
  if (deadline > nowMs + 7 * 24 * 60 * 60 * 1000) {
    return {
      value: null,
      errors: ["PRODUCTION_RELEASE_LOCK_DEADLINE must be no more than 7 days ahead when creating a lock."],
    };
  }
  return result;
}

function formatExitRoute(route) {
  return route?.kind === "staging-workflow" ? `staging workflow ${route.workflow}` : "host revert";
}

export async function runReleaseLockCheck(options) {
  const result = await evaluateReleaseLockWithResolution(options);
  if (isNonEmptyString(options.outPath)) await writeJsonRecord(options.outPath, result);
  if (isNonEmptyString(options.githubOutputPath)) {
    await appendGitHubOutputs(options.githubOutputPath, {
      deployment_allowed: String(result.deploymentAllowed),
      release_mode: result.releaseMode,
      release_locked: String(result.releaseLocked),
      emergency_reference: result.validatedEmergencyReference ?? "",
      emergency_reference_kind: result.emergencyReferenceKind ?? "",
    });
  }
  return result;
}

export async function evaluateReleaseLockWithResolution(options, dependencies = {}) {
  const result = evaluateReleaseLock(options);
  if (result.errors?.length || options.emergencyBypass !== "true" || !result.validatedEmergencyReference) {
    return result;
  }

  if (result.emergencyReferenceKind !== "github") {
    return result;
  }

  const resolution = await resolveGitHubIssueOrPullRequestReference(
    result.validatedEmergencyReference,
    options,
    dependencies,
  );
  if (resolution.ok) {
    return {
      ...result,
      validatedEmergencyReference: resolution.reference,
      emergencyReferenceUrl: resolution.url,
    };
  }

  return {
    ...result,
    deploymentAllowed: false,
    errors: [resolution.error],
  };
}

export function normalizeEmergencyReference(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }

  const trimmed = value.trim();
  if (/^INC-(?:\d+|\d{4}-\d{2}-\d{2}-\d{3,})$/i.test(trimmed)) {
    return { kind: "incident", reference: trimmed.toUpperCase() };
  }

  const qualifiedGitHubMatch =
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/i.exec(trimmed) ??
    /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/.exec(trimmed);
  if (qualifiedGitHubMatch) {
    return {
      kind: "github",
      owner: qualifiedGitHubMatch[1],
      repo: qualifiedGitHubMatch[2],
      number: Number(qualifiedGitHubMatch[3]),
      reference: `${qualifiedGitHubMatch[1]}/${qualifiedGitHubMatch[2]}#${qualifiedGitHubMatch[3]}`,
    };
  }

  const numberMatch = /^(?:#|GH-|ISSUE-|PR-|PULL-)(\d+)$/i.exec(trimmed);
  if (numberMatch) {
    return {
      kind: "github",
      number: Number(numberMatch[1]),
      reference: `#${numberMatch[1]}`,
    };
  }

  return null;
}

async function resolveGitHubIssueOrPullRequestReference(reference, options, dependencies) {
  const parsed = normalizeEmergencyReference(reference);
  const repository = parsed?.owner && parsed?.repo ? `${parsed.owner}/${parsed.repo}` : options.githubRepository;
  const token = options.githubToken;

  if (!parsed || parsed.kind !== "github" || !Number.isInteger(parsed.number)) {
    return { ok: false, error: "EMERGENCY_RELEASE_REFERENCE could not be parsed as a GitHub issue or PR reference." };
  }
  if (!isNonEmptyString(repository)) {
    return { ok: false, error: "GITHUB_REPOSITORY is required to validate GitHub emergency references." };
  }
  if (!isNonEmptyString(token)) {
    return { ok: false, error: "GITHUB_TOKEN is required to validate GitHub emergency references." };
  }

  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { ok: false, error: "fetch is unavailable for GitHub emergency reference validation." };
  }

  const apiUrl = String(options.githubApiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const response = await fetchImpl(`${apiUrl}/repos/${repository}/issues/${parsed.number}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });

  if (response.status === 404) {
    return { ok: false, error: `EMERGENCY_RELEASE_REFERENCE ${reference} did not resolve to an existing issue or PR.` };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: `GitHub emergency reference validation failed with status ${response.status}.`,
    };
  }

  const payload = await response.json();
  return {
    ok: true,
    reference: `${repository}#${parsed.number}`,
    url:
      typeof payload.html_url === "string"
        ? payload.html_url
        : `https://github.com/${repository}/issues/${parsed.number}`,
  };
}

async function main(argv, env = process.env) {
  let options;
  try {
    options = parseReleaseLockOptions(argv, env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const result = await runReleaseLockCheck(options);
  console.log(JSON.stringify(result, null, 2));

  if (result.errors?.length) {
    for (const error of result.errors) {
      console.error(error);
    }
    if (result.releaseLocked) console.error(releaseLockRefusal(result));
    return 1;
  }

  if (!result.deploymentAllowed) {
    console.error(releaseLockRefusal(result));
    return 1;
  }

  return 0;
}

export function releaseLockRefusal(result) {
  return [
    `Production release is locked (${result.lockState}).`,
    `Reason: ${result.lockReason ?? "missing"}`,
    `Reference: ${result.lockReference ?? "not supplied"}`,
    `Exit route: ${result.lockExitRoute ? JSON.stringify(result.lockExitRoute) : "invalid or missing"}`,
    `Deadline: ${result.lockDeadline ?? "invalid or missing"}`,
    "Host/orchestrator must triage the Production release lock incident (notify-production-deploy-incident); only the host may clear the lock. No bypass is authorized by this refusal.",
  ].join("\n");
}

async function appendGitHubOutputs(path, outputs) {
  const lines = Object.entries(outputs).map(([name, value]) => `${name}=${value}`);
  await appendFile(path, `${lines.join("\n")}\n`);
}

function normalizeBooleanString(value, name) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true" || normalized === "false") {
    return normalized;
  }
  throw new Error(`${name} must be the string true or false.`);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
