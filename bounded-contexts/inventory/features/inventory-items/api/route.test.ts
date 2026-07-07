import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryApiEnv } from "../../../api";
import type { InventoryHoldServices } from "../../holds/api/runtime";
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

function buildApp(items: InventoryItemServices) {
  const app = new Hono<InventoryApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      accountId: "acc_inventory",
      permissions: ["inventory.view", "inventory.manage"],
    });
    c.set("context", context);
    await next();
  });
  app.route("/items", inventoryItemRoutes(items, createHoldServices()));
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

  it("returns localized copy when an adjustment would drop below committed stock", async () => {
    const app = buildApp(
      createItemServices({
        adjustItem: vi.fn(async () => {
          throw new Error("2 units are committed to open orders.");
        }),
      }),
    );

    const response = await app.fetch(
      new Request("http://inventory.test/items/inv_1/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantityDelta: -1,
          reason: "Cycle count",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "inventory_adjustment_below_committed_quantity",
        message: "2 units are committed to open orders.",
      },
    });
  });
});
