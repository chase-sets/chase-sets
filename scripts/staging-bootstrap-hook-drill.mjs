#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { spawn } from "node:child_process";
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
export const HELD_LOCK_READY_MARKER = "CHASE_SETS_HELD_LOCK_READY";
export const HELD_LOCK_TIMEOUT_MARKER = "CHASE_SETS_HELD_LOCK_TIMEOUT";
export const HELD_LOCK_SETUP_FAILED_MARKER = "CHASE_SETS_HELD_LOCK_SETUP_FAILED";
const MAX_CAPTURE_BYTES = 200_000;
const DEFAULT_HELD_LOCK_TIMEOUT_SECONDS = 1_200;
const DEFAULT_HELD_LOCK_READY_TIMEOUT_MS = 60_000;
const DEFAULT_HELD_LOCK_RELEASE_TIMEOUT_MS = 30_000;
const DEFAULT_ROLLOUT_SETTLE_ATTEMPTS = 180;
const DEFAULT_ROLLOUT_SETTLE_POLL_INTERVAL_MS = 5_000;
const QUIESCED_WORKER_COMPONENT = "platform-worker";

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
    marketplaceRootUrl: readOption(argv, "--marketplace-root-url") ?? readEnv("MARKETPLACE_ROOT_WEB_URL", env),
    helmPath: readOption(argv, "--helm") ?? readEnv("HELM_PATH", env) ?? "helm",
    kubectlPath: readOption(argv, "--kubectl") ?? readEnv("KUBECTL_PATH", env) ?? "kubectl",
    pnpmPath: readOption(argv, "--pnpm") ?? readEnv("PNPM_PATH", env) ?? "pnpm",
    heldLockTimeoutSeconds: Number(
      readOption(argv, "--held-lock-timeout-seconds") ??
        readEnv("STAGING_BOOTSTRAP_HOOK_DRILL_HELD_LOCK_TIMEOUT_SECONDS", env) ??
        DEFAULT_HELD_LOCK_TIMEOUT_SECONDS,
    ),
    heldLockReadyTimeoutMs: Number(
      readOption(argv, "--held-lock-ready-timeout-ms") ??
        readEnv("STAGING_BOOTSTRAP_HOOK_DRILL_HELD_LOCK_READY_TIMEOUT_MS", env) ??
        DEFAULT_HELD_LOCK_READY_TIMEOUT_MS,
    ),
    heldLockReleaseTimeoutMs: Number(
      readOption(argv, "--held-lock-release-timeout-ms") ??
        readEnv("STAGING_BOOTSTRAP_HOOK_DRILL_HELD_LOCK_RELEASE_TIMEOUT_MS", env) ??
        DEFAULT_HELD_LOCK_RELEASE_TIMEOUT_MS,
    ),
    rolloutSettleAttempts: Number(
      readOption(argv, "--rollout-settle-attempts") ??
        readEnv("STAGING_BOOTSTRAP_HOOK_DRILL_ROLLOUT_SETTLE_ATTEMPTS", env) ??
        DEFAULT_ROLLOUT_SETTLE_ATTEMPTS,
    ),
    rolloutSettlePollIntervalMs: Number(
      readOption(argv, "--rollout-settle-poll-interval-ms") ??
        readEnv("STAGING_BOOTSTRAP_HOOK_DRILL_ROLLOUT_SETTLE_POLL_INTERVAL_MS", env) ??
        DEFAULT_ROLLOUT_SETTLE_POLL_INTERVAL_MS,
    ),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    workflowRunId: readEnv("GITHUB_RUN_ID", env),
    workflowRunAttempt: readEnv("GITHUB_RUN_ATTEMPT", env),
    commitSha: readEnv("GITHUB_SHA", env),
  };
}

