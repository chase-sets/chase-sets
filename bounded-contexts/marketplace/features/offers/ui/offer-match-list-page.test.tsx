import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketplaceOfferMatchListPage } from "./offer-match-list-page";
import type { OfferMatchListItem } from "./contracts";

const offer: OfferMatchListItem = {
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

describe("MarketplaceOfferMatchListPage", () => {
  it("presents offer matches as a source list for checkout sell list review", () => {
    const markup = renderToString(<MarketplaceOfferMatchListPage data={{ items: [offer] }} />);

    expect(markup).toContain("Checkout Sell List");
    expect(markup).toContain("Offer Matches is now a Marketplace source list");
    expect(markup).toContain("Add selected offers to the Checkout Sell List");
    expect(markup).toContain('action="/account/sell-list"');
    expect(markup).toContain('name="intent" value="add-selected-offer"');
    expect(markup).toContain('name="offerId" value="off_1"');
    expect(markup).toContain('name="buyerDisplayName" value="Ash Ketchum"');
    expect(markup).toContain('name="offerPriceAmount" value="20.00"');
    expect(markup).toContain('name="catalogItemId" value="cat_charizard"');
    expect(markup).toContain('name="productId" value="cat_charizard::condition:raw"');
    expect(markup).toContain('name="selectedOptions"');
    expect(markup).not.toContain('name="buyerAccountId"');
    expect(markup).not.toContain("60601");
    expect(markup).not.toContain("seller_listing_availability");
    expect(markup).toContain("Add selected offer to Sell List");
    expect(markup).toContain('class="rounded-tokenLg overflow-hidden bg-surface-2 p-4"');
  });

  it("shows listing price next to the best offer so sellers can judge the gap", () => {
    const markup = renderToString(<MarketplaceOfferMatchListPage data={{ items: [offer] }} />);

    expect(markup).toContain("Best Offer Matches");
    expect(markup).toContain("Your Listing");
    expect(markup).toContain("$22.00");
    expect(markup).toContain("$20.00");
    expect(markup).toContain("$2.00 below ask");
    expect(markup).toContain("Ash Ketchum");
    expect(markup).toContain("Buyer reputation");
  });

  it("shows buyer reputation on offer match rows", () => {
    const markup = renderToString(<MarketplaceOfferMatchListPage data={{ items: [offer] }} />);

    expect(markup).toContain("Buyer reputation");
    expect(markup).toContain("4.6");
    expect(markup).toContain("(<!-- -->7<!-- -->)");
  });
});
