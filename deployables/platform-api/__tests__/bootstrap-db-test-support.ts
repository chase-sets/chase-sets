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
import { apiContextRegistry } from "../src/generated/api-context-registry";
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
export const RETAINED_STATE_HANDOFF_ERROR = "RETAINED_STATE_HANDOFF_NOT_ARMED";

/**
 * The seam the bootstrap harness consumes. `consumeFor` is called once per case
 * from `beforeEach` with that case's name and returns `true` only for the single
 * named case that the previous case explicitly armed; every other case — in this
 * partition file and in every other one — falls through to the ordinary schema
 * reset.
 */
export type PlatformApiRetainedStateHandoffSeam = Readonly<{
  caseName: string;
  consumeFor: (currentCaseName: string | undefined) => boolean;
}>;

/**
 * An explicit, single-purpose, fail-closed retained-state handoff between two
 * adjacent cases in one partition file. The producing case calls `arm` with the
 * receipt the consuming case needs; the consuming case calls `requireRetained`,
 * which throws `RETAINED_STATE_HANDOFF_NOT_ARMED` unless the producing case ran
 * AND the harness actually skipped the reset for this case. A consuming case run
 * on its own therefore fails closed instead of passing on a freshly reset
 * database.
 */
export type PlatformApiRetainedStateHandoff<TReceipt> = PlatformApiRetainedStateHandoffSeam &
  Readonly<{
    arm: (receipt: TReceipt) => void;
    requireRetained: () => TReceipt;
  }>;

export function createPlatformApiRetainedStateHandoff<TReceipt>(
  caseName: string,
): PlatformApiRetainedStateHandoff<TReceipt> {
  let armed: Readonly<{ receipt: TReceipt }> | undefined;
  let consumed = false;

  return {
    caseName,
    consumeFor(currentCaseName) {
      if (currentCaseName !== caseName || !armed || consumed) return false;
      consumed = true;
      return true;
    },
    arm(receipt) {
      if (armed) {
        throw new Error(`${RETAINED_STATE_HANDOFF_ERROR}: the '${caseName}' handoff was armed more than once.`);
      }
      armed = { receipt };
    },
    requireRetained() {
      if (!armed) {
        throw new Error(
          `${RETAINED_STATE_HANDOFF_ERROR}: '${caseName}' ran without its producing case arming the handoff, ` +
            "so its database was reset and no retained state exists to assert against.",
        );
      }
      if (!consumed) {
        throw new Error(
          `${RETAINED_STATE_HANDOFF_ERROR}: '${caseName}' did not inherit the retained database; the harness ` +
            "reset its schemas because the handoff was not consumed for this case.",
        );
      }
      return armed.receipt;
    },
  };
}

export type PlatformApiBootstrapTestHarnessOptions = Readonly<{
  activeContextNames?: readonly PlatformApiContextName[];
  /**
   * Opt-in only. When absent — which is every caller except the one case that
   * deliberately inherits its predecessor's database — every case in the file
   * keeps its per-case `resetMultiContextTestSchemas`.
   */
  retainedStateHandoff?: PlatformApiRetainedStateHandoffSeam;
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

  beforeEach(async (testContext) => {
    if (!state) {
      throw new Error("Platform API bootstrap test harness was not initialized.");
    }
    if (options.retainedStateHandoff?.consumeFor(testContext.task.name) === true) {
      return;
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
