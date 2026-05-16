import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketplaceOfferMatchListPage } from "./offer-match-list-page";
import type { OfferMatchListItem } from "./contracts";
import type { MarketplaceListingTermsPreview } from "../../listings/ui/contracts";

const offer: OfferMatchListItem = {
  offer_id: "off_1",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Ash Ketchum",
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
  in_sell_list: true,
};

const terms: MarketplaceListingTermsPreview = {
  account_type: "business",
  basis_amount: "20.00",
  marketplace_sales_fee_unit_amount: "1.00",
  seller_net_unit_amount: "19.00",
  shipping_allowance_percentage_bps: 500,
  schedule_id: "cts_launch",
  agreement_id: null,
  resolved_at: "2026-04-28T00:00:00.000Z",
  fee_quote_fingerprint: "terms-fingerprint",
};

describe("MarketplaceOfferMatchListPage", () => {
  it("explains the seller shipping allowance on sell-list offer batches", () => {
    const markup = renderToString(
      <MarketplaceOfferMatchListPage
        data={{ items: [offer] }}
        cartData={{ items: [offer] }}
        cartTermsByOfferId={{ [offer.offer_id]: terms }}
      />,
    );

    expect(markup).toContain("Seller shipping allowance");
    expect(markup).toContain("Queue multiple offers from the same buyer");
    expect(markup).toContain("Shipping allowance: 5% of accepted offer value");
    expect(markup).toContain("Listing price: $22.00");
    expect(markup).toContain("Offer is 90.91% of ask");
  });

  it("shows listing price next to the best offer so sellers can judge the gap", () => {
    const markup = renderToString(
      <MarketplaceOfferMatchListPage
        data={{ items: [offer] }}
        cartData={{ items: [] }}
      />,
    );

    expect(markup).toContain("Best Offer Matches");
    expect(markup).toContain("Your Listing");
    expect(markup).toContain("$22.00");
    expect(markup).toContain("$20.00");
    expect(markup).toContain("$2.00 below ask");
  });
});
