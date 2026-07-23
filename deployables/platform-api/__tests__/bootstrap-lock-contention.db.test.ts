import { describe, expect, it } from "vitest";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  bootstrapContextDatabase,
  SCHEMA_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE,
  SCHEMA_MIGRATIONS_TABLE,
} from "@chase-sets/bounded-context-runtime";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";
import type { PlatformApiContextName } from "../src/config";
import {
  createPlatformApiBootstrapTestHarness,
  platformApiContextNames,
  requireCatalogContext,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";

const contentionBootstrapOptions = {
  lockTimeoutMs: 100,
  lockTimeoutRetryBudgetMs: 2_000,
  lockTimeoutRetryBaseDelayMs: 25,
  lockTimeoutRetryMaxDelayMs: 50,
  lockTimeoutRetryJitterMs: 0,
} as const;
const exhaustedContentionBootstrapOptions = { ...contentionBootstrapOptions, lockTimeoutRetryBudgetMs: 350 } as const;
const partitionDatabaseSuffixes = [
  "platform_api_bootstrap_scenario",
  "platform_api_bootstrap_production_reconciliation",
  "platform_api_bootstrap_lock_contention",
] as const;
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function holdSchemaMigrationsTableLock(pool: PlatformApiTestPools["catalog"]): Promise<() => Promise<void>> {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query("BEGIN");
    await client.query(`LOCK TABLE ${SCHEMA_MIGRATIONS_TABLE} IN ACCESS EXCLUSIVE MODE`);
  } catch (error) {
    client.release(error);
    throw error;
  }
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  };
}
async function tryHoldSchemaBootstrapAdvisoryLock(
  pool: PlatformApiTestPools[PlatformApiContextName],
): Promise<(() => Promise<void>) | null> {
  const client = await pool.connect();
  const result = await client.query<Readonly<{ acquired: boolean }>>(
    "SELECT pg_try_advisory_lock(hashtextextended(($1::text || ':' || current_database()), 0)) AS acquired",
    [SCHEMA_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE],
  );
  if (!result.rows[0]?.acquired) {
    client.release();
    return null;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query("SELECT pg_advisory_unlock_all()");
    } finally {
      client.release();
    }
  };
}

let pools: PlatformApiTestPools;
createPlatformApiBootstrapTestHarness("platform_api_bootstrap_lock_contention", (state) => {
  pools = state.pools;
});

describe("platform api bootstrap lock contention", () => {
  it("recovers when bootstrap-touched table locks release within the retry budget", async () => {
    const catalogContext = requireCatalogContext();
    await bootstrapContextDatabase(catalogContext.module, pools.catalog);
    const unlockSchemaMigrationsTable = await holdSchemaMigrationsTableLock(pools.catalog);
    const delayedUnlock = sleep(250).then(unlockSchemaMigrationsTable);

    try {
      await expect(
        bootstrapContextDatabase(catalogContext.module, pools.catalog, contentionBootstrapOptions),
      ).resolves.toBeUndefined();
    } finally {
      await unlockSchemaMigrationsTable();
      await delayedUnlock;
    }

    const migrations = await pools.catalog.query<Readonly<{ migration_count: string }>>(
      `SELECT COUNT(*) AS migration_count FROM ${SCHEMA_MIGRATIONS_TABLE}`,
    );
    expect(Number(migrations.rows[0]?.migration_count ?? 0)).toBeGreaterThan(0);
  }, 30_000);

  it("fails closed when bootstrap-touched table locks exhaust the retry budget", async () => {
    const catalogContext = requireCatalogContext();
    await bootstrapContextDatabase(catalogContext.module, pools.catalog);
    const unlockSchemaMigrationsTable = await holdSchemaMigrationsTableLock(pools.catalog);

    try {
      await expect(
        bootstrapContextDatabase(catalogContext.module, pools.catalog, exhaustedContentionBootstrapOptions),
      ).rejects.toThrow(/Schema bootstrap hit PostgreSQL lock_timeout for \d+ attempts over \d+ms/);
    } finally {
      await unlockSchemaMigrationsTable();
    }
  }, 30_000);

  it("isolates partition databases and bootstrap advisory locks", async () => {
    const databaseBaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for database-backed platform-api tests.");
    const databaseUrlSets = partitionDatabaseSuffixes.map(
      (suffix) =>
        createMultiContextTestDatabaseUrls(databaseBaseUrl, platformApiContextNames, suffix) as Readonly<
          Record<PlatformApiContextName, string>
        >,
    );
    await Promise.all(
      databaseUrlSets.map((databaseUrls) => ensureMultiContextTestDatabases(databaseBaseUrl, databaseUrls)),
    );
    const partitionPools = databaseUrlSets.map((contextDatabaseUrls) =>
      createPlatformApiPools({
        runtimeProfile: "public",
        sharedDatabaseUrl: null,
        contextDatabaseUrls,
        port: 6182,
      }),
    );
    const releaseLocks: Array<() => Promise<void>> = [];
    try {
      const identities = databaseUrlSets.flatMap((databaseUrls, partitionIndex) =>
        platformApiContextNames.map((contextName) => ({
          contextName,
          databaseName: decodeURIComponent(new URL(databaseUrls[contextName]).pathname.slice(1)),
          partitionIndex,
        })),
      );
      expect(new Set(identities.map(({ databaseName }) => databaseName))).toHaveLength(identities.length);
      for (const contextName of platformApiContextNames) {
        const contextIdentities = identities
          .filter((identity) => identity.contextName === contextName)
          .map(({ databaseName }) => databaseName);
        expect(new Set(contextIdentities), contextName + " must use one database per partition").toHaveLength(3);
      }
      const acquiredLocks = await Promise.all(
        partitionPools.map((partition) => tryHoldSchemaBootstrapAdvisoryLock(partition.catalog)),
      );
      expect(acquiredLocks).not.toContain(null);
      releaseLocks.push(...acquiredLocks.filter((release): release is () => Promise<void> => release !== null));
      expect(releaseLocks).toHaveLength(3);
    } finally {
      await Promise.allSettled(releaseLocks.map((release) => release()));
      await Promise.all(partitionPools.map((partition) => closePlatformApiPools(partition)));
    }
  }, 30_000);
});
