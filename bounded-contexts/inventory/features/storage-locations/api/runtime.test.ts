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
import { createStorageLocationRuntime } from "./runtime";
import type { InventoryStorageLocationRow } from "../read-model/queries";

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

function createStorageLocationDb() {
  const locations = new Map<string, InventoryStorageLocationRow>();
  const db = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("INSERT INTO inventory_storage_locations")) {
        locations.set(String(values[0]), {
          storage_location_id: String(values[0]),
          account_id: String(values[1]),
          name: String(values[2]),
          description: values[3] === null ? null : String(values[3]),
          ship_from_code: String(values[4]),
          ship_from_address: JSON.parse(String(values[5])) as InventoryStorageLocationRow["ship_from_address"],
          is_archived: false,
          updated_at: String(values[6]),
        });
        return { rows: [] };
      }

      if (sql.includes("UPDATE inventory_storage_locations") && sql.includes("is_archived = true")) {
        const current = locations.get(String(values[0]));
        if (current) {
          locations.set(current.storage_location_id, {
            ...current,
            is_archived: true,
            updated_at: String(values[1]),
          });
        }
        return { rows: [] };
      }

      if (sql.includes("UPDATE inventory_storage_locations")) {
        const current = locations.get(String(values[0]));
        if (current) {
          locations.set(current.storage_location_id, {
            ...current,
            name: String(values[1]),
            description: values[2] === null ? null : String(values[2]),
            ship_from_code: String(values[3]),
            ship_from_address: JSON.parse(String(values[4])) as InventoryStorageLocationRow["ship_from_address"],
            updated_at: String(values[5]),
          });
        }
        return { rows: [] };
      }

      if (sql.includes("FROM inventory_storage_locations") && sql.includes("storage_location_id = $1")) {
        const row = locations.get(String(values[0])) ?? null;
        const accountId = values[1] ? String(values[1]) : null;
        return {
          rows: row && (!accountId || row.account_id === accountId) ? [row] : [],
        };
      }

      if (sql.includes("FROM inventory_storage_locations")) {
        const accountId = String(values[0]);
        const includeArchived = !sql.includes("is_archived = false");
        return {
          rows: [...locations.values()]
            .filter((location) => location.account_id === accountId)
            .filter((location) => includeArchived || !location.is_archived)
            .sort(
              (left, right) =>
                Number(left.is_archived) - Number(right.is_archived) || left.name.localeCompare(right.name),
            ),
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    }),
  };

  return { db, locations };
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

describe("storage location runtime", () => {
  it("projects created storage locations before the caller reads the list", async () => {
    const { eventStore, streams } = createInMemoryEventStore();
    const { db } = createStorageLocationDb();
    const services = createStorageLocationRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    const result = await services.createStorageLocation(
      {
        accountId: "acc_seller" as never,
        name: "Listing stock",
        description: "Auto-managed stock backing standard marketplace listings.",
        shipFromCode: "LISTING-STOCK",
        shipFromAddress,
      },
      context,
    );

    const locations = await services.listStorageLocations({
      accountId: "acc_seller",
      includeArchived: false,
    });

    expect(streams.get(`inventory.storage-location-${result.storageLocationId}`)).toHaveLength(1);
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({
      storage_location_id: result.storageLocationId,
      account_id: "acc_seller",
      name: "Listing stock",
      ship_from_code: "LISTING-STOCK",
      ship_from_address: shipFromAddress,
      is_archived: false,
    });
  });

  it("projects updates and archives before the caller reads the location", async () => {
    const { eventStore } = createInMemoryEventStore();
    const { db } = createStorageLocationDb();
    const services = createStorageLocationRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });
    const created = await services.createStorageLocation(
      {
        accountId: "acc_seller" as never,
        name: "Listing stock",
        description: null,
        shipFromCode: "LISTING-STOCK",
        shipFromAddress,
      },
      context,
    );
    const updatedAddress = {
      ...shipFromAddress,
      line1: "2 Warehouse Way",
    };

    await services.updateStorageLocation(
      {
        storageLocationId: created.storageLocationId,
        accountId: "acc_seller",
        name: "Archived listing stock",
        description: "Closed",
        shipFromCode: "LISTING-STOCK-OLD",
        shipFromAddress: updatedAddress,
        isArchived: true,
      },
      context,
    );

    await expect(
      services.listStorageLocations({
        accountId: "acc_seller",
        includeArchived: false,
      }),
    ).resolves.toEqual([]);
    await expect(services.getStorageLocation(created.storageLocationId, "acc_seller")).resolves.toMatchObject({
      name: "Archived listing stock",
      description: "Closed",
      ship_from_code: "LISTING-STOCK-OLD",
      ship_from_address: updatedAddress,
      is_archived: true,
    });
  });
});
