#!/usr/bin/env node
import pg from "pg";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { normalizePostgresConnectionString, resolvePostgresSsl } from "./lib/postgres-connection.mjs";

const { Client } = pg;

export const POSTGRES_GROWTH_EVIDENCE_VERSION = "postgres-growth-evidence/v1";
export const DEFAULT_TOP_TABLE_LIMIT = 20;
export const DEFAULT_CONNECTION_UTILIZATION_WARNING_PERCENT = 80;

export function parsePostgresGrowthEvidenceArgs(argv, env = process.env) {
  return {
    environment: readOption(argv, "--environment") ?? readEnv("POSTGRES_GROWTH_ENVIRONMENT", env) ?? "staging",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    topTableLimit: normalizePositiveInteger(
      readOption(argv, "--top-table-limit") ?? readEnv("POSTGRES_GROWTH_TOP_TABLE_LIMIT", env),
      DEFAULT_TOP_TABLE_LIMIT,
    ),
    connectionUtilizationWarningPercent: normalizePositiveInteger(
      readOption(argv, "--connection-utilization-warning-percent") ??
        readEnv("POSTGRES_CONNECTION_UTILIZATION_WARNING_PERCENT", env),
      DEFAULT_CONNECTION_UTILIZATION_WARNING_PERCENT,
    ),
    outPath:
      readOption(argv, "--out") ??
      readEnv("POSTGRES_GROWTH_EVIDENCE_OUT", env) ??
      "artifacts/release-health/postgres-growth-evidence.json",
    contexts: parseContextOptions(readOption(argv, "--contexts") ?? readEnv("POSTGRES_GROWTH_CONTEXTS", env)),
    databaseUrls: parseDatabaseUrls(argv, env),
  };
}

