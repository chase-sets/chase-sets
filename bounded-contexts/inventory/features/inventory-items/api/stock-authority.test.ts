import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext, EventRecordToStore } from "@chase-sets/event-core/storage";
import type { PgQueryable, PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { createInventoryStockReservations } from "./stock-reservations";
import { createInventoryStockAuthority, type InventoryStockTarget } from "./stock-authority";
import { foldInventoryStockHold } from "../../../support/runtime-support/stock-history";

const context: EventStoreContext = {
  tenantId: "tnt_tenant",
  audit: { performedByUserId: "usr_user", forAccountId: "acc_account" },
};
const target: InventoryStockTarget = {
  listingId: "listing",
  accountId: "acc_account",
  inventoryItemId: "item",
  channelConnectionId: "connection",
  catalogItemId: "catalog",
  productId: "catalog::raw",
  selectedOptions: [],
};
const time = "2026-11-15T12:00:00.000Z" as IsoUtcTimestamp;

async function fixture(holdEvents = 0) {
  const { eventStore } = createInMemoryEventStore();
  await eventStore.appendToStream({
    streamId: "inventory.item-item",
    expectedVersion: "no_stream",
    context,
    events: [
      {
        eventType: "inventory.item.created",
        payload: {
          itemId: "item",
          accountId: "acc_account",
          catalogItemId: "catalog",
          productId: "catalog::raw",
          selectedOptions: [],
          storageLocationId: "location",
          totalQuantity: 10,
        },
      },
    ],
  });
  await eventStore.appendToStream({
    streamId: "inventory.channel-stock-allocation-item",
    expectedVersion: "no_stream",
    context,
    events: [
      {
        eventType: "inventory.channel-stock-allocation.set",
        occurredAt: time,
        payload: {
          eventVersion: 1,
          accountId: "acc_account",
          inventoryItemId: "item",
          mode: "shared-pool",
          partitions: [],
          setAt: time,
        },
      },
    ],
  });
  if (holdEvents) {
    const events: EventRecordToStore[] = [
      {
        eventType: "inventory.hold.placed",
        payload: {
          holdId: "hold",
          accountId: "acc_account",
          itemId: "item",
          quantity: 2,
          reason: "Checkout",
          purpose: "checkout",
          sourceRef: { checkoutSessionId: "checkout", lineKey: "line" },
          expiresAt: "2026-11-16T00:00:00.000Z",
        },
      },
    ];
    for (let extensionCount = 1; extensionCount < Math.min(holdEvents, 500); extensionCount++)
      events.push({
        eventType: "inventory.hold.extended",
        payload: {
          holdId: "hold",
          extendedAt: time,
          extensionCount,
          expiresAt: new Date(Date.parse("2026-11-16T00:00:00.000Z") + extensionCount * 1000).toISOString(),
        },
      });
    if (holdEvents === 501)
      events.push({
        eventType: "inventory.hold.released",
        payload: { holdId: "hold", releasedAt: time, releaseReason: "manual" },
      });
    await eventStore.appendToStream({ streamId: "inventory.hold-hold", expectedVersion: "no_stream", context, events });
  }
  const queries: string[] = [];
  const db: PgQueryable = {
    async query<Row>(sql: string) {
      queries.push(sql);
      if (/\b(?:FROM|JOIN) inventory_/u.test(sql)) throw new Error("Poisoned projection was read");
      let rows: unknown[] = [];
      if (sql.startsWith("SELECT store_id")) rows = [{ store_id: "inventory", incarnation: "inventory-incarnation" }];
      if (sql.includes("WITH candidates") && holdEvents)
        rows = [{ stream_id: "inventory.hold-hold", total: "1", current_version: String(holdEvents) }];
      return { rows: rows as Row[] };
    },
  };
  const pool: PgTransactionalPool = { ...db, connect: async () => ({ ...db, release: () => undefined }) };
  const store: PostgresEventStore = {
    ...eventStore,
    readStreamInTransaction: (_db, input) => eventStore.readStream(input),
    appendToStreamInTransaction: (_db, input) => eventStore.appendToStream(input),
    appendToStreamsInTransaction: (_db, inputs) => eventStore.appendToStreams!(inputs),
  };
  const reservations = createInventoryStockReservations(pool, store);
  return { authority: createInventoryStockAuthority(pool, store, reservations), eventStore, queries };
}

describe("Inventory canonical stock capture", () => {
  it.each([0, 1, 500, 501])("poisons projections and reads complete %i-event Hold history", async (count) => {
    const { authority, queries, eventStore } = await fixture(count);
    const captured = await authority.capture(target, context);
    expect(captured.stock).toMatchObject({
      totalQuantity: 10,
      heldQuantity: count > 0 && count <= 500 ? 2 : 0,
      availableQuantity: count > 0 && count <= 500 ? 8 : 10,
    });
    expect(captured.allocation.revision).toBe(1);
    expect(queries.some((sql) => /\b(?:FROM|JOIN) inventory_/u.test(sql))).toBe(false);
    // Mechanism mutant: a first-page-only fold misses the release at event 501.
    if (count === 501) {
      const truncated = await eventStore.readStream({ streamId: "inventory.hold-hold", limit: 500 });
      const mutant = foldInventoryStockHold({
        events: truncated,
        streamId: "inventory.hold-hold",
        itemId: "item",
        accountId: "acc_account",
        tenantId: "tnt_tenant",
      });
      expect(() => expect(mutant.active ? mutant.quantity : 0).toBe(captured.stock.heldQuantity)).toThrow();
    }
  });

  it.each([
    { catalogItemId: "foreign" },
    { productId: "foreign" },
    { accountId: "foreign" },
    { selectedOptions: [{ dimensionId: "dimension", optionId: "option" }] },
  ])("refuses mismatched target identity %j", async (changed) => {
    const { authority } = await fixture();
    await expect(authority.capture({ ...target, ...changed }, context)).rejects.toThrow();
  });

  it.each(["zero", "foreign", "corrupt", "absent", "unallocated"])("refuses %s canonical allocation", async (fault) => {
    const { authority, eventStore } = await fixture();
    const itemId = fault === "absent" ? "missing" : "item";
    if (fault !== "absent")
      await eventStore.appendToStream({
        streamId: "inventory.channel-stock-allocation-item",
        expectedVersion: 1,
        context,
        events: [
          {
            eventType: fault === "corrupt" ? "inventory.unknown" : "inventory.channel-stock-allocation.set",
            occurredAt: time,
            payload: {
              eventVersion: 1,
              accountId: fault === "foreign" ? "foreign" : "acc_account",
              inventoryItemId: "item",
              mode: "partitioned",
              partitions: [
                {
                  channelConnectionId: fault === "unallocated" ? "other" : "connection",
                  units: fault === "zero" ? 0 : 1,
                },
              ],
              setAt: time,
            },
          },
        ],
      });
    await expect(authority.capture({ ...target, inventoryItemId: itemId }, context)).rejects.toThrow();
  });
});
