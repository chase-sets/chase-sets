// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { InventoryItemDetail } from "./contracts";
import { ListFromInventoryDrawer } from "./list-from-inventory-drawer";

const item: InventoryItemDetail = {
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
  holds: [],
  ledger: [],
};

afterEach(() => cleanup());

describe("ListFromInventoryDrawer", () => {
  it("opens a prefilled create-and-publish form that posts to the marketplace create route", async () => {
    render(<ListFromInventoryDrawer item={item} />);

    fireEvent.click(screen.getByRole("button", { name: "List it" }));

    // The one-flow form posts to the marketplace create+publish route from the
    // inventory item, prefilled with the item — no navigation to the listings section.
    const form = await waitFor(() => {
      const found = document.querySelector('form[action="/account/listings/new"]');
      expect(found).not.toBeNull();
      return found as HTMLFormElement;
    });

    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("enctype")).toBe("multipart/form-data");
    expect(form.querySelector('input[name="inventoryItemId"][value="inv_1"]')).not.toBeNull();
    expect(form.querySelector('input[name="priceAmount"]')).not.toBeNull();
    expect(form.querySelector('input[name="quantityCap"]')).not.toBeNull();
    expect(form.querySelector('input[name="evidence"]')).not.toBeNull();
    expect(form.querySelector('button[name="intent"][value="create-and-publish-listing"]')).not.toBeNull();
    expect(form.querySelector('button[name="intent"][value="create-listing"]')).not.toBeNull();
  });
});
