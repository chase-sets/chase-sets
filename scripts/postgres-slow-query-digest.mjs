#!/usr/bin/env node
import crypto from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { postgresClientConfig, postgresFailureFields } from "./lib/postgres-connection.mjs";
import { parseDatabaseUrls } from "./postgres-growth-evidence.mjs";

const { Client } = pg;

export const POSTGRES_SLOW_QUERY_DIGEST_VERSION = "postgres-slow-query-digest/v2";
export const DEFAULT_TOP_QUERY_LIMIT = 25;

export function parsePostgresSlowQueryDigestArgs(argv, env = process.env) {
  return {
    environment: readOption(argv, "--environment") ?? readEnv("POSTGRES_SLOW_QUERY_ENVIRONMENT", env) ?? "staging",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    topQueryLimit: normalizePositiveInteger(
      readOption(argv, "--top-query-limit") ?? readEnv("POSTGRES_SLOW_QUERY_TOP_QUERY_LIMIT", env),
      DEFAULT_TOP_QUERY_LIMIT,
    ),
    outPath:
      readOption(argv, "--out") ??
      readEnv("POSTGRES_SLOW_QUERY_DIGEST_OUT", env) ??
      "artifacts/release-health/postgres-slow-query-digest.json",
    contexts: parseContextOptions(readOption(argv, "--contexts") ?? readEnv("POSTGRES_SLOW_QUERY_CONTEXTS", env)),
    databaseUrls: parseDatabaseUrls(argv, env),
  };
}

export function validatePostgresSlowQueryDigestOptions(options) {
  const errors = [];
  if (!isNonEmptyString(options.environment)) {
    errors.push("--environment is required.");
  }
  if (!isIsoTimestamp(options.checkedAt)) {
    errors.push("--checked-at must be an ISO timestamp.");
  }
  if (!Number.isInteger(options.topQueryLimit) || options.topQueryLimit < 1 || options.topQueryLimit > 100) {
    errors.push("--top-query-limit must be an integer from 1 to 100.");
  }
  if (!Array.isArray(options.databaseUrls) || options.databaseUrls.length === 0) {
    errors.push(
      "At least one DATABASE_URL_<CONTEXT>, PLATFORM_CONTROL_DATABASE_URL, or --database-url context=url is required.",
    );
  } else if (selectedDatabaseUrls(options).length === 0) {
    errors.push("--contexts did not match any configured database URLs.");
  }
  return errors;
}

export async function runPostgresSlowQueryDigest(options, dependencies = {}) {
  const collectDatabase = dependencies.collectDatabase ?? collectPostgresSlowQueryDigest;
  const databases = [];
  const errors = [];

  for (const database of selectedDatabaseUrls(options)) {
    try {
      databases.push(
        await collectDatabase(database, {
          topQueryLimit: options.topQueryLimit,
        }),
      );
    } catch (error) {
      errors.push({
        contextName: database.contextName,
        category: "collection-error",
        ...postgresFailureFields(error),
      });
    }
  }

  return buildPostgresSlowQueryDigest({
    environment: options.environment,
    checkedAt: options.checkedAt,
    topQueryLimit: options.topQueryLimit,
    databases,
    errors,
  });
}

export function buildPostgresSlowQueryDigest(input) {
  const databases = input.databases.map((database) => sanitizeDatabaseDigest(database));
  const errors = input.errors.map((error) => ({
    contextName: sanitizeContextName(error.contextName),
    category: "collection-error",
    ...postgresFailureFields(error),
  }));
  const queryDigests = databases.flatMap((database) => database.slowQueryDigests);
  const extensionAbsentDatabaseCount = databases.filter(
    (database) => !database.pgStatStatements.extensionInstalled,
  ).length;

  return {
    schemaVersion: POSTGRES_SLOW_QUERY_DIGEST_VERSION,
    environment: input.environment,
    checkedAt: input.checkedAt,
    mode: "advisory-read-only",
    collection: {
      topQueryLimit: input.topQueryLimit,
      source: "pg_stat_statements-aggregate-counters",
      redaction: {
        fingerprint: "sha256(queryid) truncated to 16 hex characters",
        excludes: [
          "raw pg_stat_statements.query text",
          "bind values",
          "SQL literals",
          "row samples",
          "connection strings",
          "customer ids",
          "provider ids",
          "account ids",
          "session ids",
          "order ids",
          "emails",
          "URLs",
          "payload bodies",
          "tokens",
          "secrets",
        ],
      },
    },
    summary: {
      attemptedDatabaseCount: databases.length + errors.length,
      collectedDatabaseCount: databases.length,
      extensionAbsentDatabaseCount,
      extensionInstalledDatabaseCount: databases.length - extensionAbsentDatabaseCount,
      collectionErrorCount: errors.length,
      digestCount: queryDigests.length,
      totalCalls: queryDigests.reduce((sum, query) => sum + query.calls, 0),
      largestTotalExecTimeMs: Math.max(0, ...queryDigests.map((query) => query.totalExecTimeMs)),
      largestMeanExecTimeMs: Math.max(0, ...queryDigests.map((query) => query.meanExecTimeMs)),
      largestMaxExecTimeMs: Math.max(0, ...queryDigests.map((query) => query.maxExecTimeMs)),
    },
    databases,
    errors,
    result: resolvePostgresSlowQueryDigestResult(databases.length, errors.length),
  };
}

