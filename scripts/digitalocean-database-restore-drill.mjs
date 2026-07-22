#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { rm } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { postgresClientConfig, postgresFailureFields, safeFailureFields } from "./lib/postgres-connection.mjs";
import {
  createDigitalOceanDatabaseFork,
  waitForDigitalOceanDatabaseForkAvailability,
} from "./production-db-restore-point.mjs";
import {
  fetchDigitalOceanManagedPostgresCa,
  managedPostgresConnectionUrl,
  writeManagedPostgresCa,
} from "./terraform-state-database-urls.mjs";

const execFile = promisify(execFileCallback);
const { Client } = pg;

export const DIGITALOCEAN_DATABASE_RESTORE_DRILL_VERSION = "digitalocean-database-restore-drill/v1";
export const STAGING_RESTORE_DRILL_PREFIX = "cs-stg-drill-";
export const DEFAULT_STAGING_RESTORE_DRILL_FORK_TIMEOUT_MS = 75 * 60 * 1000;
export const DEFAULT_STAGING_RESTORE_DRILL_FORK_POLL_INTERVAL_MS = 30 * 1000;
const STAGING_CONTEXT_DATABASE_PREFIX = "chase_sets_staging_";
const STAGING_DATABASE_CONTEXT_TOKEN_OVERRIDES = new Map([["platform_ops", "platform-operations"]]);

export const DEFAULT_STAGING_DATABASE_CHECKS = Object.freeze([
  { contextName: "auth", databaseName: "chase_sets_staging_auth", eventStoreTables: true },
  { contextName: "catalog", databaseName: "chase_sets_staging_catalog", eventStoreTables: true },
  { contextName: "checkout", databaseName: "chase_sets_staging_checkout", eventStoreTables: true },
  {
    contextName: "commercial-terms",
    databaseName: "chase_sets_staging_commercial_terms",
    eventStoreTables: true,
  },
  { contextName: "control", databaseName: "chase_sets_staging_control", eventStoreTables: false },
  { contextName: "discovery", databaseName: "chase_sets_staging_discovery", eventStoreTables: true },
  { contextName: "fulfillment", databaseName: "chase_sets_staging_fulfillment", eventStoreTables: true },
  { contextName: "identity", databaseName: "chase_sets_staging_identity", eventStoreTables: true },
  { contextName: "inventory", databaseName: "chase_sets_staging_inventory", eventStoreTables: true },
  { contextName: "marketplace", databaseName: "chase_sets_staging_marketplace", eventStoreTables: true },
  { contextName: "notifications", databaseName: "chase_sets_staging_notifications", eventStoreTables: true },
  { contextName: "ordering", databaseName: "chase_sets_staging_ordering", eventStoreTables: true },
  { contextName: "payments", databaseName: "chase_sets_staging_payments", eventStoreTables: true },
  { contextName: "platform-operations", databaseName: "chase_sets_staging_platform_ops", eventStoreTables: true },
  { contextName: "pricing", databaseName: "chase_sets_staging_pricing", eventStoreTables: true },
  { contextName: "public-presence", databaseName: "chase_sets_staging_public_presence", eventStoreTables: true },
  { contextName: "settlement", databaseName: "chase_sets_staging_settlement", eventStoreTables: true },
]);

