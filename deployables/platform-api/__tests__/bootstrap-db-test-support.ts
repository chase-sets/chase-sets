import { afterAll, beforeAll, beforeEach } from "vitest";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { SCHEMA_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE } from "@chase-sets/bounded-context-runtime";
import type { PgPoolClient } from "@chase-sets/event-core-postgres";
import { getApiHostContextNames } from "@chase-sets/platform-runtime/api";
import type { ListingPhotoStorage } from "@chase-sets/marketplace/server";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";
import { apiContextRegistry } from "../src/context-registry";
import type { PlatformApiContextName } from "../src/config";

export type PlatformApiTestPools = ReturnType<typeof createPlatformApiPools>;
export const platformApiContextNames = getApiHostContextNames(apiContextRegistry, "platform-api");
export const listingPhotoStorage: ListingPhotoStorage = {
  async putObject(input) {
    return { key: input.key, publicUrl: `https://assets.test/${input.key}` };
  },
};
function requireDatabaseBaseUrl(): string {
  const databaseBaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for database-backed platform-api tests.");
  return databaseBaseUrl;
}
export function requireCatalogContext() {
  const catalogContext = apiContextRegistry.find((context) => context.contextName === "catalog");
  if (!catalogContext) throw new Error("Expected catalog context in platform-api registry.");
  return catalogContext;
}
export type PlatformApiBootstrapTestState = Readonly<{
  databaseUrls: Readonly<Record<PlatformApiContextName, string>>;
  pools: PlatformApiTestPools;
}>;
export type PlatformApiBootstrapTestHarnessOptions = Readonly<{
  activeContextNames?: readonly PlatformApiContextName[];
}>;

export function createPlatformApiBootstrapTestHarness(
  databaseSuffix: string,
  assignState: (state: PlatformApiBootstrapTestState) => void,
  options: PlatformApiBootstrapTestHarnessOptions = {},
): void {
  let state: PlatformApiBootstrapTestState | undefined;
  const activeContextNames = options.activeContextNames ?? platformApiContextNames;

  beforeAll(async () => {
    const databaseBaseUrl = requireDatabaseBaseUrl();
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl,
      platformApiContextNames,
      databaseSuffix,
    ) as Readonly<Record<PlatformApiContextName, string>>;
    await ensureMultiContextTestDatabases(databaseBaseUrl, selectPlatformApiContexts(databaseUrls, activeContextNames));
    const pools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: null,
      contextDatabaseUrls: databaseUrls,
      port: 6182,
    });
    state = { databaseUrls, pools };
    assignState(state);
  });

  beforeEach(async () => {
    if (!state) {
      throw new Error("Platform API bootstrap test harness was not initialized.");
    }
    await resetMultiContextTestSchemas(selectPlatformApiContexts(state.pools, activeContextNames));
  }, 30_000);

  afterAll(async () => {
    if (state) {
      await closePlatformApiPools(state.pools);
    }
  });
}

function selectPlatformApiContexts<T>(
  resources: Readonly<Record<PlatformApiContextName, T>>,
  contextNames: readonly PlatformApiContextName[],
): Readonly<Record<string, T>> {
  return Object.fromEntries(contextNames.map((contextName) => [contextName, resources[contextName]]));
}

export async function holdSchemaBootstrapAdvisoryLock(
  pool: PlatformApiTestPools[PlatformApiContextName],
): Promise<() => Promise<void>> {
  const client: PgPoolClient = await pool.connect();
  let released = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended(($1::text || ':' || current_database()), 0))", [
      SCHEMA_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE,
    ]);
  } catch (error) {
    client.release(error);
    throw error;
  }
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
export async function hasSettledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