export function validatePostgresGrowthEvidenceOptions(options) {
  const errors = [];
  if (!isNonEmptyString(options.environment)) {
    errors.push("--environment is required.");
  }
  if (!isIsoTimestamp(options.checkedAt)) {
    errors.push("--checked-at must be an ISO timestamp.");
  }
  if (!Number.isInteger(options.topTableLimit) || options.topTableLimit < 1 || options.topTableLimit > 100) {
    errors.push("--top-table-limit must be an integer from 1 to 100.");
  }
  if (
    !Number.isInteger(options.connectionUtilizationWarningPercent) ||
    options.connectionUtilizationWarningPercent < 1 ||
    options.connectionUtilizationWarningPercent > 100
  ) {
    errors.push("--connection-utilization-warning-percent must be an integer from 1 to 100.");
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

export async function runPostgresGrowthEvidence(options, dependencies = {}) {
  const collectDatabase = dependencies.collectDatabase ?? collectPostgresDatabaseGrowth;
  const databases = [];
  const errors = [];

  for (const database of selectedDatabaseUrls(options)) {
    try {
      databases.push(
        await collectDatabase(database, {
          topTableLimit: options.topTableLimit,
        }),
      );
    } catch (error) {
      errors.push({
        contextName: database.contextName,
        category: "collection-error",
        message: supportSafeErrorMessage(error),
      });
    }
  }

  return buildPostgresGrowthEvidence({
    environment: options.environment,
    checkedAt: options.checkedAt,
    topTableLimit: options.topTableLimit,
    connectionUtilizationWarningPercent: options.connectionUtilizationWarningPercent,
    databases,
    errors,
  });
}

export function buildPostgresGrowthEvidence(input) {
  const databases = input.databases.map((database) => ({
    contextName: sanitizeContextName(database.contextName),
    databaseName: sanitizeDatabaseName(database.databaseName),
    databaseSizeBytes: nonNegativeInteger(database.databaseSizeBytes),
    tableCount: nonNegativeInteger(database.tableCount),
    estimatedLiveRows: nonNegativeInteger(database.estimatedLiveRows),
    estimatedDeadRows: nonNegativeInteger(database.estimatedDeadRows),
    connections: sanitizeConnectionSummary(database.connections),
    largestTables: database.largestTables.map(sanitizeTableGrowth),
    eventStore: sanitizeEventStoreGrowth(database.eventStore),
  }));
  const warnings = buildWarnings({
    databases,
    connectionUtilizationWarningPercent: input.connectionUtilizationWarningPercent,
  });
  const errors = input.errors.map((error) => ({
    contextName: sanitizeContextName(error.contextName),
    category: "collection-error",
    message: supportSafeErrorMessage(error.message),
  }));

  return {
    schemaVersion: POSTGRES_GROWTH_EVIDENCE_VERSION,
    environment: input.environment,
    checkedAt: input.checkedAt,
    mode: "advisory-read-only",
    collection: {
      topTableLimit: input.topTableLimit,
      source: "pg_catalog-statistics",
      redaction: {
        excludes: [
          "row samples",
          "query text",
          "connection strings",
          "account ids",
          "order ids",
          "provider ids",
          "emails",
          "payload bodies",
        ],
      },
      thresholds: {
        connectionUtilizationWarningPercent: input.connectionUtilizationWarningPercent,
      },
    },
    summary: {
      databaseCount: databases.length,
      collectionErrorCount: errors.length,
      warningCount: warnings.length,
      totalDatabaseSizeBytes: databases.reduce((sum, database) => sum + database.databaseSizeBytes, 0),
      totalEstimatedLiveRows: databases.reduce((sum, database) => sum + database.estimatedLiveRows, 0),
      largestDatabaseBytes: Math.max(0, ...databases.map((database) => database.databaseSizeBytes)),
      largestTableBytes: Math.max(
        0,
        ...databases.flatMap((database) => database.largestTables.map((table) => table.totalBytes)),
      ),
      maxConnectionUtilizationPercent: Math.max(
        0,
        ...databases.map((database) => database.connections.utilizationPercent),
      ),
    },
    databases,
    warnings,
    errors,
    result: errors.length === 0 && warnings.length === 0 ? "success" : "warning",
  };
}

export async function collectPostgresDatabaseGrowth(database, options) {
  const connectionString = normalizePostgresConnectionString(database.url);
  const client = new Client({ connectionString, ssl: resolvePostgresSsl(connectionString) });
  try {
    await client.connect();
    return await collectPostgresDatabaseGrowthWithClient(client, database, options);
  } finally {
    await client.end();
  }
}

export async function collectPostgresDatabaseGrowthWithClient(client, database, options) {
  const [summary, tables, eventStore] = await Promise.all([
    client.query(DATABASE_SUMMARY_SQL),
    client.query(LARGEST_TABLES_SQL, [options.topTableLimit]),
    collectEventStoreGrowth(client),
  ]);
  const summaryRow = summary.rows[0] ?? {};

  return {
    contextName: database.contextName,
    databaseName: summaryRow.database_name ?? null,
    databaseSizeBytes: summaryRow.database_size_bytes,
    tableCount: summaryRow.table_count,
    estimatedLiveRows: summaryRow.estimated_live_rows,
    estimatedDeadRows: summaryRow.estimated_dead_rows,
    connections: {
      active: summaryRow.active_connections,
      max: summaryRow.max_connections,
      utilizationPercent: summaryRow.connection_utilization_percent,
    },
    largestTables: tables.rows.map((row) => ({
      schemaName: row.schema_name,
      tableName: row.table_name,
      totalBytes: row.total_bytes,
      heapBytes: row.heap_bytes,
      indexBytes: row.index_bytes,
      toastBytes: row.toast_bytes,
      estimatedLiveRows: row.estimated_live_rows,
      estimatedDeadRows: row.estimated_dead_rows,
      lastVacuumAt: row.last_vacuum_at,
      lastAutoVacuumAt: row.last_auto_vacuum_at,
      lastAnalyzeAt: row.last_analyze_at,
      lastAutoAnalyzeAt: row.last_auto_analyze_at,
    })),
    eventStore,
  };
}

async function collectEventStoreGrowth(client) {
  const tables = await client.query(EVENT_STORE_TABLES_SQL);
  if (tables.rows[0]?.events_table !== "event_store_events") {
    return { present: false };
  }

  const eventStore = await client.query(EVENT_STORE_GROWTH_SQL);
  const row = eventStore.rows[0] ?? {};
  return {
    present: true,
    estimatedEvents: row.estimated_events,
    totalBytes: row.total_bytes,
    maxGlobalPosition: row.max_global_position,
    lastRecordedAt: row.last_recorded_at,
  };
}

export function parseDatabaseUrls(argv, env = process.env) {
  const urls = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--database-url" && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      urls.push(parseDatabaseUrlOption(argv[index + 1]));
      index += 1;
    }
  }

  for (const [envName, value] of Object.entries(env)) {
    if (!isNonEmptyString(value)) {
      continue;
    }
    if (envName === "PLATFORM_CONTROL_DATABASE_URL") {
      urls.push({ contextName: "control", url: value });
      continue;
    }
    const match = /^DATABASE_URL_([A-Z0-9_]+)$/.exec(envName);
    if (match) {
      urls.push({ contextName: contextNameFromEnvToken(match[1]), url: value });
    }
  }

  const seen = new Set();
  return urls
    .filter((entry) => isNonEmptyString(entry.contextName) && isNonEmptyString(entry.url))
    .filter((entry) => {
      const key = entry.contextName;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.contextName.localeCompare(right.contextName));
}

function selectedDatabaseUrls(options) {
  if (!Array.isArray(options.contexts) || options.contexts.length === 0) {
    return options.databaseUrls;
  }
  const selected = new Set(options.contexts);
  return options.databaseUrls.filter((database) => selected.has(database.contextName));
}

function parseDatabaseUrlOption(value) {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0) {
    return { contextName: "", url: value };
  }
  return {
    contextName: value.slice(0, separatorIndex).trim(),
    url: value.slice(separatorIndex + 1).trim(),
  };
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

function contextNameFromEnvToken(token) {
  return token.toLowerCase().replaceAll("_", "-");
}

function sanitizeTableGrowth(table) {
  return {
    schemaName: sanitizeIdentifier(table.schemaName),
    tableName: sanitizeIdentifier(table.tableName),
    totalBytes: nonNegativeInteger(table.totalBytes),
    heapBytes: nonNegativeInteger(table.heapBytes),
    indexBytes: nonNegativeInteger(table.indexBytes),
    toastBytes: nonNegativeInteger(table.toastBytes),
    estimatedLiveRows: nonNegativeInteger(table.estimatedLiveRows),
    estimatedDeadRows: nonNegativeInteger(table.estimatedDeadRows),
    lastVacuumAt: isoOrNull(table.lastVacuumAt),
    lastAutoVacuumAt: isoOrNull(table.lastAutoVacuumAt),
    lastAnalyzeAt: isoOrNull(table.lastAnalyzeAt),
    lastAutoAnalyzeAt: isoOrNull(table.lastAutoAnalyzeAt),
  };
}

function sanitizeEventStoreGrowth(eventStore) {
  if (!eventStore?.present) {
    return { present: false };
  }
  return {
    present: true,
    estimatedEvents: nonNegativeInteger(eventStore.estimatedEvents),
    totalBytes: nonNegativeInteger(eventStore.totalBytes),
    maxGlobalPosition: stringIntegerOrNull(eventStore.maxGlobalPosition),
    lastRecordedAt: isoOrNull(eventStore.lastRecordedAt),
  };
}

function sanitizeConnectionSummary(connections) {
  return {
    active: nonNegativeInteger(connections?.active),
    max: nonNegativeInteger(connections?.max),
    utilizationPercent: nonNegativeInteger(connections?.utilizationPercent),
  };
}

function buildWarnings(input) {
  const threshold = nonNegativeInteger(input.connectionUtilizationWarningPercent);
  return input.databases.flatMap((database) => {
    const connections = sanitizeConnectionSummary(database.connections);
    if (threshold < 1 || connections.utilizationPercent < threshold) {
      return [];
    }
    return [
      {
        contextName: sanitizeContextName(database.contextName),
        category: "connection-pressure",
        message: `Connection utilization is ${connections.utilizationPercent}% of max_connections.`,
        thresholdPercent: threshold,
        utilizationPercent: connections.utilizationPercent,
      },
    ];
  });
}

function sanitizeContextName(value) {
  return sanitizeIdentifier(
    String(value ?? "")
      .toLowerCase()
      .replaceAll("_", "-"),
  );
}

function sanitizeDatabaseName(value) {
  return sanitizeIdentifier(value ?? "unknown");
}

function sanitizeIdentifier(value) {
  return String(value ?? "unknown")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 120);
}

function supportSafeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-postgres-url]")
    .replace(/password=[^&\s]+/gi, "password=[redacted]")
    .replace(/token=[^&\s]+/gi, "token=[redacted]")
    .slice(0, 240);
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    return fallback;
  }
  return number;
}

function stringIntegerOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  return /^[0-9]+$/.test(text) ? text : null;
}

function isoOrNull(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

const DATABASE_SUMMARY_SQL = `
SELECT
  current_database() AS database_name,
  pg_database_size(current_database())::bigint AS database_size_bytes,
  COUNT(*)::bigint AS table_count,
  COALESCE(SUM(n_live_tup), 0)::bigint AS estimated_live_rows,
  COALESCE(SUM(n_dead_tup), 0)::bigint AS estimated_dead_rows,
  (SELECT COUNT(*)::bigint FROM pg_stat_activity WHERE datname = current_database()) AS active_connections,
  (SELECT setting::bigint FROM pg_settings WHERE name = 'max_connections') AS max_connections,
  (
    (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database()) * 100 /
    NULLIF((SELECT setting::integer FROM pg_settings WHERE name = 'max_connections'), 0)
  )::bigint AS connection_utilization_percent
FROM pg_stat_user_tables
`;

const LARGEST_TABLES_SQL = `
SELECT
  s.schemaname AS schema_name,
  s.relname AS table_name,
  pg_total_relation_size((quote_ident(s.schemaname) || '.' || quote_ident(s.relname))::regclass)::bigint AS total_bytes,
  pg_relation_size((quote_ident(s.schemaname) || '.' || quote_ident(s.relname))::regclass)::bigint AS heap_bytes,
  pg_indexes_size((quote_ident(s.schemaname) || '.' || quote_ident(s.relname))::regclass)::bigint AS index_bytes,
  pg_total_relation_size((quote_ident(s.schemaname) || '.' || quote_ident(s.relname))::regclass)::bigint
    - pg_relation_size((quote_ident(s.schemaname) || '.' || quote_ident(s.relname))::regclass)::bigint
    - pg_indexes_size((quote_ident(s.schemaname) || '.' || quote_ident(s.relname))::regclass)::bigint AS toast_bytes,
  COALESCE(s.n_live_tup, 0)::bigint AS estimated_live_rows,
  COALESCE(s.n_dead_tup, 0)::bigint AS estimated_dead_rows,
  s.last_vacuum AS last_vacuum_at,
  s.last_autovacuum AS last_auto_vacuum_at,
  s.last_analyze AS last_analyze_at,
  s.last_autoanalyze AS last_auto_analyze_at
FROM pg_stat_user_tables s
ORDER BY total_bytes DESC, s.schemaname ASC, s.relname ASC
LIMIT $1
`;

const EVENT_STORE_TABLES_SQL = `
SELECT to_regclass('public.event_store_events')::text AS events_table
`;

const EVENT_STORE_GROWTH_SQL = `
SELECT
  COALESCE(s.n_live_tup, 0)::bigint AS estimated_events,
  pg_total_relation_size('public.event_store_events'::regclass)::bigint AS total_bytes,
  COALESCE(latest.global_position, 0)::text AS max_global_position,
  latest.recorded_at AS last_recorded_at
FROM pg_stat_user_tables s
LEFT JOIN LATERAL (
  SELECT global_position, recorded_at
  FROM public.event_store_events
  ORDER BY global_position DESC
  LIMIT 1
) latest ON true
WHERE s.schemaname = 'public'
  AND s.relname = 'event_store_events'
GROUP BY s.n_live_tup, latest.global_position, latest.recorded_at
`;

async function main(argv, env = process.env) {
  const options = parsePostgresGrowthEvidenceArgs(argv, env);
  const errors = validatePostgresGrowthEvidenceOptions(options);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    return 1;
  }

  const record = await runPostgresGrowthEvidence(options);
  if (options.outPath) {
    await writeJsonRecord(options.outPath, record);
  }
  return record.result === "success" ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