function resolvePostgresSlowQueryDigestResult(collectedDatabaseCount, collectionErrorCount) {
  const attemptedDatabaseCount = collectedDatabaseCount + collectionErrorCount;
  if (attemptedDatabaseCount > 0 && collectedDatabaseCount === 0) {
    return "failure";
  }
  return collectionErrorCount === 0 ? "success" : "warning";
}

export async function collectPostgresSlowQueryDigest(database, options) {
  const client = new Client(postgresClientConfig(database.url));
  try {
    await client.connect();
    return await collectPostgresSlowQueryDigestWithClient(client, database, options);
  } finally {
    await client.end();
  }
}

export async function collectPostgresSlowQueryDigestWithClient(client, database, options) {
  const statusResult = await client.query(PG_STAT_STATEMENTS_EXTENSION_STATUS_SQL);
  const status = statusResult.rows[0] ?? {};
  const extensionSchema = sanitizeIdentifier(status.extension_schema);
  const extensionInstalled = Boolean(status.extension_installed) && Boolean(extensionSchema);

  const pgStatStatements = {
    extensionInstalled,
    viewAccessible: false,
    sharedPreloadLibraryEnabled: await probeSharedPreloadLibraryEnabled(client),
    trackSetting: await probeOptionalPostureSetting(client, "pg_stat_statements.track"),
    computeQueryIdSetting: await probeOptionalPostureSetting(client, "compute_query_id"),
  };

  if (!extensionInstalled) {
    return {
      contextName: database.contextName,
      databaseName: status.database_name,
      pgStatStatements,
      slowQueryDigests: [],
    };
  }

  const slowQueries = await client.query(pgStatStatementsDigestSql(extensionSchema), [options.topQueryLimit]);
  pgStatStatements.viewAccessible = true;

  return {
    contextName: database.contextName,
    databaseName: status.database_name,
    pgStatStatements,
    slowQueryDigests: slowQueries.rows.map((row) => ({
      fingerprint: fingerprintQueryId(row.query_id),
      calls: row.calls,
      totalExecTimeMs: row.total_exec_time_ms,
      meanExecTimeMs: row.mean_exec_time_ms,
      maxExecTimeMs: row.max_exec_time_ms,
      stddevExecTimeMs: row.stddev_exec_time_ms,
      rowsReturned: row.rows_returned,
      sharedBlockHits: row.shared_block_hits,
      sharedBlockReads: row.shared_block_reads,
      tempBlockReads: row.temp_block_reads,
      tempBlockWrites: row.temp_block_writes,
      walBytes: row.wal_bytes,
    })),
  };
}

// Each optional posture setting is probed with its own statement so a
// least-privilege role denied one GUC (commonly shared_preload_libraries on
// managed Postgres) cannot abort the extension/view/digest evidence that
// query above already obtained from unrestricted catalog relations.
async function probeOptionalPostureSetting(client, settingName) {
  try {
    const result = await client.query(OPTIONAL_POSTURE_SETTING_SQL, [settingName]);
    return result.rows[0]?.value ?? null;
  } catch {
    // A role denied SELECT on this optional GUC (e.g. shared_preload_libraries
    // on managed Postgres) reports the setting as undetermined; that must not
    // abort the extension/view/digest evidence already collected above.
    return null;
  }
}

async function probeSharedPreloadLibraryEnabled(client) {
  const value = await probeOptionalPostureSetting(client, "shared_preload_libraries");
  return value === null ? null : value.includes("pg_stat_statements");
}

function sanitizeDatabaseDigest(database) {
  const posture = database.pgStatStatements ?? {};
  return {
    contextName: sanitizeContextName(database.contextName),
    databaseName: sanitizeIdentifier(database.databaseName ?? "unknown"),
    pgStatStatements: {
      extensionInstalled: Boolean(posture.extensionInstalled),
      viewAccessible: Boolean(posture.viewAccessible),
      // null means the runtime role could not read this optional GUC; that
      // must stay distinguishable from a determined true/false posture.
      sharedPreloadLibraryEnabled:
        posture.sharedPreloadLibraryEnabled === null ? null : Boolean(posture.sharedPreloadLibraryEnabled),
      trackSetting: sanitizePostureSetting(posture.trackSetting),
      computeQueryIdSetting: sanitizePostureSetting(posture.computeQueryIdSetting),
    },
    slowQueryDigests: toArray(database.slowQueryDigests).map(sanitizeSlowQueryDigest),
  };
}

