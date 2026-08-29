import {
  createMountedContextTestRuntime,
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
  seedMountedContextTestRuntimeIfEmpty,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
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
import type { ListingPhotoStorage } from "@chase-sets/marketplace/server";
import { module as orderingModule } from "@chase-sets/ordering";
import { module as paymentsModule } from "@chase-sets/payments";
import { module as pricingModule } from "@chase-sets/pricing";
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
      await seedMountedContextTestRuntimeIfEmpty(runtime, marketplaceSeedLifecycleContextOrder, options.seedOptions);

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

  return createMountedContextTestRuntime([
    { contextName: "catalog", module: catalogModule, pool: pools.catalog, ports: options.catalogPorts },
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
      ports: undefined,
    },
    { contextName: "discovery", module: discoveryModule, pool: pools.discovery, ports: undefined },
    {
      contextName: "fulfillment",
      module: fulfillmentModule,
      pool: pools.fulfillment,
      ports: undefined,
    },
    { contextName: "identity", module: identityModule, pool: pools.identity, ports: undefined },
    { contextName: "inventory", module: inventoryModule, pool: pools.inventory, ports: undefined },
    {
      contextName: "marketplace",
      module: marketplaceModule,
      pool: pools.marketplace,
      ports: { commercialTermsResolver, listingPhotoStorage },
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
    { contextName: "pricing", module: pricingModule, pool: pools.pricing, ports: undefined },
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
}

function createMarketplaceSeedListingPhotoStorage(): ListingPhotoStorage {
  return {
    async putObject(input) {
      return {
        key: input.key,
        publicUrl: `https://assets.test/${input.key}`,
      };
    },
  };
}
