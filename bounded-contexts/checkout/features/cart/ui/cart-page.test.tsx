import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckoutCartPage } from "./cart-page";
import type { CheckoutCartLine } from "./contracts";

const cartLine: CheckoutCartLine = {
  buyer_account_id: "acc_buyer",
  line_id: "cart_line_1",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::condition:raw",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [{ dimensionId: "condition", optionId: "raw" }],
  product_summary: "Raw / Near Mint",
  quantity: 2,
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};

describe("checkout cart page", () => {
  it("presents cart totals as saved buyer intent before checkout creates purchases", () => {
    const markup = renderToString(<CheckoutCartPage cartLines={[cartLine]} />);

    expect(markup).toContain("Calculated during checkout");
    expect(markup).toContain("Ready for checkout");
    expect(markup).toContain("Cart status");
    expect(markup).toContain("Shipping credit grows with same-seller cards");
    expect(markup).toContain("Listings earn 5% of item value toward shipping");
    expect(markup).toContain("Start checkout");
    expect(markup).not.toContain("Estimated total");
    expect(markup).not.toContain(">Pending<");
    expect(markup).not.toContain("Checkout cart");
  });
});
