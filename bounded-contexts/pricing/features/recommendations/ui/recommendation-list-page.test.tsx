import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AccountRecommendationListItem } from "../read-model/queries";
import { PricingRecommendationListPage } from "./recommendation-list-page";

const recommendation = {
  recommendation_id: "rec_1",
  catalog_catalog_item_id: "cat_1",
  seller_account_id: "acc_1",
  catalog_item_title: "Charizard ex",
  catalog_item_subtitle: "Obsidian Flames",
  catalog_item_status: "active",
  market_price_amount: 20,
  market_currency: "USD",
  market_observed_at: "2026-05-09T00:00:00.000Z",
  recommended_list_amount: 22,
  recommendation_reason: "Protect margin.",
  recommendation_published_at: "2026-05-09T00:01:00.000Z",
  stock_on_hand_quantity: 4,
  stock_reserved_quantity: 1,
  active_listing_count: 3,
  lowest_listing_price_amount: 18,
  active_offer_count: 2,
  highest_offer_price_amount: 19,
  committed_order_quantity: 5,
  delivered_quantity: 4,
  returned_quantity: 1,
  updated_at: "2026-05-09T00:02:00.000Z",
} satisfies AccountRecommendationListItem;

describe("PricingRecommendationListPage", () => {
  it("renders advisory recommendation feed signals without active listing mutation controls", () => {
    const html = renderToString(
      <PricingRecommendationListPage recommendations={[recommendation]} />,
    );

    expect(html).toContain("Pricing recommendations are advisory.");
    expect(html).toContain("Charizard ex");
    expect(html).toContain("$20.00");
    expect(html).toContain("$22.00");
    expect(html).toContain("Lowest active: $18.00");
    expect(html).toContain("Offers: 2; Highest: $19.00");
    expect(html).toContain("Delivered: 4; Returned: 1");
    expect(html).toContain("Reserved: 1");
    expect(html).toContain("Use in draft");
    expect(html).toContain("/account/listings?catalogItemId=cat_1&amp;recommendedPrice=22");
    expect(html).not.toContain("Publish listing");
  });
});
