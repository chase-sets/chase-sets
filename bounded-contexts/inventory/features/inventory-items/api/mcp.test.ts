import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import type { StorageLocationServices } from "../../storage-locations/api/runtime";
import type { InventoryHoldCollisionServices } from "../../hold-collisions/api/runtime";
import { createInventoryItemMcpHandlers } from "./mcp";
import type { InventoryItemServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["inventory.view", "inventory.manage"],
} satisfies ResolvedActor;

const legacyMcpProtocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function mcpRequest(arguments_: Record<string, unknown>, requestActor: ResolvedActor = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol: legacyMcpProtocol,
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    item_id: "inv_1",
    account_id: "acc_1",
    catalog_catalog_item_id: "cat_1",
    product_id: "prod_1",
    language_code: "en",
    item_title: "Charizard",
    item_subtitle: null,
    selected_options: [{ dimensionId: "condition", optionId: "near-mint" }],
    product_summary: "Condition: Near Mint",
    graded_card: null,
    storage_location_id: "loc_1",
    storage_location_name: "Shelf A",
    ship_from_code: "AUS",
    ship_from_address: {
      name: "Seller",
      line1: "1 Main",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    },
    total_quantity: 4,
    held_quantity: 1,
    available_quantity: 3,
    acquisition_cost_amount: "10.00",
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function services(): InventoryItemServices {
  return {
    listItems: vi.fn(async () => ({ items: [itemRow()], total: 1 })),
    getItem: vi.fn(async (itemId, accountId) =>
      itemRow({ item_id: itemId, account_id: accountId, holds: [], ledger: [] }),
    ),
    adjustItem: vi.fn(async (params) => ({ itemId: params.itemId, version: 3 })),
  } as unknown as InventoryItemServices;
}

function collisionServices(): InventoryHoldCollisionServices {
  return {
    reduceItem: vi.fn(async (params) => ({
      itemId: params.itemId,
      version: 3,
      requestedQuantity: params.requestedQuantity,
      appliedQuantity: params.requestedQuantity,
      refusedQuantity: 0,
      collision: null,
    })),
    projectors: [],
  };
}

function storageLocationRow(overrides: Record<string, unknown> = {}) {
  return {
    storage_location_id: "loc_1",
    account_id: "acc_1",
    name: "Shelf A",
    description: null,
    ship_from_code: "AUS",
    ship_from_address: {},
    is_archived: false,
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function storageLocations(
  locations: readonly Record<string, unknown>[] = [storageLocationRow()],
): Pick<StorageLocationServices, "listStorageLocations"> {
  return {
    listStorageLocations: vi.fn(async () => locations),
  } as unknown as Pick<StorageLocationServices, "listStorageLocations">;
}

describe("inventory item MCP handlers", () => {
  it("lists account inventory with natural key and hold-derived availability filters", async () => {
    const fakeServices = services();
    const handlers = createInventoryItemMcpHandlers(fakeServices, storageLocations(), collisionServices());

    const result = await handlers.toolHandlers["inventory.list-items"]?.(
      mcpRequest({
        accountId: "acc_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        storageLocationId: "loc_1",
        availability: "available",
        limit: 25,
        offset: 5,
      }),
    );

    expect(result).toMatchObject({ accountId: "acc_1", total: 1, count: 1 });
    expect(fakeServices.listItems).toHaveBeenCalledWith({
      accountId: "acc_1",
      catalogItemId: "cat_1",
      productId: "prod_1",
      storageLocationId: "loc_1",
      availability: "available",
      limit: 25,
      offset: 5,
    });
  });

  it("resolves a storageLocationName filter to the canonical storage location id", async () => {
    const fakeServices = services();
    const fakeStorageLocations = storageLocations([
      storageLocationRow({ storage_location_id: "loc_1", name: "Shelf A" }),
    ]);
    const handlers = createInventoryItemMcpHandlers(fakeServices, fakeStorageLocations, collisionServices());

    await handlers.toolHandlers["inventory.list-items"]?.(
      mcpRequest({ accountId: "acc_1", storageLocationName: "shelf a" }),
    );

    expect(fakeStorageLocations.listStorageLocations).toHaveBeenCalledWith({
      accountId: "acc_1",
      includeArchived: true,
    });
    expect(fakeServices.listItems).toHaveBeenCalledWith(expect.objectContaining({ storageLocationId: "loc_1" }));
  });

  it("prefers storageLocationId over storageLocationName when both are given", async () => {
    const fakeServices = services();
    const fakeStorageLocations = storageLocations();
    const handlers = createInventoryItemMcpHandlers(fakeServices, fakeStorageLocations, collisionServices());

    await handlers.toolHandlers["inventory.list-items"]?.(
      mcpRequest({ accountId: "acc_1", storageLocationId: "loc_explicit", storageLocationName: "Shelf A" }),
    );

    expect(fakeStorageLocations.listStorageLocations).not.toHaveBeenCalled();
    expect(fakeServices.listItems).toHaveBeenCalledWith(expect.objectContaining({ storageLocationId: "loc_explicit" }));
  });

  it("rejects an unknown storageLocationName", async () => {
    const fakeServices = services();
    const handlers = createInventoryItemMcpHandlers(fakeServices, storageLocations([]), collisionServices());

    await expect(
      handlers.toolHandlers["inventory.list-items"]?.(
        mcpRequest({ accountId: "acc_1", storageLocationName: "No Such Shelf" }),
      ),
    ).rejects.toThrow('No storage location named "No Such Shelf" was found for this account.');
  });

  it("returns a disambiguation error for an ambiguous storageLocationName", async () => {
    const fakeServices = services();
    const fakeStorageLocations = storageLocations([
      storageLocationRow({ storage_location_id: "loc_1", name: "Warehouse" }),
      storageLocationRow({ storage_location_id: "loc_2", name: "Warehouse" }),
    ]);
    const handlers = createInventoryItemMcpHandlers(fakeServices, fakeStorageLocations, collisionServices());

    await expect(
      handlers.toolHandlers["inventory.list-items"]?.(
        mcpRequest({ accountId: "acc_1", storageLocationName: "Warehouse" }),
      ),
    ).rejects.toThrow(/Multiple storage locations are named "Warehouse": loc_1 \(Warehouse\), loc_2 \(Warehouse\)/);
    expect(fakeServices.listItems).not.toHaveBeenCalled();
  });

  it("defaults MCP stock reductions to protect orders and returns the collision evidence", async () => {
    const fakeServices = services();
    const collisions = collisionServices();
    vi.mocked(collisions.reduceItem).mockResolvedValue({
      itemId: "inv_1",
      version: 3,
      requestedQuantity: 1,
      appliedQuantity: 0,
      refusedQuantity: 1,
      collision: {
        mode: "protect-orders",
        authorizedByRole: null,
        requestedQuantity: 1,
        appliedQuantity: 0,
        refusedQuantity: 1,
        heldQuantity: 1,
        availableQuantity: 0,
        releasedHoldQuantity: 0,
        affectedOrders: [
          {
            holdId: "hld_1",
            orderId: "ord_1",
            reservationRequestId: "rsv_1",
            quantity: 1,
            disposition: "protected",
          },
        ],
      },
    });
    const handlers = createInventoryItemMcpHandlers(fakeServices, storageLocations(), collisions);

    const result = await handlers.toolHandlers["inventory.adjust-item"]?.(
      mcpRequest({
        accountId: "acc_1",
        inventoryItemId: "inv_1",
        quantityDelta: -1,
        reason: "Correct physical count",
      }),
    );

    expect(result).toMatchObject({
      accountId: "acc_1",
      id: "inv_1",
      inventoryItemId: "inv_1",
      version: 3,
      status: "hold-collision-recorded",
      quantityDelta: -1,
      collision: {
        mode: "protect-orders",
        refusedQuantity: 1,
        affectedOrders: [{ orderId: "ord_1" }],
      },
      resourceUri: "chase-sets://inventory/acc_1/items/inv_1",
    });
    expect(collisions.reduceItem).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_1",
        itemId: "inv_1",
        requestedQuantity: 1,
        reason: "Correct physical count",
        mode: "protect-orders",
      }),
      expect.objectContaining({
        audit: {
          performedByUserId: "usr_1",
          forAccountId: "acc_1",
        },
      }),
    );
  });

  it("forwards optional adjustment reason fields while accepting legacy omission", async () => {
    const fakeServices = services();
    const handlers = createInventoryItemMcpHandlers(fakeServices, storageLocations(), collisionServices());

    await handlers.toolHandlers["inventory.adjust-item"]?.(
      mcpRequest({
        accountId: "acc_1",
        inventoryItemId: "inv_1",
        quantityDelta: 1,
        reason: "Found during count",
        reasonCode: "found",
        note: "  Behind display case  ",
        idempotencyKey: "adjust-found-1",
      }),
    );
    await handlers.toolHandlers["inventory.adjust-item"]?.(
      mcpRequest({
        accountId: "acc_1",
        inventoryItemId: "inv_1",
        quantityDelta: 1,
        reason: "Legacy count",
        idempotencyKey: "adjust-legacy-1",
      }),
    );

    expect(fakeServices.adjustItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ reasonCode: "found", note: "Behind display case" }),
      expect.anything(),
    );
    expect(vi.mocked(fakeServices.adjustItem).mock.calls[1]?.[0]).not.toHaveProperty("reasonCode");
    expect(vi.mocked(fakeServices.adjustItem).mock.calls[1]?.[0]).not.toHaveProperty("note");
  });

  it("derives sold-offline for honor offline and rejects conflicting or unknown codes", async () => {
    const fakeServices = services();
    const collisions = collisionServices();
    const handlers = createInventoryItemMcpHandlers(fakeServices, storageLocations(), collisions);

    await handlers.toolHandlers["inventory.adjust-item"]?.(
      mcpRequest({
        accountId: "acc_1",
        inventoryItemId: "inv_1",
        quantityDelta: -1,
        reason: "Counter sale",
        collisionMode: "honor-offline",
        confirmSellerCannotFulfill: true,
      }),
    );
    await expect(
      handlers.toolHandlers["inventory.adjust-item"]?.(
        mcpRequest({
          accountId: "acc_1",
          inventoryItemId: "inv_1",
          quantityDelta: -1,
          reason: "Counter sale",
          reasonCode: "damaged",
          collisionMode: "honor-offline",
          confirmSellerCannotFulfill: true,
        }),
      ),
    ).rejects.toThrow("Honor offline requires reasonCode sold-offline.");
    await expect(
      handlers.toolHandlers["inventory.adjust-item"]?.(
        mcpRequest({
          accountId: "acc_1",
          inventoryItemId: "inv_1",
          quantityDelta: 1,
          reason: "Count",
          reasonCode: "other",
        }),
      ),
    ).rejects.toThrow("supported inventory adjustment reason");

    expect(collisions.reduceItem).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "sold-offline" }),
      expect.anything(),
    );
  });

  it("rejects account mismatches and dry-run writes before mutating stock", async () => {
    const fakeServices = services();
    const handlers = createInventoryItemMcpHandlers(fakeServices, storageLocations(), collisionServices());

    await expect(
      handlers.toolHandlers["inventory.adjust-item"]?.(
        mcpRequest({ accountId: "acc_other", inventoryItemId: "inv_1", quantityDelta: 1, reason: "Count" }),
      ),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
    await expect(
      handlers.toolHandlers["inventory.adjust-item"]?.(
        mcpRequest({
          accountId: "acc_1",
          inventoryItemId: "inv_1",
          quantityDelta: 1,
          reason: "Count",
          dryRun: true,
        }),
      ),
    ).rejects.toThrow("dryRun is not supported for inventory item MCP writes yet.");
    expect(fakeServices.adjustItem).not.toHaveBeenCalled();
  });

  it("reads inventory item resources by URI", async () => {
    const handlers = createInventoryItemMcpHandlers(services(), storageLocations(), collisionServices());

    const result = await handlers.resourceHandlers["chase-sets://inventory/{accountId}/items/{inventoryItemId}"]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://inventory/acc_1/items/inv_1",
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({ item_id: "inv_1", account_id: "acc_1", available_quantity: 3 });
  });
});
