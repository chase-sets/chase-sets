#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";

export const PLATFORM_DEPLOY_INCIDENT_VERSION = "platform-deploy-incident/v1";

const NO_OP_INCIDENT_TITLE_PREFIX = "Incident: Platform Deploy superseded before production for ";

export function parsePlatformDeployIncidentOptions(argv, env = process.env) {
  return {
    command: readOption(argv, "--command") ?? readEnv("PLATFORM_DEPLOY_INCIDENT_COMMAND", env) ?? "classify-run",
    format: readOption(argv, "--format") ?? readEnv("PLATFORM_DEPLOY_INCIDENT_FORMAT", env) ?? "json",
    resolveReleaseResult: readOption(argv, "--resolve-release-result") ?? readEnv("RESOLVE_RELEASE_RESULT", env),
    buildImageResult: readOption(argv, "--build-image-result") ?? readEnv("BUILD_IMAGE_RESULT", env),
    deployStagingResult: readOption(argv, "--deploy-staging-result") ?? readEnv("DEPLOY_STAGING_RESULT", env),
    stagingApplied: readOption(argv, "--staging-applied") ?? readEnv("STAGING_APPLIED", env),
    stagingDeployed: readOption(argv, "--staging-deployed") ?? readEnv("STAGING_DEPLOYED", env),
    deployProductionResult: readOption(argv, "--deploy-production-result") ?? readEnv("DEPLOY_PRODUCTION_RESULT", env),
    productionSuperseded: readOption(argv, "--production-superseded") ?? readEnv("PRODUCTION_SUPERSEDED", env),
    recordStagingHealthResult:
      readOption(argv, "--record-staging-health-result") ?? readEnv("RECORD_STAGING_HEALTH_RESULT", env),
    title: readOption(argv, "--title") ?? readEnv("INCIDENT_TITLE", env) ?? "",
    body: readOption(argv, "--body") ?? readEnv("INCIDENT_BODY", env) ?? "",
    runUrl: readOption(argv, "--run-url") ?? readEnv("RUN_URL", env) ?? "",
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env) ?? "",
    supersededByCommit: readOption(argv, "--superseded-by-commit") ?? readEnv("SUPERSEDED_BY_COMMIT", env) ?? "",
    reason: readOption(argv, "--reason") ?? readEnv("PLATFORM_DEPLOY_INCIDENT_REASON", env) ?? "",
  };
}

export function classifyPlatformDeployRun(input = {}) {
  const successfulPrerequisites = [
    input.resolveReleaseResult,
    input.buildImageResult,
    input.deployStagingResult,
    input.recordStagingHealthResult,
  ].every((result) => result === "success");
  const productionSuperseded = parseBoolean(input.productionSuperseded) === true;
  const stagingApplied = parseBoolean(input.stagingApplied);
  const stagingDeployed = parseBoolean(input.stagingDeployed);
  const stagingWasNotApplied = stagingApplied === false || (stagingApplied === null && stagingDeployed === false);
  const legacyStagingNoOp =
    stagingApplied === null &&
    stagingDeployed === null &&
    input.deployStagingResult === "success" &&
    input.deployProductionResult === "skipped";
  const stagingSuperseded =
    input.deployStagingResult === "success" &&
    input.deployProductionResult === "skipped" &&
    (stagingWasNotApplied || legacyStagingNoOp);
  const supersededNoOp = successfulPrerequisites && (productionSuperseded || stagingSuperseded);

  return {
    schemaVersion: PLATFORM_DEPLOY_INCIDENT_VERSION,
    action: supersededNoOp ? "close" : "create-or-update",
    kind: supersededNoOp ? "superseded-no-op" : "deploy-failure",
    noOp: supersededNoOp,
    reason: productionSuperseded
      ? "production-superseded-by-newer-main"
      : stagingSuperseded
        ? "staging-superseded-before-apply"
        : "deploy-stage-failure",
  };
}

export function classifySupersededNoOpIncident({ title = "", body = "" } = {}) {
  const hasSupersededTitle = title.startsWith(NO_OP_INCIDENT_TITLE_PREFIX);
  const hasSupersededKind = /(?:^|\n)\s*-\s*Kind:\s*production-superseded\s*$/im.test(body);
  const hasSupersedingCommit = /(?:^|\n)\s*-\s*Superseded by commit:\s*[0-9a-f]{40}\s*$/im.test(body);

  return {
    action: hasSupersededTitle && hasSupersededKind && hasSupersedingCommit ? "close" : "leave-open",
    noOp: hasSupersededTitle && hasSupersededKind && hasSupersedingCommit,
  };
}

export function buildSupersededNoOpResolutionComment({
  runUrl = "",
  releaseCommit = "",
  supersededByCommit = "",
  reason = "",
} = {}) {
  return `Automated Platform Deploy no-op resolution.

- Resolving workflow run: ${runUrl || "unavailable"}
- Superseded release commit: ${releaseCommit || "unavailable"}
- Superseding commit: ${supersededByCommit || "unavailable"}
- Classification: ${reason || "superseded-no-op"}

This deploy run was intentionally superseded before its release was applied. The newer release owns the deploy lane, so no failed deploy action remains for this incident.`;
}

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

function writeResult(result, format) {
  if (format === "plain") {
    process.stdout.write(`${result.action ?? result}\n`);
    return;
  }
  if (format === "github-output") {
    for (const [key, value] of Object.entries(result)) {
      process.stdout.write(`${key}=${typeof value === "boolean" ? String(value) : value}\n`);
    }
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function runCli() {
  const options = parsePlatformDeployIncidentOptions(process.argv.slice(2));
  if (options.command === "classify-run") {
    writeResult(classifyPlatformDeployRun(options), options.format);
    return;
  }
  if (options.command === "classify-issue") {
    writeResult(classifySupersededNoOpIncident(options), options.format);
    return;
  }
  if (options.command === "build-comment") {
    process.stdout.write(
      `${buildSupersededNoOpResolutionComment({
        runUrl: options.runUrl,
        releaseCommit: options.releaseCommit,
        supersededByCommit: options.supersededByCommit,
        reason: options.reason,
      })}\n`,
    );
    return;
  }
  throw new Error(`Unknown platform deploy incident command: ${options.command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
