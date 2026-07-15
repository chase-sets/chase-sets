import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InventoryItemDetailPage } from "./inventory-item-detail-page";
import { InventoryItemListPage } from "./inventory-item-list-page";
import type { InventoryItemDetail, InventoryItemListItem } from "./contracts";

const inventoryItem: InventoryItemListItem = {
  item_id: "inv_1",
  account_id: "acc_1",
  catalog_catalog_item_id: "cat_1",
  product_id: "cat_1::raw",
  language_code: "ja",
  item_title: "Bulbasaur",
  item_subtitle: "Japanese Base Set",
  selected_options: [],
  product_summary: "Condition: Raw",
  graded_card: null,
  storage_location_id: "loc_1",
  storage_location_name: "Main shelf",
  ship_from_code: "STL",
  ship_from_address: {
    name: "Chase Sets",
    line1: "100 Market St",
    city: "St. Louis",
    state: "MO",
    postalCode: "63101",
    country: "US",
  },
  total_quantity: 3,
  held_quantity: 1,
  available_quantity: 2,
  acquisition_cost_amount: null,
  created_at: "2026-05-13T00:00:00.000Z",
  updated_at: "2026-05-13T00:00:00.000Z",
};

describe("inventory item pages", () => {
  it("renders inventory list language codes as localized labels", () => {
    const html = renderToString(<InventoryItemListPage data={{ items: [inventoryItem] }} locations={[]} />);

    expect(html).toContain("Japanese");
    expect(html).not.toContain(">ja<");
  });

  it("renders catalog item creation as a visible search and selection flow", () => {
    const html = renderToString(<InventoryItemListPage data={{ items: [] }} locations={[]} />);

    expect(html).toContain("Search catalog");
    expect(html).toMatch(/<select[^>]*name="catalogItemId"/);
    expect(html).not.toMatch(/<input[^>]*name="catalogItemId"/);
  });

  it("renders inventory detail language codes as localized labels", () => {
    const detail: InventoryItemDetail = { ...inventoryItem, holds: [], ledger: [] };
    const html = renderToString(<InventoryItemDetailPage item={detail} />);

    expect(html).toContain("Japanese");
    expect(html).not.toContain(">ja<");
  });

  it("offers a list-from-inventory action when stock is available", () => {
    const detail: InventoryItemDetail = { ...inventoryItem, holds: [], ledger: [] };
    const html = renderToString(<InventoryItemDetailPage item={detail} />);

    // The list-from-inventory drawer trigger replaces the navigate-away create link.
    expect(html).toContain("List it");
    expect(html).not.toContain("/account/listings/new?inventoryItemId=");
  });

  it("hides the list-from-inventory action when nothing is available", () => {
    const detail: InventoryItemDetail = { ...inventoryItem, available_quantity: 0, holds: [], ledger: [] };
    const html = renderToString(<InventoryItemDetailPage item={detail} />);

    expect(html).not.toContain("List it");
  });

  it("renders order hold provenance without a seller release affordance", () => {
    const detail: InventoryItemDetail = {
      ...inventoryItem,
      ledger: [],
      holds: [
        {
          hold_id: "hld_order",
          account_id: "acc_1",
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
          created_at: "2026-05-13T00:00:00.000Z",
          updated_at: "2026-05-13T00:00:00.000Z",
          released_at: null,
          release_reason: null,
        },
        {
          hold_id: "hld_manual",
          account_id: "acc_1",
          item_id: "inv_1",
          quantity: 1,
          reason: "Shelf audit",
          notes: null,
          purpose: "manual",
          source_ref: null,
          expires_at: null,
          status: "active",
          created_at: "2026-05-13T00:00:00.000Z",
          updated_at: "2026-05-13T00:00:00.000Z",
          released_at: null,
          release_reason: null,
        },
      ],
    };
    const html = renderToString(<InventoryItemDetailPage item={detail} />);

    expect(html).toContain("Order");
    expect(html).toContain("/account/sales/ord_1");
    expect(html).toContain("View order ord_1");
    expect(html).toContain("Manual");
    expect(html.match(/name="intent" value="release-hold"/g) ?? []).toHaveLength(1);
  });
});
