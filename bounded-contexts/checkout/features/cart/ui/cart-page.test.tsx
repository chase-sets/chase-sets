import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckoutCartPage } from "./cart-page";
import type { CheckoutCartLine } from "./contracts";

const cartLine: CheckoutCartLine = {
  buyer_account_id: "acc_buyer",
  line_id: "cart_line_1",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::condition:raw",
  item_language_code: "ja",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  item_image_url: "/fake-cdn/assets/charizard.png",
  item_image_loading_url: "/fake-cdn/assets/pokemon_tcg_back.png",
  item_image_loading_alt: "Pokemon card back",
  item_image_loading_srcset: "/fake-cdn/assets/pokemon_tcg_back.png 1x",
  selected_options: [{ dimensionId: "condition", optionId: "raw" }],
  product_summary: "Form: Raw | Condition: Near Mint",
  quantity: 2,
  fulfillment_mode: "optimize",
  locked_listing_id: null,
  seller_preference_id: null,
  availability_state: "available",
  seller_options: [
    {
      listing_id: "lst_card_vault",
      seller_account_id: "acc_card_vault",
      seller_slug: "card-vault",
      seller_display_name: "Card Vault",
      seller_average_rating: "4.90",
      seller_review_count: 12,
      price_amount: "389.00",
      available_quantity: 2,
      product_summary: "Form: Raw | Condition: Near Mint",
    },
    {
      listing_id: "lst_hobby_shop",
      seller_account_id: "acc_hobby_shop",
      seller_slug: "hobby-shop",
      seller_display_name: "Hobby Shop",
      seller_average_rating: null,
      seller_review_count: 0,
      price_amount: "395.00",
      available_quantity: 1,
      product_summary: "Form: Raw | Condition: Near Mint",
    },
  ],
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};

describe("checkout cart page", () => {
  it("presents cart totals as saved buyer intent before checkout creates purchases", () => {
    const markup = renderToString(<CheckoutCartPage cartLines={[cartLine]} />);

    expect(markup).toContain("Calculated during checkout");
    expect(markup).toContain("Ready for checkout");
    expect(markup).toContain("Buy cart status");
    expect(markup).toContain("Smart Match settings");
    expect(markup).toContain("Lowest total cost");
    expect(markup).toContain("Place offers for unavailable quantity");
    expect(markup).toContain("Products");
    expect(markup).toContain("Product-level lines let Chase Sets Smart Match listings during checkout");
    expect(markup).toContain("Shipping credit grows with same-seller cards");
    expect(markup).toContain("Listings earn 5% of item value toward shipping");
    expect(markup).toContain("Seller option");
    expect(markup).toContain('href="/accounts/card-vault#feedback"');
    expect(markup).toContain("4.9");
    expect(markup).toContain("New");
    expect(markup).toContain("No feedback yet");
    expect(markup).toContain("Card Vault - $389.00 - 2 available");
    expect(markup).toContain("Lock seller");
    expect(markup).toContain("Start checkout");
    expect(markup).not.toContain("Estimated total");
    expect(markup).not.toContain(">Pending<");
    expect(markup).not.toContain("Checkout cart");
  });

  it("groups duplicate product intent as one quantity-controlled cart line", () => {
    const duplicateLine: CheckoutCartLine = {
      ...cartLine,
      line_id: "cart_line_2",
      quantity: 3,
      updated_at: "2026-04-29T00:00:00.000Z",
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[cartLine, duplicateLine]} />);

    expect(markup).toContain('src="/fake-cdn/assets/charizard.png"');
    expect(markup).toContain("Charizard");
    expect(markup).toContain("Japanese");
    expect(markup).toContain("Base Set 4/102 Holo Rare");
    expect(markup).toContain(">Raw</span>");
    expect(markup).toContain(">Near Mint</span>");
    expect(markup).toContain('aria-label="Product options: Form Raw, Condition Near Mint"');
    expect(markup).not.toContain("Charizard | Base Set 4/102 Holo Rare");
    expect(markup).not.toContain("Form: Raw | Condition: Near Mint");
    expect(markup).toContain('value="5"');
    expect(markup).toContain('name="lineId" value="cart_line_1"');
    expect(markup).toContain('name="lineId" value="cart_line_2"');
    expect(markup).not.toContain("Catalog item:");
    expect(markup).not.toContain("cat_charizard");
  });

  it("shows locked, optimized, and unavailable recovery controls together", () => {
    const lockedLine: CheckoutCartLine = {
      ...cartLine,
      line_id: "cart_line_locked",
      fulfillment_mode: "locked-listing",
      locked_listing_id: "lst_card_vault",
    };
    const unavailableLine: CheckoutCartLine = {
      ...cartLine,
      line_id: "cart_line_unavailable",
      product_id: "cat_charizard::condition:played",
      product_summary: "Form: Raw | Condition: Played",
      availability_state: "waiting-for-supply",
      seller_options: [],
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[cartLine, lockedLine, unavailableLine]} />);

    expect(markup).toContain("Smart Match at checkout");
    expect(markup).toContain("Selected listings");
    expect(markup).toContain("Exact listings stay attached to this buy cart");
    expect(markup).toContain("Locked to seller - not reserved yet");
    expect(markup).toContain("Unlock seller");
    expect(markup).toContain("Waiting for supply");
    expect(markup).toContain("Make offer");
  });
});
