import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  bootstrapContextDatabase,
  refreshProjectionReplaySummary,
  SCHEMA_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE,
  SCHEMA_MIGRATIONS_TABLE,
} from "@chase-sets/bounded-context-runtime";
import {
  getApiHostContextNames,
  getApiHostSeedOrder,
  productionLikeDataProfiles,
  seedApiHostIfEmpty,
} from "@chase-sets/platform-runtime/api";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import type { ListingPhotoStorage } from "@chase-sets/marketplace/server";
import { createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import type { PlatformApiContextName } from "../src/config";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const platformApiContextNames = getApiHostContextNames(apiContextRegistry, "platform-api");

type PlatformApiTestPools = ReturnType<typeof createPlatformApiPools>;

const contentionBootstrapOptions = {
  lockTimeoutMs: 100,
  lockTimeoutRetryBudgetMs: 2_000,
  lockTimeoutRetryBaseDelayMs: 25,
  lockTimeoutRetryMaxDelayMs: 50,
  lockTimeoutRetryJitterMs: 0,
} as const;

const exhaustedContentionBootstrapOptions = {
  ...contentionBootstrapOptions,
  lockTimeoutRetryBudgetMs: 350,
} as const;

const listingPhotoStorage: ListingPhotoStorage = {
  async putObject(input) {
    return {
      key: input.key,
      publicUrl: `https://assets.test/${input.key}`,
    };
  },
};

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed platform-api tests.");
  }

  return databaseBaseUrl;
}

function requireCatalogContext() {
  const catalogContext = apiContextRegistry.find((context) => context.contextName === "catalog");
  if (!catalogContext) {
    throw new Error("Expected catalog context in platform-api registry.");
  }

  return catalogContext;
}

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
    if (released) {
      return;
    }

    released = true;
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  };
}

async function holdSchemaBootstrapAdvisoryLock(
  pool: PlatformApiTestPools[PlatformApiContextName],
): Promise<() => Promise<void>> {
  const client = await pool.connect();
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
    if (released) {
      return;
    }

    released = true;
    try {
      await client.query("SELECT pg_advisory_unlock_all()");
    } finally {
      client.release();
    }
  };
}

async function hasSettledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
}

