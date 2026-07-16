#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { captureRollbackTarget, rollbackAppImage, waitForDeployments } from "./digitalocean-app-deployment.mjs";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

const execFile = promisify(execFileCallback);

export const DIGITALOCEAN_STAGING_ROLLBACK_DRILL_VERSION = "digitalocean-staging-rollback-drill/v1";
const DEFAULT_REPOSITORY = "chase-sets-platform";
const DEFAULT_EXPECTED_STAGING_APP_NAME = "chase-sets-staging-platform";
const MAX_ERROR_LENGTH = 2_000;

export function parseDigitalOceanStagingRollbackDrillArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("STAGING_ROLLBACK_DRILL_OUT", env),
    environment: readOption(argv, "--environment") ?? readEnv("DEPLOYMENT_ENVIRONMENT", env) ?? "staging",
    appId: readOption(argv, "--app-id") ?? readEnv("STAGING_APP_ID", env),
    expectedAppName:
      readOption(argv, "--expected-app-name") ?? readEnv("STAGING_APP_NAME", env) ?? DEFAULT_EXPECTED_STAGING_APP_NAME,
    registryName: readOption(argv, "--registry-name") ?? readEnv("DIGITALOCEAN_REGISTRY_NAME", env),
    repository: readOption(argv, "--repository") ?? readEnv("PLATFORM_IMAGE_REPOSITORY", env) ?? DEFAULT_REPOSITORY,
    targetDigest: readOption(argv, "--target-digest") ?? readEnv("ROLLBACK_TARGET_DIGEST", env),
    targetTag: readOption(argv, "--target-tag") ?? readEnv("ROLLBACK_TARGET_TAG", env),
    targetReference: readOption(argv, "--target-reference") ?? readEnv("ROLLBACK_TARGET_REFERENCE", env),
    landingUrl: readOption(argv, "--landing-url") ?? readEnv("LANDING_URL", env),
    adminUrl: readOption(argv, "--admin-url") ?? readEnv("ADMIN_URL", env),
    marketplaceUrl: readOption(argv, "--marketplace-url") ?? readEnv("MARKETPLACE_URL", env),
    marketplaceRootUrl: readOption(argv, "--marketplace-root-url") ?? readEnv("MARKETPLACE_ROOT_WEB_URL", env),
    workflowRunId: readEnv("GITHUB_RUN_ID", env),
    workflowRunAttempt: readEnv("GITHUB_RUN_ATTEMPT", env),
    commitSha: readEnv("GITHUB_SHA", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    timeoutSeconds: readPositiveInteger(
      readOption(argv, "--timeout-seconds") ?? readEnv("APP_PLATFORM_DEPLOYMENT_TIMEOUT_SECONDS", env) ?? "1800",
      "APP_PLATFORM_DEPLOYMENT_TIMEOUT_SECONDS",
    ),
    pollSeconds: readPositiveInteger(
      readOption(argv, "--poll-seconds") ?? readEnv("APP_PLATFORM_DEPLOYMENT_POLL_SECONDS", env) ?? "30",
      "APP_PLATFORM_DEPLOYMENT_POLL_SECONDS",
    ),
    validateTargetImage: parseBoolean(
      readOption(argv, "--validate-target-image") ?? readEnv("ROLLBACK_VALIDATE_TARGET_IMAGE", env) ?? "true",
      "ROLLBACK_VALIDATE_TARGET_IMAGE",
    ),
  };
}

export async function runDigitalOceanStagingRollbackDrill(options, dependencies = {}) {
  const result = await performDigitalOceanStagingRollbackDrill(options, dependencies);
  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }
  return result;
}

