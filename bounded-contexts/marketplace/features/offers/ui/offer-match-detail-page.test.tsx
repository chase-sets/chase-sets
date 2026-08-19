// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MarketplaceOfferMatchDetailPage } from "./offer-match-detail-page";
import type { OfferMatchDetail } from "./contracts";

const offer: OfferMatchDetail = {
  offer_id: "off_1",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Ash Ketchum",
  buyer_average_rating: "4.60",
  buyer_review_count: 7,
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::condition:raw",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [{ dimensionId: "condition", optionId: "raw" }],
  product_summary: "Raw / Near Mint",
  price_amount: "20.00",
  quantity_requested: 1,
  status: "submitted",
  accepted_seller_account_id: null,
  accepted_at: null,
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
  listing_id: "lst_1",
  listing_price_amount: "22.00",
  listing_quantity_cap: 2,
  listing_visible_quantity: 2,
  offer_price_gap_amount: "2.00",
  offer_to_listing_price_bps: 9091,
  seller_available_quantity: 2,
  seller_listing_availability_status: "available",
  can_fulfill: true,
};

afterEach(cleanup);

describe("MarketplaceOfferMatchDetailPage", () => {
  it("renders the offer-match overview as an elevated entity", () => {
    render(<MarketplaceOfferMatchDetailPage offer={offer} canAccept />);

    const root = screen.getByText("Ash Ketchum").closest(".rounded-tokenLg");
    expect(root).not.toBeNull();
    const tokens = new Set((root as HTMLElement).className.split(/\s+/));
    for (const included of ["ds-glass", "border", "border-muted", "shadow-tokenSm"])
      expect(tokens.has(included), `offer-match overview includes ${included}`).toBe(true);
    for (const excluded of ["bg-surface-2", "ds-glow"])
      expect(tokens.has(excluded), `offer-match overview excludes ${excluded}`).toBe(false);
  });

  it("routes the primary accept action through Checkout Sell List review", () => {
    const markup = renderToString(<MarketplaceOfferMatchDetailPage offer={offer} canAccept />);

    expect(markup).toContain('action="/account/sell-list"');
    expect(markup).toContain('name="intent" value="add-selected-offer"');
    expect(markup).toContain('name="offerId" value="off_1"');
    expect(markup).toContain('name="buyerDisplayName" value="Ash Ketchum"');
    expect(markup).toContain('name="offerPriceAmount" value="20.00"');
    expect(markup).toContain('name="catalogItemId" value="cat_charizard"');
    expect(markup).toContain('name="productId" value="cat_charizard::condition:raw"');
    expect(markup).not.toContain('name="feeQuoteFingerprint"');
    expect(markup).not.toContain('value="accept-offer"');
  });
});
