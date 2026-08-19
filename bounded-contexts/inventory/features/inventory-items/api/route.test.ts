import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryApiEnv } from "../../../api";
import type { InventoryHoldServices } from "../../holds/api/runtime";
import type { InventoryHoldCollisionServices } from "../../hold-collisions/api/runtime";
import { inventoryItemRoutes } from "./route";
import type { InventoryItemServices } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_inventory" as never,
  },
};

const listingStockResult = {
  inventoryItemId: "itm_1",
  storageLocationId: "sloc_1",
  createdStorageLocation: false,
  createdInventoryItem: false,
  adjustedQuantityBy: 0,
  snapshot: {
    inventoryItemId: "itm_1",
    catalogItemId: "cat_1",
    productId: "cat_1::form:graded",
    selectedOptions: [{ dimensionId: "form", optionId: "graded" }],
    gradedCard: null,
    storageLocationId: "sloc_1",
    storageLocationName: "Listing stock",
    shipFromCode: "LISTING-STOCK",
    shipFromAddress: {
      name: "Inventory",
      line1: "100 Test Lane",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
    },
    totalQuantity: 1,
    availableQuantity: 1,
    acquisitionCostAmount: null,
  },
} satisfies Awaited<ReturnType<InventoryItemServices["ensureListingStock"]>>;

function buildApp(
  items: InventoryItemServices,
  options: Readonly<{ roleKey?: string; holdCollisions?: InventoryHoldCollisionServices }> = {},
) {
  const app = new Hono<InventoryApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      accountId: "acc_inventory",
      roleKey: options.roleKey,
      permissions: ["inventory.view", "inventory.manage"],
    });
    c.set("context", context);
    await next();
  });
  app.route(
    "/items",
    inventoryItemRoutes(
      items,
      createHoldServices(),
      options.holdCollisions ?? {
        reduceItem: vi.fn(async (params) => ({ itemId: params.itemId, version: 3, collision: null })),
        projectors: [],
      },
    ),
  );
  return app;
}

function createItemServices(overrides: Partial<InventoryItemServices> = {}): InventoryItemServices {
  return {
    listItems: async () => ({ items: [], total: 0 }),
    getItem: async () => null,
    createItem: async () => ({ itemId: "itm_1" as never, version: 1 }),
    adjustItem: async () => ({ itemId: "itm_1" as never, version: 2 }),
    ensureListingStock: vi.fn<InventoryItemServices["ensureListingStock"]>(async () => listingStockResult),
    commandHandler: async () => {
      throw new Error("command handler not expected");
    },
    projectors: [],
    ...overrides,
  } as unknown as InventoryItemServices;
}

function createHoldServices(): InventoryHoldServices {
  return {
    createHold: async () => ({ holdId: "hold_1", version: 1 }),
    releaseHold: async () => ({ holdId: "hold_1", version: 2 }),
    commandHandler: async () => {
      throw new Error("command handler not expected");
    },
    projectors: [],
  } as unknown as InventoryHoldServices;
}

