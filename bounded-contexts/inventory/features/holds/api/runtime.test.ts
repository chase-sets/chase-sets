import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, ReadAllInput, ReadStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { AccountId, EventId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  createInventoryHoldRuntime,
  InventoryHoldPlacementError,
  withInventorySystemHoldReleaseAuthority,
} from "./runtime";
import type { InventoryHoldId } from "../../../support/runtime-support/common";

const context = {
  tenantId: "tnt_test" as TenantId,
  audit: {
    performedByUserId: "usr_test" as UserId,
    forAccountId: "acc_seller" as AccountId,
  },
};

function createInventoryDb(
  options: Readonly<{
    itemRows?: Record<string, unknown>[];
    aggregateHoldRows?: Record<string, unknown>[];
    holdRows?: Record<string, unknown>[];
  }> = {},
) {
  const itemRows = options.itemRows ?? [
    {
      item_id: "inv_1",
      account_id: "acc_seller",
      catalog_catalog_item_id: "cat_1",
      product_id: "prod_1",
      selected_options: [],
      graded_card: null,
      storage_location_id: "loc_1",
      storage_location_name: "Main",
      ship_from_code: "CHI",
      ship_from_address: {
        name: "Seller",
        line1: "1 Test St",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
      total_quantity: 1,
      held_quantity: 0,
      available_quantity: 1,
      acquisition_cost_amount: null,
      created_at: "2026-06-24T00:00:00.000Z",
      updated_at: "2026-06-24T00:00:00.000Z",
    },
  ];
  const aggregateHoldRows = options.aggregateHoldRows ?? [];
  const holdRows = options.holdRows ?? [];

  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM inventory_items AS item")) {
        return {
          rows: itemRows,
        };
      }

      if (sql.includes("FROM event_store_events")) {
        return { rows: aggregateHoldRows };
      }

      if (sql.includes("FROM inventory_holds")) {
        return { rows: holdRows };
      }

      if (sql.includes("to_regclass('public.inventory_catalog_items')")) {
        return { rows: [{ table_name: null }] };
      }

      return { rows: [] };
    }),
  };
}

async function seedInventoryItem(eventStore: EventStore) {
  await eventStore.appendToStream({
    streamId: "inventory.item-inv_1",
    expectedVersion: "no_stream",
    events: [
      {
        eventType: "inventory.item.created",
        payload: {
          itemId: "inv_1",
          accountId: "acc_seller",
          catalogItemId: "cat_1",
          productId: "prod_1",
          selectedOptions: [],
          gradedCard: null,
          storageLocationId: "loc_1",
          totalQuantity: 1,
          acquisitionCostAmount: null,
        },
      },
    ],
    context,
  });
}

