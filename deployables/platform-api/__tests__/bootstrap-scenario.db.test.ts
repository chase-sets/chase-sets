import { describe, expect, it } from "vitest";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  bootstrapContextDatabase,
  refreshProjectionReplaySummary,
  SCHEMA_MIGRATIONS_TABLE,
} from "@chase-sets/bounded-context-runtime";
import { module as identityModule } from "@chase-sets/identity";
import { module as paymentsModule } from "@chase-sets/payments";
import { getApiHostSeedOrder, nonProductionDataProfiles, seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { buildPlatformApiApp, createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createSeedCommandPools } from "../src/database-pools";
import type { PlatformApiContextName } from "../src/config";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import {
  createPlatformApiBootstrapTestHarness,
  listingPhotoStorage,
  requireCatalogContext,
} from "./bootstrap-db-test-support";
import type { PlatformApiTestPools } from "./bootstrap-db-test-support";

let databaseUrls: Readonly<Record<PlatformApiContextName, string>>;
let pools: PlatformApiTestPools;
createPlatformApiBootstrapTestHarness("platform_api_bootstrap_scenario", (state) => {
  databaseUrls = state.databaseUrls;
  pools = state.pools;
});

describe("platform api bootstrap scenario", () => {
  it("boots every non-production profile on one shared max-one seed command pool", async () => {
    const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (!adminDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for the shared seed command bootstrap.");
    const sharedUrls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl,
      ["discovery"] as const,
      "platform_api_bootstrap_shared_seed_command",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl, sharedUrls);
    const seedPools = createSeedCommandPools({
      runtimeProfile: "public",
      deploymentEnvironment: "test",
      sharedDatabaseUrl: sharedUrls.discovery,
      contextDatabaseUrls: {},
      port: 6182,
      pool: { max: 6, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 500 },
    });
    try {
      expect(seedPools.catalog).toBe(seedPools.channels);
      expect((seedPools.channels as unknown as { options: { max: number } }).options.max).toBe(1);
      const runtime = createPlatformApiHost({
        runtimeProfile: "public",
        pools: seedPools,
        hostPorts: {
          processorGateway: createFakePaymentProcessorGateway(),
          listingPhotoStorage,
        },
      });
      await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, {
        enabledDataProfiles: nonProductionDataProfiles,
        schemaBootstrapLockPool: seedPools.schemaBootstrapLockPool,
        environmentName: "test",
        runtimeProfile: "public",
        substepTimeoutMs: 600_000,
      });
      const run = await seedPools.channels.query<{ count: string }>(
        "SELECT count(*) FROM event_store_events WHERE stream_id = $1",
        ["channels.tcgplayer-sync-run-run-seed-tcgplayer-manual-recovery"],
      );
      expect(Number(run.rows[0]?.count)).toBeGreaterThan(0);
    } finally {
      await closePlatformApiPools(seedPools);
    }
  }, 600_000);

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

  it("revokes agent-owned saved instruments through the composed OAuth route with a valid audit context", async () => {
    const runtime = createPlatformApiHost({
      runtimeProfile: "public",
      pools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
    const requiredContexts = runtime.mountedContexts.filter(
      (context) => context.contextName === "identity" || context.contextName === "payments",
    );
    expect(requiredContexts.map((context) => context.contextName).sort()).toEqual(["identity", "payments"]);
    await Promise.all(requiredContexts.map((context) => bootstrapContextDatabase(context.module, context.pool)));

    const accountId = "acc_oauth_revoke";
    const agentGrantId = "lpa_oauth_revoke";
    const identityServices = runtime.services.identity as ReturnType<typeof identityModule.createServices>;
    const paymentsServices = runtime.services.payments as ReturnType<typeof paymentsModule.createServices>;
    await identityServices.linkedPlatformAuthorizations.grant({
      authorizationId: agentGrantId,
      platformProfileUrl: "https://agent.example/.well-known/ucp",
      clientId: "oauth-revoke-client",
      userId: "usr_oauth_revoke",
      accountId,
      scopes: ["checkout:write"],
      accessTokenHash: "hash:oauth-revoke-access",
      refreshTokenHash: "hash:oauth-revoke-refresh",
      accessTokenExpiresAt: "2026-07-20T22:00:00.000Z",
      refreshTokenExpiresAt: "2026-08-20T22:00:00.000Z",
      grantedAt: "2026-07-20T21:00:00.000Z",
    });
    await paymentsServices.pool.query(
      `INSERT INTO payments_saved_checkout_instruments (
         instrument_id,
         account_id,
         agent_grant_id,
         payment_method_category,
         provider,
         provider_customer_reference,
         provider_reference,
         display_label,
         confirmation_experience,
         readiness,
         is_default
       ) VALUES ($1, $2, $3, 'card', 'stripe', $4, $5, 'Visa ending in 4242', 'off-session-token', 'ready', true)`,
      ["sci_oauth_revoke", accountId, agentGrantId, "cus_oauth_revoke", "pm_oauth_revoke"],
    );

    const revokingActor: ResolvedActor = {
      sessionId: "sess_oauth_revoke",
      tenantId: "tnt_customer",
      userId: "usr_oauth_revoke",
      accountId,
      membershipId: "mem_oauth_revoke",
      roleKey: "owner",
      permissions: ["security.manage"],
    };
    const app = buildPlatformApiApp(runtime, {
      resolveActor: async () => revokingActor,
    });
    const response = await app.request(`/ucp/oauth/authorizations/${agentGrantId}/revoke`, { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: true });
    const events = await paymentsServices.pool.query<
      Readonly<{
        tenant_id: string;
        performed_by_user_id: string;
        for_account_id: string;
        payload: { savedCheckoutInstruments: readonly { instrumentId: string; readiness: string }[] };
      }>
    >(
      `SELECT tenant_id, performed_by_user_id, for_account_id, payload
       FROM event_store_events
       WHERE stream_id = $1
         AND event_type = 'payments.checkout-affordances-published'`,
      [`payments.checkout-affordances-${accountId}`],
    );
    expect(events.rows).toEqual([
      {
        tenant_id: "tnt_identity",
        performed_by_user_id: "usr_identity_system",
        for_account_id: accountId,
        payload: expect.objectContaining({
          savedCheckoutInstruments: [
            expect.objectContaining({ instrumentId: "sci_oauth_revoke", readiness: "removed" }),
          ],
        }),
      },
    ]);
  }, 60_000);

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
});
