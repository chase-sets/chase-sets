// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarketplaceListingDetailPage } from "./listing-detail-page";
import type {
  MarketplaceListingDetail,
  MarketplaceListingTermsPreview,
} from "./contracts";

const listing: MarketplaceListingDetail = {
  listing_id: "lst_1",
  account_id: "acc_1",
  inventory_item_id: "inv_1",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::dim_condition:near_mint",
  item_language_code: "ja",
  item_title: "Charizard",
  item_subtitle: null,
  selected_options: [],
  product_summary: "Condition: Near Mint",
  graded_card: null,
  storage_location_name: "North shelf",
  ship_from_code: "CHI-WH-1",
  price_amount: "20.00",
  marketplace_sales_fee_unit_amount: "0.00",
  seller_net_unit_amount: "20.00",
  shipping_allowance_percentage_bps: 500,
  terms_schedule_id: "cts_launch",
  terms_agreement_id: null,
  terms_resolved_at: "2026-04-01T00:00:00.000Z",
  fee_quote_fingerprint: "stale-fingerprint",
  quantity_cap: 1,
  status: "active",
  created_at: "2026-04-01T00:00:00.000Z",
  updated_at: "2026-04-01T00:00:00.000Z",
};

const currentQuote: MarketplaceListingTermsPreview = {
  account_type: "business",
  basis_amount: "20.00",
  marketplace_sales_fee_unit_amount: "1.00",
  seller_net_unit_amount: "19.00",
  shipping_allowance_percentage_bps: 750,
  schedule_id: "cts_current",
  agreement_id: null,
  resolved_at: "2026-04-17T00:00:00.000Z",
  fee_quote_fingerprint: "current-fingerprint",
};

describe("MarketplaceListingDetailPage", () => {
  it("renders the fresh stale-quote fingerprint for browser retry submission", () => {
    const { container } = render(
      <MarketplaceListingDetailPage
        listing={listing}
        feeHistory={[]}
        priceDraftAmount="20.00"
        pricePreview={currentQuote}
        errorMessage="Fee quote changed. Review the current preview and submit again."
      />,
    );

    expect(
      screen.getByText("Fee quote changed. Review the current preview and submit again."),
    ).toBeTruthy();
    expect(screen.getAllByText("Buyer shipping credit").length).toBeGreaterThan(0);
    expect(screen.getByText("Japanese")).toBeTruthy();
    expect(screen.getByText(/Buyer shipping credit 7.5%/)).toBeTruthy();
    expect(
      container.querySelector(
        'input[name="feeQuoteFingerprint"][value="current-fingerprint"]',
      ),
    ).toBeTruthy();
  });
});
