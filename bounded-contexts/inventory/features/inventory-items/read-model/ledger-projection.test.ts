import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildInventoryItemLedgerProjectionHandlers } from "./ledger-projection";
import { buildInventoryItemProjectionHandlers } from "./projection";
import { inventoryItemSchemaMigrations } from "./schema";

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

const saleHandoff = inventoryItemSchemaMigrations.find(
  (migration) => migration.migrationId === "20261028_inventory_offline_sale_ledger_handoff",
)!;

describe("offline-sale handoff query contract", () => {
  it("retained sale handoff corrects only the exact audit predicate", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    await saleHandoff.dataStep!({ query });
    const statements = query.mock.calls.map(([sql]) => sql);
    const correction = statements.find((sql) => sql.startsWith("UPDATE"))!;
    expect(correction.replace(/\s+/g, " ")).toBe(
      "UPDATE inventory_item_ledger SET quantity_delta = NULL WHERE kind = 'offline-sale' AND event_type = 'inventory.item.offline-sale-recorded' AND quantity_delta IS NOT NULL",
    );
    expect(statements).toContain("SELECT ledger_entry_id FROM inventory_item_ledger LIMIT 100001");
  });

  it("old writer across sale handoff meets a durable guard before correction and validation", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    await saleHandoff.dataStep!({ query });
    const statements = query.mock.calls.map(([sql]) => sql).filter((sql) => !sql.includes("set_config"));
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(statements[1]).toBe("LOCK TABLE inventory_item_ledger IN ACCESS EXCLUSIVE MODE");
    expect(statements[3]?.replace(/\s+/g, " ")).toBe(
      "ALTER TABLE inventory_item_ledger ADD CONSTRAINT inventory_item_ledger_offline_sale_null_delta CHECK (NOT (kind = 'offline-sale' AND event_type = 'inventory.item.offline-sale-recorded' AND quantity_delta IS NOT NULL)) NOT VALID",
    );
    expect(statements[4]).toMatch(/^UPDATE inventory_item_ledger/);
    expect(statements[5]?.replace(/\s+/g, " ")).toBe(
      "ALTER TABLE inventory_item_ledger VALIDATE CONSTRAINT inventory_item_ledger_offline_sale_null_delta",
    );
    expect(statements[6]).toContain("quantity_delta IS NOT NULL LIMIT 1");
  });

  it("handoff rollback and retry reports incomplete on query failure and refuses overflow", async () => {
    const failure = new Error("synthetic query failure");
    await expect(
      saleHandoff.dataStep!({
        query: async () => {
          throw failure;
        },
      }),
    ).rejects.toMatchObject({ message: "Inventory offline-sale ledger handoff incomplete", cause: failure });
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(saleHandoff.dataStep!({ query })).resolves.toBeUndefined();
    const overflow = {
      query: async <Row = Record<string, unknown>>(sql: string) => ({
        rows: (sql.includes("LIMIT 100001") ? Array.from({ length: 100001 }, () => ({})) : []) as Row[],
      }),
    };
    await expect(saleHandoff.dataStep!(overflow)).rejects.toMatchObject({
      message: "Inventory offline-sale ledger handoff incomplete",
      cause: expect.objectContaining({ message: "ledger exceeds the 100000-row handoff bound" }),
    });
  });
});

describe("inventory item ledger projection", () => {
  it("consumed hold remains outside sale repair with its unchanged stock mismatch", async () => {
    const hold = {
      hold_id: "hld_1",
      account_id: "acc_seller",
      item_id: "inv_1",
      quantity: 1,
      reason: "Order commitment",
      purpose: "order",
      source_ref: orderSourceRef,
    };
    const db = {
      query: vi.fn(async (sql: string, _values: readonly unknown[] = []) =>
        sql.includes("FROM inventory_holds") ? { rows: [hold] } : { rows: [] },
      ),
    };
    const itemHandlers = buildInventoryItemProjectionHandlers(db);
    const ledgerHandlers = buildInventoryItemLedgerProjectionHandlers(db);
    const history = [
      event("inventory.item.created", {
        itemId: "inv_1",
        accountId: "acc_seller",
        totalQuantity: 5,
        catalogItemId: "cat_1",
        productId: "prd_1",
        selectedOptions: [],
        gradedCard: null,
        storageLocationId: "loc_1",
        acquisitionCostAmount: null,
      }),
      event("inventory.hold.placed", {
        holdId: "hld_1",
        accountId: "acc_seller",
        itemId: "inv_1",
        quantity: 1,
        reason: "Order commitment",
        purpose: "order",
        sourceRef: orderSourceRef,
      }),
      event(
        "inventory.hold.consumed",
        {
          holdId: "hld_1",
          consumedAt: "2026-07-06T01:00:00.000Z",
          consumptionReason: "Order fulfilled",
          sourceRef: orderSourceRef,
        },
        2,
      ),
    ];
    for (const entry of history) {
      await itemHandlers[entry.type]?.(entry);
      await ledgerHandlers[entry.type]?.(entry);
    }
    const stockWrites = db.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO inventory_items"));
    const adjustments = db.query.mock.calls.filter(([sql]) => sql.includes("SET total_quantity = total_quantity +"));
    const onHand =
      Number(stockWrites[0]![1]![7]) + adjustments.reduce((sum, [, values]) => sum + Number(values?.[1]), 0);
    const movements = db.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO inventory_item_ledger"));
    const ledgerQuantity = movements.reduce((sum, [, values]) => sum + Number(values?.[5]), 0);
    expect(movements.at(-1)?.[1]?.[4]).toBe("hold-consumed");
    expect(movements.at(-1)?.[1]?.[5]).toBe(-1);
    expect({ ledgerQuantity, onHand }).toEqual({ ledgerQuantity: 4, onHand: 5 });
  });

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

  it("retains one movement and one audit row for an offline sale", async () => {
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
    expect(db.query.mock.calls.map(([, values]) => values?.[5])).toEqual([-3, null]);
    expect(db.query.mock.calls[0]?.[1]?.[9]).toBe("sold-offline");
    expect(db.query.mock.calls[1]?.[1]).toEqual([
      "inventory.item-inv_1:3",
      "inv_1",
      "acc_seller",
      "2026-07-06T01:00:00.000Z",
      "offline-sale",
      null,
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
