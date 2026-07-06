#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

const execFile = promisify(execFileCallback);

export const STAGING_BOOTSTRAP_HOOK_DRILL_VERSION = "staging-bootstrap-hook-drill/v1";
export const DEFAULT_RELEASE = "chase-sets-platform";
export const DEFAULT_NAMESPACE = "chase-sets-platform";
export const DEFAULT_CHART_PATH = "infrastructure/helm/platform";
export const DEFAULT_FAILURE_RUNTIME_PROFILE = "bootstrap-hook-drill-invalid-runtime-profile";
const MAX_CAPTURE_BYTES = 200_000;

export function parseStagingBootstrapHookDrillArgs(argv, env = process.env) {
  return {
    outDir:
      readOption(argv, "--out-dir") ??
      readEnv("STAGING_BOOTSTRAP_HOOK_DRILL_OUT_DIR", env) ??
      "artifacts/staging-bootstrap-hook-drill",
    environment: readOption(argv, "--environment") ?? readEnv("DEPLOYMENT_ENVIRONMENT", env) ?? "staging",
    release: readOption(argv, "--release") ?? readEnv("CHASE_SETS_HELM_RELEASE", env) ?? DEFAULT_RELEASE,
    namespace: readOption(argv, "--namespace") ?? readEnv("CHASE_SETS_KUBERNETES_NAMESPACE", env) ?? DEFAULT_NAMESPACE,
    chartPath: readOption(argv, "--chart-path") ?? readEnv("CHASE_SETS_HELM_CHART_PATH", env) ?? DEFAULT_CHART_PATH,
    timeout: readOption(argv, "--timeout") ?? readEnv("CHASE_SETS_KUBERNETES_ROLLOUT_TIMEOUT", env) ?? "15m",
    marker:
      readOption(argv, "--marker") ??
      readEnv("STAGING_BOOTSTRAP_HOOK_DRILL_MARKER", env) ??
      `github-${readEnv("GITHUB_RUN_ID", env) ?? "local"}-${readEnv("GITHUB_RUN_ATTEMPT", env) ?? "1"}`,
    failureRuntimeProfile:
      readOption(argv, "--failure-runtime-profile") ??
      readEnv("STAGING_BOOTSTRAP_HOOK_DRILL_FAILURE_RUNTIME_PROFILE", env) ??
      DEFAULT_FAILURE_RUNTIME_PROFILE,
    landingUrl: readOption(argv, "--landing-url") ?? readEnv("LANDING_URL", env),
    adminUrl: readOption(argv, "--admin-url") ?? readEnv("ADMIN_URL", env),
    marketplaceUrl: readOption(argv, "--marketplace-url") ?? readEnv("MARKETPLACE_URL", env),
    legacyRedirectUrl: readOption(argv, "--legacy-redirect-url") ?? readEnv("LEGACY_REDIRECT_URL", env),
    marketplaceRootUrl: readOption(argv, "--marketplace-root-url") ?? readEnv("MARKETPLACE_ROOT_WEB_URL", env),
    helmPath: readOption(argv, "--helm") ?? readEnv("HELM_PATH", env) ?? "helm",
    kubectlPath: readOption(argv, "--kubectl") ?? readEnv("KUBECTL_PATH", env) ?? "kubectl",
    pnpmPath: readOption(argv, "--pnpm") ?? readEnv("PNPM_PATH", env) ?? "pnpm",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    workflowRunId: readEnv("GITHUB_RUN_ID", env),
    workflowRunAttempt: readEnv("GITHUB_RUN_ATTEMPT", env),
    commitSha: readEnv("GITHUB_SHA", env),
  };
}

