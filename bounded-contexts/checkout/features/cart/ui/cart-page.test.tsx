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
  item_image_srcset: "/fake-cdn/assets/charizard.png 1x, /fake-cdn/assets/charizard@2x.png 2x",
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
  it("renders a Shopify-simple cart review without dense marketplace panels", () => {
    const markup = renderToString(<CheckoutCartPage cartLines={[cartLine]} />);

    expect(markup).toContain("Your cart");
    expect(markup).toContain("Review quantities and remove anything you do not want before checkout.");
    expect(markup).toContain("Charizard");
    expect(markup).toContain("Base Set 4/102 Holo Rare");
    expect(markup).toContain("Japanese");
    expect(markup).toContain(">Raw</span>");
    expect(markup).toContain(">Near Mint</span>");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Quantity");
    expect(markup).toContain("Decrease");
    expect(markup).toContain("Increase");
    expect(markup).toContain("Update");
    expect(markup).toContain("Remove");
    expect(markup).toContain("Subtotal");
    expect(markup).toContain("$778.00");
    expect(markup).toContain("Shipping and tax");
    expect(markup).toContain("Calculated at checkout");
    expect(markup).toContain("Taxes and shipping are calculated at checkout.");
    expect(markup).toContain("Check out");
    expect(markup).toContain('action="/checkout/start"');
    expect(markup).toContain('name="readinessSnapshotId"');
    expect(markup).toContain('name="readinessSourceRevision"');
    expect(markup).toContain('name="readinessDecisions"');
    expect(markup).not.toContain("Smart Match settings");
    expect(markup).not.toContain("Landed-cost preview");
    expect(markup).not.toContain("Shipping credit grows with same-seller cards");
    expect(markup).not.toContain("Seller option");
    expect(markup).not.toContain("Lock seller");
    expect(markup).not.toContain("Estimated checkout fee");
    expect(markup).not.toContain("Early landed-cost signal");
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
    expect(markup).toContain('srcSet="/fake-cdn/assets/charizard.png 1x, /fake-cdn/assets/charizard@2x.png 2x"');
    expect(markup).toContain('sizes="6rem"');
    expect(markup).toContain('value="5"');
    expect(markup).toContain('name="lineId" value="cart_line_1"');
    expect(markup).toContain('name="lineId" value="cart_line_2"');
    expect(markup).toContain("$1,945.00");
    expect(markup).not.toContain("Catalog item:");
    expect(markup).not.toContain("cat_charizard");
  });

  it("shows preferred listing context and a cart-side lock action", () => {
    const preferredLine: CheckoutCartLine = {
      ...cartLine,
      seller_preference_id: "lst_card_vault",
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[preferredLine]} />);

    expect(markup).toContain("Preferred listing");
    expect(markup).toContain(
      "Card Vault is the starting preference. Smart Match may choose another available listing.",
    );
    expect(markup).toContain("Lock this listing");
    expect(markup).toContain('value="lock-preferred-listing"');
    expect(markup).toContain('name="intent"');
    expect(markup).toContain('name="sellerPreferenceId" value="lst_card_vault"');
    expect(markup).not.toContain("Locked listing");
  });

  it("blocks checkout and hands unresolved fulfillment to readiness", () => {
    const unavailableLine: CheckoutCartLine = {
      ...cartLine,
      line_id: "cart_line_unavailable",
      product_id: "cat_charizard::condition:played",
      product_summary: "Form: Raw | Condition: Played",
      availability_state: "waiting-for-supply",
      seller_options: [],
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[unavailableLine]} />);

    expect(markup).toContain("Some items need attention");
    expect(markup).toContain("1 item needs fulfillment or availability resolved before checkout.");
    expect(markup).toContain("Waiting for supply");
    expect(markup).toContain("Resolve this item before checkout or remove it from your cart.");
    expect(markup).toContain("Find alternatives");
    expect(markup).toContain('href="/search?q=Charizard"');
    expect(markup).toContain("Resolve items");
    expect(markup).toContain('href="/checkout/buy/readiness"');
    expect(markup).toContain("Resolve item availability before payment starts.");
    expect(markup).not.toContain('action="/checkout/start"');
    expect(markup).not.toContain("Check out");
  });

  it("offers optional fulfillment savings before checkout starts", () => {
    const expensiveLine: CheckoutCartLine = {
      ...cartLine,
      fulfillment_mode: "locked-listing",
      locked_listing_id: "lst_hobby_shop",
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
          available_quantity: 2,
          product_summary: "Form: Raw | Condition: Near Mint",
        },
      ],
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[expensiveLine]} />);

    expect(markup).toContain("Save $12.00 before checkout");
    expect(markup).toContain(
      "You can keep your current fulfillment or use the lower-cost option before checkout begins.",
    );
    expect(markup).toContain("Use lower price");
    expect(markup).toContain("&quot;decision&quot;:&quot;accepted&quot;");
    expect(markup).toContain("&quot;decision&quot;:&quot;declined&quot;");
    expect(markup).not.toContain("allocation");
  });

  it("shows a simple empty-cart recovery state", () => {
    const markup = renderToString(<CheckoutCartPage cartLines={[]} />);

    expect(markup).toContain("Your buy cart is empty");
    expect(markup).toContain("Browse the marketplace and add a product to start building a Buy Cart checkout.");
    expect(markup).toContain(
      "When you add items, checkout will show final shipping, tax, and payment details before you pay.",
    );
    expect(markup).toContain("Keep shopping");
    expect(markup).not.toContain("Subtotal");
    expect(markup).not.toContain("Check out");
  });
});
