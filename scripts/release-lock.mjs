#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";

export const RELEASE_LOCK_CHECK_VERSION = "release-lock-check/v1";

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
    emergencyBypass: normalizeBooleanString(
      readOption(argv, "--emergency-bypass") ?? readEnv("EMERGENCY_RELEASE_BYPASS", env) ?? "false",
      "EMERGENCY_RELEASE_BYPASS",
    ),
    emergencyReference: readOption(argv, "--emergency-reference") ?? readEnv("EMERGENCY_RELEASE_REFERENCE", env) ?? "",
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env) ?? "",
  };
}

export function evaluateReleaseLock(options) {
  const errors = [];
  const locked = options.releaseLocked === "true";
  const emergencyBypass = options.emergencyBypass === "true";

  if (locked && !isNonEmptyString(options.lockReason)) {
    errors.push("PRODUCTION_RELEASE_LOCK_REASON is required when PRODUCTION_RELEASE_LOCKED=true.");
  }

  if (emergencyBypass && !isNonEmptyString(options.emergencyReference)) {
    errors.push("EMERGENCY_RELEASE_REFERENCE is required when EMERGENCY_RELEASE_BYPASS=true.");
  }

  const deploymentAllowed = errors.length === 0 && (!locked || emergencyBypass);
  const releaseMode = emergencyBypass ? "emergency" : "normal";

  return {
    schemaVersion: RELEASE_LOCK_CHECK_VERSION,
    environmentName: options.environmentName,
    releaseCommit: options.releaseCommit,
    releaseLocked: locked,
    deploymentAllowed,
    releaseMode,
    ...(isNonEmptyString(options.lockReason) ? { lockReason: options.lockReason.trim() } : {}),
    ...(isNonEmptyString(options.lockReference) ? { lockReference: options.lockReference.trim() } : {}),
    ...(isNonEmptyString(options.emergencyReference) ? { emergencyReference: options.emergencyReference.trim() } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function runReleaseLockCheck(options) {
  const result = evaluateReleaseLock(options);
  if (isNonEmptyString(options.githubOutputPath)) {
    await appendGitHubOutputs(options.githubOutputPath, {
      deployment_allowed: String(result.deploymentAllowed),
      release_mode: result.releaseMode,
      release_locked: String(result.releaseLocked),
    });
  }
  return result;
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
    return 1;
  }

  if (!result.deploymentAllowed) {
    console.error(
      [
        "Production release is locked.",
        result.lockReason ? `Reason: ${result.lockReason}` : "",
        result.lockReference ? `Reference: ${result.lockReference}` : "",
        "Set EMERGENCY_RELEASE_BYPASS=true and provide EMERGENCY_RELEASE_REFERENCE only for an audited fix-forward or revert.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return 1;
  }

  return 0;
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
