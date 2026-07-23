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

export const POSTGRES_SLOW_QUERY_DIGEST_VERSION = "postgres-slow-query-digest/v1";
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
      databaseCount: databases.length,
      collectionErrorCount: errors.length,
      extensionInstalledDatabaseCount: databases.filter((database) => database.pgStatStatements.extensionInstalled)
        .length,
      digestCount: queryDigests.length,
      totalCalls: queryDigests.reduce((sum, query) => sum + query.calls, 0),
      largestTotalExecTimeMs: Math.max(0, ...queryDigests.map((query) => query.totalExecTimeMs)),
      largestMeanExecTimeMs: Math.max(0, ...queryDigests.map((query) => query.meanExecTimeMs)),
      largestMaxExecTimeMs: Math.max(0, ...queryDigests.map((query) => query.maxExecTimeMs)),
    },
    databases,
    errors,
    result: errors.length === 0 ? "success" : "warning",
  };
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
  const statusResult = await client.query(PG_STAT_STATEMENTS_STATUS_SQL);
  const status = statusResult.rows[0] ?? {};
  const extensionSchema = sanitizeIdentifier(status.extension_schema);

  if (!status.extension_installed || !extensionSchema) {
    return {
      contextName: database.contextName,
      databaseName: status.database_name,
      pgStatStatements: {
        extensionInstalled: false,
        viewAccessible: false,
        sharedPreloadLibraryEnabled: Boolean(status.shared_preload_library_enabled),
        trackSetting: status.track_setting,
        computeQueryIdSetting: status.compute_query_id_setting,
      },
      slowQueryDigests: [],
    };
  }

  const slowQueries = await client.query(pgStatStatementsDigestSql(extensionSchema), [options.topQueryLimit]);

  return {
    contextName: database.contextName,
    databaseName: status.database_name,
    pgStatStatements: {
      extensionInstalled: true,
      viewAccessible: true,
      sharedPreloadLibraryEnabled: Boolean(status.shared_preload_library_enabled),
      trackSetting: status.track_setting,
      computeQueryIdSetting: status.compute_query_id_setting,
    },
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

function sanitizeDatabaseDigest(database) {
  return {
    contextName: sanitizeContextName(database.contextName),
    databaseName: sanitizeIdentifier(database.databaseName ?? "unknown"),
    pgStatStatements: {
      extensionInstalled: Boolean(database.pgStatStatements?.extensionInstalled),
      viewAccessible: Boolean(database.pgStatStatements?.viewAccessible),
      sharedPreloadLibraryEnabled: Boolean(database.pgStatStatements?.sharedPreloadLibraryEnabled),
      trackSetting: sanitizePostureSetting(database.pgStatStatements?.trackSetting),
      computeQueryIdSetting: sanitizePostureSetting(database.pgStatStatements?.computeQueryIdSetting),
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
  const text = sanitizeIdentifier(value ?? "unknown").toLowerCase();
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

const PG_STAT_STATEMENTS_STATUS_SQL = `
SELECT
  current_database() AS database_name,
  e.extname IS NOT NULL AS extension_installed,
  n.nspname AS extension_schema,
  POSITION('pg_stat_statements' IN current_setting('shared_preload_libraries', true)) > 0
    AS shared_preload_library_enabled,
  current_setting('pg_stat_statements.track', true) AS track_setting,
  current_setting('compute_query_id', true) AS compute_query_id_setting
FROM (SELECT 1) seed
LEFT JOIN pg_extension e ON e.extname = 'pg_stat_statements'
LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
`;

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
  return record.result === "success" ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
