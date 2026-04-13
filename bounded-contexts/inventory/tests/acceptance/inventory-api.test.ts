import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  bootstrapContextDatabase,
  drainContextProcesses,
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
import { type InventoryApiEnv, buildInventoryApi } from "../../api";
import { InventoryDomainError } from "../../support/runtime-support/common";
import { createInventoryServices } from "../../support/runtime-support/services";
import { module as inventoryModule } from "../..";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseBaseUrl ? describe : describe.skip;
const inventoryContextNames = ["catalog", "inventory"] as const;

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
  let runtime: any;
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
      return c.json({ error: "Internal server error." }, 500);
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
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await catalogModule.seed?.(pools.catalog);
    await syncContextProjectionGroups(runtime, "inventory", { requiredOnly: true });
  }, 30_000);

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("creates records, places holds, releases holds, and projects availability", async () => {
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

    const recordResponse = await app.request("/api/inventory/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        catalogItemId: catalogSeedIds.items.charizardBaseSet,
        versionSelection: [
          {
            dimensionId: catalogSeedIds.dimensions.form.dimensionId,
            choiceId: catalogSeedIds.dimensions.form.choiceIds.raw,
          },
          {
            dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
            choiceId: catalogSeedIds.dimensions.condition.choiceIds.nearMint,
          },
        ],
        storageLocationId: locationBody.id,
        totalQuantity: 10,
        acquisitionCostAmount: "4.50",
      }),
    });
    expect(recordResponse.status).toBe(201);
    const recordBody = await recordResponse.json();

    const holdResponse = await app.request(
      `/api/inventory/records/${recordBody.id}/holds`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantity: 3,
          reason: "Checkout hold",
          notes: "Buyer cart",
        }),
      },
    );
    expect(holdResponse.status).toBe(201);
    const holdBody = await holdResponse.json();

    const listResponse = await app.request("/api/inventory/records");
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]).toMatchObject({
      version_summary: "Form: Raw | Condition: Near Mint",
      total_quantity: 10,
      held_quantity: 3,
      available_quantity: 7,
    });

    const detailResponse = await app.request(`/api/inventory/records/${recordBody.id}`);
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
      `/api/inventory/records/${recordBody.id}`,
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

    const record = await app.request("/api/inventory/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        catalogItemId: catalogSeedIds.items.pikachuPrismaticEvolutions,
        versionSelection: [
          {
            dimensionId: catalogSeedIds.dimensions.form.dimensionId,
            choiceId: catalogSeedIds.dimensions.form.choiceIds.raw,
          },
          {
            dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
            choiceId: catalogSeedIds.dimensions.condition.choiceIds.excellent,
          },
        ],
        storageLocationId: locationBody.id,
        totalQuantity: 5,
      }),
    });
    const recordBody = await record.json();

    const hold = await app.request(`/api/inventory/records/${recordBody.id}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantity: 2,
        reason: "Packing",
      }),
    });
    expect(hold.status).toBe(201);

    const overHold = await app.request(`/api/inventory/records/${recordBody.id}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantity: 4,
        reason: "Too much",
      }),
    });
    expect(overHold.status).toBe(400);

    const invalidAdjustment = await app.request(
      `/api/inventory/records/${recordBody.id}/adjustments`,
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
      return c.json({ error: "Internal server error." }, 500);
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

  it("hides cross-account records", async () => {
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

    await services.records.createRecord(
      {
        accountId: "acc_other" as never,
        catalogItemId: catalogSeedIds.items.charizardBaseSet,
        versionSelection: [
          {
            dimensionId: catalogSeedIds.dimensions.form.dimensionId,
            choiceId: catalogSeedIds.dimensions.form.choiceIds.raw,
          },
          {
            dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
            choiceId: catalogSeedIds.dimensions.condition.choiceIds.nearMint,
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

    const listResponse = await app.request("/api/inventory/records");
    const listBody = await listResponse.json();
    expect(listBody.items).toHaveLength(0);
  });

  it("creates deterministic cross-context seed data and stays idempotent", async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await catalogModule.seed?.(pools.catalog);
    await syncContextProjectionGroups(runtime, "inventory", { requiredOnly: true });
    await inventoryModule.seed?.(pools.inventory);
    await drainContextProcesses({
      projectors: services.projectors,
      subscriptionRunners,
    });

    const seededServices = createInventoryServices(pools.inventory);
    const records = await seededServices.records.listRecords({
      accountId: demoIdentitySeedIds.accountId,
      limit: 50,
      offset: 0,
    });

    expect(records.total).toBe(Object.keys(inventorySeedIds.records).length);
    expect(new Set(records.items.map((item) => item.account_id))).toEqual(
      new Set([demoIdentitySeedIds.accountId]),
    );
    expect(new Set(records.items.map((item) => item.catalog_item_id))).toEqual(
      new Set(Object.values(catalogSeedIds.items)),
    );

    const charizardRecord = await seededServices.records.getRecord(
      inventorySeedIds.records.charizardBaseSetNearMint,
      demoIdentitySeedIds.accountId,
    );
    expect(charizardRecord).toMatchObject({
      record_id: inventorySeedIds.records.charizardBaseSetNearMint,
      catalog_item_id: catalogSeedIds.items.charizardBaseSet,
      item_title: "Charizard",
      item_subtitle: "Base Set 4/102 Holo Rare",
      held_quantity: 1,
      available_quantity: 2,
    });
    expect(charizardRecord?.holds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hold_id: inventorySeedIds.holds.charizardCheckout,
          status: "active",
        }),
      ]),
    );

    const pikachuRecord = await seededServices.records.getRecord(
      inventorySeedIds.records.pikachuJungleLightlyPlayed,
      demoIdentitySeedIds.accountId,
    );
    expect(pikachuRecord).toMatchObject({
      record_id: inventorySeedIds.records.pikachuJungleLightlyPlayed,
      catalog_item_id: catalogSeedIds.items.pikachuJungle,
      item_title: "Pikachu",
      item_subtitle: "Jungle 60/64 Common",
      held_quantity: 0,
      available_quantity: 8,
    });
    expect(pikachuRecord?.holds).toEqual(
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
      Object.values(inventorySeedIds.storageLocations).sort(),
    );
  }, 60000);
});




