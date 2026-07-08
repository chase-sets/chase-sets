import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InventoryItemDetailPage } from "../features/inventory-items/ui/inventory-item-detail-page";
import type { InventoryItemDetail } from "../features/inventory-items/ui/contracts";

const item: InventoryItemDetail = {
  item_id: "inv_1",
  account_id: "acc_seller",
  catalog_catalog_item_id: "cat_1",
  product_id: "cat_1::raw",
  language_code: "en",
  item_title: "Pikachu",
  item_subtitle: "Base Set",
  selected_options: [],
  product_summary: "Condition: Near Mint",
  graded_card: null,
  storage_location_id: "loc_1",
  storage_location_name: "Main shelf",
  ship_from_code: "STL",
  ship_from_address: {
    name: "Seller",
    line1: "100 Market St",
    city: "St. Louis",
    state: "MO",
    postalCode: "63101",
    country: "US",
  },
  total_quantity: 4,
  held_quantity: 0,
  available_quantity: 4,
  acquisition_cost_amount: null,
  created_at: "2026-07-06T00:00:00.000Z",
  updated_at: "2026-07-06T04:00:00.000Z",
  holds: [
    {
      hold_id: "hld_checkout",
      account_id: "acc_seller",
      item_id: "inv_1",
      quantity: 1,
      reason: "Checkout reservation",
      notes: null,
      purpose: "checkout",
      source_ref: null,
      expires_at: "2099-07-07T23:59:59.000Z",
      status: "active",
      created_at: "2026-07-06T03:00:00.000Z",
      updated_at: "2026-07-06T03:00:00.000Z",
      released_at: null,
      release_reason: null,
    },
  ],
  ledger: [
    ledger("hold-consumed", "Sale recorded", -1, 1, "order", "ord_sale"),
    ledger("hold-released", "order-cancelled", null, 1, "order", "ord_cancel"),
    ledger("adjusted", "Shelf count correction", -1, null, null, null),
    ledger("hold-expired", "checkout-expired", null, 1, "checkout", null),
  ],
};

describe("inventory item stock ledger page", () => {
  it("narrates sale, pre-ship cancel, manual adjust, and expired checkout hold journeys", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00.000Z"));

    try {
      const html = renderToString(
        createElement(InventoryItemDetailPage, {
          item,
          currentPath: "/account/inventory/items/inv_1",
        }),
      );

      expect(html).toContain("Stock Ledger");
      expect(html).toContain("Sale recorded");
      expect(html).toContain("order-cancelled");
      expect(html).toContain("Shelf count correction");
      expect(html).toContain("checkout-expired");
      expect(html).toContain("/account/sales/ord_sale");
      expect(html).toContain("/account/sales/ord_cancel");
      expect(html).toContain("ledgerKind=hold-consumed");
      expect(html).toContain("Expires");
    } finally {
      vi.useRealTimers();
    }
  });
});

function ledger(
  kind: InventoryItemDetail["ledger"][number]["kind"],
  reason: string,
  quantityDelta: number | null,
  holdQuantity: number | null,
  purpose: InventoryItemDetail["ledger"][number]["purpose"],
  orderId: string | null,
): InventoryItemDetail["ledger"][number] {
  return {
    ledger_entry_id: `entry_${kind}_${reason}`,
    item_id: "inv_1",
    account_id: "acc_seller",
    occurred_at: "2026-07-06T04:00:00.000Z",
    kind,
    quantity_delta: quantityDelta,
    hold_quantity: holdQuantity,
    purpose,
    reason,
    source_ref: orderId ? { orderId, reservationRequestId: `rsv_${orderId}` } : null,
    actor: kind === "adjusted" ? "seller" : "system",
    event_type: `inventory.${kind}`,
    stream_id: `stream_${kind}`,
    stream_version: 1,
    recorded_at: "2026-07-06T04:00:01.000Z",
  };
}