export async function performDigitalOceanStagingRollbackDrill(options, dependencies = {}) {
  const commandOutput = dependencies.commandOutput ?? commandOutputDefault;
  const commandJson = dependencies.commandJson ?? ((command, args) => commandJsonDefault(command, args, commandOutput));
  const now = dependencies.now ?? (() => new Date().toISOString());
  const record = createBaseRecord(options);
  record.errors.push(...validateOptions(options));

  if (record.errors.length > 0) {
    finalizeRecord(record);
    return { record, passesRollbackDrillGate: false };
  }

  let currentTarget = null;
  let rollbackAttempted = false;

  try {
    const app = await readAppSummary(options.appId, commandJson);
    record.app = app;
    if (app.name !== options.expectedAppName || !app.name.includes("staging")) {
      record.errors.push(
        `Refusing rollback drill for App Platform app '${app.name || "unknown"}'; expected staging app '${options.expectedAppName}'.`,
      );
      finalizeRecord(record);
      return { record, passesRollbackDrillGate: false };
    }

    currentTarget = await (dependencies.captureRollbackTarget ?? captureRollbackTarget)(options.appId, {
      registryName: options.registryName,
      repository: options.repository,
      commandJson,
    });
    record.current = summarizeTarget(currentTarget);

    if (currentTarget.digest && currentTarget.digest === options.targetDigest) {
      record.errors.push(
        "Rollback target digest matches the current staging image; drill would not exercise rollback.",
      );
      finalizeRecord(record);
      return { record, passesRollbackDrillGate: false };
    }

    record.rollbackTarget = {
      ...record.rollbackTarget,
      imageRef: imageReference(options),
      digest: options.targetDigest,
      tag: emptyToNull(options.targetTag),
      reference: options.targetReference,
    };

    if (options.validateTargetImage) {
      record.rollbackTarget.imageExists = await inspectImageExists(record.rollbackTarget.imageRef, commandOutput);
      if (!record.rollbackTarget.imageExists) {
        record.errors.push(`Rollback target image '${record.rollbackTarget.imageRef}' was not found in DOCR.`);
        finalizeRecord(record);
        return { record, passesRollbackDrillGate: false };
      }
    } else {
      record.rollbackTarget.imageExists = "skipped";
    }

    rollbackAttempted = true;
    await applyImageAndWait({
      phase: record.phases.rollback,
      appId: options.appId,
      target: rollbackTargetFromOptions(options),
      options,
      dependencies,
      commandJson,
      commandOutput,
      now,
    });

    if (record.phases.rollback.status === "success") {
      await runSmokePhase(record.phases.rollbackSmoke, options, dependencies, now, "rollback");
    }
  } catch (error) {
    record.errors.push(...describeFailure(error, "Staging rollback drill failed before roll-forward."));
    markPhaseFailure(record.phases.rollback, error, now);
  } finally {
    if (currentTarget && rollbackAttempted) {
      await applyImageAndWait({
        phase: record.phases.rollForward,
        appId: options.appId,
        target: {
          registryName: options.registryName,
          repository: options.repository,
          digest: currentTarget.digest ?? "",
          tag: currentTarget.digest ? "" : currentTarget.tag,
        },
        options,
        dependencies,
        commandJson,
        commandOutput,
        now,
      });

      if (record.phases.rollForward.status === "success") {
        await runSmokePhase(record.phases.rollForwardSmoke, options, dependencies, now, "roll-forward");
      }
    }
  }

  finalizeRecord(record);
  return { record, passesRollbackDrillGate: record.result === "success" };
}

async function applyImageAndWait({ phase, appId, target, options, dependencies, commandJson, commandOutput, now }) {
  phase.startedAt = now();
  phase.imageRef = imageReference({ ...options, targetDigest: target.digest, targetTag: target.tag });
  try {
    await (dependencies.rollbackAppImage ?? rollbackAppImage)(appId, target, {
      repository: options.repository,
      commandJson,
      commandOutput,
    });
    await (dependencies.waitForDeployments ?? waitForDeployments)(appId, {
      timeoutSeconds: options.timeoutSeconds,
      pollSeconds: options.pollSeconds,
      commandOutput,
    });
    phase.status = "success";
  } catch (error) {
    markPhaseFailure(phase, error, now);
  } finally {
    phase.finishedAt = phase.finishedAt ?? now();
  }
}

async function runSmokePhase(phase, options, dependencies, now, label) {
  phase.startedAt = now();
  try {
    await (dependencies.runSmoke ?? runSmoke)(options, label);
    phase.status = "success";
  } catch (error) {
    markPhaseFailure(phase, error, now);
  } finally {
    phase.finishedAt = phase.finishedAt ?? now();
  }
}

async function runSmoke(options, label) {
  const env = {
    ...process.env,
    MARKETPLACE_ROOT_WEB_URL: options.marketplaceRootUrl,
    SMOKE_SOURCE: `staging-rollback-drill-${label}`,
  };
  await execFile(
    "pnpm",
    ["run", "smoke:platform", "--", options.landingUrl, options.adminUrl, options.marketplaceUrl],
    { env, maxBuffer: 50 * 1024 * 1024, windowsHide: true },
  );
}

async function readAppSummary(appId, commandJson) {
  const response = await commandJson("doctl", ["apps", "get", appId, "--output", "json"]);
  const app = Array.isArray(response) ? response[0] : response;
  return {
    id: app?.id ?? app?.ID ?? appId,
    name: app?.spec?.name ?? app?.name ?? app?.Name ?? "",
  };
}

async function inspectImageExists(imageRef, commandOutput) {
  try {
    await commandOutput("docker", ["buildx", "imagetools", "inspect", imageRef]);
    return true;
  } catch {
    return false;
  }
}

