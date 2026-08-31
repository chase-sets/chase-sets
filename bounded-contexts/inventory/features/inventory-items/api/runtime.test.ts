import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createInventoryItemRuntime } from "./runtime";

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

const context = {
  tenantId: "tnt_inventory" as never,
  audit: {
    performedByUserId: "usr_seller" as never,
    forAccountId: "acc_seller" as never,
  },
};

const shipFromAddress = {
  name: "Seller Shipping",
  line1: "1 Warehouse Way",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
} as const;

describe("inventory item runtime", () => {
  it("issue-6299-acceptance-control recovers beyond 500 events and issue-7054-F1 recovers note-only crash-window retries", async () => {
    const { eventStore, streams } = createInMemoryEventStore();
    const ledger = new Map<
      string,
      {
        inserted: boolean;
        command_fingerprint: string;
        status: "in_progress" | "completed";
        result_item_id: string | null;
        result_version: number | null;
        result_collision: unknown;
        created_at: string;
      }
    >();
    let failNextIdempotencyComplete = false;
    const inventoryRow = {
      item_id: "inv_1",
      account_id: "acc_seller",
      catalog_catalog_item_id: "cat_1",
      product_id: "cat_1::",
      selected_options: [],
      graded_card: null,
      storage_location_id: "loc_1",
      storage_location_name: "Main",
      ship_from_code: "MAIN",
      total_quantity: 10,
      held_quantity: 0,
      available_quantity: 10,
      acquisition_cost_amount: null,
      created_at: "2026-05-28T00:00:00.000Z",
      updated_at: "2026-05-28T00:00:00.000Z",
    };
    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("WITH inserted")) {
          const key = String(values[0]);
          const existing = ledger.get(key);
          if (existing) {
            return { rows: [{ ...existing, inserted: false }], rowCount: 1 };
          }
          const row = {
            inserted: true,
            command_fingerprint: String(values[3]),
            status: "in_progress" as const,
            result_item_id: null,
            result_version: null,
            result_collision: null,
            created_at: new Date().toISOString(),
          };
          ledger.set(key, row);
          return { rows: [row], rowCount: 1 };
        }
        if (sql.includes("UPDATE inventory_item_adjustment_idempotency")) {
          const key = String(values[0]);
          const existing = ledger.get(key);
          if (failNextIdempotencyComplete) {
            failNextIdempotencyComplete = false;
            throw new Error("ledger complete failed");
          }
          if (existing?.status === "in_progress" && existing.command_fingerprint === String(values[1])) {
            ledger.set(key, {
              ...existing,
              inserted: false,
              status: "completed",
              result_item_id: String(values[2]),
              result_version: Number(values[3]),
              result_collision: JSON.parse(String(values[4])),
            });
          }
          return {
            rows: [],
            rowCount: existing?.status === "in_progress" && existing.command_fingerprint === String(values[1]) ? 1 : 0,
          };
        }
        if (sql.includes("DELETE FROM inventory_item_adjustment_idempotency")) {
          ledger.delete(String(values[0]));
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM inventory_items AS item")) {
          return { rows: [inventoryRow] };
        }
        if (sql.includes("FROM inventory_holds")) {
          return { rows: [] };
        }
        if (sql.includes("to_regclass")) {
          return { rows: [{ table_name: null }] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const services = createInventoryItemRuntime(
      {
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: db as never,
      },
      {
        getCatalogItem: vi.fn(),
      } as never,
      {
        listStorageLocations: vi.fn(),
        createStorageLocation: vi.fn(),
      } as never,
    );
    await services.commandHandler({
      streamId: "inventory.item-inv_1",
      command: {
        type: "CreateInventoryItem",
        itemId: "inv_1" as never,
        accountId: "acc_seller" as never,
        catalogItemId: "cat_1",
        productId: "cat_1::",
        selectedOptions: [],
        storageLocationId: "loc_1",
        totalQuantity: 10,
      },
      context,
    });

    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 3,
          reason: "Import quantity adjustment",
          idempotencyKey: "inventory-import-row:imr_1:adjustment",
        },
        context,
      ),
    ).resolves.toEqual({ itemId: "inv_1", version: 2 });
    expect(ledger.get("inventory-import-row:imr_1:adjustment")?.command_fingerprint).toBe(
      "5b7e79c784d1004f25875df18baab87cdf8f6060fe537fa10effd644cfc931bb",
    );
    await eventStore.appendToStream({
      streamId: "inventory.item-inv_1",
      expectedVersion: 2,
      context,
      events: Array.from({ length: 498 }, (_, index) => ({
        eventType: "inventory.item.adjusted",
        payload: {
          itemId: "inv_1",
          quantityDelta: index % 2 === 0 ? 1 : -1,
          reason: "Pagination control",
          sourceRef: null,
        },
      })),
    });
    failNextIdempotencyComplete = true;
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 2,
          reason: "Import quantity adjustment",
          idempotencyKey: "inventory-import-row:imr_2:adjustment",
        },
        context,
      ),
    ).rejects.toThrow("ledger complete failed");
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 2,
          reason: "Import quantity adjustment",
          idempotencyKey: "inventory-import-row:imr_2:adjustment",
        },
        context,
      ),
    ).resolves.toEqual({ itemId: "inv_1", version: 501 });
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 3,
          reason: "Import quantity adjustment",
          idempotencyKey: "inventory-import-row:imr_1:adjustment",
        },
        context,
      ),
    ).resolves.toEqual({ itemId: "inv_1", version: 2 });
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 4,
          reason: "Import quantity adjustment",
          idempotencyKey: "inventory-import-row:imr_1:adjustment",
        },
        context,
      ),
    ).rejects.toThrow("idempotency key was reused");

    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 3,
          reason: "Import quantity adjustment",
          reasonCode: "intake",
          note: "  Received at counter  ",
          idempotencyKey: "inventory-import-row:imr_extended:adjustment",
        },
        context,
      ),
    ).resolves.toEqual({ itemId: "inv_1", version: 502 });
    expect(ledger.get("inventory-import-row:imr_extended:adjustment")?.command_fingerprint).toBe(
      "b4e204c1c02147fe9d06473d002e86c17f75808b9c19d4c80331c744dbff7862",
    );
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 3,
          reason: "Import quantity adjustment",
          reasonCode: "intake",
          note: "Different note",
          idempotencyKey: "inventory-import-row:imr_extended:adjustment",
        },
        context,
      ),
    ).rejects.toThrow("idempotency key was reused");
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: 3,
          reason: "Import quantity adjustment",
          reasonCode: "correction",
          note: "Received at counter",
          idempotencyKey: "inventory-import-row:imr_extended:adjustment",
        },
        context,
      ),
    ).rejects.toThrow("idempotency key was reused");

    const noteOnlyCrashWindowCases = [
      {
        name: "note present with reasonCode omitted",
        idempotencyKey: "inventory-import-row:imr_note_only:adjustment",
        note: "  Received at counter  ",
        expectedNote: "Received at counter",
        expectedVersion: 503,
      },
      {
        name: "blank note with reasonCode omitted",
        idempotencyKey: "inventory-import-row:imr_blank_note:adjustment",
        note: "   ",
        expectedNote: null,
        expectedVersion: 504,
      },
    ] as const;

    for (const testCase of noteOnlyCrashWindowCases) {
      const request = {
        accountId: "acc_seller",
        itemId: "inv_1",
        quantityDelta: 1,
        reason: "Counter intake",
        note: testCase.note,
        idempotencyKey: testCase.idempotencyKey,
      } as const;

      failNextIdempotencyComplete = true;
      await expect(services.adjustItem(request, context), testCase.name).rejects.toThrow("ledger complete failed");
      const committed = streams.get("inventory.item-inv_1")?.at(-1);
      expect(committed?.streamVersion, testCase.name).toBe(testCase.expectedVersion);
      expect(committed?.payload, testCase.name).toMatchObject({
        itemId: "inv_1",
        quantityDelta: 1,
        reason: "Counter intake",
        note: testCase.expectedNote,
      });
      expect(committed?.payload, testCase.name).not.toHaveProperty("reasonCode");

      await expect(services.adjustItem(request, context), testCase.name).resolves.toEqual({
        itemId: "inv_1",
        version: testCase.expectedVersion,
      });
      expect(streams.get("inventory.item-inv_1"), testCase.name).toHaveLength(testCase.expectedVersion);
    }
  });

  it("uses aggregate held quantity to enforce the adjustment floor when projections lag", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM inventory_items AS item")) {
          return { rows: [] };
        }
        if (sql.includes("FROM event_store_events")) {
          return {
            rows: [
              {
                hold_id: "hld_1",
                account_id: "acc_seller",
                item_id: "inv_1",
                quantity: 1,
                active: true,
              },
              {
                hold_id: "hld_2",
                account_id: "acc_seller",
                item_id: "inv_1",
                quantity: 2,
                active: true,
              },
            ],
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const services = createInventoryItemRuntime(
      {
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: db as never,
      },
      {
        getCatalogItem: vi.fn(),
      } as never,
      {
        listStorageLocations: vi.fn(),
        createStorageLocation: vi.fn(),
      } as never,
    );
    await services.commandHandler({
      streamId: "inventory.item-inv_1",
      command: {
        type: "CreateInventoryItem",
        itemId: "inv_1" as never,
        accountId: "acc_seller" as never,
        catalogItemId: "cat_1",
        productId: "cat_1::",
        selectedOptions: [],
        storageLocationId: "loc_1",
        totalQuantity: 5,
      },
      context,
    });

    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: -2,
          reason: "Cycle count",
        },
        context,
      ),
    ).resolves.toEqual({ itemId: "inv_1", version: 2 });
    await expect(
      services.adjustItem(
        {
          accountId: "acc_seller",
          itemId: "inv_1",
          quantityDelta: -1,
          reason: "Cycle count",
        },
        context,
      ),
    ).rejects.toThrow("3 units are committed to open orders.");
  });

  it("ensures default listing stock without requiring manual inventory setup", async () => {
    const { eventStore, streams } = createInMemoryEventStore();
    let listingStockLocation: {
      storage_location_id: string;
      account_id: string;
      name: string;
      description: string | null;
      ship_from_code: string;
      ship_from_address: typeof shipFromAddress;
      is_archived: boolean;
      updated_at: string;
    } | null = null;
    let existingItem: Record<string, unknown> | null = null;

    const db = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("INSERT INTO inventory_storage_locations")) {
          listingStockLocation = {
            storage_location_id: String(values[0]),
            account_id: String(values[1]),
            name: String(values[2]),
            description: String(values[3]),
            ship_from_code: String(values[4]),
            ship_from_address: JSON.parse(String(values[5])) as typeof shipFromAddress,
            is_archived: false,
            updated_at: new Date().toISOString(),
          };
          return { rows: [] };
        }

        if (sql.includes("FROM inventory_storage_locations")) {
          return { rows: listingStockLocation ? [listingStockLocation] : [] };
        }

        if (sql.includes("FROM inventory_items AS item")) {
          return { rows: existingItem ? [existingItem] : [] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const storageLocations = {
      listStorageLocations: vi.fn(async () => (listingStockLocation ? [listingStockLocation] : [])),
      createStorageLocation: vi.fn(async () => ({
        storageLocationId: "loc_listing_stock",
        version: 1,
      })),
    };
    const services = createInventoryItemRuntime(
      {
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: db as never,
      },
      {
        getCatalogItem: vi.fn(async () => ({
          catalog_item_id: "cat_1",
          status: "active",
          product_schema: null,
        })),
      } as never,
      storageLocations as never,
    );

    const result = await services.ensureListingStock(
      {
        accountId: "acc_seller" as never,
        catalogItemId: "cat_1",
        selectedOptions: [],
        quantity: 2,
        shipFromAddress,
      },
      context,
    );

    expect(result).toMatchObject({
      inventoryItemId: expect.stringMatching(/^inv_listing_stock_/),
      storageLocationId: "loc_listing_stock",
      createdStorageLocation: true,
      createdInventoryItem: true,
      adjustedQuantityBy: 0,
      snapshot: {
        catalogItemId: "cat_1",
        totalQuantity: 2,
        availableQuantity: 2,
        storageLocationName: "Listing stock",
      },
    });
    expect(streams.has(`inventory.item-${result.inventoryItemId}`)).toBe(true);

    existingItem = {
      item_id: result.inventoryItemId,
      account_id: "acc_seller",
      catalog_catalog_item_id: "cat_1",
      product_id: "cat_1::",
      selected_options: [],
      graded_card: null,
      storage_location_id: "loc_listing_stock",
      storage_location_name: "Listing stock",
      ship_from_code: "LISTING-STOCK",
      ship_from_address: shipFromAddress,
      total_quantity: 2,
      held_quantity: 0,
      available_quantity: 2,
      acquisition_cost_amount: null,
    };
    const toppedUp = await services.ensureListingStock(
      {
        accountId: "acc_seller" as never,
        catalogItemId: "cat_1",
        selectedOptions: [],
        quantity: 4,
        shipFromAddress,
      },
      context,
    );

    expect(toppedUp.adjustedQuantityBy).toBe(2);
    expect(streams.get(`inventory.item-${result.inventoryItemId}`)?.at(-1)?.payload).toMatchObject({
      quantityDelta: 2,
      reasonCode: "intake",
    });
  });
});
