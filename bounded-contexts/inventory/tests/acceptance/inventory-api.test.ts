import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  bootstrapContextDatabase,
  type ContextProjectionGroup,
  type ContextSubscriptionRunner,
  drainContextProcesses,
  type MountedContextRuntimeEntry,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  syncContextProjectionGroups,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { catalogSeedIds } from "@chase-sets/catalog/seed-support/ids";
import { demoIdentitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { inventorySeedIds } from "@chase-sets/inventory/seed-support/ids";
import { module as catalogModule } from "@chase-sets/catalog";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { module as orderingModule } from "@chase-sets/ordering";
import { type InventoryApiEnv, buildInventoryApi } from "../../api";
import { InventoryDomainError } from "../../support/runtime-support/common";
import { createInventoryServices } from "../../support/runtime-support/services";
import { module as inventoryModule } from "../..";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseBaseUrl ? describe : describe.skip;
const inventoryContextNames = ["catalog", "ordering", "inventory"] as const;
type InventoryAcceptanceRuntime = {
  mountedContexts: readonly MountedContextRuntimeEntry[];
  subscriptionRunners: readonly ContextSubscriptionRunner[];
  projectionGroups: readonly ContextProjectionGroup[];
};

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed inventory tests.");
  }

  return databaseBaseUrl;
}

const inventoryContext: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_inventory" as never,
  },
};

async function countEvents(pool: PgTransactionalPool, prefix: string) {
  const result = await pool.query(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1",
    [`${prefix}%`],
  );

  return Number(result.rows[0]?.count ?? 0);
}