describe("inventory item routes", () => {
  it("passes a valid graded card shape into listing stock creation", async () => {
    const ensureListingStock = vi.fn<InventoryItemServices["ensureListingStock"]>(async () => listingStockResult);
    const app = buildApp(createItemServices({ ensureListingStock }));

    const response = await app.fetch(
      new Request("http://inventory.test/items/listing-stock/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogItemId: "cat_1",
          selectedOptions: [{ dimensionId: "form", optionId: "graded" }],
          gradedCard: {
            gradingCompany: "PSA",
            grade: "10",
            certificationNumber: "12345678",
            population: null,
            conditionDescriptors: ["Gem Mint"],
          },
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(ensureListingStock).toHaveBeenCalledWith(
      expect.objectContaining({
        gradedCard: expect.objectContaining({
          gradingCompany: "PSA",
          grade: "10",
          conditionDescriptors: ["Gem Mint"],
        }),
      }),
      context,
    );
  });

  it("rejects malformed graded card shapes before listing stock creation", async () => {
    const ensureListingStock = vi.fn<InventoryItemServices["ensureListingStock"]>(async () => listingStockResult);
    const app = buildApp(createItemServices({ ensureListingStock }));

    const response = await app.fetch(
      new Request("http://inventory.test/items/listing-stock/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogItemId: "cat_1",
          selectedOptions: [{ dimensionId: "form", optionId: "graded" }],
          gradedCard: {
            gradingCompany: "PSA",
            certificationNumber: "12345678",
            population: null,
            conditionDescriptors: [],
          },
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(ensureListingStock).not.toHaveBeenCalled();
  });

  it("preserves non-object graded card inputs as null for listing stock creation", async () => {
    const ensureListingStock = vi.fn<InventoryItemServices["ensureListingStock"]>(async () => listingStockResult);
    const app = buildApp(createItemServices({ ensureListingStock }));

    const response = await app.fetch(
      new Request("http://inventory.test/items/listing-stock/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogItemId: "cat_1",
          gradedCard: "not-a-card",
          quantity: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(ensureListingStock).toHaveBeenCalledWith(expect.objectContaining({ gradedCard: null }), context);
  });

  it("defaults negative adjustments to protect orders and returns the partial collision outcome", async () => {
    const reduceItem = vi.fn<InventoryHoldCollisionServices["reduceItem"]>(async () => ({
      itemId: "inv_1",
      version: 3,
      collision: {
        mode: "protect-orders",
        authorizedByRole: null,
        requestedQuantity: 4,
        appliedQuantity: 2,
        refusedQuantity: 2,
        heldQuantity: 3,
        availableQuantity: 2,
        releasedHoldQuantity: 0,
        affectedOrders: [
          {
            holdId: "hld_1",
            orderId: "ord_1",
            reservationRequestId: "rsv_1",
            quantity: 3,
            disposition: "protected",
          },
        ],
      },
    }));
    const app = buildApp(createItemServices(), {
      holdCollisions: { reduceItem, projectors: [] },
    });

    const response = await app.request("/items/inv_1/adjustments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantityDelta: -4, reason: "Counter count" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "hold-collision-recorded",
      message: "2 units are committed and were not removed. Protected online orders: ord_1.",
      collision: {
        mode: "protect-orders",
        appliedQuantity: 2,
        refusedQuantity: 2,
        affectedOrders: [{ orderId: "ord_1", disposition: "protected" }],
      },
    });
    expect(reduceItem).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "protect-orders", actorRole: null }),
      context,
    );
  });

  it("forwards optional adjustment reason fields and preserves legacy omission", async () => {
    const adjustItem = vi.fn<InventoryItemServices["adjustItem"]>(async (params) => ({
      itemId: params.itemId,
      version: 2,
    }));
    const app = buildApp(createItemServices({ adjustItem }));

    const extended = await app.request("/items/inv_1/adjustments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantityDelta: 1,
        reason: "Found during shelf count",
        reasonCode: "found",
        note: "  Behind the display case  ",
      }),
    });
    const legacy = await app.request("/items/inv_1/adjustments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantityDelta: 1, reason: "Legacy count" }),
    });

    expect(extended.status).toBe(200);
    expect(legacy.status).toBe(200);
    expect(adjustItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ reasonCode: "found", note: "Behind the display case" }),
      context,
    );
    expect(adjustItem.mock.calls[1]?.[0]).not.toHaveProperty("reasonCode");
    expect(adjustItem.mock.calls[1]?.[0]).not.toHaveProperty("note");
  });

  it("rejects unknown reason codes and derives sold-offline for honor offline", async () => {
    const reduceItem = vi.fn<InventoryHoldCollisionServices["reduceItem"]>(async (params) => ({
      itemId: params.itemId,
      version: 3,
      collision: null,
    }));
    const app = buildApp(createItemServices(), {
      roleKey: "manager",
      holdCollisions: { reduceItem, projectors: [] },
    });

    const unknown = await app.request("/items/inv_1/adjustments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantityDelta: 1, reason: "Count", reasonCode: "other" }),
    });
    const conflicting = await app.request("/items/inv_1/adjustments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantityDelta: -1,
        reason: "Counter sale",
        reasonCode: "damaged",
        collisionMode: "honor-offline",
        confirmSellerCannotFulfill: true,
      }),
    });
    const derived = await app.request("/items/inv_1/adjustments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantityDelta: -1,
        reason: "Counter sale",
        collisionMode: "honor-offline",
        confirmSellerCannotFulfill: true,
      }),
    });

    expect(unknown.status).toBe(400);
    expect(conflicting.status).toBe(400);
    expect(derived.status).toBe(200);
    expect(reduceItem).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: "sold-offline" }), context);
  });

  it("requires manager-or-owner authority and explicit confirmation for honor offline", async () => {
    const reduceItem = vi.fn<InventoryHoldCollisionServices["reduceItem"]>();
    const collisions = { reduceItem, projectors: [] } satisfies InventoryHoldCollisionServices;
    const fulfillmentApp = buildApp(createItemServices(), { roleKey: "fulfillment", holdCollisions: collisions });
    const forbidden = await fulfillmentApp.request("/items/inv_1/adjustments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantityDelta: -1, reason: "Counter sale", collisionMode: "honor-offline" }),
    });
    expect(forbidden.status).toBe(403);

    const managerApp = buildApp(createItemServices(), { roleKey: "manager", holdCollisions: collisions });
    const unconfirmed = await managerApp.request("/items/inv_1/adjustments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantityDelta: -1, reason: "Counter sale", collisionMode: "honor-offline" }),
    });
    expect(unconfirmed.status).toBe(400);
    await expect(unconfirmed.json()).resolves.toMatchObject({
      error: { code: "honor_offline_confirmation_required" },
    });
    expect(reduceItem).not.toHaveBeenCalled();
  });
});