export async function runStagingBootstrapHookDrill(options, dependencies = {}) {
  const runner = dependencies.runner ?? runCommand;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const record = createBaseRecord(options);
  const validationErrors = validateOptions(options);
  record.errors.push(...validationErrors);

  await mkdir(options.outDir, { recursive: true });
  record.heldLock = buildHeldLockBlocker(options, now());
  await writeJsonArtifact(options, "held-lock-blocker.json", record.heldLock);

  if (validationErrors.length > 0) {
    finalizeRecord(record, now());
    await writeJsonRecord(join(options.outDir, "staging-bootstrap-hook-drill.json"), record);
    return { record, passesDrillGate: false };
  }

  try {
    record.preDrill = await captureSnapshot("pre-drill", options, runner);
    record.phases.preDrillSmoke = await runSmokePhase("pre-drill", options, runner, now);

    record.phases.successfulUpgrade = await runUpgradePhase({
      phaseName: "successful-bootstrap-upgrade",
      options,
      runner,
      now,
      args: buildSuccessfulUpgradeArgs(options),
      expectSuccess: true,
    });
    await captureHookLogs("successful-bootstrap-upgrade", options, runner);
    record.afterSuccessfulUpgrade = await captureSnapshot("after-successful-upgrade", options, runner);
    record.phases.successfulSmoke = await runSmokePhase("successful-upgrade", options, runner, now);

    const failedBaseline = record.afterSuccessfulUpgrade;
    record.phases.failedBootstrapUpgrade = await runUpgradePhase({
      phaseName: "failed-bootstrap-upgrade",
      options,
      runner,
      now,
      args: buildFailedBootstrapUpgradeArgs(options),
      expectSuccess: false,
    });
    await captureHookLogs("failed-bootstrap-upgrade", options, runner);
    record.afterFailedBootstrapUpgrade = await captureSnapshot("after-failed-bootstrap-upgrade", options, runner);
    record.phases.failedBootstrapSmoke = await runSmokePhase("failed-bootstrap-rollback", options, runner, now);
    record.rollbackVerification = verifyAtomicRollback(failedBaseline, record.afterFailedBootstrapUpgrade);
  } catch (error) {
    record.errors.push(summarizeError(error));
  }

  record.cleanup = buildCleanupStatus(record);
  finalizeRecord(record, now());
  await writeJsonRecord(join(options.outDir, "staging-bootstrap-hook-drill.json"), record);
  return { record, passesDrillGate: record.result === "success" };
}

export function buildSuccessfulUpgradeArgs(options) {
  return [
    "upgrade",
    "--install",
    options.release,
    options.chartPath,
    "--namespace",
    options.namespace,
    "--wait",
    "--timeout",
    options.timeout,
    "--atomic",
    "--reuse-values",
    "--set-string",
    `global.podAnnotations.bootstrap-hook-drill=${helmSetString(options.marker)}`,
  ];
}

export function buildFailedBootstrapUpgradeArgs(options) {
  return [
    "upgrade",
    "--install",
    options.release,
    options.chartPath,
    "--namespace",
    options.namespace,
    "--wait",
    "--timeout",
    options.timeout,
    "--atomic",
    "--reuse-values",
    "--set-string",
    `global.envOverrides.CHASE_SETS_RUNTIME_PROFILE=${helmSetString(options.failureRuntimeProfile)}`,
    "--set-string",
    `global.podAnnotations.bootstrap-hook-drill-failed=${helmSetString(options.marker)}`,
  ];
}

export function buildHeldLockBlocker(options, checkedAt) {
  return {
    schemaVersion: "staging-bootstrap-hook-held-lock-blocker/v1",
    checkedAt,
    environment: options.environment,
    release: options.release,
    namespace: options.namespace,
    result: "blocked",
    liveHeldLockInjection: "not-enabled",
    bootstrapTouchedRelation: {
      context: "catalog",
      table: "bounded_context_schema_migrations",
      sourceEvidence: "deployables/platform-api/__tests__/bootstrap-integration.test.ts",
    },
    supportSafe: true,
    redaction: {
      databaseUrls: "not-read",
      credentials: "not-read",
      rawIdentifiers: "not-written",
      customerOrProviderData: "not-read",
    },
    nextAction:
      "Add a dedicated least-privilege staging lock injector before replacing this blocker with a live held-lock phase.",
  };
}