function sanitizeSlowQueryDigest(query) {
  return {
    fingerprint: sanitizeFingerprint(query.fingerprint),
    calls: nonNegativeInteger(query.calls),
    totalExecTimeMs: nonNegativeNumber(query.totalExecTimeMs),
    meanExecTimeMs: nonNegativeNumber(query.meanExecTimeMs),
    maxExecTimeMs: nonNegativeNumber(query.maxExecTimeMs),
    stddevExecTimeMs: nonNegativeNumber(query.stddevExecTimeMs),
    rowsReturned: nonNegativeInteger(query.rowsReturned),
    sharedBlockHits: nonNegativeInteger(query.sharedBlockHits),
    sharedBlockReads: nonNegativeInteger(query.sharedBlockReads),
    tempBlockReads: nonNegativeInteger(query.tempBlockReads),
    tempBlockWrites: nonNegativeInteger(query.tempBlockWrites),
    walBytes: nonNegativeInteger(query.walBytes),
  };
}

function pgStatStatementsDigestSql(extensionSchema) {
  return `
SELECT
  s.queryid::text AS query_id,
  COALESCE(s.calls, 0)::bigint AS calls,
  COALESCE(s.total_exec_time, 0)::double precision AS total_exec_time_ms,
  COALESCE(s.mean_exec_time, 0)::double precision AS mean_exec_time_ms,
  COALESCE(s.max_exec_time, 0)::double precision AS max_exec_time_ms,
  COALESCE(s.stddev_exec_time, 0)::double precision AS stddev_exec_time_ms,
  COALESCE(s.rows, 0)::bigint AS rows_returned,
  COALESCE(s.shared_blks_hit, 0)::bigint AS shared_block_hits,
  COALESCE(s.shared_blks_read, 0)::bigint AS shared_block_reads,
  COALESCE(s.temp_blks_read, 0)::bigint AS temp_block_reads,
  COALESCE(s.temp_blks_written, 0)::bigint AS temp_block_writes,
  COALESCE((to_jsonb(s)->>'wal_bytes')::numeric, 0)::numeric AS wal_bytes
FROM ${quoteIdentifier(extensionSchema)}.pg_stat_statements s
WHERE s.queryid IS NOT NULL
ORDER BY COALESCE(s.total_exec_time, 0) DESC, COALESCE(s.max_exec_time, 0) DESC, s.queryid::text ASC
LIMIT $1
`;
}

function selectedDatabaseUrls(options) {
  if (!Array.isArray(options.contexts) || options.contexts.length === 0) {
    return options.databaseUrls;
  }
  const selected = new Set(options.contexts);
  return options.databaseUrls.filter((database) => selected.has(database.contextName));
}

function parseContextOptions(value) {
  if (!isNonEmptyString(value) || value === "all") {
    return null;
  }
  return value
    .split(",")
    .map((context) => sanitizeContextName(context))
    .filter(Boolean);
}

function fingerprintQueryId(queryId) {
  return `pgss-${crypto
    .createHash("sha256")
    .update(String(queryId ?? "unknown"))
    .digest("hex")
    .slice(0, 16)}`;
}

function sanitizeFingerprint(value) {
  const text = String(value ?? "");
  return /^pgss-[a-f0-9]{16}$/.test(text) ? text : fingerprintQueryId(text);
}

function sanitizeContextName(value) {
  return sanitizeIdentifier(
    String(value ?? "")
      .toLowerCase()
      .replaceAll("_", "-"),
  );
}

function sanitizeIdentifier(value) {
  return String(value ?? "")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 120);
}

function sanitizePostureSetting(value) {
  // Preserve null (undetermined: denied or genuinely unset) rather than
  // collapsing it into the same "unknown" text a determined-but-empty
  // setting would produce.
  if (value === null || value === undefined) {
    return null;
  }
  const text = sanitizeIdentifier(value).toLowerCase();
  return text || "unknown";
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 1000) / 1000 : 0;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    return fallback;
  }
  return number;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function isIsoTimestamp(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Reads only pg_extension/pg_namespace, catalog relations readable by any
// role with CONNECT privilege on the database; it must never reference an
// optional GUC (those are probed separately and independently below) so a
// least-privilege role can always determine extension/view coverage.
const PG_STAT_STATEMENTS_EXTENSION_STATUS_SQL = `
SELECT
  current_database() AS database_name,
  e.extname IS NOT NULL AS extension_installed,
  n.nspname AS extension_schema
FROM (SELECT 1) seed
LEFT JOIN pg_extension e ON e.extname = 'pg_stat_statements'
LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
`;

const OPTIONAL_POSTURE_SETTING_SQL = `SELECT current_setting($1, true) AS value`;

async function main(argv, env = process.env) {
  const options = parsePostgresSlowQueryDigestArgs(argv, env);
  const errors = validatePostgresSlowQueryDigestOptions(options);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    return 1;
  }

  const record = await runPostgresSlowQueryDigest(options);
  if (options.outPath) {
    await writeJsonRecord(options.outPath, record);
  }
  if (record.result === "success") {
    return 0;
  }
  return record.result === "warning" ? 2 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
