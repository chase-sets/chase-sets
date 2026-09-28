import {
  createMountedContextTestRuntime,
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
  seedMountedContextTestRuntimeIfEmpty,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  createListingAuthorityConsumerResolver,
  bindListingAuthorityParticipant,
} from "@chase-sets/platform-runtime/listing-authority-host";
import { createFixtureListingSeedContext } from "@chase-sets/identity/server";
import { defaultSeedOptions } from "@chase-sets/bounded-context-runtime";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { module as catalogModule } from "@chase-sets/catalog";
import { module as checkoutModule } from "@chase-sets/checkout";
import { module as collectionsModule } from "@chase-sets/collections";
import { module as commercialTermsModule } from "@chase-sets/commercial-terms";
import { createCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { module as discoveryModule } from "@chase-sets/discovery";
import { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { module as identityModule } from "@chase-sets/identity";
import { module as inventoryModule } from "@chase-sets/inventory";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import type {
  ListingPhotoStorage,
  MarketplaceListingSeedPorts,
  MarketplaceListingAuthorityPorts,
} from "@chase-sets/marketplace/server";
import { module as orderingModule } from "@chase-sets/ordering";
import { module as paymentsModule } from "@chase-sets/payments";
import { module as pricingModule } from "@chase-sets/pricing";
import type { PricingHostPorts } from "@chase-sets/pricing/server";
import { module as settlementModule } from "@chase-sets/settlement";
import { module as platformOperationsModule } from "@chase-sets/platform-operations";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement/test-support";

export const marketplaceSeedContextNames = [
  "catalog",
  "checkout",
  "collections",
  "commercial-terms",
  "discovery",
  "fulfillment",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "pricing",
  "settlement",
  "platform-operations",
] as const;

export const marketplaceSeedLifecycleContextOrder = [
  "catalog",
  // Catalog resolves product measurements from its item read model, so it needs one reconciliation pass after item projections drain.
  "catalog",
  "commercial-terms",
  "discovery",
  "identity",
  "inventory",
  "marketplace",
  "checkout",
  "ordering",
  "payments",
  "fulfillment",
  "pricing",
  // Marketplace runs a second pass after fulfillment so the reviews slice can
  // seed from delivered-shipment review eligibility.
  "marketplace",
  "settlement",
  "platform-operations",
] as const;

type MarketplaceSeedOptions = NonNullable<Parameters<NonNullable<typeof catalogModule.seed>>[2]>;
type MarketplaceCatalogPorts = Parameters<typeof catalogModule.createServices>[1];

export type MarketplaceSeedRuntimePools = Readonly<
  Record<(typeof marketplaceSeedContextNames)[number], PgTransactionalPool>
>;

const databaseBaseUrl = process.env.TEST_DATABASE_URL;

export const describeWithMarketplaceSeedDatabase = describe;

function requireMarketplaceSeedDatabaseBaseUrl(testName: string): string {
  if (!databaseBaseUrl) {
    throw new Error(`TEST_DATABASE_URL is required for database-backed ${testName} seed tests.`);
  }

  return databaseBaseUrl;
}

export function useMarketplaceSeedRuntime(
  testName: string,
  options: Readonly<{
    resetSchemas?: "beforeEach" | "beforeAll" | "manual";
    seedOptions?: MarketplaceSeedOptions;
    catalogPorts?: MarketplaceCatalogPorts;
  }> = {},
) {
  let pools: MarketplaceSeedRuntimePools | undefined;
  const resetSchemas = options.resetSchemas ?? "beforeEach";

  function requirePools() {
    if (!pools) {
      throw new Error(`Marketplace seed pools are not initialized for ${testName}.`);
    }

    return pools;
  }

  beforeAll(async () => {
    const baseUrl = requireMarketplaceSeedDatabaseBaseUrl(testName);
    const databaseUrls = createMultiContextTestDatabaseUrls(baseUrl, marketplaceSeedContextNames, `${testName}_seed`);

    await ensureMultiContextTestDatabases(baseUrl, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls) as MarketplaceSeedRuntimePools;
  });

  if (resetSchemas === "beforeAll") {
    beforeAll(async () => {
      await resetMultiContextTestSchemas(requirePools());
    }, 120_000);
  } else if (resetSchemas === "beforeEach") {
    beforeEach(async () => {
      await resetMultiContextTestSchemas(requirePools());
    }, 120_000);
  }

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  return {
    get pools() {
      return requirePools();
    },
    seed: async () => {
      const runtime = createMarketplaceSeedRuntime(requirePools(), { catalogPorts: options.catalogPorts });
      await seedMountedContextTestRuntimeIfEmpty(
        runtime,
        marketplaceSeedLifecycleContextOrder,
        options.seedOptions ?? { ...defaultSeedOptions, environmentName: "test" },
      );

      return runtime;
    },
  };
}

export function createMarketplaceSeedRuntime(
  pools: MarketplaceSeedRuntimePools,
  options: Readonly<{ catalogPorts?: MarketplaceCatalogPorts }> = {},
) {
  const commercialTermsResolver = createCommercialTermsResolver({
    db: pools["commercial-terms"],
  });
  const listingPhotoStorage = createMarketplaceSeedListingPhotoStorage();
  let services: Readonly<Record<string, unknown>> = {};
  const identity = () => services.identity as ReturnType<typeof identityModule.createServices>;
  const catalog = () => services.catalog as ReturnType<typeof catalogModule.createServices>;
  const inventory = () => services.inventory as ReturnType<typeof inventoryModule.createServices>;
  const fees = () => services["commercial-terms"] as ReturnType<typeof commercialTermsModule.createServices>;
  const stores = {
    marketplace: createPostgresEventStore({ pool: pools.marketplace }),
    ordering: createPostgresEventStore({ pool: pools.ordering }),
  };
  const consumer = (owner: Parameters<typeof createListingAuthorityConsumerResolver>[1]) =>
    createListingAuthorityConsumerResolver(stores, owner);
  const manage = bindListingAuthorityParticipant(
    { owner: "identity", purpose: "manage-listing" },
    () => identity().listingAuthority.port,
  );
  const stock = bindListingAuthorityParticipant(
    { owner: "inventory", purpose: "stock-allocation" },
    () => inventory().listingAuthority.source,
  );
  const product = bindListingAuthorityParticipant(
    { owner: "catalog", purpose: "product-measures" },
    () => catalog().listingAuthority.source,
  );
  const identityFacts = {
    participant: manage,
    accountFacts: (
      reservation: Parameters<ReturnType<typeof identityModule.createServices>["listingAuthority"]["accountFacts"]>[0],
    ) => identity().listingAuthority.accountFacts(reservation),
  };
  const listingSeed: MarketplaceListingSeedPorts = {
    withContext: (input, use) => createFixtureListingSeedContext(identity())(input, use),
    identity: manage,
    inventory: stock,
    catalog: product,
    fee: bindListingAuthorityParticipant(
      { owner: "commercial-terms", purpose: "native-fee" },
      () => fees().listingAuthority.source,
    ),
    prepareIdentity: (operation, context) => identity().listingAuthority.prepareAuthorities(operation, context),
    catalogFacts: (operation) => catalog().listingAuthority.readFacts(operation),
  };
  const pricingHostPorts: PricingHostPorts = {
    pricingListingAuthorityConsumer: createListingAuthorityConsumerResolver(
      {
        marketplace: createPostgresEventStore({ pool: pools.marketplace }),
        ordering: createPostgresEventStore({ pool: pools.ordering }),
      },
      "pricing",
    ),
    tcgplayerMarketTransport: { kind: "not-mounted" },
    tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
    commercialTermsResolver,
    channelConnectionIdentityReader: {
      // This host has no Channels database. The unmistakably synthetic reader
      // keeps seed construction explicit and can never alias a real account.
      resolve: async () => null,
    },
  };

  const runtime = createMountedContextTestRuntime([
    {
      contextName: "catalog",
      module: catalogModule,
      pool: pools.catalog,
      ports: { ...options.catalogPorts, listingAuthorityConsumer: consumer("catalog") },
    },
    {
      contextName: "checkout",
      module: checkoutModule,
      pool: pools.checkout,
      ports: undefined,
    },
    {
      contextName: "collections",
      mountRole: "source-only",
      module: collectionsModule,
      pool: pools.collections,
      ports: undefined,
    },
    {
      contextName: "commercial-terms",
      module: commercialTermsModule,
      pool: pools["commercial-terms"],
      ports: { listingAuthority: { consumer: consumer("commercial-terms"), identity: identityFacts } },
    },
    { contextName: "discovery", module: discoveryModule, pool: pools.discovery, ports: undefined },
    {
      contextName: "fulfillment",
      module: fulfillmentModule,
      pool: pools.fulfillment,
      ports: undefined,
    },
    {
      contextName: "identity",
      module: identityModule,
      pool: pools.identity,
      ports: { listingAuthorityConsumer: consumer("identity") },
    },
    {
      contextName: "inventory",
      module: inventoryModule,
      pool: pools.inventory,
      ports: { listingAuthorityConsumer: consumer("inventory") },
    },
    {
      contextName: "marketplace",
      module: marketplaceModule,
      pool: pools.marketplace,
      ports: {
        commercialTermsResolver,
        listingPhotoStorage,
        listingSeed,
        listingAuthority: {
          consumer: consumer("marketplace"),
          inventory: stock,
          identity: {
            participant: manage,
            sellerFacts: (reservation) => identity().listingAuthority.sellerFacts(reservation),
          },
          catalog: { participant: product, readFacts: (operation) => catalog().listingAuthority.readFacts(operation) },
        } satisfies MarketplaceListingAuthorityPorts,
      },
    },
    {
      contextName: "ordering",
      module: orderingModule,
      pool: pools.ordering,
      ports: { commercialTermsResolver, inventoryCleanupAuthority: { kind: "not-mounted" } },
    },
    {
      contextName: "payments",
      module: paymentsModule,
      pool: pools.payments,
      ports: {
        processorGateway: createFakePaymentProcessorGateway(),
      },
    },
    { contextName: "pricing", module: pricingModule, pool: pools.pricing, ports: pricingHostPorts },
    {
      contextName: "settlement",
      module: settlementModule,
      pool: pools.settlement,
      ports: {
        moneyMovementGateway: createFakeMoneyMovementGateway(),
      },
    },
    {
      contextName: "platform-operations",
      module: platformOperationsModule,
      pool: pools["platform-operations"],
      ports: undefined,
    },
  ] as const);
  services = runtime.services;
  return runtime;
}

function createMarketplaceSeedListingPhotoStorage(): ListingPhotoStorage {
  return {
    async getObject() {
      return null;
    },
    async putObject(input) {
      return {
        key: input.key,
        publicUrl: `https://assets.test/${input.key}`,
      };
    },
  };
}
