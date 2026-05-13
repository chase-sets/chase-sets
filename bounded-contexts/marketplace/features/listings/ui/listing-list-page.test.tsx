// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarketplaceListingListPage } from "./listing-list-page";
import type { MarketplaceListingListItem, MarketplaceSellerListingAvailability } from "./contracts";

const listing: MarketplaceListingListItem = {
  listing_id: "lst_1",
  account_id: "acc_seller",
  inventory_item_id: "inv_1",
  catalog_catalog_item_id: "cat_1",
  product_id: "cat_1::raw",
  item_language_code: "en",
  item_title: "Charizard",
  item_subtitle: null,
  selected_options: [],
  product_summary: "Condition: Raw",
  graded_card: null,
  storage_location_name: "Main",
  ship_from_code: "STL",
  ship_from_address: {
    name: "",
    line1: "",
    city: "",
    state: "",
    postalCode: "",
    country: "US",
  },
  price_amount: "10.00",
  marketplace_sales_fee_unit_amount: "1.00",
  seller_net_unit_amount: "9.00",
  shipping_allowance_percentage_bps: 500,
  terms_schedule_id: "terms_1",
  terms_agreement_id: null,
  terms_resolved_at: "2026-05-01T00:00:00.000Z",
  fee_quote_fingerprint: "fee_1",
  quantity_cap: 1,
  status: "active",
  created_at: "2026-05-01T00:00:00.000Z",
  updated_at: "2026-05-01T00:00:00.000Z",
};

const unavailable: MarketplaceSellerListingAvailability = {
  account_id: "acc_seller",
  status: "unavailable",
  disabled_reason_category: "audit",
  available_again_on: "2026-06-01",
  disabled_at: "2026-05-13T00:00:00.000Z",
  enabled_at: null,
  updated_at: "2026-05-13T00:00:00.000Z",
};

describe("MarketplaceListingListPage", () => {
  it("shows account-wide seller listing availability and resume action", () => {
    render(
      <MarketplaceListingListPage
        data={{ items: [listing] }}
        feeLockReport={{ items: [] }}
        listingAvailability={unavailable}
        inventoryItems={[]}
      />,
    );

    expect(screen.getByText("Seller Listing Availability")).toBeTruthy();
    expect(screen.getByText("Listings unavailable")).toBeTruthy();
    expect(screen.getAllByText("English").length).toBeGreaterThan(0);
    expect(screen.getByText(/Reason: Audit/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn on listings" })).toBeTruthy();
  });
});