export function parseDigitalOceanDatabaseRestoreDrillArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("DIGITALOCEAN_DATABASE_RESTORE_DRILL_OUT", env),
    doctlPath: readOption(argv, "--doctl") ?? readEnv("DOCTL_PATH", env) ?? "doctl",
    sourceClusterId: readOption(argv, "--source-cluster-id") ?? readEnv("STAGING_DATABASE_CLUSTER_ID", env),
    digitalOceanToken: readEnv("DIGITALOCEAN_ACCESS_TOKEN", env),
    caPath: readOption(argv, "--ca-path") ?? readEnv("MANAGED_POSTGRES_CA_PATH", env),
    environment: readOption(argv, "--environment") ?? readEnv("DEPLOYMENT_ENVIRONMENT", env) ?? "staging",
    workflowRunId: readOption(argv, "--workflow-run-id") ?? readEnv("GITHUB_RUN_ID", env),
    workflowRunAttempt: readOption(argv, "--workflow-run-attempt") ?? readEnv("GITHUB_RUN_ATTEMPT", env),
    commitSha: readOption(argv, "--commit-sha") ?? readEnv("GITHUB_SHA", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    forkTimeoutMs: parsePositiveSecondsAsMs(
      readOption(argv, "--fork-timeout-seconds") ??
        readEnv("RESTORE_DRILL_FORK_TIMEOUT_SECONDS", env) ??
        String(DEFAULT_STAGING_RESTORE_DRILL_FORK_TIMEOUT_MS / 1000),
      "RESTORE_DRILL_FORK_TIMEOUT_SECONDS",
    ),
    forkPollIntervalMs: parsePositiveSecondsAsMs(
      readOption(argv, "--fork-poll-seconds") ??
        readEnv("RESTORE_DRILL_FORK_POLL_SECONDS", env) ??
        String(DEFAULT_STAGING_RESTORE_DRILL_FORK_POLL_INTERVAL_MS / 1000),
      "RESTORE_DRILL_FORK_POLL_SECONDS",
    ),
    databaseChecks: parseDatabaseChecks(
      readOption(argv, "--database-checks") ?? readEnv("RESTORE_DRILL_DATABASE_CHECKS", env),
    ),
  };
}

export async function runDigitalOceanDatabaseRestoreDrill(options, dependencies = {}) {
  const result = await performDigitalOceanDatabaseRestoreDrill(options, dependencies);
  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }
  return result;
}

export async function performDigitalOceanDatabaseRestoreDrill(options, dependencies = {}) {
  const exec = dependencies.execFile ?? execFile;
  const ClientClass = dependencies.Client ?? Client;
  const fetchCa = dependencies.fetchManagedPostgresCa ?? fetchDigitalOceanManagedPostgresCa;
  const writeCa = dependencies.writeManagedPostgresCa ?? writeManagedPostgresCa;
  const removeCa = dependencies.rm ?? rm;
  const now = dependencies.now ?? (() => Date.now());
  const errors = validateOptions(options);
  const baseRecord = createBaseRecord(options, errors);

  if (errors.length > 0) {
    return { record: baseRecord, passesRestoreDrillGate: false };
  }

  let record = baseRecord;
  const forkName = buildStagingRestoreDrillName(options);
  let forkClusterId = null;
  const forkStartedMs = now();

  try {
    const fork = await createDigitalOceanDatabaseFork(
      {
        doctlPath: options.doctlPath,
        sourceClusterId: options.sourceClusterId,
        forkName,
        wait: false,
      },
      exec,
    );
    forkClusterId = fork.clusterId;
    const availability = fork.clusterId
      ? await waitForDigitalOceanDatabaseForkAvailability(
          {
            doctlPath: options.doctlPath,
            clusterId: fork.clusterId,
            forkName,
            initialFork: fork,
            timeoutMs: options.forkTimeoutMs ?? DEFAULT_STAGING_RESTORE_DRILL_FORK_TIMEOUT_MS,
            pollIntervalMs: options.forkPollIntervalMs ?? DEFAULT_STAGING_RESTORE_DRILL_FORK_POLL_INTERVAL_MS,
          },
          dependencies,
        )
      : { outcome: "missing-cluster-id", fork, elapsedMs: 0 };
    const latestFork = availability.fork ?? fork;
    const forkFinishedMs = now();
    const forkReachedAvailable = availability.outcome === "available";
    record = {
      ...record,
      fork: {
        ...record.fork,
        clusterId: latestFork.clusterId,
        name: latestFork.name ?? forkName,
        status: latestFork.status,
        createdAt: latestFork.createdAt,
      },
      timings: {
        forkStartedAt: isoFromMs(forkStartedMs),
        forkWaitFinishedAt: isoFromMs(forkFinishedMs),
        forkWaitMs: forkFinishedMs - forkStartedMs,
        forkAvailableAt: forkReachedAvailable ? isoFromMs(forkFinishedMs) : null,
        forkToAvailableMs: forkReachedAvailable ? forkFinishedMs - forkStartedMs : null,
      },
    };

    if (!fork.clusterId) {
      record.errors.push("doctl database fork output did not include a forked cluster id.");
    } else if (availability.outcome === "timeout") {
      record.errors.push(`Timed out waiting for staging restore drill fork '${forkName}' to become online.`);
      record.errors.push(`last observed cluster id: ${latestFork.clusterId ?? "unknown"}`);
      record.errors.push(`last observed status: ${latestFork.status ?? "unknown"}`);
    } else if (availability.outcome === "failed") {
      record.errors.push(
        `Staging restore drill fork '${forkName}' entered failed status '${latestFork.status ?? "unknown"}'.`,
      );
    } else if (availability.outcome !== "available") {
      record.errors.push(`Staging restore drill fork '${forkName}' did not report an available outcome.`);
    } else {
      const certificate = await fetchCa(
        { clusterId: fork.clusterId, digitalOceanToken: options.digitalOceanToken },
        dependencies,
      );
      await writeCa(options.caPath, certificate);
      const connectionUri = managedPostgresConnectionUrl(
        await readConnectionUri(options.doctlPath, fork.clusterId, exec),
        options.caPath,
      );
      const databaseChecks =
        options.databaseChecks ??
        (await discoverForkDatabaseChecks({
          connectionUri,
          ClientClass,
          certificate,
        }));
      record = {
        ...record,
        validation: await validateForkDatabases({
          connectionUri,
          databaseChecks,
          ClientClass,
          certificate,
        }),
      };
    }
  } catch (error) {
    record = {
      ...record,
      fork: {
        ...record.fork,
        clusterId: forkClusterId,
        name: forkName,
        status: forkClusterId ? "validation-failed" : "create-failed",
      },
      errors: [...record.errors, ...describeFailure(error, "digitalocean-restore-drill-failed")],
    };
  } finally {
    if (options.caPath) {
      try {
        await removeCa(options.caPath, { force: true });
      } catch (error) {
        record.errors.push(...describeFailure(error, "managed-postgres-ca-cleanup-failed"));
      }
    }
    if (forkClusterId) {
      const cleanupStartedMs = now();
      record = {
        ...record,
        cleanup: await deleteDatabaseFork(options.doctlPath, forkClusterId, exec),
        timings: {
          ...record.timings,
          cleanupStartedAt: isoFromMs(cleanupStartedMs),
          cleanupFinishedAt: isoFromMs(now()),
        },
      };
    }
  }

  record = finalizeRecord(record);
  return { record, passesRestoreDrillGate: record.result === "success" };
}

