import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckoutSellListPage } from "./sell-list-page";
import type { CheckoutSellListLineRow } from "../read-model/queries";

const selectedOfferLine: CheckoutSellListLineRow = {
  seller_account_id: "acc_seller",
  line_id: "sll_offer",
  line_type: "selected-offer",
  offer_id: "off_charizard",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Ash Ketchum",
  offer_price_amount: "350.00",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::condition:raw",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [{ dimensionId: "condition", optionId: "raw" }],
  product_summary: "Raw / Near Mint",
  quantity: 2,
  fallback_mode: "none",
  minimum_listing_price_amount: null,
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};

const productLine: CheckoutSellListLineRow = {
  ...selectedOfferLine,
  line_id: "sll_product",
  line_type: "product",
  offer_id: null,
  buyer_account_id: null,
  buyer_display_name: null,
  offer_price_amount: null,
  quantity: 1,
  fallback_mode: "create-listing",
  minimum_listing_price_amount: "399.00",
};

describe("checkout sell list page", () => {
  it("presents sell list review as checkout-owned seller execution", () => {
    const markup = renderToString(<CheckoutSellListPage sellListLines={[selectedOfferLine, productLine]} />);

    expect(markup).toContain("Sell List");
    expect(markup).toContain("Buyer payment already authorized by offer");
    expect(markup).toContain("Selected offers");
    expect(markup).toContain("Ash Ketchum");
    expect(markup).toContain("Accept selected offer during checkout review");
    expect(markup).toContain("Sale checkout confidence");
    expect(markup).toContain("Payout readiness");
    expect(markup).toContain("Fallback listing floor");
    expect(markup).toContain("Smart Match offers for");
    expect(markup).toContain("Checkout owns the review step");
    expect(markup).toContain("Review sale checkout");
  });

  it("confirms when sale checkout review is recorded", () => {
    const markup = renderToString(<CheckoutSellListPage sellListLines={[]} reviewCompleted />);

    expect(markup).toContain("Sale checkout review recorded");
    expect(markup).toContain("cleared the Sell List items");
  });
});
