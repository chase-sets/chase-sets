import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketplaceSubmittedOfferDetailPage } from "./submitted-offer-detail-page";
import { MarketplaceSubmittedOfferListPage } from "./submitted-offer-list-page";
import type { SubmittedOfferDetail } from "./contracts";

const acceptedOffer: SubmittedOfferDetail = {
  offer_id: "off_1",
  buyer_account_id: "acc_buyer",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::condition:raw",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [{ dimensionId: "condition", optionId: "raw" }],
  product_summary: "Raw / Near Mint",
  shipping_destination_snapshot: {
    name: "Ash Ketchum",
    company: null,
    line1: "100 Market Street",
    line2: null,
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
    phone: null,
    email: null,
  },
  price_amount: "20.00",
  quantity_requested: 1,
  status: "accepted",
  accepted_seller_account_id: "acc_seller",
  accepted_seller_average_rating: "4.80",
  accepted_seller_review_count: 12,
  accepted_at: "2026-04-28T01:00:00.000Z",
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T01:00:00.000Z",
};

describe("submitted offer reputation", () => {
  it("shows accepted seller reputation on submitted offer details", () => {
    const markup = renderToString(<MarketplaceSubmittedOfferDetailPage offer={acceptedOffer} />);

    expect(markup).toContain("Seller reputation");
    expect(markup).toContain("4.8");
    expect(markup).toContain("(<!-- -->12<!-- -->)");
  });

  it("shows accepted seller reputation on submitted offer rows", () => {
    const markup = renderToString(<MarketplaceSubmittedOfferListPage data={{ items: [acceptedOffer] }} />);

    expect(markup).toContain("Seller reputation");
    expect(markup).toContain("4.8");
    expect(markup).toContain("(<!-- -->12<!-- -->)");
  });
});