export async function runStagingBootstrapHookDrill(options, dependencies = {}) {
  const runner = dependencies.runner ?? runCommand;
  const processStarter = dependencies.processStarter ?? startCommand;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const record = createBaseRecord(options);
  const validationErrors = validateOptions(options);
  record.errors.push(...validationErrors);

  await mkdir(options.outDir, { recursive: true });
  record.heldLock = buildHeldLockNotStarted(options, now());

  if (validationErrors.length > 0) {
    await writeJsonArtifact(options, "held-lock-evidence.json", record.heldLock);
    finalizeRecord(record, now());
    await writeJsonRecord(join(options.outDir, "staging-bootstrap-hook-drill.json"), record);
    return { record, passesDrillGate: false };
  }

  let heldLockRun = null;
  try {
    record.preDrill = await captureSnapshot("pre-drill", options, runner);
    record.phases.preDrillSmoke = await runSmokePhase("pre-drill", options, runner, now);

    heldLockRun = await startHeldLockInjector(options, { runner, processStarter, now });
    record.heldLock = heldLockRun.evidence;
    await writeJsonArtifact(options, "held-lock-evidence.json", record.heldLock);

    record.phases.successfulUpgrade = await runUpgradePhase({
      phaseName: "successful-bootstrap-upgrade",
      options,
      runner,
      now,
      args: buildSuccessfulUpgradeArgs(options),
      expectSuccess: true,
    });
    record.heldLock = await observeHeldLockRelease(heldLockRun, options, now);
    await writeHeldLockOutput(options, heldLockRun);
    await writeJsonArtifact(options, "held-lock-evidence.json", record.heldLock);
    if (record.heldLock.result !== "released") {
      throw new Error("Held-lock injector did not exit during the successful bootstrap upgrade.");
    }
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
    if (heldLockRun && !heldLockRun.finished) {
      heldLockRun.handle.kill();
      record.heldLock = await observeHeldLockCleanup(heldLockRun, options, now);
      await writeHeldLockOutput(options, heldLockRun);
      await writeJsonArtifact(options, "held-lock-evidence.json", record.heldLock);
    }
    if (!heldLockRun && record.heldLock?.result === "not-started") {
      record.heldLock = {
        ...record.heldLock,
        result: "setup-failed",
        setup: {
          ...record.heldLock.setup,
          status: "failure",
          failedAt: now(),
          releaseTouched: false,
          error: summarizeError(error),
        },
      };
      await writeJsonArtifact(options, "held-lock-evidence.json", record.heldLock);
    }
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

export function buildHeldLockNotStarted(options, checkedAt) {
  return {
    schemaVersion: "staging-bootstrap-hook-held-lock-evidence/v1",
    checkedAt,
    environment: options.environment,
    release: options.release,
    namespace: options.namespace,
    result: "not-started",
    liveHeldLockInjection: "worker-pod-kubectl-exec",
    bootstrapTouchedRelation: {
      context: "catalog",
      schema: null,
      table: "bounded_context_schema_migrations",
      lockMode: "ACCESS EXCLUSIVE",
      schemaDiscovery: "runtime-pg-tables",
      sourceEvidence: "deployables/platform-api/__tests__/bootstrap-integration.test.ts",
    },
    supportSafe: true,
    redaction: {
      databaseUrls: "not-read-by-workflow",
      credentials: "not-read-by-workflow",
      rawPodNames: "fingerprinted",
      customerOrProviderData: "not-read",
    },
    setup: {
      status: "not-started",
      releaseTouched: false,
    },
  };
}

export function buildHeldLockInjectorExecArgs(options, podName) {
  return [
    "exec",
    "--namespace",
    options.namespace,
    podName,
    "--container",
    "platform-worker",
    "--",
    "sh",
    "-lc",
    buildHeldLockInjectorShell(options),
  ];
}

export function buildHeldLockInjectorShell(options) {
  return `CHASE_SETS_HELD_LOCK_TIMEOUT_SECONDS=${Number(options.heldLockTimeoutSeconds)} node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import pg from "pg";

const { Client } = pg;
const timeoutSeconds = Number(process.env.CHASE_SETS_HELD_LOCK_TIMEOUT_SECONDS || "1200");
const databaseUrl = process.env.DATABASE_URL_CATALOG;
const schemaMigrationsTable = "bounded_context_schema_migrations";

if (!databaseUrl) {
  console.error("${HELD_LOCK_SETUP_FAILED_MARKER} " + JSON.stringify({ reason: "missing-catalog-database-url" }));
  process.exit(2);
}

function normalizeConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
    if (sslMode && sslMode !== "disable" && !url.searchParams.has("uselibpqcompat")) {
      url.searchParams.set("uselibpqcompat", "true");
      return url.toString();
    }
  } catch {
    return connectionString;
  }
  return connectionString;
}

function resolveSslConfig(connectionString, env) {
  const parsed = parseConnectionString(connectionString);
  if (!parsed) {
    return undefined;
  }

  const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();
  if (sslMode === "disable") {
    return undefined;
  }
  if (sslMode === "require") {
    return { rejectUnauthorized: false };
  }
  if (sslMode === "verify-ca" || sslMode === "verify-full") {
    return verifyingSslConfig(parsed, env);
  }
  if (!isLocalDatabaseHost(parsed.hostname)) {
    return verifyingSslConfig(parsed, env);
  }
  return undefined;
}

function verifyingSslConfig(connectionString, env) {
  const caPath = connectionString.searchParams.get("sslrootcert") ?? env.PGSSLROOTCERT;
  const ca = caPath ? readFileSync(caPath, "utf8") : undefined;
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

function parseConnectionString(connectionString) {
  try {
    return new URL(connectionString);
  } catch {
    return null;
  }
}

function isLocalDatabaseHost(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function summarizeSafeError(error) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  return {
    reason: "injector-error",
    name: error instanceof Error ? error.name : typeof error,
    code,
  };
}

function quoteIdentifier(identifier) {
  return '"' + String(identifier).replaceAll('"', '""') + '"';
}

async function discoverSchemaMigrationsRelation(client) {
  const result = await client.query(
    "SELECT schemaname FROM pg_tables WHERE tablename = $1 ORDER BY schemaname",
    [schemaMigrationsTable],
  );
  const schemas = result.rows.map((row) => row.schemaname).filter((schema) => typeof schema === "string");
  if (schemas.length === 1) {
    return {
      ok: true,
      schema: schemas[0],
      relation: schemas[0] + "." + schemaMigrationsTable,
      lockTarget: quoteIdentifier(schemas[0]) + "." + quoteIdentifier(schemaMigrationsTable),
    };
  }

  if (schemas.length > 1) {
    return {
      ok: false,
      reason: "multiple-relations",
      table: schemaMigrationsTable,
      candidates: schemas.map((schema) => schema + "." + schemaMigrationsTable),
    };
  }

  const schemasPresentResult = await client.query(
    "SELECT nspname AS schema FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY nspname",
  );
  const databaseResult = await client.query("SELECT current_database() AS database");
  return {
    ok: false,
    reason: "missing-relation",
    table: schemaMigrationsTable,
    database: databaseResult.rows[0]?.database ?? null,
    schemasPresent: schemasPresentResult.rows
      .map((row) => row.schema)
      .filter((schema) => typeof schema === "string"),
  };
}

const connectionString = normalizeConnectionString(databaseUrl);
const client = new Client({
  connectionString,
  ssl: resolveSslConfig(connectionString, process.env),
  application_name: "staging-bootstrap-hook-drill-held-lock",
});

try {
  await client.connect();
  try {
    const relationDiscovery = await discoverSchemaMigrationsRelation(client);
    if (!relationDiscovery.ok) {
      console.error("${HELD_LOCK_SETUP_FAILED_MARKER} " + JSON.stringify(relationDiscovery));
      await client.end().catch(() => undefined);
      process.exit(3);
    }

    await client.query("SET statement_timeout = 0");
    await client.query("SET lock_timeout = '5s'");
    await client.query("BEGIN");
    await client.query(\`LOCK TABLE \${relationDiscovery.lockTarget} IN ACCESS EXCLUSIVE MODE\`);
    console.log("${HELD_LOCK_READY_MARKER} " + JSON.stringify({
      context: "catalog",
      schema: relationDiscovery.schema,
      table: schemaMigrationsTable,
      relation: relationDiscovery.relation,
      lockMode: "ACCESS EXCLUSIVE",
      readyAt: new Date().toISOString(),
    }));
    await new Promise((resolve) => setTimeout(resolve, timeoutSeconds * 1000));
    await client.query("ROLLBACK");
    console.log("${HELD_LOCK_TIMEOUT_MARKER} " + JSON.stringify({ releasedBy: "injector-timeout" }));
  } finally {
    await client.end().catch(() => undefined);
  }
} catch (error) {
  console.error("${HELD_LOCK_SETUP_FAILED_MARKER} " + JSON.stringify(summarizeSafeError(error)));
  process.exit(3);
}
NODE`;
}

export function selectReadyWorkerPodName(raw) {
  const parsed = JSON.parse(raw || '{"items":[]}');
  const pod = (parsed.items ?? []).find((item) => {
    const ready = (item.status?.conditions ?? []).some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    );
    return item.status?.phase === "Running" && !item.metadata?.deletionTimestamp && ready;
  });
  return pod?.metadata?.name ?? null;
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
      expectedReplicas: item.spec?.replicas ?? 1,
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

async function startHeldLockInjector(options, dependencies) {
  const startedAt = dependencies.now();
  const pods = await dependencies.runner(options.kubectlPath, [
    "get",
    "pods",
    "--namespace",
    options.namespace,
    "--selector",
    `app.kubernetes.io/instance=${options.release},app.kubernetes.io/component=platform-worker`,
    "-o",
    "json",
  ]);
  const podName = selectReadyWorkerPodName(pods.stdout);
  if (!podName) {
    throw new Error("Held-lock injector setup failed: no ready platform-worker pod was available.");
  }

  const handle = dependencies.processStarter(options.kubectlPath, buildHeldLockInjectorExecArgs(options, podName), {
    env: process.env,
  });
  const run = {
    handle,
    finished: false,
    stdout: "",
    stderr: "",
    evidence: {
      ...buildHeldLockNotStarted(options, startedAt),
      result: "setup-running",
      setup: {
        status: "running",
        startedAt,
        releaseTouched: false,
      },
      runtimePath: {
        component: "platform-worker",
        container: "platform-worker",
        podNameFingerprint: fingerprint(podName),
      },
    },
  };

  handle.onStdout((text) => {
    run.stdout = `${run.stdout}${text}`;
  });
  handle.onStderr((text) => {
    run.stderr = `${run.stderr}${text}`;
  });
  handle.wait.then(
    () => {
      run.finished = true;
    },
    () => {
      run.finished = true;
    },
  );

  try {
    await waitForHeldLockReady(run, options.heldLockReadyTimeoutMs);
  } catch (error) {
    handle.kill();
    run.evidence = {
      ...run.evidence,
      result: "setup-failed",
      setup: {
        ...run.evidence.setup,
        status: "failure",
        failedAt: dependencies.now(),
        releaseTouched: false,
        error: summarizeError(error),
      },
    };
    await writeHeldLockOutput(options, run);
    await writeJsonArtifact(options, "held-lock-evidence.json", run.evidence);
    throw error;
  }

  run.evidence = {
    ...run.evidence,
    result: "held",
    bootstrapTouchedRelation: {
      ...run.evidence.bootstrapTouchedRelation,
      schema: parseHeldLockReadyMetadata(run.stdout)?.schema ?? run.evidence.bootstrapTouchedRelation.schema,
    },
    setup: {
      ...run.evidence.setup,
      status: "success",
      readyAt: dependencies.now(),
      releaseTouched: false,
    },
  };
  return run;
}

async function waitForHeldLockReady(run, timeoutMs) {
  if (run.stdout.includes(HELD_LOCK_READY_MARKER)) {
    return;
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`Held-lock injector did not report ready within ${timeoutMs}ms.`));
    }, timeoutMs);
    run.handle.onStdout((text) => {
      if (text.includes(HELD_LOCK_READY_MARKER)) {
        finish(resolve);
      }
    });
    run.handle.wait.then((result) => {
      if (!settled) {
        finish(
          reject,
          new Error(`Held-lock injector exited before acquiring the lock with exit code ${result.exitCode}.`),
        );
      }
    });
  });
}

