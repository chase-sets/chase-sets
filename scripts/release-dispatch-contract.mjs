#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readEnv, readOption } from "./lib/cli-options.mjs";

export const RELEASE_DISPATCH_SOURCES = Object.freeze(["automatic", "manual", "recovery", "emergency"]);

export function parseReleaseDispatchContractArgs(argv, env = process.env) {
  return {
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    source: readOption(argv, "--source") ?? readEnv("DISPATCH_SOURCE", env),
    dispatchRunId: readOption(argv, "--dispatch-run-id") ?? readEnv("DISPATCH_RUN_ID", env),
    dispatchAttempt: readOption(argv, "--dispatch-attempt") ?? readEnv("DISPATCH_ATTEMPT", env),
    reason: readOption(argv, "--reason") ?? readEnv("DISPATCH_REASON", env),
    emergencyRelease: readOption(argv, "--emergency-release") ?? readEnv("EMERGENCY_RELEASE", env) ?? "false",
    emergencyReference: readOption(argv, "--emergency-reference") ?? readEnv("EMERGENCY_REFERENCE", env),
  };
}

export function validateReleaseDispatchContract(input) {
  const errors = [];
  const source = String(input.source ?? "").trim();
  const reason = String(input.reason ?? "").trim();
  const runId = String(input.dispatchRunId ?? "").trim();
  const attempt = String(input.dispatchAttempt ?? "").trim();
  const emergencyRelease = String(input.emergencyRelease ?? "false").trim() === "true";
  const emergencyReference = String(input.emergencyReference ?? "").trim();

  if (!isCommitSha(input.releaseCommit)) {
    errors.push("release_commit must resolve to a 40-character Git commit SHA.");
  }
  if (!RELEASE_DISPATCH_SOURCES.includes(source)) {
    errors.push(`dispatch_source must be one of: ${RELEASE_DISPATCH_SOURCES.join(", ")}.`);
  }

  if (source === "automatic") {
    if (!isPositiveInteger(runId))
      errors.push("dispatch_run_id is required and must be a positive integer for automatic releases.");
    if (!isPositiveInteger(attempt)) {
      errors.push("dispatch_attempt is required and must be a positive integer for automatic releases.");
    }
  } else {
    if (!reason) errors.push("reason is required for manual, recovery, and emergency releases.");
    if (runId || attempt) errors.push("dispatch_run_id and dispatch_attempt are only valid for automatic releases.");
  }

  if (source === "emergency") {
    if (!emergencyRelease) errors.push("emergency_release must be true when dispatch_source is emergency.");
    if (!emergencyReference) errors.push("emergency_reference is required for emergency releases.");
  } else if (emergencyRelease) {
    errors.push("emergency_release may only be true when dispatch_source is emergency.");
  }

  return {
    errors,
    contract: {
      releaseCommit: String(input.releaseCommit ?? "").trim(),
      source,
      dispatchRunId: runId || null,
      dispatchAttempt: attempt || null,
      reason: reason || null,
    },
  };
}

function isPositiveInteger(value) {
  return /^[1-9]\d*$/.test(value);
}

async function main() {
  const result = validateReleaseDispatchContract(parseReleaseDispatchContractArgs(process.argv.slice(2)));
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Validated ${result.contract.source} release dispatch for ${result.contract.releaseCommit}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
