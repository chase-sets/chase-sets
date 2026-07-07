import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildCheckoutInventorySupplyProjectionHandlers } from "./inventory-projection";

type SupplyItemRow = { item_id: string; total_quantity: number; last_stream_version: number };
type SupplyHoldRow = {
  hold_id: string;
  item_id: string;
  quantity: number;
  status: string;
  last_stream_version: number;
};
type SellerOptionRow = {
  listing_id: string;
  inventory_item_id: string | null;
  listing_quantity_cap: number;
  supply_total_quantity: number | null;
  active_held_quantity: number | null;
};

/**
 * In-memory fake `PgQueryable` that interprets the inventory supply/holds
 * projection SQL by statement shape. It maintains the auxiliary
 * `checkout_supply_items` / `checkout_supply_holds` tables and the recompute
 * that denormalizes `supply_total_quantity` / `active_held_quantity` onto the
 * matching seller-option rows. Seller-option rows are seeded by the test to
 * represent listings created by the marketplace handler set.
 */
class InventoryProjectionDb implements PgQueryable {
  public readonly supplyItems = new Map<string, SupplyItemRow>();
  public readonly supplyHolds = new Map<string, SupplyHoldRow>();
  public readonly sellerOptions = new Map<string, SellerOptionRow>();

  seedSellerOption(row: SellerOptionRow): void {
    this.sellerOptions.set(row.listing_id, row);
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO checkout_supply_items")) {
      const itemId = String(values[0]);
      const totalQuantity = Number(values[7]);
      const streamVersion = Number(values[8]);
      const existing = this.supplyItems.get(itemId);
      if (!existing || existing.last_stream_version < streamVersion) {
        this.supplyItems.set(itemId, {
          item_id: itemId,
          total_quantity: totalQuantity,
          last_stream_version: streamVersion,
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE checkout_supply_items") && sql.includes("total_quantity = total_quantity +")) {
      const itemId = String(values[0]);
      const delta = Number(values[1]);
      const streamVersion = Number(values[3]);
      const existing = this.supplyItems.get(itemId);
      if (existing && existing.last_stream_version < streamVersion) {
        existing.total_quantity += delta;
        existing.last_stream_version = streamVersion;
      }
      return { rows: [], rowCount: existing ? 1 : 0 };
    }

    if (sql.includes("INSERT INTO checkout_supply_holds")) {
      const holdId = String(values[0]);
      const itemId = String(values[1]);
      const quantity = Number(values[2]);
      const streamVersion = Number(values[3]);
      const existing = this.supplyHolds.get(holdId);
      if (!existing || existing.last_stream_version < streamVersion) {
        this.supplyHolds.set(holdId, {
          hold_id: holdId,
          item_id: itemId,
          quantity,
          status: "active",
          last_stream_version: streamVersion,
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE checkout_supply_holds") && sql.includes("RETURNING item_id")) {
      const holdId = String(values[0]);
      const status = String(values[1]);
      const streamVersion = Number(values[4]);
      const existing = this.supplyHolds.get(holdId);
      if (existing && existing.last_stream_version < streamVersion) {
        existing.status = status;
        existing.last_stream_version = streamVersion;
        return { rows: [{ item_id: existing.item_id }] as Row[], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (
      sql.includes("UPDATE checkout_marketplace_seller_options AS o") &&
      sql.includes("supply_total_quantity = supply.total_quantity")
    ) {
      const itemId = String(values[0]);
      const supply = this.supplyItems.get(itemId);
      if (!supply) {
        return { rows: [], rowCount: 0 };
      }
      const heldQuantity = [...this.supplyHolds.values()]
        .filter((hold) => hold.item_id === itemId && hold.status === "active")
        .reduce((total, hold) => total + hold.quantity, 0);
      let affected = 0;
      for (const row of this.sellerOptions.values()) {
        if (row.inventory_item_id === itemId) {
          row.supply_total_quantity = supply.total_quantity;
          row.active_held_quantity = heldQuantity;
          affected += 1;
        }
      }
      return { rows: [], rowCount: affected };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function event(type: string, streamVersion: number, data: Record<string, unknown>): TransportEvent {
  return {
    id: "evt_1" as never,
    type,
    streamId: "inventory.item-inv_1" as never,
    streamVersion: streamVersion as never,
    globalPosition: streamVersion as never,
    tenantId: "tnt_1" as never,
    data: data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_1" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-06-17T00:00:00.000Z" as never,
      recordedAt: "2026-06-17T00:00:00.000Z" as never,
    },
  };
}

function seededDb(): InventoryProjectionDb {
  const db = new InventoryProjectionDb();
  // Two listings backed by the same inventory item, plus an unrelated listing.
  db.seedSellerOption({
    listing_id: "lst_1",
    inventory_item_id: "inv_1",
    listing_quantity_cap: 5,
    supply_total_quantity: null,
    active_held_quantity: null,
  });
  db.seedSellerOption({
    listing_id: "lst_2",
    inventory_item_id: "inv_1",
    listing_quantity_cap: 5,
    supply_total_quantity: null,
    active_held_quantity: null,
  });
  db.seedSellerOption({
    listing_id: "lst_other",
    inventory_item_id: "inv_other",
    listing_quantity_cap: 5,
    supply_total_quantity: null,
    active_held_quantity: null,
  });
  return db;
}

describe("checkout inventory supply/holds projection", () => {
  it("sets supply_total_quantity on item.created for every joined listing", async () => {
    const db = seededDb();
    const handlers = buildCheckoutInventorySupplyProjectionHandlers(db);

    await handlers["inventory.item.created"]!(
      event("inventory.item.created", 1, { itemId: "inv_1", totalQuantity: 8 }),
    );

    expect(db.sellerOptions.get("lst_1")).toMatchObject({ supply_total_quantity: 8, active_held_quantity: 0 });
    expect(db.sellerOptions.get("lst_2")).toMatchObject({ supply_total_quantity: 8, active_held_quantity: 0 });
    // Unrelated inventory item is untouched.
    expect(db.sellerOptions.get("lst_other")).toMatchObject({ supply_total_quantity: null });
  });

  it("applies item.adjusted deltas to supply_total_quantity", async () => {
    const db = seededDb();
    const handlers = buildCheckoutInventorySupplyProjectionHandlers(db);

    await handlers["inventory.item.created"]!(
      event("inventory.item.created", 1, { itemId: "inv_1", totalQuantity: 8 }),
    );
    await handlers["inventory.item.adjusted"]!(
      event("inventory.item.adjusted", 2, { itemId: "inv_1", quantityDelta: -3 }),
    );

    expect(db.sellerOptions.get("lst_1")).toMatchObject({ supply_total_quantity: 5, active_held_quantity: 0 });
  });

  it("increments active_held_quantity on hold.placed and restores it on hold.released", async () => {
    const db = seededDb();
    const handlers = buildCheckoutInventorySupplyProjectionHandlers(db);

    await handlers["inventory.item.created"]!(
      event("inventory.item.created", 1, { itemId: "inv_1", totalQuantity: 8 }),
    );
    await handlers["inventory.hold.placed"]!(
      event("inventory.hold.placed", 1, { holdId: "hld_1", itemId: "inv_1", quantity: 3 }),
    );

    // available = LEAST(cap 5, GREATEST(8 - 3, 0)) = 5 in the read model, but the
    // denormalized counters reflect supply 8 and holds 3.
    expect(db.sellerOptions.get("lst_1")).toMatchObject({ supply_total_quantity: 8, active_held_quantity: 3 });

    await handlers["inventory.hold.released"]!(
      event("inventory.hold.released", 2, { holdId: "hld_1", releasedAt: "2026-06-17T01:00:00.000Z" }),
    );

    // Released holds are resolved back to the inventory item via the holds table.
    expect(db.sellerOptions.get("lst_1")).toMatchObject({ supply_total_quantity: 8, active_held_quantity: 0 });
  });

  it("sums multiple active holds and is idempotent under replay (last_stream_version guard)", async () => {
    const db = seededDb();
    const handlers = buildCheckoutInventorySupplyProjectionHandlers(db);

    await handlers["inventory.item.created"]!(
      event("inventory.item.created", 1, { itemId: "inv_1", totalQuantity: 10 }),
    );
    await handlers["inventory.hold.placed"]!(
      event("inventory.hold.placed", 1, { holdId: "hld_1", itemId: "inv_1", quantity: 3 }),
    );
    await handlers["inventory.hold.placed"]!(
      event("inventory.hold.placed", 1, { holdId: "hld_2", itemId: "inv_1", quantity: 2 }),
    );

    expect(db.sellerOptions.get("lst_1")).toMatchObject({ supply_total_quantity: 10, active_held_quantity: 5 });

    // Replaying the same item.created and hold.placed events (same stream
    // versions) must not double-count: counters converge to the same values.
    await handlers["inventory.item.created"]!(
      event("inventory.item.created", 1, { itemId: "inv_1", totalQuantity: 10 }),
    );
    await handlers["inventory.hold.placed"]!(
      event("inventory.hold.placed", 1, { holdId: "hld_1", itemId: "inv_1", quantity: 3 }),
    );

    expect(db.sellerOptions.get("lst_1")).toMatchObject({ supply_total_quantity: 10, active_held_quantity: 5 });
  });

  it("ignores hold.released for an unknown hold id", async () => {
    const db = seededDb();
    const handlers = buildCheckoutInventorySupplyProjectionHandlers(db);

    await handlers["inventory.item.created"]!(
      event("inventory.item.created", 1, { itemId: "inv_1", totalQuantity: 8 }),
    );
    await handlers["inventory.hold.released"]!(
      event("inventory.hold.released", 2, { holdId: "hld_missing", releasedAt: "2026-06-17T01:00:00.000Z" }),
    );

    expect(db.sellerOptions.get("lst_1")).toMatchObject({ supply_total_quantity: 8, active_held_quantity: 0 });
  });
});
