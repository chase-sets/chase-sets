// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
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
  it("renders a simple seller review with readiness and payout before checkout", () => {
    const markup = renderToString(
      <CheckoutSellListPage
        sellListLines={[selectedOfferLine, productLine]}
        payoutReadiness={{ status: "ready", missing_requirements: [] }}
        offerReviews={[
          {
            lineId: "sll_offer",
            status: "ready",
            terms: {
              basis_amount: "350.00",
              marketplace_sales_fee_unit_amount: "35.00",
              seller_net_unit_amount: "315.00",
              shipping_allowance_percentage_bps: 0,
              fee_quote_fingerprint: "fee_selected",
            },
            message: null,
          },
        ]}
        productOfferReviews={[
          {
            lineId: "sll_product",
            status: "ready",
            offers: [
              {
                offer: {
                  offer_id: "off_blastoise",
                  buyer_display_name: "Misty",
                  buyer_account_id: "acc_misty",
                  price_amount: "410.00",
                  quantity_requested: 1,
                  offer_to_listing_price_bps: 10200,
                  can_fulfill: true,
                },
                terms: {
                  marketplace_sales_fee_unit_amount: "41.00",
                  seller_net_unit_amount: "369.00",
                  fee_quote_fingerprint: "fee_product",
                },
              },
            ],
            message: null,
          },
        ]}
        inventoryItems={[
          {
            item_id: "inv_blastoise",
            product_id: productLine.product_id,
            item_title: "Blastoise",
            product_summary: "Raw / Near Mint",
            storage_location_name: "Home Vault",
            ship_from_code: "KS",
            available_quantity: 1,
          },
        ]}
      />,
    );

    expect(markup).toContain("Sell List");
    expect(markup).toContain("Review cards, payout readiness, and pre-checkout sale actions before seller checkout.");
    expect(markup).toContain("Ready for seller checkout");
    expect(markup).toContain("Review items");
    expect(markup).toContain("Selected offer");
    expect(markup).toContain("Product");
    expect(markup).toContain("Ash Ketchum");
    expect(markup).toContain("Use Misty offer");
    expect(markup).toContain("Expected seller payout");
    expect(markup).toContain("$999.00");
    expect(markup).toContain("Payout readiness");
    expect(markup).toContain("Line readiness");
    expect(markup).toContain("Continue to seller checkout");
    expect(markup).toContain('id="sell-list-checkout-form"');
    expect(markup).toContain('name="offerFeeQuoteFingerprint:sll_offer"');
    expect(markup).toContain('name="productOfferFeeQuoteFingerprint:sll_product:off_blastoise"');
    expect(markup).not.toContain("Execute sale checkout");
    expect(markup).not.toContain("Smart Match settings");
    expect(markup).not.toContain("Checkout owns the review step");
    expect(markup).not.toContain(">Execution<");
  });

  it("blocks seller checkout when payout or line readiness is unresolved", () => {
    const blockedProductLine: CheckoutSellListLineRow = {
      ...productLine,
      fallback_mode: "none",
      minimum_listing_price_amount: null,
    };

    const markup = renderToString(
      <CheckoutSellListPage
        sellListLines={[blockedProductLine]}
        payoutReadiness={{ status: "restricted", missing_requirements: ["bank account"] }}
        productOfferReviews={[
          {
            lineId: "sll_product",
            status: "unavailable",
            offers: [],
            message: "No ready matching offers are currently available.",
          },
        ]}
      />,
    );

    expect(markup).toContain("Some items need action");
    expect(markup).toContain("Resolve 1 line(s) before seller checkout starts.");
    expect(markup).toContain("Payout setup required");
    expect(markup).toContain("bank account");
    expect(markup).toContain("No ready Smart Match offers are available for this line.");
    expect(markup).toContain("Resolve items");
    expect(markup).toContain('href="/checkout/sell/readiness"');
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("Continue sale checkout to safely resume");
    expect(markup).not.toContain("provider diagnostics");
    expect(markup).not.toContain("settlement internals");
  });

  it("shows a simple empty Sell List recovery state", () => {
    const markup = renderToString(<CheckoutSellListPage sellListLines={[]} />);

    expect(markup).toContain("Your Sell List is empty");
    expect(markup).toContain("Add selected offers or products");
    expect(markup).toContain("Browse products");
    expect(markup).not.toContain("Expected seller payout");
    expect(markup).not.toContain("Continue to seller checkout");
  });

  it("shows guest selected-offer payout details through Reference Info without a fee fingerprint", () => {
    const guestSelectedOfferLine: CheckoutSellListLineRow = {
      ...selectedOfferLine,
      line_id: "sll_guest_offer",
      offer_price_amount: "380.00",
      quantity: 1,
    };

    const { container } = render(
      <CheckoutSellListPage
        isSignedIn={false}
        sellListLines={[guestSelectedOfferLine]}
        offerReviews={[
          {
            lineId: "sll_guest_offer",
            status: "ready",
            terms: {
              account_type: "personal",
              basis_amount: "380.00",
              marketplace_sales_fee_unit_amount: "34.35",
              seller_net_unit_amount: "345.65",
              shipping_allowance_percentage_bps: 500,
              source_kind: "public-standard-seller-terms",
              source_label: "Standard seller terms",
              schedule_label: "Personal Default",
              source_updated_at: "2026-04-01T00:00:00.000Z",
              resolved_at: "2026-04-28T00:00:00.000Z",
            },
            message: null,
          },
        ]}
      />,
    );

    expect(screen.getAllByText("$345.65").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Estimated payout is ready using current standard seller terms. Create an account to review final terms before committing.",
      ),
    ).toBeTruthy();
    expect(container.querySelector('input[name^="offerFeeQuoteFingerprint"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View estimated payout details" }));

    const dialog = screen.getByRole("dialog", { name: "Estimated payout" });
    expect(within(dialog).getByText("Estimated payout uses Standard seller terms.")).toBeTruthy();
    expect(within(dialog).getByText("Sales fee")).toBeTruthy();
    expect(within(dialog).getByText("$34.35")).toBeTruthy();
    expect(within(dialog).getByText("Shipping allowance")).toBeTruthy();
    expect(within(dialog).getByText("$19.00 (5%)")).toBeTruthy();
    expect(within(dialog).getByText("Terms source")).toBeTruthy();
    expect(within(dialog).getByText("Standard seller terms")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "This estimate uses public standard seller terms because no seller account is attached yet.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "After registration, Checkout refreshes seller-specific terms before any offer acceptance or sale commitment.",
      ),
    ).toBeTruthy();
  });

  it("uses a generic buyer label instead of raw account ids", () => {
    const lineWithoutPublicBuyerName: CheckoutSellListLineRow = {
      ...selectedOfferLine,
      buyer_account_id: "acc_private_buyer_id",
      buyer_display_name: null,
    };

    render(<CheckoutSellListPage sellListLines={[lineWithoutPublicBuyerName]} />);

    expect(screen.getAllByText("Buyer").length).toBeGreaterThan(0);
    expect(screen.queryByText("acc_private_buyer_id")).toBeNull();
  });
});
