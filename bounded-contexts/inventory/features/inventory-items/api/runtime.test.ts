import { describe, expect, it, vi } from "vitest";
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

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: existing.length + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
          traceId: input.context.trace?.traceId,
          spanId: input.context.trace?.spanId,
          parentSpanId: input.context.trace?.parentSpanId,
          traceState: input.context.trace?.traceState,
        } satisfies StoredEvent;
      });

      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice(input.fromVersion ?? 0),
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return { eventStore, streams };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) =>
      checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
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
          return { rows: [] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const storageLocations = {
      listStorageLocations: vi.fn(async () => []),
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
  });
});
