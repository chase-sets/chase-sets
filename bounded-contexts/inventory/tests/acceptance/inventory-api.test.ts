import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { BcApiEntry, BcApiModule } from "@chase-sets/bounded-context-module";
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
import { createPostgresEventStore, escapeLikePattern, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { demoIdentitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { inventorySeedIds } from "@chase-sets/inventory/seed-support/ids";
import { module as catalogModule } from "@chase-sets/catalog";
import { type InventoryApiEnv, buildInventoryApi } from "../../api";
import { InventoryDomainError } from "../../support/runtime-support/common";
import { createInventoryServices } from "../../support/runtime-support/services";
import { reserveOrderInventoryRequest } from "../../features/reservations/api/order-reservation-workflow";
import { module as inventoryModule } from "../..";

const NO_API_ENTRIES: readonly BcApiEntry[] = [];

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const inventoryContextNames = ["catalog", "ordering", "inventory"] as const;
type InventoryAcceptanceRuntime = {
  mountedContexts: readonly MountedContextRuntimeEntry[];
  subscriptionRunners: readonly ContextSubscriptionRunner[];
  projectionGroups: readonly ContextProjectionGroup[];
};

const orderingSourceModule = {
  contextName: "ordering",
  routePrefix: "/api/marketplace",
  streamPrefix: "ordering.",
  schemaSql: "",
  apiMounts: [],
  createServices: () => ({}),
  buildApis: () => NO_API_ENTRIES,
} satisfies BcApiModule<Record<string, never>, PgTransactionalPool, Record<string, never>>;

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

const shipFromAddress = {
  name: "Test Inventory",
  line1: "100 Test Lane",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: "3125550100",
  email: "inventory@example.test",
};

async function countEvents(pool: PgTransactionalPool, prefix: string) {
  const result = await pool.query(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1 ESCAPE '\\'",
    [`${escapeLikePattern(prefix)}%`],
  );

  return Number(result.rows[0]?.count ?? 0);
}

async function countStreamEvents(pool: PgTransactionalPool, streamId: string) {
  const result = await pool.query("SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id = $1", [streamId]);

  return Number(result.rows[0]?.count ?? 0);
}

async function countStreamEventsByType(pool: PgTransactionalPool, streamId: string, eventType: string) {
  const result = await pool.query(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id = $1 AND event_type = $2",
    [streamId, eventType],
  );

  return Number(result.rows[0]?.count ?? 0);
}

describe("inventory api", () => {
  let databaseUrls: Readonly<Record<(typeof inventoryContextNames)[number], string>>;
  let pools: Readonly<Record<(typeof inventoryContextNames)[number], PgTransactionalPool>>;
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
    const catalogServices = catalogModule.createServices(pools.catalog, {});
    services = createInventoryServices(pools.inventory);
    runtime = {
      mountedContexts: [
        {
          contextName: "catalog",
          module: catalogModule,
          services: catalogServices,
          pool: pools.catalog,
          projectionHandlerSets: catalogModule.projectionHandlerSets?.(catalogServices) ?? [],
        },
        {
          contextName: "ordering",
          mountRole: "source-only",
          module: orderingSourceModule,
          services: {},
          pool: pools.ordering,
          projectionHandlerSets: [],
        },
        {
          contextName: "inventory",
          module: inventoryModule,
          services,
          pool: pools.inventory,
          projectionHandlerSets: inventoryModule.projectionHandlerSets?.(services) ?? [],
        },
      ] as const,
      subscriptionRunners: [],
      projectionGroups: [],
    };
    subscriptionRunners = resolveModuleSubscriptions(runtime.mountedContexts);
    runtime.subscriptionRunners = subscriptionRunners;
    runtime.projectionGroups = resolveModuleProjectionGroups(runtime.mountedContexts, subscriptionRunners);
    app = new Hono<InventoryApiEnv>();
    app.onError((error, c) => {
      if (error instanceof InventoryDomainError) {
        return c.json({ error: error.message }, 400);
      }

      console.error(error);
      return c.json(
        {
          error: {
            code: "internal_error",
            message: "Internal server error.",
          },
        },
        500,
      );
    });
    app.use("/api/inventory/*", async (c, next) => {
      c.set("actor", {
        accountId: "acc_inventory",
        roleKey: "owner",
        permissions: ["inventory.view", "inventory.manage"],
      });
      c.set("context", inventoryContext);
      await next();
    });
    app.use("/api/inventory/*", async (c, next) => {
      await next();

      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        await drainContextProcesses({
          subscriptionRunners,
        });
      }
    });
    app.route("/api/inventory", buildInventoryApi(services));
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await bootstrapContextDatabase(orderingSourceModule, pools.ordering);
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
        shipFromAddress,
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

    const holdResponse = await app.request(`/api/inventory/items/${itemBody.id}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantity: 3,
        reason: "Checkout hold",
        notes: "Cart",
      }),
    });
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

    const releaseResponse = await app.request(`/api/inventory/holds/${holdBody.id}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(releaseResponse.status).toBe(200);

    const updatedDetailResponse = await app.request(`/api/inventory/items/${itemBody.id}`);
    const updatedDetailBody = await updatedDetailResponse.json();
    expect(updatedDetailBody).toMatchObject({
      held_quantity: 0,
      available_quantity: 10,
    });
    expect(updatedDetailBody.holds[0].status).toBe("released");
  });

  it("rolls back the order hold when reservation confirmation loses the dual append race", async () => {
    const location = await services.storageLocations.createStorageLocation(
      {
        accountId: "acc_inventory" as never,
        name: "Atomic shelf",
        shipFromCode: "CHI-ATOMIC",
        shipFromAddress,
      },
      inventoryContext,
    );
    await drainContextProcesses({
      subscriptionRunners,
    });

    const item = await services.items.createItem(
      {
        accountId: "acc_inventory" as never,
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
        totalQuantity: 1,
      },
      inventoryContext,
    );
    await drainContextProcesses({
      subscriptionRunners,
    });

    const eventStore = createPostgresEventStore({ pool: pools.inventory });
    const reservationRequestId = "rsv_atomic_rollback";
    const holdStreamId = `inventory.hold-hld_order_reservation_${reservationRequestId}`;
    const reservationStreamId = `inventory.reservation-${reservationRequestId}`;
    const planConfirmation = services.reservations.planConfirmation;

    await expect(
      reserveOrderInventoryRequest(
        {
          holds: services.holds,
          reservations: {
            ...services.reservations,
            planConfirmation: async (params, context) => {
              const plan = await planConfirmation(params, context);
              await eventStore.appendToStream({
                streamId: reservationStreamId,
                expectedVersion: "no_stream",
                context,
                events: [
                  {
                    eventType: "inventory.reservation.rejected",
                    payload: {
                      reservationRequestId,
                      orderId: params.orderId,
                      sellerAccountId: params.sellerAccountId,
                      inventoryItemId: params.inventoryItemId,
                      quantity: params.quantity,
                      reason: "simulated competing resolution",
                    },
                  },
                ],
              });
              return plan;
            },
          },
          appendToStreams: services.appendToStreams,
        },
        {
          orderId: "ord_atomic_rollback",
          request: {
            reservationRequestId,
            sellerAccountId: "acc_inventory",
            inventoryItemId: item.itemId,
            quantity: 1,
          },
          context: inventoryContext,
        },
      ),
    ).rejects.toMatchObject({
      code: "concurrency_conflict",
    });

    await expect(countStreamEvents(pools.inventory, holdStreamId)).resolves.toBe(0);
    await expect(countStreamEvents(pools.inventory, reservationStreamId)).resolves.toBe(1);
  });

  it("converts checkout holds without opening an interleaved placement window", async () => {
    const location = await services.storageLocations.createStorageLocation(
      {
        accountId: "acc_inventory" as never,
        name: "Checkout conversion shelf",
        shipFromCode: "CHI-CONVERT",
        shipFromAddress,
      },
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });

    const item = await services.items.createItem(
      {
        accountId: "acc_inventory" as never,
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
        totalQuantity: 1,
      },
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });

    const checkoutHoldId = "hld_checkout_conversion_atomic" as never;
    await services.holds.createHold(
      {
        holdId: checkoutHoldId,
        accountId: "acc_inventory" as never,
        itemId: item.itemId,
        quantity: 1,
        reason: "Checkout reservation",
        notes: null,
        purpose: "checkout",
        sourceRef: {
          checkoutSessionId: "chk_conversion_atomic" as never,
          lineKey: "cli_conversion_atomic",
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });

    await expect(services.items.getItem(item.itemId, "acc_inventory")).resolves.toMatchObject({
      held_quantity: 1,
      available_quantity: 0,
    });

    const conversion = reserveOrderInventoryRequest(services, {
      orderId: "ord_checkout_conversion_atomic",
      request: {
        reservationRequestId: "rsv_checkout_conversion_atomic",
        sellerAccountId: "acc_inventory",
        inventoryItemId: item.itemId,
        quantity: 1,
        holdId: checkoutHoldId,
      },
      context: inventoryContext,
    });
    const competingPlacement = services.holds.createHold(
      {
        holdId: "hld_order_competing_checkout_conversion" as never,
        accountId: "acc_inventory" as never,
        itemId: item.itemId,
        quantity: 1,
        reason: "Competing order commitment",
        notes: null,
        purpose: "order",
        sourceRef: {
          orderId: "ord_competing_checkout_conversion",
          reservationRequestId: "rsv_competing_checkout_conversion",
        },
        expiresAt: null,
      },
      inventoryContext,
    );
    const [conversionResult, competingPlacementResult] = await Promise.allSettled([conversion, competingPlacement]);

    expect(conversionResult.status).toBe("fulfilled");
    expect(competingPlacementResult.status).toBe("rejected");
    if (competingPlacementResult.status === "rejected") {
      expect(competingPlacementResult.reason).toMatchObject({
        kind: "insufficient-available-quantity",
      });
    }

    await drainContextProcesses({ subscriptionRunners });

    await expect(services.holds.getHold(checkoutHoldId, "acc_inventory")).resolves.toMatchObject({
      hold_id: checkoutHoldId,
      status: "active",
      purpose: "order",
      source_ref: {
        orderId: "ord_checkout_conversion_atomic",
        reservationRequestId: "rsv_checkout_conversion_atomic",
      },
      expires_at: null,
    });
    const convertedItem = await services.items.getItem(item.itemId, "acc_inventory");
    expect(convertedItem).toMatchObject({
      held_quantity: 1,
      available_quantity: 0,
    });
    expect(convertedItem?.holds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hold_id: checkoutHoldId,
          status: "active",
          purpose: "order",
        }),
      ]),
    );
    await expect(
      countStreamEventsByType(pools.inventory, `inventory.hold-${checkoutHoldId}`, "inventory.hold.converted"),
    ).resolves.toBe(1);
    await expect(
      countStreamEvents(pools.inventory, "inventory.hold-hld_order_competing_checkout_conversion"),
    ).resolves.toBe(0);
    await expect(
      countStreamEvents(pools.inventory, "inventory.reservation-rsv_checkout_conversion_atomic"),
    ).resolves.toBe(1);
  });

  it("expires abandoned checkout holds in one sweep and restores availability", async () => {
    const location = await services.storageLocations.createStorageLocation(
      {
        accountId: "acc_inventory" as never,
        name: "Checkout expiry shelf",
        shipFromCode: "CHI-EXPIRE",
        shipFromAddress,
      },
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });

    const item = await services.items.createItem(
      {
        accountId: "acc_inventory" as never,
        catalogItemId: catalogSeedIds.items.pikachuJungle,
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
        totalQuantity: 1,
      },
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });

    const checkoutHoldId = "hld_checkout_expiry_drill" as never;
    await services.holds.createHold(
      {
        holdId: checkoutHoldId,
        accountId: "acc_inventory" as never,
        itemId: item.itemId,
        quantity: 1,
        reason: "Checkout reservation",
        notes: null,
        purpose: "checkout",
        sourceRef: {
          checkoutSessionId: "chk_expiry_drill" as never,
          lineKey: "cli_expiry_drill",
        },
        expiresAt: "2026-07-07T00:00:00.000Z",
      },
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });

    await expect(services.items.getItem(item.itemId, "acc_inventory")).resolves.toMatchObject({
      held_quantity: 1,
      available_quantity: 0,
    });

    await expect(
      services.holds.expireDueCheckoutHolds(
        {
          now: "2026-07-07T00:01:00.000Z",
          limit: 10,
        },
        inventoryContext,
      ),
    ).resolves.toEqual([{ holdId: checkoutHoldId, version: 2 }]);
    await drainContextProcesses({ subscriptionRunners });

    await expect(services.holds.getHold(checkoutHoldId, "acc_inventory")).resolves.toMatchObject({
      hold_id: checkoutHoldId,
      status: "expired",
      release_reason: "checkout-expired",
      expired_at: new Date("2026-07-07T00:01:00.000Z"),
    });
    const expiredItem = await services.items.getItem(item.itemId, "acc_inventory");
    expect(expiredItem).toMatchObject({
      held_quantity: 0,
      available_quantity: 1,
    });
    expect(expiredItem?.holds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hold_id: checkoutHoldId,
          status: "expired",
        }),
      ]),
    );
    await expect(
      countStreamEventsByType(pools.inventory, `inventory.hold-${checkoutHoldId}`, "inventory.hold.expired"),
    ).resolves.toBe(1);
    await expect(
      countStreamEventsByType(pools.inventory, `inventory.hold-${checkoutHoldId}`, "inventory.hold.released"),
    ).resolves.toBe(0);
  });

  it("prevents over-holds and defaults colliding reductions to protect orders with a partial fill", async () => {
    const location = await app.request("/api/inventory/storage-locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Overflow",
        shipFromCode: "DFW-2",
        shipFromAddress,
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

    const protectedAdjustment = await app.request(`/api/inventory/items/${itemBody.id}/adjustments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantityDelta: -4,
        reason: "Bad cycle count",
      }),
    });
    expect(protectedAdjustment.status).toBe(200);
    await expect(protectedAdjustment.json()).resolves.toMatchObject({
      status: "hold-collision-recorded",
      collision: {
        mode: "protect-orders",
        requestedQuantity: 4,
        appliedQuantity: 3,
        refusedQuantity: 1,
      },
    });

    const protectedItem = await services.items.getItem(itemBody.id, "acc_inventory");
    expect(protectedItem).toMatchObject({
      total_quantity: 2,
      held_quantity: 2,
      available_quantity: 0,
    });
  });

  it("honors an explicit manager override by atomically releasing affected order commitments", async () => {
    const location = await services.storageLocations.createStorageLocation(
      {
        accountId: "acc_inventory" as never,
        name: "Counter collision",
        shipFromCode: "CHI-COUNTER",
        shipFromAddress,
      },
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });
    const item = await services.items.createItem(
      {
        accountId: "acc_inventory" as never,
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
        totalQuantity: 5,
      },
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });

    await reserveOrderInventoryRequest(services, {
      orderId: "ord_collision_1",
      request: {
        reservationRequestId: "rsv_collision_1",
        sellerAccountId: "acc_inventory",
        inventoryItemId: item.itemId,
        quantity: 3,
      },
      context: inventoryContext,
    });
    await drainContextProcesses({ subscriptionRunners });

    const response = await app.request(`/api/inventory/items/${item.itemId}/adjustments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantityDelta: -4,
        reason: "Counter sale",
        collisionMode: "honor-offline",
        confirmSellerCannotFulfill: true,
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      collision: {
        mode: "honor-offline",
        appliedQuantity: 4,
        releasedHoldQuantity: 3,
        affectedOrders: [
          {
            orderId: "ord_collision_1",
            reservationRequestId: "rsv_collision_1",
            disposition: "released",
          },
        ],
      },
    });

    await expect(services.items.getItem(item.itemId, "acc_inventory")).resolves.toMatchObject({
      total_quantity: 1,
      held_quantity: 0,
      available_quantity: 1,
    });
    await expect(services.reservations.getReservationState("rsv_collision_1")).resolves.toMatchObject({
      status: "released",
      releaseReason: "hold-collision",
    });
    const releaseEvents = await pools.inventory.query<{ payload: Record<string, unknown> }>(
      `SELECT payload
       FROM event_store_events
       WHERE stream_id = 'inventory.reservation-rsv_collision_1'
         AND event_type = 'inventory.reservation.released'`,
    );
    expect(releaseEvents.rows[0]?.payload).toMatchObject({
      orderId: "ord_collision_1",
      sellerAccountId: "acc_inventory",
      releaseReason: "hold-collision",
    });
    const collisions = await pools.inventory.query<{ mode: string; affected_orders: unknown }>(
      "SELECT mode, affected_orders FROM inventory_hold_collisions WHERE item_id = $1",
      [item.itemId],
    );
    expect(collisions.rows).toEqual([
      expect.objectContaining({
        mode: "honor-offline",
        affected_orders: [expect.objectContaining({ orderId: "ord_collision_1" })],
      }),
    ]);
  });

  it("treats checkout conversion as the order commitment time when releasing the newest order", async () => {
    const location = await services.storageLocations.createStorageLocation(
      {
        accountId: "acc_inventory" as never,
        name: "Conversion collision",
        shipFromCode: "CHI-CONVERT",
        shipFromAddress,
      },
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });
    const item = await services.items.createItem(
      {
        accountId: "acc_inventory" as never,
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
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });

    const checkoutHoldId = "hld_checkout_older_than_direct" as never;
    await services.holds.createHold(
      {
        holdId: checkoutHoldId,
        accountId: "acc_inventory" as never,
        itemId: item.itemId,
        quantity: 1,
        reason: "Checkout payment step",
        purpose: "checkout",
        sourceRef: { checkoutSessionId: "chk_older" as never, lineKey: "line_1" },
        expiresAt: "2099-07-17T12:00:00.000Z",
      },
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });

    await reserveOrderInventoryRequest(services, {
      orderId: "ord_direct_newer_than_checkout",
      request: {
        reservationRequestId: "rsv_direct_newer_than_checkout",
        sellerAccountId: "acc_inventory",
        inventoryItemId: item.itemId,
        quantity: 1,
      },
      context: inventoryContext,
    });
    await drainContextProcesses({ subscriptionRunners });

    await reserveOrderInventoryRequest(services, {
      orderId: "ord_converted_newest",
      request: {
        reservationRequestId: "rsv_converted_newest",
        sellerAccountId: "acc_inventory",
        inventoryItemId: item.itemId,
        quantity: 1,
        holdId: checkoutHoldId,
      },
      context: inventoryContext,
    });
    await drainContextProcesses({ subscriptionRunners });

    const result = await services.holdCollisions.reduceItem(
      {
        accountId: "acc_inventory",
        itemId: item.itemId,
        requestedQuantity: 1,
        reason: "Counter sale after checkout conversion",
        mode: "honor-offline",
        actorRole: "owner",
      },
      inventoryContext,
    );

    expect(result.collision?.affectedOrders).toEqual([
      expect.objectContaining({
        orderId: "ord_converted_newest",
        reservationRequestId: "rsv_converted_newest",
        disposition: "released",
      }),
    ]);
    await expect(services.reservations.getReservationState("rsv_converted_newest")).resolves.toMatchObject({
      status: "released",
    });
    await expect(services.reservations.getReservationState("rsv_direct_newer_than_checkout")).resolves.toMatchObject({
      status: "confirmed",
    });
  });

  it("serializes a simultaneous reservation and stock reduction so one unit is never double-committed", async () => {
    const location = await services.storageLocations.createStorageLocation(
      {
        accountId: "acc_inventory" as never,
        name: "Race shelf",
        shipFromCode: "CHI-RACE",
        shipFromAddress,
      },
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });
    const item = await services.items.createItem(
      {
        accountId: "acc_inventory" as never,
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
        totalQuantity: 1,
      },
      inventoryContext,
    );
    await drainContextProcesses({ subscriptionRunners });

    const reservationInput = {
      orderId: "ord_collision_race",
      request: {
        reservationRequestId: "rsv_collision_race",
        sellerAccountId: "acc_inventory",
        inventoryItemId: item.itemId,
        quantity: 1,
      },
      context: inventoryContext,
    } as const;
    const [reservationAttempt] = await Promise.allSettled([
      reserveOrderInventoryRequest(services, reservationInput),
      services.holdCollisions.reduceItem(
        {
          accountId: "acc_inventory",
          itemId: item.itemId,
          requestedQuantity: 1,
          reason: "Concurrent counter sale",
        },
        inventoryContext,
      ),
    ]);
    if (reservationAttempt.status === "rejected") {
      await reserveOrderInventoryRequest(services, reservationInput);
    }
    await drainContextProcesses({ subscriptionRunners });

    const stock = await services.items.getItem(item.itemId, "acc_inventory");
    expect(stock).not.toBeNull();
    expect(stock!.total_quantity).toBeGreaterThanOrEqual(stock!.held_quantity);
    expect(stock!.available_quantity).toBe(stock!.total_quantity - stock!.held_quantity);
    expect([
      [0, 0],
      [1, 1],
    ]).toContainEqual([stock!.total_quantity, stock!.held_quantity]);
  });

  it("enforces inventory write permissions", async () => {
    const unauthorizedApp = new Hono<InventoryApiEnv>();
    unauthorizedApp.onError((error, c) => {
      if (error instanceof InventoryDomainError) {
        return c.json({ error: error.message }, 400);
      }

      console.error(error);
      return c.json(
        {
          error: {
            code: "internal_error",
            message: "Internal server error.",
          },
        },
        500,
      );
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
        shipFromAddress,
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
        shipFromAddress,
      },
      otherContext,
    );
    await drainContextProcesses({
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
      subscriptionRunners,
    });

    const listResponse = await app.request("/api/inventory/items");
    const listBody = await listResponse.json();
    expect(listBody.items).toHaveLength(0);
  });

  it("creates deterministic cross-context seed data and stays idempotent", async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await bootstrapContextDatabase(orderingSourceModule, pools.ordering);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await catalogModule.seed?.(pools.catalog);
    await syncContextProjectionGroups(runtime, "inventory", { requiredOnly: true });
    await inventoryModule.seed?.(pools.inventory);
    await drainContextProcesses({
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
    expect(new Set(items.items.map((item) => item.item_id))).toEqual(new Set(demoAccountInventoryItemIds));
    expect(new Set(items.items.map((item) => item.account_id))).toEqual(new Set([demoIdentitySeedIds.accountId]));
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
