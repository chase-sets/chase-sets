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
  total_quantity: 3,
  held_quantity: 1,
  available_quantity: 2,
  acquisition_cost_amount: null,
  created_at: "2026-05-13T00:00:00.000Z",
  updated_at: "2026-05-13T00:00:00.000Z",
};

describe("inventory item pages", () => {
  it("renders inventory list language codes as localized labels", () => {
    const html = renderToString(
      <InventoryItemListPage
        data={{ items: [inventoryItem] }}
        locations={[]}
      />,
    );

    expect(html).toContain("Japanese");
    expect(html).not.toContain(">ja<");
  });

  it("renders inventory detail language codes as localized labels", () => {
    const detail: InventoryItemDetail = { ...inventoryItem, holds: [] };
    const html = renderToString(<InventoryItemDetailPage item={detail} />);

    expect(html).toContain("Japanese");
    expect(html).not.toContain(">ja<");
  });
});
