import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable, PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";
import { createInventoryStockReservations, stockOwnerStreams } from "./stock-reservations";

describe("Inventory physical stock enrollment", () => {
  const context: EventStoreContext = {
    tenantId: "tnt_tenant",
    audit: { performedByUserId: "usr_user", forAccountId: "acc_account" },
  };
  it("maps Item, allocation, Hold placement and retained Hold aliases to both owner streams", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("RETURNING generation"))
        return { rows: [{ generation: "1", status: "PENDING", affected_reservation_ids: [] }] };
      if (sql.includes("SELECT generation"))
        return { rows: [{ generation: "1", status: "PENDING", affected_reservation_ids: [] }] };
      return { rows: [] };
    });
    const db = { query } as PgQueryable;
    const store = {
      readStreamInTransaction: vi.fn(async () => [{ payload: { itemId: "item" } }]),
    } as unknown as PostgresEventStore;
    const stock = createInventoryStockReservations(db as PgTransactionalPool, store);
    for (const [streamId, eventType, payload] of [
      ["inventory.item-item", "inventory.item.adjusted", { quantityDelta: -1 }],
      ["inventory.channel-stock-allocation-item", "inventory.channel-stock-allocation.set", {}],
      ["inventory.hold-new", "inventory.hold.placed", { itemId: "item" }],
      ["inventory.hold-old", "inventory.hold.released", { holdId: "old" }],
    ] as const) {
      query.mockClear();
      await stock.enroll(db, [{ streamId, expectedVersion: "any", context, events: [{ eventType, payload }] }]);
      const locks = query.mock.calls
        .filter(([sql]) => sql.includes("'owner_stream:'"))
        .map((call) => (call as unknown as [string, string[]])[1][0]);
      expect([...new Set(locks)]).toEqual(stockOwnerStreams("item"));
    }
  });

  it("excludes projections and unrelated Inventory streams from canonical stock authority", async () => {
    const db = { query: vi.fn() } as unknown as PgQueryable;
    const stock = createInventoryStockReservations(db as PgTransactionalPool, {} as PostgresEventStore);
    await stock.enroll(db, [
      {
        streamId: "inventory.recovered-item-one",
        expectedVersion: "any",
        context,
        events: [{ eventType: "inventory.recovered-item.transferred", payload: {} }],
      },
    ]);
    expect(db.query).not.toHaveBeenCalled();
  });
});
