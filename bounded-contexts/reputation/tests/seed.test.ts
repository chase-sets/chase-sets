import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
  seedMountedContextTestRuntimeIfEmpty,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "@chase-sets/catalog";
import { module as discoveryModule } from "@chase-sets/discovery";
import { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { module as identityModule } from "@chase-sets/identity";
import { module as inventoryModule } from "@chase-sets/inventory";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { module as orderingModule } from "@chase-sets/ordering";
import { module as paymentsModule } from "@chase-sets/payments";
import { module as pricingModule } from "@chase-sets/pricing";
import { module as settlementModule } from "@chase-sets/settlement";
import { createFakePaymentProcessorGateway } from "../../payments/support/runtime-support/fake-gateway";
import { module as reputationModule } from "..";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseBaseUrl ? describe : describe.skip;
const marketplaceContextNames = [
  "catalog",
  "discovery",
  "fulfillment",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "pricing",
  "reputation",
  "settlement",
] as const;
const marketplaceLifecycleContextOrder = [
  "catalog",
  "discovery",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "fulfillment",
  "pricing",
  "reputation",
  "settlement",
] as const;

type MarketplaceSeedRuntimePools = Readonly<
  Record<(typeof marketplaceContextNames)[number], PgTransactionalPool>
>;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed reputation seed tests.");
  }

  return databaseBaseUrl;
}

function createMarketplaceSeedRuntime(pools: MarketplaceSeedRuntimePools) {
  return createMountedContextTestRuntime([
    { contextName: "catalog", module: catalogModule, pool: pools.catalog, ports: undefined },
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
      ports: undefined,
    },
    {
      contextName: "ordering",
      module: orderingModule,
      pool: pools.ordering,
      ports: undefined,
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
      contextName: "reputation",
      module: reputationModule,
      pool: pools.reputation,
      ports: undefined,
    },
    {
      contextName: "settlement",
      module: settlementModule,
      pool: pools.settlement,
      ports: undefined,
    },
  ] as const);
}

describeWithDatabase("reputation seed", () => {
  let pools: MarketplaceSeedRuntimePools;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      marketplaceContextNames,
      "reputation_seed",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls) as MarketplaceSeedRuntimePools;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
  }, 50_000);

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("creates review lifecycle projections and summary data", async () => {
    const runtime = createMarketplaceSeedRuntime(pools);
    await seedMountedContextTestRuntimeIfEmpty(runtime, marketplaceLifecycleContextOrder);

    const reviewStatuses = await pools.reputation.query<{ status: string }>(
      "SELECT status FROM reputation_review_pages ORDER BY review_id ASC",
    );
    expect(new Set(reviewStatuses.rows.map((row) => row.status))).toEqual(
      new Set(["active", "withdrawn"]),
    );

    const summary = await pools.reputation.query<{
      review_count: number;
      average_rating: string | null;
    }>(
      "SELECT review_count, average_rating::text AS average_rating FROM reputation_summary_pages",
    );
    expect(summary.rows[0]).toMatchObject({
      review_count: 1,
      average_rating: "5.00",
    });

    const before = await pools.reputation.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'reputation.%'",
    );
    await seedMountedContextTestRuntimeIfEmpty(runtime, marketplaceLifecycleContextOrder);
    const after = await pools.reputation.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'reputation.%'",
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 70_000);
});
