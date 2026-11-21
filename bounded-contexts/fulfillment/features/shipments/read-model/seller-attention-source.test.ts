import { describe, expect, it, vi } from "vitest";
import {
  aggregateSellerAttentionQueue,
  isSellerAttentionItem,
  type SellerAttentionContext,
} from "@chase-sets/seller-attention-queue";
import {
  createShipByAttentionSource,
  createShipByAttentionSourceFromReadModel,
  toShipByAttentionItems,
  type ShipByAttentionRow,
} from "./seller-attention-source";

const NOW = "2026-07-14T12:00:00.000Z";
const CONTEXT: SellerAttentionContext = { accountId: "acct-1", now: NOW };

// node-postgres hands back a timestamptz column as a Date unless the query reads
// it as text; this fake answers the same way for the column it is asked about.
function pgTimestamp(sql: string, column: string, iso: string): string | Date {
  return sql.includes(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`) ? iso : new Date(iso);
}

function row(overrides: Partial<ShipByAttentionRow> = {}): ShipByAttentionRow {
  return {
    shipmentId: "ship-1",
    reference: "SHP-1",
    shipByAt: "2026-07-16T12:00:00.000Z",
    observedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("toShipByAttentionItems", () => {
  it("escalates severity by proximity to the ship-by deadline", () => {
    const [overdue, soon, upcoming] = toShipByAttentionItems(
      [
        row({ shipmentId: "a", shipByAt: "2026-07-14T00:00:00.000Z" }),
        row({ shipmentId: "b", shipByAt: "2026-07-14T20:00:00.000Z" }),
        row({ shipmentId: "c", shipByAt: "2026-07-20T00:00:00.000Z" }),
      ],
      CONTEXT,
    );
    expect(overdue.severity).toBe("critical");
    expect(soon.severity).toBe("warning");
    expect(upcoming.severity).toBe("info");
  });

  it("carries the ship-by as the deadline and deep-links to the shipment surface", () => {
    const [item] = toShipByAttentionItems([row()], CONTEXT);
    expect(item.dueAt).toBe("2026-07-16T12:00:00.000Z");
    expect(item.deepLink).toEqual({ surface: "shipment", href: "/account/sales/shipments/ship-1" });
    expect(isSellerAttentionItem(item, "fulfillment-ship-by")).toBe(true);
  });
});

describe("createShipByAttentionSource", () => {
  it("loads rows through the injected query and maps them", async () => {
    const source = createShipByAttentionSource({ loadShipByRows: async () => [row()] });
    const items = await source.load(CONTEXT);
    expect(source.id).toBe("fulfillment-ship-by");
    expect(items).toHaveLength(1);
  });
});

describe("createShipByAttentionSourceFromReadModel", () => {
  it("uses the same command-center queue projection as the seller web surface", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          shipment_id: "shp_1",
          order_id: "ord_1",
          display_reference: "SHP-1",
          status: "label-attached",
          label_status: "purchased",
          tracking_identifier: "tracking_1",
          carrier_name: "USPS",
          buyer_display_name: "Buyer",
          current_exception_type: null,
          current_exception_notes: null,
          line_count: 1,
          total_quantity: 2,
          created_at: "2026-07-13T00:00:00.000Z",
          updated_at: "2026-07-14T00:00:00.000Z",
          conflicts: [],
        },
      ],
    }));

    const items = await createShipByAttentionSourceFromReadModel({ query } as never).load(CONTEXT);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("page.seller_account_id = $1"), ["acct-1"]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("fulfillment_shipment_conflict_pages"), ["acct-1"]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("page.status <> 'cancelled'"), ["acct-1"]);
    expect(items).toEqual([
      expect.objectContaining({
        id: "fulfillment-ship-by:shp_1",
        source: "fulfillment-ship-by",
        summary: expect.objectContaining({ code: "fulfillment.command-center.ready-to-dispatch" }),
      }),
    ]);
  });

  it("reads its times as ISO text, so the queue keeps the shipment", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: [
        {
          shipment_id: "shp_1",
          order_id: "ord_1",
          display_reference: "SHP-1",
          status: "awaiting-package",
          label_status: "not-purchased",
          tracking_identifier: null,
          carrier_name: null,
          buyer_display_name: "Buyer",
          current_exception_type: null,
          current_exception_notes: null,
          line_count: 1,
          total_quantity: 1,
          created_at: pgTimestamp(sql, "page.created_at", "2026-07-13T00:00:00.000Z"),
          updated_at: pgTimestamp(sql, "page.updated_at", "2026-07-13T00:05:00.000Z"),
          conflicts: [],
        },
      ],
    }));

    const queue = await aggregateSellerAttentionQueue(
      [createShipByAttentionSourceFromReadModel({ query } as never)],
      CONTEXT,
    );

    expect(queue.sources).toEqual([{ id: "fulfillment-ship-by", status: "available", itemCount: 1 }]);
    expect(queue.items[0]?.observedAt).toBe("2026-07-13T00:00:00.000Z");
  });
});
