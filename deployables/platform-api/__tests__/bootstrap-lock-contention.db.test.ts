import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  bootstrapContextDatabase,
  SCHEMA_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE,
  SCHEMA_MIGRATIONS_TABLE,
} from "@chase-sets/bounded-context-runtime";
import { closePlatformApiPools, createPlatformApiPools, createSeedCommandPools } from "../src/database-pools";
import { productionLikeDataProfiles, seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import { withSchemaBootstrapLock } from "@chase-sets/bounded-context-runtime";
import { createPlatformApiHost } from "../src/app";
import { apiContextRegistry } from "../src/generated/api-context-registry";
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
let databaseUrls: Readonly<Record<PlatformApiContextName, string>>;
createPlatformApiBootstrapTestHarness("platform_api_bootstrap_lock_contention", (state) => {
  pools = state.pools;
  databaseUrls = state.databaseUrls;
});

describe("platform api bootstrap lock contention", () => {
  it("pins the existing namespace and auth database across profiles and releases", async () => {
    expect(SCHEMA_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE).toBe("chase_sets_schema_bootstrap");
    for (const release of ["synthetic-old-release", "synthetic-new-release"]) {
      vi.stubEnv("CHASE_SETS_HELM_RELEASE", release);
      try {
        for (const runtimeProfile of ["landing", "proof", "public"] as const) {
          const seedPools = createSeedCommandPools({
            runtimeProfile,
            deploymentEnvironment: "test",
            sharedDatabaseUrl: null,
            contextDatabaseUrls: databaseUrls,
            controlDatabaseUrl: databaseUrls.auth,
            port: 6182,
          });
          try {
            const identity = await seedPools.schemaBootstrapLockPool.query<{ name: string }>(
              "SELECT current_database() AS name",
            );
            expect(identity.rows[0]?.name).toBe(decodeURIComponent(new URL(databaseUrls.auth).pathname.slice(1)));
            await withSchemaBootstrapLock(seedPools.schemaBootstrapLockPool, {}, async () => {
              const contender = await tryHoldSchemaBootstrapAdvisoryLock(pools.auth);
              await contender?.();
              expect(contender).toBeNull();
            });
          } finally {
            await closePlatformApiPools(seedPools);
          }
        }
      } finally {
        vi.unstubAllEnvs();
      }
    }
  }, 30_000);

  it("standalone seeds acquire L, while caller-held seeds never acquire or release it twice", async () => {
    const seedPools = createSeedCommandPools({
      runtimeProfile: "public",
      deploymentEnvironment: "test",
      sharedDatabaseUrl: null,
      contextDatabaseUrls: databaseUrls,
      controlDatabaseUrl: databaseUrls.auth,
      port: 6182,
    });
    const registry = apiContextRegistry.filter((entry) => entry.contextName === "auth");
    const runtime = createPlatformApiHost({ pools: seedPools, runtimeProfile: "public" });
    const authRuntime = {
      ...runtime,
      mountedContexts: runtime.mountedContexts.filter((entry) => entry.contextName === "auth"),
    };
    const options = {
      enabledDataProfiles: productionLikeDataProfiles,
      environmentName: "test",
      schemaBootstrapLockPool: seedPools.schemaBootstrapLockPool,
      schemaBootstrap: { lockAcquisitionTimeoutMs: 100 },
    };
    try {
      await withSchemaBootstrapLock(seedPools.schemaBootstrapLockPool, {}, async (schemaBootstrapLockAcquisition) => {
        // A second independent seed must not enter this held span.
        await expect(
          seedApiHostIfEmpty(registry, "platform-api", authRuntime, {
            ...options,
            schemaBootstrapLockPool: pools.auth,
          }),
        ).rejects.toThrow("Schema bootstrap lock was not acquired");
        await seedApiHostIfEmpty(registry, "platform-api", authRuntime, { ...options, schemaBootstrapLockAcquisition });
        const contender = await tryHoldSchemaBootstrapAdvisoryLock(pools.auth);
        await contender?.();
        expect(contender).toBeNull();
      });
      await seedApiHostIfEmpty(registry, "platform-api", authRuntime, options);
      const contender = await tryHoldSchemaBootstrapAdvisoryLock(pools.auth);
      expect(contender).not.toBeNull();
      await contender?.();
    } finally {
      await closePlatformApiPools(seedPools);
    }
  }, 30_000);

  it("real bootstrap holds L through every admin phase and a killed bootstrap frees L", async () => {
    const phases = ["seed-api-host", "platform-admin-identity", "auth-projection-sync", "platform-admin-password"];
    for (const disposition of ["complete", "kill"] as const) {
      const directory = mkdtempSync(join(tmpdir(), "bootstrap-lock-"));
      const preload = join(directory, "phase-barrier.mjs");
      // A synchronous barrier observes the unmodified CLI's real phase boundaries.
      // It does not acquire L, replace any production service or narrow data profiles.
      writeFileSync(
        preload,
        `
        import { existsSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const phases = ${JSON.stringify(phases)};
        const directory = ${JSON.stringify(directory)};
        const log = console.log;
        console.log = (...args) => {
          log(...args);
          const phase = phases.find(phase => args[0] === '[platform-bootstrap] ' + phase + ' started.');
          if (!phase) return;
          writeFileSync(join(directory, phase + '.entered'), 'entered');
          const deadline = Date.now() + 30000;
          while (!existsSync(join(directory, phase + '.continue'))) {
            if (Date.now() > deadline) throw new Error('Test phase barrier expired: ' + phase);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
          }
        };
      `,
      );
      // Allowlist only OS necessities. No ambient PGHOSTADDR, provider credentials,
      // dotenv files or loader redirects can escape the disposable hosted DB fixture.
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        ["PATH", "SystemRoot", "TEMP", "TMP"].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
      );
      Object.assign(env, {
        DEPLOYMENT_ENVIRONMENT: "test",
        CHASE_SETS_RUNTIME_PROFILE: "public",
        PLATFORM_DATA_PROFILES: productionLikeDataProfiles.join(","),
        PLATFORM_CONTROL_DATABASE_URL: databaseUrls.auth,
        PLATFORM_ADMIN_EMAIL: "bootstrap-lock@synthetic.test",
        PLATFORM_ADMIN_PASSWORD: "Synthetic-lock-test-8579!",
        CATALOG_ASSET_LOCAL_ROOT: join(directory, "catalog"),
        LISTING_PHOTO_LOCAL_ROOT: join(directory, "photos"),
        OBSERVABILITY_ENABLED: "false",
      });
      for (const [name, url] of Object.entries(databaseUrls))
        env[`DATABASE_URL_${name.toUpperCase().replaceAll("-", "_")}`] = url;
      expect(env.PGHOSTADDR).toBeUndefined();
      expect(env.STRIPE_SECRET_KEY).toBeUndefined();
      expect(env.PLATFORM_DATA_PROFILES).toBe("critical-bootstrap,catalog-integration-bootstrap");
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--import", pathToFileURL(preload).href, "src/bootstrap.ts"],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output = (output + String(chunk)).slice(-12000);
      });
      child.stderr.on("data", (chunk) => {
        output = (output + String(chunk)).slice(-12000);
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      });
      try {
        for (const phase of phases) {
          await vi.waitFor(
            () => {
              if (child.exitCode !== null) throw new Error(`Bootstrap exited before ${phase}: ${output}`);
              expect(existsSync(join(directory, `${phase}.entered`)), output).toBe(true);
            },
            { timeout: 180_000, interval: 50 },
          );
          const contender = await tryHoldSchemaBootstrapAdvisoryLock(pools.auth);
          await contender?.();
          expect(contender, `L must exclude contenders during ${phase}`).toBeNull();
          if (disposition === "kill" && phase === "platform-admin-password") {
            child.kill("SIGKILL");
            break;
          }
          writeFileSync(join(directory, `${phase}.continue`), "continue");
        }
        const code = await exited;
        if (disposition === "complete") {
          expect(code, output).toBe(0);
          expect(output).toContain("Platform admin bootstrap reconciled.");
        }
        await vi.waitFor(async () => {
          const contender = await tryHoldSchemaBootstrapAdvisoryLock(pools.auth);
          await contender?.();
          expect(contender).not.toBeNull();
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 600_000);

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
