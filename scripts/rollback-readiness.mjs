#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const ROLLBACK_READINESS_VERSION = "rollback-readiness/v1";
export const DEFAULT_KUBERNETES_ROLLBACK_RELEASE = "chase-sets-platform";
export const DEFAULT_KUBERNETES_ROLLBACK_NAMESPACE = "chase-sets-platform";
export const DEFAULT_KUBERNETES_ROLLBACK_TIMEOUT = "15m";

export function parseRollbackReadinessArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("ROLLBACK_READINESS_OUT", env),
    mode: readOption(argv, "--mode") ?? readEnv("RECOVERY_MODE", env) ?? "readiness",
    targetCommit: readOption(argv, "--target-commit") ?? readEnv("ROLLBACK_TARGET_COMMIT", env),
    lastKnownGoodCommit: readOption(argv, "--last-known-good-commit") ?? readEnv("LAST_KNOWN_GOOD_COMMIT", env),
    releaseTag: readOption(argv, "--release-tag") ?? readEnv("ROLLBACK_RELEASE_TAG", env),
    imageRef: readOption(argv, "--image-ref") ?? readEnv("ROLLBACK_IMAGE_REF", env),
    imageExists: parseEvidenceState(readOption(argv, "--image-exists") ?? readEnv("ROLLBACK_IMAGE_EXISTS", env)),
    smokeVerified: parseEvidenceState(readOption(argv, "--smoke-verified") ?? readEnv("ROLLBACK_SMOKE_VERIFIED", env)),
    terraformPlanPath: readOption(argv, "--terraform-plan-json") ?? readEnv("ROLLBACK_TERRAFORM_PLAN_JSON", env),
    destructivePlanApproved: parseBoolean(
      readOption(argv, "--destructive-plan-approved") ?? readEnv("ROLLBACK_DESTRUCTIVE_PLAN_APPROVED", env) ?? "false",
      "ROLLBACK_DESTRUCTIVE_PLAN_APPROVED",
    ),
    emergencyReference: readOption(argv, "--emergency-reference") ?? readEnv("EMERGENCY_RELEASE_REFERENCE", env),
    kubernetesRelease:
      readOption(argv, "--kubernetes-release") ??
      readEnv("CHASE_SETS_HELM_RELEASE", env) ??
      DEFAULT_KUBERNETES_ROLLBACK_RELEASE,
    kubernetesNamespace:
      readOption(argv, "--kubernetes-namespace") ??
      readEnv("CHASE_SETS_KUBERNETES_NAMESPACE", env) ??
      DEFAULT_KUBERNETES_ROLLBACK_NAMESPACE,
    kubernetesTimeout:
      readOption(argv, "--kubernetes-timeout") ??
      readEnv("CHASE_SETS_KUBERNETES_ROLLOUT_TIMEOUT", env) ??
      DEFAULT_KUBERNETES_ROLLBACK_TIMEOUT,
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function runRollbackReadiness(options) {
  const terraformPlan = options.terraformPlanPath
    ? JSON.parse(await readFile(options.terraformPlanPath, "utf8"))
    : { destructiveChanges: false, source: "not-provided" };
  const result = evaluateRollbackReadiness({ ...options, terraformPlan });

  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }

  return result;
}

export function evaluateRollbackReadiness(input) {
  const blockers = [];
  const warnings = [];
  const mode = input.mode ?? "readiness";
  const destructiveChanges = Boolean(input.terraformPlan?.destructiveChanges);

  if (!["readiness", "rollback", "fix-forward"].includes(mode)) {
    blockers.push("Recovery mode must be readiness, rollback, or fix-forward.");
  }
  if (!isCommitSha(input.targetCommit)) {
    blockers.push("Rollback target commit must be a 40-character Git commit SHA.");
  }
  if (isNonEmptyString(input.lastKnownGoodCommit) && input.lastKnownGoodCommit !== input.targetCommit) {
    warnings.push("Target commit differs from the last known-good production commit.");
  }
  if (!isNonEmptyString(input.releaseTag)) {
    blockers.push("Rollback target release tag is required.");
  }
  if (!isNonEmptyString(input.imageRef)) {
    blockers.push("Rollback target image reference is required.");
  }
  if (input.imageExists !== "true") {
    blockers.push("Rollback target image must exist in the production container registry.");
  }
  if (input.smokeVerified !== "true") {
    blockers.push("Rollback target must have a smoke-verified production marker or release record.");
  }
  if (!isNonEmptyString(input.emergencyReference)) {
    blockers.push("Emergency reference is required before rollback or fix-forward recovery.");
  }
  if (!isNonEmptyString(input.kubernetesRelease ?? DEFAULT_KUBERNETES_ROLLBACK_RELEASE)) {
    blockers.push("DOKS rollback release is required.");
  }
  if (!isNonEmptyString(input.kubernetesNamespace ?? DEFAULT_KUBERNETES_ROLLBACK_NAMESPACE)) {
    blockers.push("DOKS rollback namespace is required.");
  }
  if (!isNonEmptyString(input.kubernetesTimeout ?? DEFAULT_KUBERNETES_ROLLBACK_TIMEOUT)) {
    blockers.push("DOKS rollback timeout is required.");
  }
  if (destructiveChanges && !input.destructivePlanApproved) {
    blockers.push("Terraform plan contains destructive changes and requires explicit approval.");
  }

  const record = {
    schemaVersion: ROLLBACK_READINESS_VERSION,
    checkedAt: input.checkedAt,
    mode,
    targetCommit: input.targetCommit ?? "",
    lastKnownGoodCommit: emptyToNull(input.lastKnownGoodCommit),
    releaseTag: emptyToNull(input.releaseTag),
    imageRef: emptyToNull(input.imageRef),
    imageExists: input.imageExists,
    smokeVerified: input.smokeVerified,
    emergencyReference: emptyToNull(input.emergencyReference),
    kubernetesRollbackTarget: buildKubernetesRollbackTarget(input),
    terraformPlan: {
      source: input.terraformPlan?.source ?? "inline",
      destructiveChanges,
      destructivePlanApproved: input.destructivePlanApproved,
    },
    result: blockers.length === 0 ? "success" : "failure",
    blockers,
    warnings,
  };

  return {
    record,
    passesRollbackReadinessGate: blockers.length === 0,
  };
}

function buildKubernetesRollbackTarget(input) {
  const release = input.kubernetesRelease ?? DEFAULT_KUBERNETES_ROLLBACK_RELEASE;
  const namespace = input.kubernetesNamespace ?? DEFAULT_KUBERNETES_ROLLBACK_NAMESPACE;
  const timeout = input.kubernetesTimeout ?? DEFAULT_KUBERNETES_ROLLBACK_TIMEOUT;
  return {
    platform: "doks",
    release,
    namespace,
    timeout,
    command: [
      "pnpm",
      "run",
      "platform:kubernetes-deployment",
      "--",
      "rollback",
      "--release",
      release,
      "--namespace",
      namespace,
      "--timeout",
      timeout,
    ],
  };
}

function parseEvidenceState(value) {
  const normalized = String(value ?? "unknown")
    .trim()
    .toLowerCase();
  return ["true", "false", "unknown"].includes(normalized) ? normalized : "unknown";
}

function parseBoolean(value, name) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function emptyToNull(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function main(argv, env = process.env) {
  try {
    const result = await runRollbackReadiness(parseRollbackReadinessArgs(argv, env));
    console.log(JSON.stringify(result.record, null, 2));
    return result.passesRollbackReadinessGate ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