export function redactSupportUnsafeText(value) {
  return String(value ?? "")
    .replace(/\bpostgres(?:ql)?:\/\/[^\s'"`<>]+/gi, "[redacted-postgres-url]")
    .replace(
      /\b((?:DATABASE_URL(?:_[A-Z0-9_]+)?|PLATFORM_CONTROL_DATABASE_URL|PLATFORM_WORK_SIGNAL_DATABASE_URL))=[^\s]+/g,
      "$1=[redacted]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(
      /\b[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-5][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}\b/g,
      "[redacted-uuid]",
    )
    .replace(/\b(token|password|secret|cookie)=([^\s]+)/gi, "$1=[redacted]");
}

export function summarizeDeploymentSnapshot(raw) {
  const parsed = JSON.parse(raw || '{"items":[]}');
  return (parsed.items ?? [])
    .map((item) => ({
      component: item.metadata?.labels?.["app.kubernetes.io/component"] ?? "unknown",
      generation: item.metadata?.generation ?? null,
      observedGeneration: item.status?.observedGeneration ?? null,
      replicas: item.status?.replicas ?? 0,
      readyReplicas: item.status?.readyReplicas ?? 0,
      images: [
        ...new Set((item.spec?.template?.spec?.containers ?? []).map((container) => summarizeImage(container.image))),
      ].sort(),
    }))
    .sort((left, right) => left.component.localeCompare(right.component, "en"));
}

export function summarizeReadyPodUidFingerprints(raw) {
  const parsed = JSON.parse(raw || '{"items":[]}');
  return (parsed.items ?? [])
    .filter((item) =>
      (item.status?.conditions ?? []).some((condition) => condition.type === "Ready" && condition.status === "True"),
    )
    .map((item) => ({
      component: item.metadata?.labels?.["app.kubernetes.io/component"] ?? "unknown",
      uidFingerprint: fingerprint(item.metadata?.uid ?? ""),
      phase: item.status?.phase ?? "unknown",
    }))
    .sort((left, right) =>
      `${left.component}:${left.uidFingerprint}`.localeCompare(`${right.component}:${right.uidFingerprint}`, "en"),
    );
}

export function summarizeEvents(raw) {
  const parsed = JSON.parse(raw || '{"items":[]}');
  return (parsed.items ?? []).slice(-50).map((event) => ({
    time: event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp ?? null,
    type: event.type ?? "Normal",
    reason: event.reason ?? "Unknown",
    regardingKind: event.involvedObject?.kind ?? event.regarding?.kind ?? "Unknown",
    message: redactSupportUnsafeText(event.message ?? "").slice(0, 500),
  }));
}

function createBaseRecord(options) {
  return {
    schemaVersion: STAGING_BOOTSTRAP_HOOK_DRILL_VERSION,
    checkedAt: options.checkedAt,
    environment: options.environment,
    release: options.release,
    namespace: options.namespace,
    workflowRunId: options.workflowRunId ?? null,
    workflowRunAttempt: options.workflowRunAttempt ?? null,
    commitSha: options.commitSha ?? null,
    supportSafe: true,
    redaction: {
      kubeconfig: "not-written",
      rawEnvironment: "not-written",
      databaseUrls: "redacted-and-not-intentionally-read",
      secrets: "redacted-and-not-intentionally-read",
      podUids: "fingerprinted",
      customerOrProviderData: "not-read",
    },
    phases: {},
    errors: [],
    result: "unknown",
  };
}

function validateOptions(options) {
  const errors = [];
  if (options.environment !== "staging") {
    errors.push(`Refusing bootstrap hook drill for environment '${options.environment}'.`);
  }
  if (options.release !== DEFAULT_RELEASE) {
    errors.push(`Refusing stale or non-staging Helm release '${options.release}'; expected '${DEFAULT_RELEASE}'.`);
  }
  if (options.namespace !== DEFAULT_NAMESPACE) {
    errors.push(`Refusing stale or non-staging namespace '${options.namespace}'; expected '${DEFAULT_NAMESPACE}'.`);
  }
  if (!options.landingUrl || !options.adminUrl || !options.marketplaceUrl || !options.legacyRedirectUrl) {
    errors.push("Landing, admin, marketplace, and legacy redirect smoke URLs are required.");
  }
  return errors;
}

async function captureSnapshot(label, options, runner) {
  const statusJson = await runCaptured(runner, options.helmPath, [
    "status",
    options.release,
    "--namespace",
    options.namespace,
    "-o",
    "json",
  ]);
  const statusText = await runCaptured(runner, options.helmPath, [
    "status",
    options.release,
    "--namespace",
    options.namespace,
  ]);
  const historyText = await runCaptured(runner, options.helmPath, [
    "history",
    options.release,
    "--namespace",
    options.namespace,
  ]);
  const deployments = await runCaptured(runner, options.kubectlPath, [
    "get",
    "deployments",
    "--namespace",
    options.namespace,
    "--selector",
    `app.kubernetes.io/instance=${options.release},app.kubernetes.io/name=chase-sets-platform`,
    "-o",
    "json",
  ]);
  const pods = await runCaptured(runner, options.kubectlPath, [
    "get",
    "pods",
    "--namespace",
    options.namespace,
    "--selector",
    `app.kubernetes.io/instance=${options.release},app.kubernetes.io/name=chase-sets-platform`,
    "-o",
    "json",
  ]);
  const events = await runCaptured(runner, options.kubectlPath, [
    "get",
    "events",
    "--namespace",
    options.namespace,
    "--sort-by=.metadata.creationTimestamp",
    "-o",
    "json",
  ]);

  await writeTextArtifact(options, `${label}-helm-status.txt`, statusText.stdout);
  await writeTextArtifact(options, `${label}-helm-history.txt`, historyText.stdout);
  await writeJsonArtifact(
    options,
    `${label}-deployment-images-generations.json`,
    summarizeDeploymentSnapshot(deployments.stdout),
  );
  await writeJsonArtifact(
    options,
    `${label}-ready-pod-uid-fingerprints.json`,
    summarizeReadyPodUidFingerprints(pods.stdout),
  );
  await writeJsonArtifact(options, `${label}-k8s-events.json`, summarizeEvents(events.stdout));

  return {
    helmRevision: readHelmRevision(statusJson.stdout),
    deployments: summarizeDeploymentSnapshot(deployments.stdout),
    readyPodUidFingerprints: summarizeReadyPodUidFingerprints(pods.stdout),
  };
}

async function runUpgradePhase({ phaseName, options, runner, now, args, expectSuccess }) {
  const phase = {
    status: "running",
    startedAt: now(),
    finishedAt: null,
    command: "helm upgrade",
    expectedFailure: !expectSuccess,
  };
  const result = await runner(options.helmPath, args, { allowFailure: !expectSuccess });
  await writeTextArtifact(options, `${phaseName}-helm-upgrade.txt`, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  phase.finishedAt = now();
  phase.exitCode = result.exitCode;
  if (expectSuccess && result.exitCode !== 0) {
    phase.status = "failure";
    throw new Error(`${phaseName} failed with exit code ${result.exitCode}.`);
  }
  if (!expectSuccess && result.exitCode === 0) {
    phase.status = "failure";
    throw new Error(`${phaseName} unexpectedly succeeded; failed bootstrap hook was not exercised.`);
  }
  phase.status = "success";
  return phase;
}

async function captureHookLogs(label, options, runner) {
  const result = await runner(
    options.kubectlPath,
    [
      "logs",
      "--namespace",
      options.namespace,
      "--selector",
      `app.kubernetes.io/instance=${options.release},app.kubernetes.io/component=platform-bootstrap`,
      "--all-containers",
      "--tail",
      "300",
    ],
    { allowFailure: true },
  );
  await writeTextArtifact(options, `${label}-hook-logs.txt`, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

async function runSmokePhase(label, options, runner, now) {
  const phase = { status: "running", startedAt: now(), finishedAt: null };
  const env = {
    ...process.env,
    MARKETPLACE_ROOT_WEB_URL: options.marketplaceRootUrl ?? "",
    SMOKE_SOURCE: `staging-bootstrap-hook-drill-${label}`,
    SMOKE_REQUIRE_ADMIN: "true",
    SMOKE_REQUIRE_MARKETPLACE: "true",
    SMOKE_REQUIRE_MARKETPLACE_ROOT: options.marketplaceRootUrl ? "true" : "false",
    SMOKE_REQUIRE_LEGACY_REDIRECT: "true",
    SMOKE_WRITE_WAITLIST: "false",
    SMOKE_FETCH_ATTEMPTS: process.env.SMOKE_FETCH_ATTEMPTS ?? "24",
    SMOKE_FETCH_RETRY_DELAY_MS: process.env.SMOKE_FETCH_RETRY_DELAY_MS ?? "5000",
    SMOKE_FETCH_TIMEOUT_MS: process.env.SMOKE_FETCH_TIMEOUT_MS ?? "15000",
  };
  const result = await runner(
    options.pnpmPath,
    [
      "run",
      "smoke:platform",
      "--",
      options.landingUrl,
      options.adminUrl,
      options.marketplaceUrl,
      options.legacyRedirectUrl,
    ],
    { env, allowFailure: true },
  );
  await writeTextArtifact(options, `${label}-smoke-output.txt`, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  phase.finishedAt = now();
  phase.exitCode = result.exitCode;
  phase.status = result.exitCode === 0 ? "success" : "failure";
  if (result.exitCode !== 0) {
    phase.error = `Smoke failed for ${label}. See redacted smoke artifact.`;
  }
  return phase;
}

function verifyAtomicRollback(before, after) {
  const beforeImages = JSON.stringify(
    before?.deployments?.map((deployment) => [deployment.component, deployment.images]) ?? [],
  );
  const afterImages = JSON.stringify(
    after?.deployments?.map((deployment) => [deployment.component, deployment.images]) ?? [],
  );
  const beforePods = JSON.stringify(before?.readyPodUidFingerprints ?? []);
  const afterPods = JSON.stringify(after?.readyPodUidFingerprints ?? []);
  return {
    status: beforeImages === afterImages && beforePods === afterPods ? "success" : "failure",
    baselineHelmRevision: before?.helmRevision ?? null,
    postFailureHelmRevision: after?.helmRevision ?? null,
    deploymentImagesStable: beforeImages === afterImages,
    readyPodUidFingerprintsStable: beforePods === afterPods,
  };
}

function buildCleanupStatus(record) {
  return {
    status: record.rollbackVerification?.status === "success" ? "not-needed" : "needs-operator-review",
    atomicRollbackVerified: record.rollbackVerification?.status === "success",
    recoveryAction: "failed bootstrap upgrade used Helm --atomic; no secret cleanup artifact was produced.",
  };
}

function finalizeRecord(record, finishedAt) {
  record.finishedAt = finishedAt;
  const smokeFailures = Object.values(record.phases).filter((phase) => phase?.status === "failure");
  const rollbackOk = !record.rollbackVerification || record.rollbackVerification.status === "success";
  record.result = record.errors.length === 0 && smokeFailures.length === 0 && rollbackOk ? "success" : "failure";
}

async function runCaptured(runner, command, args) {
  return runner(command, args, { allowFailure: false });
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFile(command, args, {
      env: options.env ?? process.env,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: limitOutput(result.stdout), stderr: limitOutput(result.stderr) };
  } catch (error) {
    const result = {
      exitCode: error?.code ?? 1,
      stdout: limitOutput(error?.stdout ?? ""),
      stderr: limitOutput(error?.stderr ?? summarizeError(error)),
    };
    if (options.allowFailure) {
      return result;
    }
    throw error;
  }
}

async function writeTextArtifact(options, fileName, text) {
  await writeFile(join(options.outDir, fileName), `${redactSupportUnsafeText(limitOutput(text))}\n`);
}

async function writeJsonArtifact(options, fileName, value) {
  await writeJsonRecord(join(options.outDir, fileName), value);
}

function readHelmRevision(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed.version ?? parsed.info?.version ?? null;
  } catch {
    return null;
  }
}

function summarizeImage(image) {
  const value = String(image ?? "");
  return value.replace(/^registry\.digitalocean\.com\/[^/]+\//, "registry.digitalocean.com/[registry]/");
}

function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function helmSetString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(",", "\\,");
}

function limitOutput(value) {
  const text = String(value ?? "");
  return text.length > MAX_CAPTURE_BYTES ? `${text.slice(0, MAX_CAPTURE_BYTES)}\n[output-truncated]` : text;
}

function summarizeError(error) {
  return redactSupportUnsafeText(error instanceof Error ? error.message : String(error));
}

async function main() {
  const options = parseStagingBootstrapHookDrillArgs(process.argv.slice(2));
  const { record, passesDrillGate } = await runStagingBootstrapHookDrill(options);
  console.log(`Staging bootstrap hook drill result: ${record.result}`);
  process.exitCode = passesDrillGate ? 0 : 1;
}

if (process.argv[1]?.endsWith("staging-bootstrap-hook-drill.mjs")) {
  main().catch((error) => {
    console.error(summarizeError(error));
    process.exitCode = 1;
  });
}
