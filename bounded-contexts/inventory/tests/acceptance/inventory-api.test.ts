import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { Hono } from "hono";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  catalogSeedIds,
  demoIdentitySeedIds,
  inventorySeedIds,
} from "@chase-sets/dev-seeds";
import {
  catalogAuthoringSchemaSql,
  seedCatalogDatabase,
} from "@chase-sets/catalog-authoring";
import {
  identitySchemaSql,
  seedIdentityDatabase,
} from "@chase-sets/identity";
import {
  InventoryDomainError,
  type InventoryApiEnv,
  buildInventoryApi,
  createInventoryServices,
  inventorySchemaSql,
  seedInventoryDatabase,
} from "../..";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://catalog:catalog@localhost:5432/catalog";

const inventoryContext: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_inventory" as never,
  },
};

function createPool(connectionString: string): PgTransactionalPool {
  return new pg.Pool({ connectionString }) as unknown as PgTransactionalPool;
}

async function recreateSchema(pool: PgTransactionalPool) {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await pool.query(inventorySchemaSql);
}

async function recreateCrossContextSchema(pool: PgTransactionalPool) {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await pool.query(identitySchemaSql);
  await pool.query(catalogAuthoringSchemaSql);
  await pool.query(inventorySchemaSql);
}

async function drainProjectors(projectors: readonly { runOnce: () => Promise<{ processed: number }> }[]) {
  for (const projector of projectors) {
    let processed = 0;
    do {
      processed = (await projector.runOnce()).processed;
    } while (processed > 0);
  }
}

async function countEvents(pool: PgTransactionalPool, prefix: string) {
  const result = await pool.query(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1",
    [`${prefix}%`],
  );

  return Number(result.rows[0]?.count ?? 0);
}

describe("inventory api", () => {
  let pool: PgTransactionalPool;
  let services: ReturnType<typeof createInventoryServices>;
  let app: Hono<InventoryApiEnv>;

  beforeAll(async () => {
    pool = createPool(databaseUrl);
    services = createInventoryServices(pool);
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
    app.route("/api/inventory", buildInventoryApi(services));
  });

  beforeEach(async () => {
    await recreateSchema(pool);
  });

  afterAll(async () => {
    await (pool as unknown as { end: () => Promise<void> }).end();
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
        catalogItemId: "cat_charizard",
        condition: "NM",
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
        catalogItemId: "cat_iono",
        condition: "LP",
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
    await drainProjectors(services.projectors);

    await services.records.createRecord(
      {
        accountId: "acc_other" as never,
        catalogItemId: "cat_other",
        condition: "NM",
        storageLocationId: location.storageLocationId,
        totalQuantity: 2,
      },
      otherContext,
    );
    await drainProjectors(services.projectors);

    const listResponse = await app.request("/api/inventory/records");
    const listBody = await listResponse.json();
    expect(listBody.items).toHaveLength(0);
  });

  it("creates deterministic cross-context seed data and stays idempotent", async () => {
    await recreateCrossContextSchema(pool);

    await seedIdentityDatabase(pool);
    await seedCatalogDatabase(pool);
    await seedInventoryDatabase(pool);

    const seededServices = createInventoryServices(pool);
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

    const eventCountBefore = await countEvents(pool, "inventory.");
    await seedInventoryDatabase(pool);
    const eventCountAfter = await countEvents(pool, "inventory.");
    expect(eventCountAfter).toBe(eventCountBefore);

    const storageLocations = await seededServices.storageLocations.listStorageLocations({
      accountId: demoIdentitySeedIds.accountId,
    });
    expect(storageLocations.map((location) => location.storage_location_id).sort()).toEqual(
      Object.values(inventorySeedIds.storageLocations).sort(),
    );
  }, 15000);
});