function parseHeldLockReadyMetadata(output) {
  const line = String(output ?? "")
    .split(/\r?\n/)
    .find((entry) => entry.includes(HELD_LOCK_READY_MARKER));
  if (!line) {
    return null;
  }
  const markerIndex = line.indexOf(HELD_LOCK_READY_MARKER);
  const jsonText = line.slice(markerIndex + HELD_LOCK_READY_MARKER.length).trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

async function observeHeldLockRelease(run, options, now) {
  const result = await waitForProcessExit(run.handle, options.heldLockReleaseTimeoutMs);
  run.finished = result.exited;
  const timedOut = run.stdout.includes(HELD_LOCK_TIMEOUT_MARKER);
  return {
    ...run.evidence,
    result: result.exited && !timedOut ? "released" : "release-not-observed",
    setup: {
      ...run.evidence.setup,
      releaseTouched: true,
    },
    lockRelease: {
      status: result.exited && !timedOut ? "observed" : "not-observed",
      observedAt: now(),
      releasedDuring: "successful-bootstrap-upgrade",
      execExitCode: result.exitCode,
      injectorTimedOut: timedOut,
    },
  };
}

async function observeHeldLockCleanup(run, options, now) {
  const result = await waitForProcessExit(run.handle, options.heldLockReleaseTimeoutMs);
  run.finished = result.exited;
  return {
    ...run.evidence,
    result: "cleanup-after-failure",
    cleanup: {
      status: result.exited ? "observed" : "not-observed",
      observedAt: now(),
      execExitCode: result.exitCode,
      reason: "drill-ended-before-held-lock-release-proof",
    },
  };
}

async function waitForProcessExit(handle, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ exited: false, exitCode: null }), timeoutMs);
  });
  const result = await Promise.race([handle.wait.then((value) => ({ exited: true, ...value })), timeout]);
  clearTimeout(timer);
  return result;
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
  if (!options.landingUrl || !options.adminUrl || !options.marketplaceUrl) {
    errors.push("Landing, admin, and marketplace smoke URLs are required.");
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
  const settledSnapshot = await captureSettledKubernetesSnapshot(label, options, runner);
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
  await writeJsonArtifact(options, `${label}-deployment-images-generations.json`, settledSnapshot.deployments);
  await writeJsonArtifact(options, `${label}-ready-pod-uid-fingerprints.json`, settledSnapshot.readyPodUidFingerprints);
  await writeJsonArtifact(options, `${label}-rollout-settle.json`, settledSnapshot.rolloutSettle);
  await writeJsonArtifact(options, `${label}-k8s-events.json`, summarizeEvents(events.stdout));

  return {
    helmRevision: readHelmRevision(statusJson.stdout),
    deployments: settledSnapshot.deployments,
    readyPodUidFingerprints: settledSnapshot.readyPodUidFingerprints,
    rolloutSettle: settledSnapshot.rolloutSettle,
  };
}