describeWithDatabase("inventory api", () => {
  let databaseUrls: Readonly<Record<(typeof inventoryContextNames)[number], string>>;
  let pools: Readonly<
    Record<(typeof inventoryContextNames)[number], PgTransactionalPool>
  >;
  let subscriptionRunners: ReturnType<typeof resolveModuleSubscriptions>;
  let runtime: InventoryAcceptanceRuntime;
  let services: ReturnType<typeof createInventoryServices>;
  let app: Hono<InventoryApiEnv>;

  beforeAll(async () => {
    databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      inventoryContextNames,
      "inventory_acceptance",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    const catalogServices = catalogModule.createServices(pools.catalog, undefined);
    const orderingServices = orderingModule.createServices(pools.ordering, {
      commercialTermsResolver: createNoopCommercialTermsResolver(),
    });
    services = createInventoryServices(pools.inventory);
    runtime = {
      mountedContexts: [
        {
          contextName: "catalog",
          module: catalogModule,
          services: catalogServices,
          pool: pools.catalog,
          projectors: catalogModule.projectors(catalogServices),
        },
        {
          contextName: "ordering",
          mountRole: "source-only",
          module: orderingModule,
          services: orderingServices,
          pool: pools.ordering,
          projectors: [],
        },
        {
          contextName: "inventory",
          module: inventoryModule,
          services,
          pool: pools.inventory,
          projectors: inventoryModule.projectors(services),
        },
      ] as const,
      subscriptionRunners: [],
      projectionGroups: [],
    };
    subscriptionRunners = resolveModuleSubscriptions(runtime.mountedContexts);
    runtime.subscriptionRunners = subscriptionRunners;
    runtime.projectionGroups = resolveModuleProjectionGroups(
      runtime.mountedContexts,
      subscriptionRunners,
    );
    app = new Hono<InventoryApiEnv>();
    app.onError((error, c) => {
      if (error instanceof InventoryDomainError) {
        return c.json({ error: error.message }, 400);
      }

      console.error(error);
      return c.json({
        error: {
          code: "internal_error",
          message: "Internal server error.",
        },
      }, 500);
    });
    app.use("/api/inventory/*", async (c, next) => {
      c.set("actor", {
        accountId: "acc_inventory",
        permissions: ["inventory.view", "inventory.manage"],
      });
      c.set("context", inventoryContext);
      await next();
    });
    app.use("/api/inventory/*", async (c, next) => {
      await next();

      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        await drainContextProcesses({
          projectors: services.projectors,
          subscriptionRunners,
        });
      }
    });
    app.route("/api/inventory", buildInventoryApi(services));
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await bootstrapContextDatabase(orderingModule, pools.ordering);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await catalogModule.seed?.(pools.catalog);
    await syncContextProjectionGroups(runtime, "inventory", { requiredOnly: true });
  }, 120_000);

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("creates inventory items, places holds, releases holds, and projects availability", async () => {
    const locationResponse = await app.request("/api/inventory/storage-locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "North shelf",
        description: "Singles",
        shipFromCode: "CHI-WH-1",
      }),
    });
    expect(locationResponse.status).toBe(201);
    const locationBody = await locationResponse.json();

    const itemResponse = await app.request("/api/inventory/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        catalogItemId: catalogSeedIds.items.charizardBaseSet,
        selectedOptions: [
          {
            dimensionId: catalogSeedIds.dimensions.form.dimensionId,
            optionId: catalogSeedIds.dimensions.form.optionIds.raw,
          },
          {
            dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
            optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
          },
        ],
        storageLocationId: locationBody.id,
        totalQuantity: 10,
        acquisitionCostAmount: "4.50",
      }),
    });
    expect(itemResponse.status).toBe(201);
    const itemBody = await itemResponse.json();

    const holdResponse = await app.request(
      `/api/inventory/items/${itemBody.id}/holds`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantity: 3,
          reason: "Checkout hold",
          notes: "Cart",
        }),
      },
    );
    expect(holdResponse.status).toBe(201);
    const holdBody = await holdResponse.json();

    const listResponse = await app.request("/api/inventory/items");
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]).toMatchObject({
      product_summary: "Form: Raw | Condition: Near Mint",
      total_quantity: 10,
      held_quantity: 3,
      available_quantity: 7,
    });

    const detailResponse = await app.request(`/api/inventory/items/${itemBody.id}`);
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json();
    expect(detailBody.holds).toHaveLength(1);
    expect(detailBody.holds[0]).toMatchObject({
      hold_id: holdBody.id,
      status: "active",
    });

    const releaseResponse = await app.request(
      `/api/inventory/holds/${holdBody.id}/release`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(releaseResponse.status).toBe(200);

    const updatedDetailResponse = await app.request(
      `/api/inventory/items/${itemBody.id}`,
    );
    const updatedDetailBody = await updatedDetailResponse.json();
    expect(updatedDetailBody).toMatchObject({
      held_quantity: 0,
      available_quantity: 10,
    });
    expect(updatedDetailBody.holds[0].status).toBe("released");
  });

  it("prevents over-holds and invalid negative adjustments", async () => {
    const location = await app.request("/api/inventory/storage-locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Overflow",
        shipFromCode: "DFW-2",
      }),
    });
    const locationBody = await location.json();

    const itemResponse = await app.request("/api/inventory/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        catalogItemId: catalogSeedIds.items.pikachuPrismaticEvolutions,
        selectedOptions: [
          {
            dimensionId: catalogSeedIds.dimensions.form.dimensionId,
            optionId: catalogSeedIds.dimensions.form.optionIds.raw,
          },
          {
            dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
            optionId: catalogSeedIds.dimensions.condition.optionIds.excellent,
          },
        ],
        storageLocationId: locationBody.id,
        totalQuantity: 5,
      }),
    });
    const itemBody = await itemResponse.json();

    const hold = await app.request(`/api/inventory/items/${itemBody.id}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantity: 2,
        reason: "Packing",
      }),
    });
    expect(hold.status).toBe(201);

    const overHold = await app.request(`/api/inventory/items/${itemBody.id}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantity: 4,
        reason: "Too much",
      }),
    });
    expect(overHold.status).toBe(400);

    const invalidAdjustment = await app.request(
      `/api/inventory/items/${itemBody.id}/adjustments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantityDelta: -4,
          reason: "Bad cycle count",
        }),
      },
    );
    expect(invalidAdjustment.status).toBe(400);
  });

  it("enforces inventory write permissions", async () => {
    const unauthorizedApp = new Hono<InventoryApiEnv>();
    unauthorizedApp.onError((error, c) => {
      if (error instanceof InventoryDomainError) {
        return c.json({ error: error.message }, 400);
      }

      console.error(error);
      return c.json({
        error: {
          code: "internal_error",
          message: "Internal server error.",
        },
      }, 500);
    });
    unauthorizedApp.use("/api/inventory/*", async (c, next) => {
      c.set("actor", {
        accountId: "acc_inventory",
        permissions: ["inventory.view"],
      });
      c.set("context", inventoryContext);
      await next();
    });
    unauthorizedApp.use("/api/inventory/*", async (c, next) => {
      await next();

      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        await drainContextProcesses({
          projectors: services.projectors,
          subscriptionRunners,
        });
      }
    });
    unauthorizedApp.route("/api/inventory", buildInventoryApi(services));

    const writeResponse = await unauthorizedApp.request("/api/inventory/storage-locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Blocked",
        shipFromCode: "MSP-1",
      }),
    });
    expect(writeResponse.status).toBe(403);
  });

  it("hides cross-account inventory items", async () => {
    const otherContext: EventStoreContext = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_other" as never,
        forAccountId: "acc_other" as never,
      },
    };

    const location = await services.storageLocations.createStorageLocation(
      {
        accountId: "acc_other" as never,
        name: "Other location",
        shipFromCode: "NYC-1",
      },
      otherContext,
    );
    await drainContextProcesses({
      projectors: services.projectors,
      subscriptionRunners,
    });

    await services.items.createItem(
      {
        accountId: "acc_other" as never,
        catalogItemId: catalogSeedIds.items.charizardBaseSet,
        selectedOptions: [
          {
            dimensionId: catalogSeedIds.dimensions.form.dimensionId,
            optionId: catalogSeedIds.dimensions.form.optionIds.raw,
          },
          {
            dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
            optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
          },
        ],
        storageLocationId: location.storageLocationId,
        totalQuantity: 2,
      },
      otherContext,
    );
    await drainContextProcesses({
      projectors: services.projectors,
      subscriptionRunners,
    });

    const listResponse = await app.request("/api/inventory/items");
    const listBody = await listResponse.json();
    expect(listBody.items).toHaveLength(0);
  });

  it("creates deterministic cross-context seed data and stays idempotent", async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await bootstrapContextDatabase(orderingModule, pools.ordering);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await catalogModule.seed?.(pools.catalog);
    await syncContextProjectionGroups(runtime, "inventory", { requiredOnly: true });
    await inventoryModule.seed?.(pools.inventory);
    await drainContextProcesses({
      projectors: services.projectors,
      subscriptionRunners,
    });

    const seededServices = createInventoryServices(pools.inventory);
    const items = await seededServices.items.listItems({
      accountId: demoIdentitySeedIds.accountId,
      limit: 50,
      offset: 0,
    });
    const demoAccountInventoryItemIds = [
      inventorySeedIds.items.charizardBaseSetNearMint,
      inventorySeedIds.items.charizardBaseSetPsa8,
      inventorySeedIds.items.pikachuJungleLightlyPlayed,
      inventorySeedIds.items.lugiaNeoGenesisNearMint,
      inventorySeedIds.items.lugiaNeoGenesisBgs95,
      inventorySeedIds.items.mewtwoBlackStarPromoNearMint,
      inventorySeedIds.items.pikachuPrismaticEvolutionsNearMint,
      inventorySeedIds.items.pikachuPrismaticEvolutionsPsa10,
      inventorySeedIds.items.prismaticEvolutionsBoosterPack,
      inventorySeedIds.items.surgingSparksBoosterBox,
      inventorySeedIds.items.twilightMasqueradeEliteTrainerBox,
    ];
    const demoAccountCatalogItemIds = [
      catalogSeedIds.items.charizardBaseSet,
      catalogSeedIds.items.pikachuJungle,
      catalogSeedIds.items.lugiaNeoGenesis,
      catalogSeedIds.items.mewtwoBlackStarPromo,
      catalogSeedIds.items.pikachuPrismaticEvolutions,
      catalogSeedIds.items.prismaticEvolutionsBoosterPack,
      catalogSeedIds.items.surgingSparksBoosterBox,
      catalogSeedIds.items.twilightMasqueradeEliteTrainerBox,
    ];

    expect(items.total).toBe(demoAccountInventoryItemIds.length);
    expect(new Set(items.items.map((item) => item.item_id))).toEqual(
      new Set(demoAccountInventoryItemIds),
    );
    expect(new Set(items.items.map((item) => item.account_id))).toEqual(
      new Set([demoIdentitySeedIds.accountId]),
    );
    expect(new Set(items.items.map((item) => item.catalog_catalog_item_id))).toEqual(
      new Set(demoAccountCatalogItemIds),
    );

    const charizardItem = await seededServices.items.getItem(
      inventorySeedIds.items.charizardBaseSetNearMint,
      demoIdentitySeedIds.accountId,
    );
    expect(charizardItem).toMatchObject({
      item_id: inventorySeedIds.items.charizardBaseSetNearMint,
      catalog_catalog_item_id: catalogSeedIds.items.charizardBaseSet,
      item_title: "Charizard",
      item_subtitle: "Base Set 4/102 Holo Rare",
      held_quantity: 1,
      available_quantity: 2,
    });
    expect(charizardItem?.holds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hold_id: inventorySeedIds.holds.charizardCheckout,
          status: "active",
        }),
      ]),
    );

    const gradedCharizardItem = await seededServices.items.getItem(
      inventorySeedIds.items.charizardBaseSetPsa8,
      demoIdentitySeedIds.accountId,
    );
    expect(gradedCharizardItem).toMatchObject({
      item_id: inventorySeedIds.items.charizardBaseSetPsa8,
      catalog_catalog_item_id: catalogSeedIds.items.charizardBaseSet,
      product_summary: "Form: Graded | Grading Company: PSA | Grade: NM-MT 8",
      graded_card: {
        gradingCompany: "PSA",
        grade: "NM-MT 8",
        certificationNumber: "81234567",
        population: {
          populationAtGrade: 1842,
          populationHigher: 721,
          source: "PSA population report",
          asOf: "2026-04-01",
        },
      },
      available_quantity: 1,
    });

    const pikachuItem = await seededServices.items.getItem(
      inventorySeedIds.items.pikachuJungleLightlyPlayed,
      demoIdentitySeedIds.accountId,
    );
    expect(pikachuItem).toMatchObject({
      item_id: inventorySeedIds.items.pikachuJungleLightlyPlayed,
      catalog_catalog_item_id: catalogSeedIds.items.pikachuJungle,
      item_title: "Pikachu",
      item_subtitle: "Jungle 60/64 Common",
      held_quantity: 0,
      available_quantity: 8,
    });
    expect(pikachuItem?.holds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hold_id: inventorySeedIds.holds.pikachuPackingReleased,
          status: "released",
        }),
      ]),
    );

    const eventCountBefore = await countEvents(pools.inventory, "inventory.");
    await inventoryModule.seed?.(pools.inventory);
    const eventCountAfter = await countEvents(pools.inventory, "inventory.");
    expect(eventCountAfter).toBe(eventCountBefore);

    const storageLocations = await seededServices.storageLocations.listStorageLocations({
      accountId: demoIdentitySeedIds.accountId,
      includeArchived: true,
    });
    expect(storageLocations.map((location) => location.storage_location_id).sort()).toEqual(
      [
        inventorySeedIds.storageLocations.northShelf,
        inventorySeedIds.storageLocations.vaultAnnex,
        inventorySeedIds.storageLocations.archivedOverflow,
      ].sort(),
    );
  }, 60000);
});
