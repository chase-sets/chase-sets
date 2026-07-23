#!/usr/bin/env node
// Support-safe status check for the scheduled Catalog provider scope refresh
//. Reads the per-provider refresh-schedule bookkeeping the platform
// worker maintains and reports failed or stale scheduled providers so the
// scheduled-workflow alerting path (m72 posture) can open/close an ops issue.
// Exit codes: 0 = healthy, 2 = warning (failed or stale providers), 1 = the
// check itself could not run.
import { writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { postgresClientConfig, safeFailureFields } from "./lib/postgres-connection.mjs";

const { Client } = pg;

export const CATALOG_PROVIDER_REFRESH_STATUS_VERSION = "catalog-provider-refresh-status/v1";

// A scheduled provider is stale when it has not completed a run within twice
// its own cadence (plus a fixed grace hour for worker restarts/deploys).
const STALENESS_INTERVAL_MULTIPLIER = 2;
const STALENESS_GRACE_MS = 60 * 60 * 1000;

export function parseCatalogProviderRefreshStatusArgs(argv, env = process.env) {
  return {
    environment:
      readOption(argv, "--environment") ??
      readEnv("CATALOG_PROVIDER_REFRESH_ENVIRONMENT", env) ??
      readEnv("DEPLOYMENT_ENVIRONMENT", env) ??
      "unknown",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    catalogDatabaseUrl:
      readOption(argv, "--catalog-database-url") ??
      readEnv("CATALOG_DATABASE_URL", env) ??
      readEnv("DATABASE_URL_CATALOG", env),
    outPath: readOption(argv, "--out"),
  };
}

export function evaluateProviderRefreshSchedules(rows, checkedAt) {
  const now = new Date(checkedAt).getTime();
  const providers = rows.map((row) => {
    const intervalMs = Number(row.interval_ms);
    const scheduledActive = row.schedule_enabled && !row.manual_only && !row.paused;
    const lastCompleted = row.last_run_completed_at ? new Date(row.last_run_completed_at).getTime() : null;
    const staleAfterMs = intervalMs * STALENESS_INTERVAL_MULTIPLIER + STALENESS_GRACE_MS;

    const failed = scheduledActive && row.last_run_status === "failed";
    const neverRan =
      scheduledActive && lastCompleted === null && row.next_run_at !== null
        ? now - new Date(row.next_run_at).getTime() > staleAfterMs
        : false;
    const overdue = scheduledActive && lastCompleted !== null ? now - lastCompleted > staleAfterMs : false;

    return {
      providerKey: row.provider_key,
      scheduledActive,
      paused: Boolean(row.paused),
      manualOnly: Boolean(row.manual_only),
      intervalMs,
      lastRunStatus: row.last_run_status ?? null,
      lastRunCompletedAt: row.last_run_completed_at ? new Date(row.last_run_completed_at).toISOString() : null,
      failed,
      stale: neverRan || overdue,
    };
  });

  const failedProviders = providers.filter((provider) => provider.failed);
  const staleProviders = providers.filter((provider) => provider.stale && !provider.failed);

  return {
    schemaVersion: CATALOG_PROVIDER_REFRESH_STATUS_VERSION,
    checkedAt,
    result: failedProviders.length > 0 || staleProviders.length > 0 ? "warning" : "success",
    summary: {
      providerCount: providers.length,
      scheduledActiveCount: providers.filter((provider) => provider.scheduledActive).length,
      pausedCount: providers.filter((provider) => provider.paused).length,
      failedCount: failedProviders.length,
      staleCount: staleProviders.length,
    },
    failedProviders,
    staleProviders,
    providers,
  };
}

export async function runCatalogProviderRefreshStatus(options, ClientCtor = Client) {
  if (!options.catalogDatabaseUrl) {
    throw new Error("CATALOG_DATABASE_URL, DATABASE_URL_CATALOG, or --catalog-database-url is required.");
  }

  const client = new ClientCtor(postgresClientConfig(options.catalogDatabaseUrl));
  await client.connect();
  try {
    const result = await client.query(`
      SELECT provider_key,
             schedule_enabled,
             manual_only,
             paused,
             interval_ms,
             next_run_at,
             last_run_completed_at,
             last_run_status
      FROM catalog_provider_refresh_schedule
      ORDER BY provider_key
    `);

    return {
      environment: options.environment,
      ...evaluateProviderRefreshSchedules(result.rows, options.checkedAt),
    };
  } finally {
    await client.end();
  }
}

async function main() {
  const options = parseCatalogProviderRefreshStatusArgs(process.argv.slice(2));
  const record = await runCatalogProviderRefreshStatus(options);

  const serialized = JSON.stringify(record, null, 2);
  if (options.outPath) {
    writeFileSync(options.outPath, `${serialized}\n`);
  }
  console.log(serialized);

  process.exitCode = record.result === "success" ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(JSON.stringify(safeFailureFields("catalog-provider-refresh-status-failed", error)));
    process.exitCode = 1;
  });
}
