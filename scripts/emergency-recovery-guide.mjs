#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const EMERGENCY_RECOVERY_GUIDE_VERSION = "emergency-recovery-guide/v1";
export const DEFAULT_EMERGENCY_KUBERNETES_RELEASE = "chase-sets-platform";
export const DEFAULT_EMERGENCY_KUBERNETES_NAMESPACE = "chase-sets-platform";
export const DEFAULT_EMERGENCY_KUBERNETES_TIMEOUT = "15m";

const modes = new Set(["rollback-readiness", "rollback", "revert", "fix-forward"]);

export function parseEmergencyRecoveryGuideArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("EMERGENCY_RECOVERY_GUIDE_OUT", env),
    mode: readOption(argv, "--mode") ?? readEnv("EMERGENCY_RECOVERY_MODE", env) ?? "rollback-readiness",
    emergencyReference: readOption(argv, "--emergency-reference") ?? readEnv("EMERGENCY_RELEASE_REFERENCE", env),
    targetCommit: readOption(argv, "--target-commit") ?? readEnv("RECOVERY_TARGET_COMMIT", env),
    recoveryPullRequest: readOption(argv, "--recovery-pr") ?? readEnv("RECOVERY_PULL_REQUEST", env),
    releaseTag: readOption(argv, "--release-tag") ?? readEnv("ROLLBACK_RELEASE_TAG", env),
    imageRef: readOption(argv, "--image-ref") ?? readEnv("ROLLBACK_IMAGE_REF", env),
    kubernetesRelease:
      readOption(argv, "--kubernetes-release") ??
      readEnv("CHASE_SETS_HELM_RELEASE", env) ??
      DEFAULT_EMERGENCY_KUBERNETES_RELEASE,
    kubernetesNamespace:
      readOption(argv, "--kubernetes-namespace") ??
      readEnv("CHASE_SETS_KUBERNETES_NAMESPACE", env) ??
      DEFAULT_EMERGENCY_KUBERNETES_NAMESPACE,
    kubernetesTimeout:
      readOption(argv, "--kubernetes-timeout") ??
      readEnv("CHASE_SETS_KUBERNETES_ROLLOUT_TIMEOUT", env) ??
      DEFAULT_EMERGENCY_KUBERNETES_TIMEOUT,
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function runEmergencyRecoveryGuide(options) {
  const result = buildEmergencyRecoveryGuide(options);
  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }
  return result;
}

export function buildEmergencyRecoveryGuide(input) {
  const blockers = [];
  const mode = normalizeString(input.mode) ?? "rollback-readiness";

  if (!modes.has(mode)) {
    blockers.push("Emergency recovery mode must be rollback-readiness, rollback, revert, or fix-forward.");
  }
  if (!normalizeString(input.emergencyReference)) {
    blockers.push("Emergency reference is required for every guided recovery path.");
  }
  if (!isCommitSha(input.targetCommit)) {
    blockers.push("Emergency recovery requires a 40-character target commit.");
  }
  if (["rollback-readiness", "rollback"].includes(mode) && !normalizeString(input.releaseTag)) {
    blockers.push("Rollback recovery requires the target production release tag.");
  }
  if (["rollback-readiness", "rollback"].includes(mode) && !normalizeString(input.imageRef)) {
    blockers.push("Rollback recovery requires the target production image reference.");
  }
  if (["revert", "fix-forward"].includes(mode) && !normalizeString(input.recoveryPullRequest)) {
    blockers.push("Revert and fix-forward recovery require a recovery pull request reference.");
  }
  if (!normalizeString(input.kubernetesRelease ?? DEFAULT_EMERGENCY_KUBERNETES_RELEASE)) {
    blockers.push("DOKS rollback release is required.");
  }
  if (!normalizeString(input.kubernetesNamespace ?? DEFAULT_EMERGENCY_KUBERNETES_NAMESPACE)) {
    blockers.push("DOKS rollback namespace is required.");
  }
  if (!normalizeString(input.kubernetesTimeout ?? DEFAULT_EMERGENCY_KUBERNETES_TIMEOUT)) {
    blockers.push("DOKS rollback timeout is required.");
  }

  const lockBypassAllowed = ["rollback", "revert", "fix-forward"].includes(mode) && blockers.length === 0;
  const kubernetesRollback = buildKubernetesRollback(input);
  const record = {
    schemaVersion: EMERGENCY_RECOVERY_GUIDE_VERSION,
    checkedAt: input.checkedAt,
    mode,
    emergencyReference: normalizeString(input.emergencyReference),
    targetCommit: normalizeString(input.targetCommit),
    recoveryPullRequest: normalizeString(input.recoveryPullRequest),
    releaseTag: normalizeString(input.releaseTag),
    imageRef: normalizeString(input.imageRef),
    lockBypassAllowed,
    kubernetesRollback,
    nextActions: nextActions(mode, lockBypassAllowed, kubernetesRollback.commandText),
    productionDispatchInputs: lockBypassAllowed ? buildProductionDispatchInputs(mode, input) : null,
    blockers,
    result: blockers.length === 0 ? "ready" : "blocked",
  };

  return {
    record,
    passesEmergencyRecoveryGuide: blockers.length === 0,
  };
}

function buildProductionDispatchInputs(mode, input) {
  const emergencyReference = normalizeString(input.emergencyReference);
  const recoveryReference = normalizeString(input.recoveryPullRequest) ?? emergencyReference;
  return {
    release_ref: normalizeString(input.targetCommit),
    dispatch_source: "emergency",
    reason: `Emergency ${mode} recovery for ${recoveryReference}.`,
    emergency_release: true,
    emergency_reference: emergencyReference,
  };
}

function buildKubernetesRollback(input) {
  const release = normalizeString(input.kubernetesRelease) ?? DEFAULT_EMERGENCY_KUBERNETES_RELEASE;
  const namespace = normalizeString(input.kubernetesNamespace) ?? DEFAULT_EMERGENCY_KUBERNETES_NAMESPACE;
  const timeout = normalizeString(input.kubernetesTimeout) ?? DEFAULT_EMERGENCY_KUBERNETES_TIMEOUT;
  const command = [
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
  ];
  return {
    platform: "doks",
    release,
    namespace,
    timeout,
    command,
    commandText: command.join(" "),
  };
}

function nextActions(mode, lockBypassAllowed, kubernetesRollbackCommand) {
  if (mode === "rollback-readiness") {
    return [
      "Run Platform Rollback Readiness for the target commit, release tag, and image reference.",
      "Use rollback, revert, or fix-forward mode only after readiness evidence exists.",
    ];
  }
  if (!lockBypassAllowed) {
    return ["Resolve blockers before bypassing the production release lock."];
  }
  if (mode === "rollback") {
    return [
      "Attach rollback-readiness evidence to the incident or recovery thread.",
      `Execute the source-owned DOKS rollback from an approved production context: ${kubernetesRollbackCommand}`,
      "Run production smoke and preserve the Helm revision, immutable image, and workflow evidence before moving the production marker.",
    ];
  }
  return [
    "Merge the recovery pull request through required checks.",
    "Dispatch Platform Deploy with the emitted productionDispatchInputs after the recovery commit is on main.",
  ];
}

async function main(argv, env = process.env) {
  try {
    const result = await runEmergencyRecoveryGuide(parseEmergencyRecoveryGuideArgs(argv, env));
    console.log(JSON.stringify(result.record, null, 2));
    return result.passesEmergencyRecoveryGuide ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
