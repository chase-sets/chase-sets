import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { refreshProjectionReplaySummary } from "@chase-sets/bounded-context-runtime";
import {
  getApiHostContextNames,
  getApiHostSeedOrder,
  productionLikeDataProfiles,
  seedApiHostIfEmpty,
} from "@chase-sets/platform-runtime/api";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing-testing";
import type { ListingPhotoStorage } from "@chase-sets/marketplace/server";
import { createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import type { PlatformApiContextName } from "../src/config";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const platformApiContextNames = getApiHostContextNames(apiContextRegistry, "platform-api");

type PlatformApiTestPools = ReturnType<typeof createPlatformApiPools>;

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

describe("platform api bootstrap", () => {
  let pools: PlatformApiTestPools;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      platformApiContextNames,
      "platform_api_bootstrap",
    ) as Readonly<Record<PlatformApiContextName, string>>;

    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createPlatformApiPools({
      sharedDatabaseUrl: null,
      contextDatabaseUrls: databaseUrls,
      port: 6182,
    });
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
  }, 30_000);

  afterAll(async () => {
    await closePlatformApiPools(pools);
  });

  it("boots with context-owned pools and replays cross-context projections", async () => {
    const runtime = createPlatformApiHost({
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
    const commercialTermsSchedules = await pools["commercial-terms"].query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM commercial_terms_schedule_pages",
    );
    const commercialTermsAgreements = await pools["commercial-terms"].query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM commercial_terms_agreement_pages",
    );
    const seededCatalogItems = await pools.catalog.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM catalog_items",
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
      "SELECT COUNT(*) AS count FROM reputation_review_pages",
    );
    expect(authReplayContext?.requiredGroups).toBeGreaterThan(0);
    expect(authReplayContext?.caughtUpGroups).toBe(authReplayContext?.totalGroups);
    expect(Number(authUsers.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(identityTablesInAuth.rows[0]?.relation_name).toBeNull();
    expect(Number(commercialTermsSchedules.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(3);
    expect(Number(commercialTermsAgreements.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(Number(seededCatalogItems.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(seededListingsWithTerms.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(seededOrdersWithTerms.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(orderingOrderCreatedEvents.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(fulfillmentDeliveredEvents.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(reputationReviews.rows[0]?.count ?? 0)).toBeGreaterThan(0);
  }, 120_000);

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
    const commercialTermsScheduleEvents = await pools["commercial-terms"].query<Readonly<{ count: string }>>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type = 'commercial-terms.schedule.created'`,
    );
    const commercialTermsAgreementEvents = await pools["commercial-terms"].query<Readonly<{ count: string }>>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type = 'commercial-terms.agreement.created'`,
    );
    const marketplaceListings = await pools.marketplace.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM marketplace_listing_pages",
    );
    const reputationReviews = await pools.marketplace.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM reputation_review_pages",
    );

    expect(Number(identityAccounts.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(catalogItems.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(catalogBlueprintEvents.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(commercialTermsScheduleEvents.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(3);
    expect(Number(commercialTermsAgreementEvents.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(marketplaceListings.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(reputationReviews.rows[0]?.count ?? 0)).toBe(0);
  }, 60_000);
});