function createBaseRecord(options) {
  return {
    schemaVersion: DIGITALOCEAN_STAGING_ROLLBACK_DRILL_VERSION,
    checkedAt: options.checkedAt,
    environment: options.environment,
    workflow: {
      runId: emptyToNull(options.workflowRunId),
      runAttempt: emptyToNull(options.workflowRunAttempt),
      commitSha: emptyToNull(options.commitSha),
    },
    app: {
      id: options.appId ?? null,
      name: null,
    },
    repository: options.repository,
    current: null,
    rollbackTarget: {
      imageRef: null,
      digest: emptyToNull(options.targetDigest),
      tag: emptyToNull(options.targetTag),
      reference: emptyToNull(options.targetReference),
      imageExists: "unknown",
    },
    phases: {
      rollback: createPhase(),
      rollbackSmoke: createPhase(),
      rollForward: createPhase(),
      rollForwardSmoke: createPhase(),
    },
    supportSafe: true,
    result: "failure",
    errors: [],
  };
}

function createPhase() {
  return {
    status: "skipped",
    startedAt: null,
    finishedAt: null,
    imageRef: null,
    errors: [],
  };
}

function finalizeRecord(record) {
  const phaseStatuses = Object.values(record.phases).map((phase) => phase.status);
  record.result =
    record.errors.length === 0 && phaseStatuses.every((status) => status === "success") ? "success" : "failure";
  return record;
}

function markPhaseFailure(phase, error, now) {
  if (phase.status === "success") {
    return;
  }
  phase.status = "failure";
  phase.finishedAt = phase.finishedAt ?? now();
  phase.errors.push(...describeFailure(error, "Phase failed."));
}

function summarizeTarget(target) {
  return {
    appId: target.appId,
    imageRef: target.imageRef,
    digest: emptyToNull(target.digest),
    tag: emptyToNull(target.tag),
    repository: target.repository,
    componentNames: target.componentNames ?? [],
  };
}

function rollbackTargetFromOptions(options) {
  return {
    registryName: options.registryName,
    repository: options.repository,
    digest: options.targetDigest,
    tag: options.targetTag ?? "",
  };
}

function imageReference(options) {
  const digest = normalizeString(options.targetDigest);
  const tag = normalizeString(options.targetTag);
  if (digest) {
    return `registry.digitalocean.com/${options.registryName}/${options.repository}@${digest}`;
  }
  return `registry.digitalocean.com/${options.registryName}/${options.repository}:${tag}`;
}

function validateOptions(options) {
  const errors = [];
  if (options.environment !== "staging") {
    errors.push("DigitalOcean staging rollback drill is staging-only; DEPLOYMENT_ENVIRONMENT must be staging.");
  }
  if (!normalizeString(options.appId)) {
    errors.push("STAGING_APP_ID is required.");
  }
  if (!normalizeString(options.expectedAppName)) {
    errors.push("STAGING_APP_NAME is required.");
  }
  if (!normalizeString(options.registryName)) {
    errors.push("DIGITALOCEAN_REGISTRY_NAME is required.");
  }
  if (!normalizeString(options.repository)) {
    errors.push("PLATFORM_IMAGE_REPOSITORY is required.");
  }
  if (!isDigest(options.targetDigest)) {
    errors.push("ROLLBACK_TARGET_DIGEST is required and must be a sha256 digest.");
  }
  if (normalizeString(options.targetTag) && !/^[A-Za-z0-9_.-]+$/.test(options.targetTag)) {
    errors.push("ROLLBACK_TARGET_TAG may contain only letters, digits, underscores, dots, and hyphens.");
  }
  if (!normalizeString(options.targetReference)) {
    errors.push("ROLLBACK_TARGET_REFERENCE is required so evidence links the selected prior known-good image.");
  }
  for (const [name, value] of [
    ["LANDING_URL", options.landingUrl],
    ["ADMIN_URL", options.adminUrl],
    ["MARKETPLACE_URL", options.marketplaceUrl],
    ["MARKETPLACE_ROOT_WEB_URL", options.marketplaceRootUrl],
  ]) {
    if (!isHttpsUrl(value)) {
      errors.push(`${name} is required and must be an https URL.`);
    }
  }
  return errors;
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/i.test(value.trim());
}

function isHttpsUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function readPositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== String(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
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
  return normalizeString(value) ?? null;
}

function describeFailure(error, prefix) {
  const message = error instanceof Error ? error.message : String(error);
  return [`${prefix} ${message}`.slice(0, MAX_ERROR_LENGTH)];
}

function commandOutputDefault(command, args, options = {}) {
  if (options.input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true });
      const stdoutChunks = [];
      const stderrChunks = [];

      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0) {
          reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
          return;
        }

        resolve(stdout);
      });

      child.stdin.end(options.input);
    });
  }

  return execFile(command, args, { maxBuffer: 50 * 1024 * 1024, windowsHide: true }).then(({ stdout }) => stdout);
}

async function commandJsonDefault(command, args, commandOutput) {
  const output = await commandOutput(command, args);
  return JSON.parse(output);
}

async function main(argv) {
  try {
    const result = await runDigitalOceanStagingRollbackDrill(parseDigitalOceanStagingRollbackDrillArgs(argv));
    console.log(JSON.stringify(result.record, null, 2));
    return result.passesRollbackDrillGate ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
