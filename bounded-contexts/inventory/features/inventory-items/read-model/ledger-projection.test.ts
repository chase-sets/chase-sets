import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildInventoryItemLedgerProjectionHandlers } from "./ledger-projection";

function event(type: string, data: Record<string, unknown>, streamVersion = 1): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${type}_${streamVersion}`,
    streamId: type.startsWith("inventory.item.") ? "inventory.item-inv_1" : "inventory.hold-hld_1",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_1",
    audit: {
      performedByUserId: type === "inventory.item.adjusted" ? "usr_seller" : "usr_inventory_system",
      forAccountId: "acc_seller",
    },
    timing: { occurredAt: "2026-07-06T01:00:00.000Z", recordedAt: "2026-07-06T01:00:01.000Z" },
  });
}

const orderSourceRef = {
  orderId: "ord_1",
  reservationRequestId: "rsv_1",
};

describe("inventory item ledger projection", () => {
  it("projects item creation and adjustment rows with on-hand deltas", async () => {
    const db = {
      query: vi.fn(async (_sql: string, _values: readonly unknown[] = []) => ({ rows: [] })),
    };
    const handlers = buildInventoryItemLedgerProjectionHandlers(db);

    await handlers["inventory.item.created"]!(
      event("inventory.item.created", {
        itemId: "inv_1",
        accountId: "acc_seller",
        totalQuantity: 5,
      }),
    );
    await handlers["inventory.item.adjusted"]!(
      event(
        "inventory.item.adjusted",
        {
          itemId: "inv_1",
          quantityDelta: -1,
          reason: "Shelf count correction",
          reasonCode: "correction",
          note: "Counted after moving the shelf",
        },
        2,
      ),
    );

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("inventory_item_ledger"), [
      "inventory.item-inv_1:1",
      "inv_1",
      "acc_seller",
      "2026-07-06T01:00:00.000Z",
      "created",
      5,
      null,
      null,
      "Inventory item created",
      null,
      null,
      null,
      null,
      null,
      "system",
      "inventory.item.created",
      "inventory.item-inv_1",
      1,
      "2026-07-06T01:00:01.000Z",
    ]);
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("ON CONFLICT (ledger_entry_id) DO NOTHING"), [
      "inventory.item-inv_1:2",
      "inv_1",
      "acc_seller",
      "2026-07-06T01:00:00.000Z",
      "adjusted",
      -1,
      null,
      null,
      "Shelf count correction",
      "correction",
      "Counted after moving the shelf",
      null,
      null,
      null,
      "seller",
      "inventory.item.adjusted",
      "inventory.item-inv_1",
      2,
      "2026-07-06T01:00:01.000Z",
    ]);
  });

  it("projects placed, converted, released, expired, and consumed hold lifecycle rows", async () => {
    const holdRow = {
      hold_id: "hld_1",
      account_id: "acc_seller",
      item_id: "inv_1",
      quantity: 1,
      reason: "Ordering commitment",
      purpose: "order",
      source_ref: orderSourceRef,
    };
    const db = {
      query: vi.fn(async (sql: string, _values: readonly unknown[] = []) =>
        sql.includes("FROM inventory_holds") ? { rows: [holdRow], rowCount: 1 } : { rows: [], rowCount: 0 },
      ),
    };
    const handlers = buildInventoryItemLedgerProjectionHandlers(db);

    await handlers["inventory.hold.placed"]!(
      event("inventory.hold.placed", {
        holdId: "hld_1",
        accountId: "acc_seller",
        itemId: "inv_1",
        quantity: 1,
        reason: "Checkout reservation",
        purpose: "checkout",
        sourceRef: orderSourceRef,
      }),
    );
    await handlers["inventory.hold.converted"]!(
      event("inventory.hold.converted", { holdId: "hld_1", reason: "Order created" }, 2),
    );
    await handlers["inventory.hold.released"]!(
      event("inventory.hold.released", { holdId: "hld_1", releaseReason: "order-cancelled" }, 3),
    );
    await handlers["inventory.hold.expired"]!(
      event("inventory.hold.expired", { holdId: "hld_1", reason: "checkout-expired" }, 4),
    );
    await handlers["inventory.hold.consumed"]!(
      event("inventory.hold.consumed", { holdId: "hld_1", reason: "Fulfillment dispatched" }, 5),
    );

    const inserts = db.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO inventory_item_ledger"));
    expect(inserts.map(([, values]) => values?.[4])).toEqual([
      "hold-placed",
      "hold-converted",
      "hold-released",
      "hold-expired",
      "hold-consumed",
    ]);
    expect(inserts.map(([, values]) => values?.[14])).toEqual(["system", "system", "system", "system", "system"]);
    expect(inserts.at(-1)?.[1]).toEqual([
      "inventory.hold-hld_1:5",
      "inv_1",
      "acc_seller",
      "2026-07-06T01:00:00.000Z",
      "hold-consumed",
      -1,
      1,
      "order",
      "Fulfillment dispatched",
      null,
      null,
      null,
      null,
      JSON.stringify(orderSourceRef),
      "system",
      "inventory.hold.consumed",
      "inventory.hold-hld_1",
      5,
      "2026-07-06T01:00:01.000Z",
    ]);
  });

  it("retains the adjusted row and adds one deterministic offline-sale row", async () => {
    const db = {
      query: vi.fn(async (_sql: string, _values: readonly unknown[] = []) => ({ rows: [] })),
    };
    const handlers = buildInventoryItemLedgerProjectionHandlers(db);

    await handlers["inventory.item.adjusted"]!(
      event(
        "inventory.item.adjusted",
        { itemId: "inv_1", quantityDelta: -3, reason: "Offline sale", reasonCode: "sold-offline" },
        2,
      ),
    );
    await handlers["inventory.item.offline-sale-recorded"]!(
      event(
        "inventory.item.offline-sale-recorded",
        { itemId: "inv_1", quantity: 3, salePriceAmount: "125.00", channel: "card-show" },
        3,
      ),
    );

    expect(db.query.mock.calls.map(([, values]) => values?.[4])).toEqual(["adjusted", "offline-sale"]);
    expect(db.query.mock.calls[0]?.[1]?.[9]).toBe("sold-offline");
    expect(db.query.mock.calls[1]?.[1]).toEqual([
      "inventory.item-inv_1:3",
      "inv_1",
      "acc_seller",
      "2026-07-06T01:00:00.000Z",
      "offline-sale",
      -3,
      null,
      null,
      "Offline sale",
      null,
      null,
      "125.00",
      "card-show",
      null,
      "system",
      "inventory.item.offline-sale-recorded",
      "inventory.item-inv_1",
      3,
      "2026-07-06T01:00:01.000Z",
    ]);
  });

  it("uses deterministic ledger entry ids so projection replay rebuilds the same movement timeline", async () => {
    const db = { query: vi.fn(async (_sql: string, _values: readonly unknown[] = []) => ({ rows: [] })) };
    const handlers = buildInventoryItemLedgerProjectionHandlers(db);
    const created = event("inventory.item.created", {
      itemId: "inv_1",
      accountId: "acc_seller",
      totalQuantity: 5,
    });

    await handlers["inventory.item.created"]!(created);
    await handlers["inventory.item.created"]!(created);

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls.map(([, values]) => values?.[0])).toEqual([
      "inventory.item-inv_1:1",
      "inventory.item-inv_1:1",
    ]);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("ON CONFLICT (ledger_entry_id) DO NOTHING");
  });
});