describe("platform api bootstrap", () => {
  let pools: PlatformApiTestPools;
  let databaseUrls: Readonly<Record<PlatformApiContextName, string>>;

  beforeAll(async () => {
    databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      platformApiContextNames,
      "platform_api_bootstrap",
    ) as Readonly<Record<PlatformApiContextName, string>>;

    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: null,
      contextDatabaseUrls: databaseUrls,
      port: 6182,
    });
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
  }, 30_000);

  afterAll(async () => {
    if (pools) {
      await closePlatformApiPools(pools);
    }
  });

  it("boots with context-owned pools and replays cross-context projections", async () => {
    const runtime = createPlatformApiHost({
      runtimeProfile: "public",
      pools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });

    expect(pools.auth).not.toBe(pools.identity);

    await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime);

    const seedOrder = getApiHostSeedOrder(apiContextRegistry, "platform-api");
    expect(seedOrder.indexOf("identity")).toBeLessThan(seedOrder.indexOf("auth"));

    const replaySummary = await refreshProjectionReplaySummary(runtime, {
      contextName: "auth",
    });
    const authReplayContext = replaySummary.contexts.find((context) => context.contextName === "auth");
    const authUsers = await pools.auth.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM auth_identity_users",
    );
    const identityTablesInAuth = await pools.auth.query<Readonly<{ relation_name: string | null }>>(
      "SELECT to_regclass('public.identity_user_pages') AS relation_name",
    );
    const publishedMarketplaceSalesFeeSchedules = await pools["commercial-terms"].query<
      Readonly<{
        count: string;
        percentage_bps: string;
        fixed_amount: string;
        cap_amount: string;
      }>
    >(
      `SELECT
         COUNT(*) AS count,
         MAX(value->>'marketplaceSalesFeePercentageBps') AS percentage_bps,
         MAX(value->>'marketplaceSalesFeeFixedAmount') AS fixed_amount,
         MAX(value->>'marketplaceSalesFeeCapAmount') AS cap_amount
       FROM platform_policy_documents
       WHERE policy_key = 'commercial-terms.marketplace-sales-fee-schedule'
         AND status = 'active'`,
    );
    const commercialTermsAgreements = await pools["commercial-terms"].query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM platform_policy_documents WHERE policy_key LIKE 'commercial-terms.agreement.%'",
    );
    const seededCatalogItems = await pools.catalog.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM catalog_items",
    );
    const seededPublishedDisplayTemplates = await pools.catalog.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM catalog_display_templates WHERE status = 'active'",
    );
    const seededListingsWithTerms = await pools.marketplace.query<Readonly<{ count: string }>>(
      `SELECT COUNT(*) AS count
       FROM marketplace_listing_pages
       WHERE marketplace_sales_fee_unit_amount IS NOT NULL
         AND seller_net_unit_amount IS NOT NULL
         AND terms_schedule_id IS NOT NULL
         AND terms_resolved_at IS NOT NULL`,
    );
    const seededOrdersWithTerms = await pools.ordering.query<Readonly<{ count: string }>>(
      `SELECT COUNT(*) AS count
       FROM ordering_order_pages
       WHERE marketplace_sales_fee_amount IS NOT NULL
         AND seller_net_amount IS NOT NULL
         AND terms_schedule_id IS NOT NULL
         AND terms_resolved_at IS NOT NULL`,
    );
    const orderingOrderCreatedEvents = await pools.ordering.query<Readonly<{ count: string }>>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type = 'ordering.order.created'`,
    );
    const fulfillmentDeliveredEvents = await pools.fulfillment.query<Readonly<{ count: string }>>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type = 'fulfillment.shipment.delivered'`,
    );
    const reputationReviews = await pools.marketplace.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM marketplace_review_pages",
    );
    expect(authReplayContext?.requiredGroups).toBeGreaterThan(0);
    expect(authReplayContext?.caughtUpGroups).toBe(authReplayContext?.totalGroups);
    expect(Number(authUsers.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(identityTablesInAuth.rows[0]?.relation_name).toBeNull();
    expect(publishedMarketplaceSalesFeeSchedules.rows[0]).toEqual({
      count: "1",
      percentage_bps: "500",
      fixed_amount: "0.00",
      cap_amount: "25.00",
    });
    expect(Number(commercialTermsAgreements.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(Number(seededCatalogItems.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(seededPublishedDisplayTemplates.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(seededListingsWithTerms.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(seededOrdersWithTerms.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(orderingOrderCreatedEvents.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(fulfillmentDeliveredEvents.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(reputationReviews.rows[0]?.count ?? 0)).toBeGreaterThan(0);
  }, 300_000);

  it("records context schema migrations once during concurrent bootstrap", async () => {
    const catalogContext = requireCatalogContext();

    await Promise.all([
      bootstrapContextDatabase(catalogContext.module, pools.catalog),
      bootstrapContextDatabase(catalogContext.module, pools.catalog),
    ]);

    const migrations = await pools.catalog.query<Readonly<{ migration_id: string }>>(
      `SELECT migration_id
       FROM ${SCHEMA_MIGRATIONS_TABLE}
       ORDER BY migration_id ASC`,
    );
    const migrationIds = migrations.rows.map((row) => row.migration_id);
    const expectedMigrationIds = [
      "20260628_event_store_context_columns_backfill",
      "20260628_event_store_events_concurrent_indexes",
      "20260710_event_store_write_hot_fillfactor",
      "20260710_projection_recovery_marker_backfill",
      ...(catalogContext.module.schemaMigrations ?? []).map((migration) => migration.migrationId),
    ].sort();

    expect(expectedMigrationIds).toHaveLength(new Set(expectedMigrationIds).size);
    expect(migrationIds).toHaveLength(new Set(migrationIds).size);
    expect(migrationIds).toEqual(expectedMigrationIds);

    await bootstrapContextDatabase(catalogContext.module, pools.catalog);
    const migrationsAfterThirdBoot = await pools.catalog.query<Readonly<{ migration_id: string }>>(
      `SELECT migration_id
       FROM ${SCHEMA_MIGRATIONS_TABLE}
       ORDER BY migration_id ASC`,
    );

    expect(migrationsAfterThirdBoot.rows.map((row) => row.migration_id)).toEqual(migrationIds);
  }, 120_000);

  it("serializes two concurrent API host bootstraps with a database advisory lock", async () => {
    const secondPools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: null,
      contextDatabaseUrls: databaseUrls,
      port: 6183,
    });
    const firstRuntime = createPlatformApiHost({
      runtimeProfile: "public",
      pools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
    const secondRuntime = createPlatformApiHost({
      runtimeProfile: "public",
      pools: secondPools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
    const unlockBootstrap = await holdSchemaBootstrapAdvisoryLock(firstRuntime.mountedContexts[0]!.pool as never);
    const schemaBootstrap = {
      lockAcquisitionTimeoutMs: 120_000,
      lockTimeoutMs: 50,
      lockTimeoutRetryBudgetMs: 1_000,
      lockTimeoutRetryBaseDelayMs: 25,
      lockTimeoutRetryMaxDelayMs: 50,
      lockTimeoutRetryJitterMs: 0,
    } as const;
    const firstBootstrap = seedApiHostIfEmpty(apiContextRegistry, "platform-api", firstRuntime, {
      enabledDataProfiles: productionLikeDataProfiles,
      environmentName: "staging",
      runtimeProfile: "public",
      schemaBootstrap,
    });
    const secondBootstrap = seedApiHostIfEmpty(apiContextRegistry, "platform-api", secondRuntime, {
      enabledDataProfiles: productionLikeDataProfiles,
      environmentName: "staging",
      runtimeProfile: "public",
      schemaBootstrap,
    });

    try {
      await expect(hasSettledWithin(Promise.allSettled([firstBootstrap, secondBootstrap]), 100)).resolves.toBe(false);
      await unlockBootstrap();

      await expect(Promise.all([firstBootstrap, secondBootstrap])).resolves.toEqual([undefined, undefined]);
    } finally {
      await unlockBootstrap();
      await Promise.allSettled([firstBootstrap, secondBootstrap]);
      await closePlatformApiPools(secondPools);
    }

    const migrations = await pools.catalog.query<Readonly<{ migration_count: string }>>(
      `SELECT COUNT(*) AS migration_count FROM ${SCHEMA_MIGRATIONS_TABLE}`,
    );
    expect(Number(migrations.rows[0]?.migration_count ?? 0)).toBeGreaterThan(0);
  }, 240_000);

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

  it("limits long-lived environment bootstrap to critical and integration data", async () => {
    const runtime = createPlatformApiHost({
      pools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });

    await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, {
      enabledDataProfiles: productionLikeDataProfiles,
      environmentName: "staging",
    });

    const identityAccounts = await pools.identity.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM identity_accounts",
    );
    const catalogItems = await pools.catalog.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM catalog_items",
    );
    const catalogBlueprintEvents = await pools.catalog.query<Readonly<{ count: string }>>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type = 'catalog.blueprint.created'`,
    );
    const activeCatalogDisplayTemplates = await pools.catalog.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM catalog_display_templates WHERE status = 'active'",
    );
    const publishedMarketplaceSalesFeeScheduleEvents = await pools["commercial-terms"].query<
      Readonly<{ count: string }>
    >(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type = 'platform-policy.document.created'
         AND payload->>'policyKey' = 'commercial-terms.marketplace-sales-fee-schedule'`,
    );
    const commercialTermsAgreementEvents = await pools["commercial-terms"].query<Readonly<{ count: string }>>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type IN ('commercial-terms.agreement.created', 'platform-policy.document.created')
         AND stream_id LIKE 'commercial-terms.agreement-%'`,
    );
    const marketplaceListings = await pools.marketplace.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM marketplace_listing_pages",
    );
    const reputationReviews = await pools.marketplace.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM marketplace_review_pages",
    );

    expect(Number(identityAccounts.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(catalogItems.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(catalogBlueprintEvents.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(activeCatalogDisplayTemplates.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(publishedMarketplaceSalesFeeScheduleEvents.rows[0]?.count ?? 0)).toBe(1);
    expect(Number(commercialTermsAgreementEvents.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(marketplaceListings.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(reputationReviews.rows[0]?.count ?? 0)).toBe(0);
  }, 180_000);
});
