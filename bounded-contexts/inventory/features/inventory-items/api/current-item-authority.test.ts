import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createInventoryCurrentItemAuthority } from "./current-item-authority";

const stores = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
  createPostgresEventStore: () => stores.current,
}));

const context = {
  tenantId: "tenant" as never,
  audit: { performedByUserId: "user" as never, forAccountId: "owner" as never },
};
const address = {
  name: "Seller Shipping",
  line1: "1 Warehouse Way",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
};

const itemCreated = (recorded: Readonly<Record<string, unknown>> = {}) => ({
  eventType: "inventory.item.created",
  payload: {
    itemId: "item",
    accountId: "owner",
    catalogItemId: "cat_1",
    productId: "cat_1::finish:foil",
    selectedOptions: [],
    gradedCard: null,
    storageLocationId: "loc_1",
    totalQuantity: 3,
    acquisitionCostAmount: "4.50",
    acquisitionCostCurrencyCode: "USD",
    ...recorded,
  },
});
const locationCreated = (recorded: Readonly<Record<string, unknown>> = {}) => ({
  eventType: "inventory.storage-location.created",
  payload: {
    storageLocationId: "loc_1",
    accountId: "owner",
    name: "North shelf",
    description: null,
    shipFromCode: "CHI",
    shipFromAddress: address,
    ...recorded,
  },
});

/** The authority over an in-memory store whose pool finds no hold streams. */
function fixture() {
  const memory = createInMemoryEventStore();
  const append = (streamId: string, events: Parameters<typeof memory.eventStore.appendToStream>[0]["events"]) =>
    memory.eventStore.appendToStream({ streamId, expectedVersion: "any", context, events });
  stores.current = memory.eventStore;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("stream_category = 'inventory.hold'")) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const authority = createInventoryCurrentItemAuthority({ query, connect: query } as never);
  const resolve = (input: unknown = { accountId: "owner", inventoryItemId: "item" }) =>
    authority.resolveInventoryCurrentItem(input as never, context);
  return { append, query, resolve };
}

describe("Inventory Current Item Authority", () => {
  it.each([
    null,
    [],
    {},
    { accountId: "owner", inventoryItemId: { id: "item" } },
    { accountId: "", inventoryItemId: "item" },
    { accountId: "owner", inventoryItemId: "" },
    { accountId: "owner", inventoryItemId: "item", totalQuantity: 3 },
  ])("closes authority input before any read: %j", async (input) => {
    const { query, resolve } = fixture();

    await expect(resolve(input)).rejects.toThrow("Invalid inventory current item authority input.");

    expect(query).not.toHaveBeenCalled();
  });

  it("answers the item's facts with its location's current name and ship-from details", async () => {
    const { append, resolve } = fixture();
    await append("inventory.item-item", [itemCreated()]);
    await append("inventory.storage-location-loc_1", [locationCreated()]);
    await append("inventory.storage-location-loc_1", [
      {
        eventType: "inventory.storage-location.updated",
        payload: {
          storageLocationId: "loc_1",
          name: "Back room",
          description: null,
          shipFromCode: "NYC",
          shipFromAddress: { ...address, city: "New York", state: "NY", postalCode: "10001" },
        },
      },
    ]);

    await expect(resolve()).resolves.toEqual({
      catalogItemId: "cat_1",
      productId: "cat_1::finish:foil",
      storageLocation: {
        storageLocationId: "loc_1",
        name: "Back room",
        shipFromCode: "NYC",
        shipFromAddress: { ...address, city: "New York", state: "NY", postalCode: "10001" },
        status: "active",
      },
      totalQuantity: 3,
      availableQuantity: 3,
      acquisitionCostAmount: "4.50",
      acquisitionCostCurrencyCode: "USD",
    });
  });

  it("answers the total after adjustments, and a retired location as retired", async () => {
    const { append, resolve } = fixture();
    await append("inventory.item-item", [
      itemCreated(),
      { eventType: "inventory.item.adjusted", payload: { itemId: "item", quantityDelta: -2, reason: "Damaged" } },
    ]);
    await append("inventory.storage-location-loc_1", [
      locationCreated(),
      { eventType: "inventory.storage-location.archived", payload: { storageLocationId: "loc_1" } },
    ]);

    await expect(resolve()).resolves.toMatchObject({
      totalQuantity: 1,
      availableQuantity: 1,
      storageLocation: { status: "retired" },
    });
  });

  it.each([
    { label: "no such item", item: null, location: locationCreated() },
    { label: "the item under another account", item: itemCreated({ accountId: "other" }), location: locationCreated() },
    { label: "no such location", item: itemCreated(), location: null },
    {
      label: "the location under another account",
      item: itemCreated(),
      location: locationCreated({ accountId: "other" }),
    },
  ])("answers nothing for $label", async ({ item, location }) => {
    const { append, resolve } = fixture();
    if (item) await append("inventory.item-item", [item]);
    if (location) await append("inventory.storage-location-loc_1", [location]);

    await expect(resolve()).resolves.toBeNull();
  });
});