describe("inventory hold runtime", () => {
  it("reuses a matching stable hold id without appending a duplicate hold", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    await seedInventoryItem(eventStore);
    const db = createInventoryDb();
    const services = createInventoryHoldRuntime({
      eventStore,
      checkpointStore: {} as never,
      db,
    });
    const params = {
      holdId: "hld_order_reservation_rsv_1" as InventoryHoldId,
      accountId: "acc_seller" as AccountId,
      itemId: "inv_1",
      quantity: 1,
      reason: "Ordering commitment",
      notes: null,
      purpose: "order",
      sourceRef: {
        orderId: "ord_1",
        reservationRequestId: "rsv_1",
      },
      expiresAt: null,
    } as const;

    await services.createHold(params, context);
    await services.createHold(params, context);

    expect(readAllEvents().filter((event) => event.eventType === "inventory.hold.placed")).toHaveLength(1);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("places holds from authoritative item and hold streams", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    await seedInventoryItem(eventStore);
    const db = createInventoryDb({
      itemRows: [
        {
          item_id: "inv_1",
          account_id: "acc_seller",
          total_quantity: 1,
          held_quantity: 0,
          available_quantity: 1,
        },
      ],
    });
    const services = createInventoryHoldRuntime({
      eventStore,
      checkpointStore: {} as never,
      db,
    });

    await services.createHold(
      {
        holdId: "hld_order_reservation_rsv_1" as InventoryHoldId,
        accountId: "acc_seller" as AccountId,
        itemId: "inv_1",
        quantity: 1,
        reason: "Ordering commitment",
        notes: null,
        purpose: "order",
        sourceRef: {
          orderId: "ord_1",
          reservationRequestId: "rsv_1",
        },
        expiresAt: null,
      },
      context,
    );

    const stockQuery = String(db.query.mock.calls[0]?.[0] ?? "");
    expect(stockQuery).toContain("FROM event_store_events");
    expect(stockQuery).toContain("stream_category = 'inventory.hold'");
    expect(readAllEvents().filter((event) => event.eventType === "inventory.hold.placed")).toHaveLength(1);
  });

  it("reports missing item aggregates with a typed hold placement failure", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const services = createInventoryHoldRuntime({
      eventStore,
      checkpointStore: {} as never,
      db: createInventoryDb({ itemRows: [] }),
    });

    await expect(
      services.createHold(
        {
          holdId: "hld_order_reservation_rsv_1" as InventoryHoldId,
          accountId: "acc_seller" as AccountId,
          itemId: "inv_1",
          quantity: 1,
          reason: "Ordering commitment",
          notes: null,
          purpose: "order",
          sourceRef: {
            orderId: "ord_1",
            reservationRequestId: "rsv_1",
          },
          expiresAt: null,
        },
        context,
      ),
    ).rejects.toMatchObject({
      kind: "inventory-item-missing",
      name: "InventoryHoldPlacementError",
    } satisfies Partial<InventoryHoldPlacementError>);
    expect(readAllEvents()).toHaveLength(0);
  });

  it("places holds from aggregate stock when the stock row has not projected", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    await eventStore.appendToStream({
      streamId: "inventory.item-inv_1",
      expectedVersion: "no_stream",
      events: [
        {
          eventType: "inventory.item.created",
          payload: {
            itemId: "inv_1",
            accountId: "acc_seller",
            catalogItemId: "cat_1",
            productId: "prod_1",
            selectedOptions: [],
            gradedCard: null,
            storageLocationId: "loc_1",
            totalQuantity: 1,
            acquisitionCostAmount: null,
          },
        },
      ],
      context,
    });
    const services = createInventoryHoldRuntime({
      eventStore,
      checkpointStore: {} as never,
      db: createInventoryDb({ itemRows: [] }),
    });

    await expect(
      services.createHold(
        {
          holdId: "hld_order_reservation_rsv_1" as InventoryHoldId,
          accountId: "acc_seller" as AccountId,
          itemId: "inv_1",
          quantity: 1,
          reason: "Ordering commitment",
          notes: null,
          purpose: "order",
          sourceRef: {
            orderId: "ord_1",
            reservationRequestId: "rsv_1",
          },
          expiresAt: null,
        },
        context,
      ),
    ).resolves.toMatchObject({
      holdId: "hld_order_reservation_rsv_1",
    });
    expect(readAllEvents().filter((event) => event.eventType === "inventory.hold.placed")).toHaveLength(1);
  });

  it("counts targeted aggregate active holds before placing a fallback stock hold", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    await eventStore.appendToStream({
      streamId: "inventory.item-inv_1",
      expectedVersion: "no_stream",
      events: [
        {
          eventType: "inventory.item.created",
          payload: {
            itemId: "inv_1",
            accountId: "acc_seller",
            catalogItemId: "cat_1",
            productId: "prod_1",
            selectedOptions: [],
            gradedCard: null,
            storageLocationId: "loc_1",
            totalQuantity: 1,
            acquisitionCostAmount: null,
          },
        },
      ],
      context,
    });
    const db = createInventoryDb({
      itemRows: [],
      aggregateHoldRows: [
        {
          hold_id: "hld_existing",
          account_id: "acc_seller",
          item_id: "inv_1",
          quantity: 1,
          active: true,
        },
      ],
    });
    const services = createInventoryHoldRuntime({
      eventStore,
      checkpointStore: {} as never,
      db,
    });

    await expect(
      services.createHold(
        {
          holdId: "hld_order_reservation_rsv_1" as InventoryHoldId,
          accountId: "acc_seller" as AccountId,
          itemId: "inv_1",
          quantity: 1,
          reason: "Ordering commitment",
          notes: null,
          purpose: "order",
          sourceRef: {
            orderId: "ord_1",
            reservationRequestId: "rsv_1",
          },
          expiresAt: null,
        },
        context,
      ),
    ).rejects.toMatchObject({
      kind: "insufficient-available-quantity",
      name: "InventoryHoldPlacementError",
    } satisfies Partial<InventoryHoldPlacementError>);
    const aggregateHoldQuery = String(
      db.query.mock.calls.find((call) => String(call[0]).includes("FROM event_store_events"))?.[0] ?? "",
    );
    expect(aggregateHoldQuery).toContain("stream_category = 'inventory.hold'");
    expect(aggregateHoldQuery).toContain("payload ->> 'accountId' = $2");
    expect(aggregateHoldQuery).toContain("payload ->> 'itemId' = $3");
    expect(readAllEvents().filter((event) => event.eventType === "inventory.hold.placed")).toHaveLength(0);
  });

  it("blocks seller release of order holds while system workflows release them with audit context", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const holdRow = {
      hold_id: "hld_order_reservation_rsv_1",
      account_id: "acc_seller",
      item_id: "inv_1",
      quantity: 1,
      reason: "Ordering commitment",
      notes: null,
      purpose: "order",
      source_ref: {
        orderId: "ord_1",
        reservationRequestId: "rsv_1",
      },
      expires_at: null,
      status: "active",
      created_at: "2026-06-24T00:00:00.000Z",
      updated_at: "2026-06-24T00:00:00.000Z",
      released_at: null,
      release_reason: null,
    };
    const services = createInventoryHoldRuntime({
      eventStore,
      checkpointStore: {} as never,
      db: createInventoryDb({ holdRows: [holdRow] }),
    });
    await eventStore.appendToStream({
      streamId: "inventory.hold-hld_order_reservation_rsv_1",
      expectedVersion: "no_stream",
      events: [
        {
          eventType: "inventory.hold.placed",
          payload: {
            holdId: "hld_order_reservation_rsv_1",
            accountId: "acc_seller",
            itemId: "inv_1",
            quantity: 1,
            reason: "Ordering commitment",
            notes: null,
            purpose: "order",
            sourceRef: {
              orderId: "ord_1",
              reservationRequestId: "rsv_1",
            },
            expiresAt: null,
          },
        },
      ],
      context,
    });

    await expect(
      services.releaseHold(
        {
          accountId: "acc_seller",
          holdId: "hld_order_reservation_rsv_1",
          releaseReason: "manual",
        },
        context,
      ),
    ).rejects.toThrow("Only manual inventory holds can be released by sellers.");
    await services.releaseHold(
      {
        accountId: "acc_seller",
        holdId: "hld_order_reservation_rsv_1",
        releaseReason: "order-cancelled",
      },
      withInventorySystemHoldReleaseAuthority(context),
    );

    const released = readAllEvents().find((event) => event.eventType === "inventory.hold.released");
    expect(released).toMatchObject({
      performedByUserId: "usr_test",
      forAccountId: "acc_seller",
      payload: expect.objectContaining({
        releaseReason: "order-cancelled",
      }),
    });
  });
});