export function buildStagingRestoreDrillName(options) {
  const dateToken = options.checkedAt?.slice(0, 10).replaceAll("-", "") || "unknown";
  const runToken = sanitizeNameToken(options.workflowRunId ?? "local");
  const attemptToken = sanitizeNameToken(options.workflowRunAttempt ?? "1");
  return `${STAGING_RESTORE_DRILL_PREFIX}${dateToken}-${runToken}-${attemptToken}`.slice(0, 63);
}

export async function readConnectionUri(doctlPath, clusterId, exec) {
  const { stdout } = await exec(
    doctlPath ?? "doctl",
    ["databases", "connection", clusterId, "--format", "URI", "--no-header"],
    {
      maxBuffer: 1024 * 1024,
    },
  );
  const uri = stdout.trim();
  if (!uri) {
    throw new Error("doctl database connection did not return a connection URI.");
  }
  return uri;
}

export async function validateForkDatabases(options) {
  const checks = [];
  for (const databaseCheck of options.databaseChecks) {
    checks.push(await validateForkDatabase({ ...options, databaseCheck }));
  }
  return {
    expectedDatabaseCount: options.databaseChecks.length,
    checkedDatabaseCount: checks.length,
    checks,
  };
}

export async function discoverForkDatabaseChecks(options) {
  const client = new options.ClientClass({
    ...postgresClientConfig(options.connectionUri, {}, () => options.certificate),
    application_name: "chase_sets_restore_drill_discovery",
  });

  try {
    await client.connect();
    const result = await client.query(
      "SELECT datname AS database_name FROM pg_database WHERE datname LIKE $1 ORDER BY datname ASC",
      [`${STAGING_CONTEXT_DATABASE_PREFIX}%`],
    );
    const checks = result.rows.map((row) => stagingDatabaseCheckFromName(row.database_name)).filter(Boolean);
    if (checks.length === 0) {
      throw new Error("No staging context databases were discovered on the restore drill fork.");
    }
    return checks;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function validateForkDatabase(options) {
  const startedAt = new Date().toISOString();
  const connectionString = databaseUrlForDatabase(options.connectionUri, options.databaseCheck.databaseName);
  const client = new options.ClientClass({
    ...postgresClientConfig(connectionString, {}, () => options.certificate),
    application_name: "chase_sets_restore_drill",
  });
  const base = {
    contextName: options.databaseCheck.contextName,
    databaseName: options.databaseCheck.databaseName,
    eventStoreTablesExpected: Boolean(options.databaseCheck.eventStoreTables),
    status: "failure",
    startedAt,
    finishedAt: null,
    eventStore: null,
    errors: [],
  };

  try {
    await client.connect();
    const databaseResult = await client.query("SELECT current_database() AS database_name");
    const actualDatabaseName = databaseResult.rows[0]?.database_name ?? null;
    if (actualDatabaseName !== options.databaseCheck.databaseName) {
      throw new Error(
        `Connected database '${actualDatabaseName ?? "unknown"}' did not match '${options.databaseCheck.databaseName}'.`,
      );
    }

    const eventStore = options.databaseCheck.eventStoreTables
      ? await validateEventStoreTables(client)
      : { skipped: true, reason: "control database does not own bounded-context event-store tables." };
    return {
      ...base,
      status: "success",
      finishedAt: new Date().toISOString(),
      eventStore,
    };
  } catch (error) {
    return {
      ...base,
      finishedAt: new Date().toISOString(),
      errors: describeFailure(error, "restore-drill-database-validation-failed"),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function validateEventStoreTables(client) {
  const presence = await client.query(
    "SELECT to_regclass('public.event_store_streams')::text AS streams_table, to_regclass('public.event_store_events')::text AS events_table",
  );
  const row = presence.rows[0] ?? {};
  const missing = [
    ["event_store_streams", row.streams_table],
    ["event_store_events", row.events_table],
  ]
    .filter(([, value]) => value !== "event_store_streams" && value !== "event_store_events")
    .map(([tableName]) => tableName);
  if (missing.length > 0) {
    throw new Error(`Missing expected event-store table(s): ${missing.join(", ")}.`);
  }

  const streams = await client.query("SELECT COUNT(*)::text AS row_count FROM public.event_store_streams");
  const events = await client.query(
    "SELECT COALESCE(MAX(global_position), 0)::text AS max_global_position FROM public.event_store_events",
  );
  return {
    skipped: false,
    tables: ["event_store_streams", "event_store_events"],
    streamCount: streams.rows[0]?.row_count ?? "0",
    maxGlobalPosition: events.rows[0]?.max_global_position ?? "0",
  };
}

export async function deleteDatabaseFork(doctlPath, clusterId, exec) {
  try {
    await exec(doctlPath ?? "doctl", ["databases", "delete", clusterId, "--force"], { maxBuffer: 1024 * 1024 });
    return {
      attempted: true,
      clusterId,
      status: "deleted",
      errors: [],
    };
  } catch (error) {
    return {
      attempted: true,
      clusterId,
      status: "delete-failed",
      errors: describeFailure(error, "restore-drill-fork-delete-failed"),
    };
  }
}

export function databaseUrlForDatabase(connectionUri, databaseName) {
  const url = new URL(connectionUri);
  url.pathname = `/${encodeURIComponent(databaseName)}`;
  return url.toString();
}

function createBaseRecord(options, errors) {
  return {
    schemaVersion: DIGITALOCEAN_DATABASE_RESTORE_DRILL_VERSION,
    checkedAt: options.checkedAt,
    environment: options.environment ?? "staging",
    sourceClusterId: options.sourceClusterId ?? "",
    workflowRunId: options.workflowRunId ?? "",
    workflowRunAttempt: options.workflowRunAttempt ?? "",
    commitSha: options.commitSha ?? "",
    fork: {
      type: "digitalocean-database-fork",
      clusterId: null,
      name: null,
      status: null,
      createdAt: null,
    },
    timings: {
      forkStartedAt: null,
      forkWaitFinishedAt: null,
      forkWaitMs: null,
      forkAvailableAt: null,
      forkToAvailableMs: null,
      cleanupStartedAt: null,
      cleanupFinishedAt: null,
    },
    validation: {
      expectedDatabaseCount: (options.databaseChecks ?? DEFAULT_STAGING_DATABASE_CHECKS).length,
      checkedDatabaseCount: 0,
      checks: [],
    },
    cleanup: {
      attempted: false,
      clusterId: null,
      status: "not-needed",
      errors: [],
    },
    result: "failure",
    errors,
  };
}

function finalizeRecord(record) {
  const validationFailures = record.validation.checks
    .filter((check) => check.status !== "success")
    .map((check) => `${check.contextName}: ${check.errors.join("; ") || "validation failed"}`);
  const cleanupErrors = record.cleanup.errors ?? [];
  const errors = [...record.errors, ...validationFailures, ...cleanupErrors];
  return {
    ...record,
    result: errors.length === 0 ? "success" : "failure",
    errors,
  };
}

function validateOptions(options) {
  const errors = [];
  if (options.environment !== "staging") {
    errors.push("DigitalOcean database restore drill is staging-only; DEPLOYMENT_ENVIRONMENT must be staging.");
  }
  if (!isNonEmptyString(options.sourceClusterId)) {
    errors.push("STAGING_DATABASE_CLUSTER_ID is required.");
  }
  if (!isNonEmptyString(options.digitalOceanToken)) {
    errors.push("DIGITALOCEAN_ACCESS_TOKEN is required.");
  }
  if (!isNonEmptyString(options.caPath)) {
    errors.push("MANAGED_POSTGRES_CA_PATH or --ca-path is required.");
  }
  if (!isNonEmptyString(options.workflowRunId)) {
    errors.push("GITHUB_RUN_ID is required.");
  }
  if (!isNonEmptyString(options.workflowRunAttempt)) {
    errors.push("GITHUB_RUN_ATTEMPT is required.");
  }
  if (!Number.isFinite(Date.parse(options.checkedAt))) {
    errors.push("--checked-at must be an ISO-8601 timestamp.");
  }
  if (!isPositiveNumber(options.forkTimeoutMs ?? DEFAULT_STAGING_RESTORE_DRILL_FORK_TIMEOUT_MS)) {
    errors.push("RESTORE_DRILL_FORK_TIMEOUT_SECONDS must be greater than zero.");
  }
  if (!isPositiveNumber(options.forkPollIntervalMs ?? DEFAULT_STAGING_RESTORE_DRILL_FORK_POLL_INTERVAL_MS)) {
    errors.push("RESTORE_DRILL_FORK_POLL_SECONDS must be greater than zero.");
  }
  return errors;
}

function parsePositiveSecondsAsMs(value, name) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${name} must be a positive number of seconds.`);
  }
  return seconds * 1000;
}

function parseDatabaseChecks(value) {
  if (!value) {
    return null;
  }
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [contextName, databaseName, eventStoreFlag = "event-store"] = entry.split(":");
      if (!contextName || !databaseName) {
        throw new Error("RESTORE_DRILL_DATABASE_CHECKS entries must use context:database[:event-store|database-only].");
      }
      return {
        contextName,
        databaseName,
        eventStoreTables: eventStoreFlag !== "database-only",
      };
    });
}

function stagingDatabaseCheckFromName(databaseName) {
  if (typeof databaseName !== "string" || !databaseName.startsWith(STAGING_CONTEXT_DATABASE_PREFIX)) {
    return null;
  }

  const token = databaseName.slice(STAGING_CONTEXT_DATABASE_PREFIX.length);
  const contextName = STAGING_DATABASE_CONTEXT_TOKEN_OVERRIDES.get(token) ?? token.replaceAll("_", "-");
  return {
    contextName,
    databaseName,
    eventStoreTables: contextName !== "control",
  };
}

function describeFailure(error, classification) {
  return [JSON.stringify(safeFailureFields(classification, error))];
}

function isoFromMs(value) {
  return new Date(value).toISOString();
}

function sanitizeNameToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

async function main(argv, env = process.env) {
  try {
    const result = await runDigitalOceanDatabaseRestoreDrill(parseDigitalOceanDatabaseRestoreDrillArgs(argv, env));
    console.log(JSON.stringify(result.record, null, 2));
    return result.passesRestoreDrillGate ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify(postgresFailureFields(error)));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