async function captureSettledKubernetesSnapshot(label, options, runner) {
  const attempts = Math.max(1, options.rolloutSettleAttempts ?? DEFAULT_ROLLOUT_SETTLE_ATTEMPTS);
  let lastSnapshot = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const deploymentsResult = await runCaptured(runner, options.kubectlPath, [
      "get",
      "deployments",
      "--namespace",
      options.namespace,
      "--selector",
      `app.kubernetes.io/instance=${options.release},app.kubernetes.io/name=chase-sets-platform`,
      "-o",
      "json",
    ]);
    const podsResult = await runCaptured(runner, options.kubectlPath, [
      "get",
      "pods",
      "--namespace",
      options.namespace,
      "--selector",
      `app.kubernetes.io/instance=${options.release},app.kubernetes.io/name=chase-sets-platform`,
      "-o",
      "json",
    ]);
    const deployments = summarizeDeploymentSnapshot(deploymentsResult.stdout);
    const readyPodUidFingerprints = summarizeReadyPodUidFingerprints(podsResult.stdout);
    const rolloutSettle = evaluateRolloutSettle(label, attempt, deployments, readyPodUidFingerprints);
    lastSnapshot = { deployments, readyPodUidFingerprints, rolloutSettle };
    if (rolloutSettle.status === "settled") {
      return lastSnapshot;
    }
    if (attempt < attempts) {
      await sleep(options.rolloutSettlePollIntervalMs ?? DEFAULT_ROLLOUT_SETTLE_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `${label} rollout did not settle before fingerprint capture: ${lastSnapshot?.rolloutSettle?.reason ?? "unknown"}.`,
  );
}

function evaluateRolloutSettle(label, attempt, deployments, readyPodUidFingerprints) {
  const readyPodsByComponent = groupPodUidFingerprintsByComponent(readyPodUidFingerprints);
  const unsettled = deployments.flatMap((deployment) => {
    const expectedReplicas = deployment.expectedReplicas ?? 0;
    const readyPodCount = readyPodsByComponent.get(deployment.component)?.length ?? 0;
    const reasons = [];
    if (deployment.observedGeneration !== deployment.generation) {
      reasons.push("generation-not-observed");
    }
    if (deployment.replicas !== expectedReplicas) {
      reasons.push("replica-count-not-settled");
    }
    if (deployment.readyReplicas !== expectedReplicas) {
      reasons.push("ready-replica-count-not-settled");
    }
    if (readyPodCount !== expectedReplicas) {
      reasons.push("ready-pod-count-not-settled");
    }
    return reasons.length === 0
      ? []
      : [
          {
            component: deployment.component,
            expectedReplicas,
            replicas: deployment.replicas,
            readyReplicas: deployment.readyReplicas,
            readyPodCount,
            reasons,
          },
        ];
  });
  return unsettled.length === 0
    ? { status: "settled", label, attempt }
    : { status: "waiting", label, attempt, reason: "rollout-not-settled", unsettled };
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
    SMOKE_WRITE_WAITLIST: "false",
    SMOKE_FETCH_ATTEMPTS: process.env.SMOKE_FETCH_ATTEMPTS ?? "24",
    SMOKE_FETCH_RETRY_DELAY_MS: process.env.SMOKE_FETCH_RETRY_DELAY_MS ?? "5000",
    SMOKE_FETCH_TIMEOUT_MS: process.env.SMOKE_FETCH_TIMEOUT_MS ?? "15000",
  };
  const result = await runner(
    options.pnpmPath,
    ["run", "smoke:platform", "--", options.landingUrl, options.adminUrl, options.marketplaceUrl],
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
  const servingComponents = (before?.deployments ?? [])
    .map((deployment) => deployment.component)
    .filter((component) => component !== QUIESCED_WORKER_COMPONENT)
    .sort((left, right) => left.localeCompare(right, "en"));
  const beforePodsByComponent = groupPodUidFingerprintsByComponent(before?.readyPodUidFingerprints ?? []);
  const afterPodsByComponent = groupPodUidFingerprintsByComponent(after?.readyPodUidFingerprints ?? []);
  const servingBeforePods = serializeComponentPodFingerprints(servingComponents, beforePodsByComponent);
  const servingAfterPods = serializeComponentPodFingerprints(servingComponents, afterPodsByComponent);
  const beforeWorkerUidFingerprints = beforePodsByComponent.get(QUIESCED_WORKER_COMPONENT) ?? [];
  const afterWorkerUidFingerprints = afterPodsByComponent.get(QUIESCED_WORKER_COMPONENT) ?? [];
  const workerExpectedReplicas =
    after?.deployments?.find((deployment) => deployment.component === QUIESCED_WORKER_COMPONENT)?.expectedReplicas ?? 1;
  const workerReturnedReady = afterWorkerUidFingerprints.length === workerExpectedReplicas;
  const workerUidChanged =
    beforeWorkerUidFingerprints.length === workerExpectedReplicas &&
    workerReturnedReady &&
    JSON.stringify(beforeWorkerUidFingerprints) !== JSON.stringify(afterWorkerUidFingerprints);
  const deploymentImagesStable = beforeImages === afterImages;
  const servingReadyPodUidFingerprintsStable = servingBeforePods === servingAfterPods;
  return {
    status:
      deploymentImagesStable && servingReadyPodUidFingerprintsStable && workerReturnedReady && workerUidChanged
        ? "success"
        : "failure",
    baselineHelmRevision: before?.helmRevision ?? null,
    postFailureHelmRevision: after?.helmRevision ?? null,
    deploymentImagesStable,
    readyPodUidFingerprintsStable: servingReadyPodUidFingerprintsStable,
    servingReadyPodUidFingerprintsStable,
    servingComponents,
    quiescedWorkerComponent: QUIESCED_WORKER_COMPONENT,
    platformWorkerReturnedReady: workerReturnedReady,
    platformWorkerUidChanged: workerUidChanged,
    platformWorkerExpectedReplicas: workerExpectedReplicas,
    platformWorkerBeforeUidFingerprints: beforeWorkerUidFingerprints,
    platformWorkerAfterUidFingerprints: afterWorkerUidFingerprints,
  };
}

function groupPodUidFingerprintsByComponent(pods) {
  const grouped = new Map();
  for (const pod of pods) {
    const component = pod.component ?? "unknown";
    grouped.set(component, [...(grouped.get(component) ?? []), pod.uidFingerprint]);
  }
  for (const [component, uidFingerprints] of grouped.entries()) {
    grouped.set(
      component,
      [...uidFingerprints].sort((left, right) => left.localeCompare(right, "en")),
    );
  }
  return grouped;
}

function serializeComponentPodFingerprints(components, podsByComponent) {
  return JSON.stringify(components.map((component) => [component, podsByComponent.get(component) ?? []]));
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
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

export async function runCommand(command, args, options = {}) {
  try {
    const result = await execFile(command, args, {
      env: options.env ?? process.env,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = {
      exitCode: error?.code ?? 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? summarizeError(error),
    };
    if (options.allowFailure) {
      return result;
    }
    throw error;
  }
}

function startCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    windowsHide: true,
  });
  const stdoutListeners = [];
  const stderrListeners = [];
  const wait = new Promise((resolve) => {
    child.on("error", (error) => {
      resolve({ exitCode: 1, error: summarizeError(error) });
    });
    child.on("close", (code, signal) => {
      resolve({ exitCode: signal ? 1 : (code ?? 0) });
    });
  });

  child.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    for (const listener of stdoutListeners) {
      listener(text);
    }
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    for (const listener of stderrListeners) {
      listener(text);
    }
  });

  return {
    wait,
    onStdout(listener) {
      stdoutListeners.push(listener);
    },
    onStderr(listener) {
      stderrListeners.push(listener);
    },
    kill() {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}

async function writeHeldLockOutput(options, run) {
  await writeTextArtifact(
    options,
    "held-lock-injector-output.txt",
    [`stdout:\n${run.stdout ?? ""}`, `stderr:\n${run.stderr ?? ""}`].join("\n"),
  );
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
  return limitOutput(redactSupportUnsafeText(error instanceof Error ? error.message : String(error)));
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
