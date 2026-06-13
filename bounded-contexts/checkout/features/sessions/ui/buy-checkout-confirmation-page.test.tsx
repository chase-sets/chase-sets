import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CheckoutSessionRow } from "../../../support/request-support/api-client";
import { BuyCheckoutConfirmationPage } from "./buy-checkout-confirmation-page";

const session: CheckoutSessionRow = {
  session_id: "chk_1",
  buyer_account_id: "acc_buyer",
  source_type: "cart",
  optimization_goal: "lowest-total",
  fulfillment_preview_revision: "rev_1",
  shipping_option: "standard",
  shipping_address_id: null,
  shipping_address: null,
  lines: [
    {
      listingId: "lst_1",
      cartLineId: "cart_line_1",
      catalogItemId: "cat_1",
      productId: "prd_1",
      itemTitle: "Test card",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: "Raw",
      quantity: 2,
    },
  ],
  order_ids: ["ord_1", "ord_2"],
  payment_id: "pay_1",
  submitted_offer_id: null,
  split_group_handoff: {
    status: "ready",
    supportReference: "CS-CR_READY",
    groups: [
      {
        groupId: "csg_card_vault",
        lineIds: ["cart_line_1"],
        listingIds: ["lst_1"],
        sellerAccountId: "acc_seller",
        sellerDisplayName: "Card Vault",
        itemCount: 2,
        packageCount: 1,
        deliveryPromise: "Estimated delivery 5-8 days after purchase",
        shippingAmount: null,
        supportReference: "CSG-CARDVAULT",
        downstreamReferenceStatus: "not-started",
      },
    ],
  },
  created_at: "2026-06-10T00:00:00.000Z",
  updated_at: "2026-06-10T00:00:00.000Z",
};

describe("buy checkout confirmation page", () => {
  it("renders a buyer handoff without implying downstream completion", () => {
    const markup = renderToString(
      <BuyCheckoutConfirmationPage session={session} paymentPath="/account/payments/pay_1" />,
    );

    expect(markup).toContain("Checkout received");
    expect(markup).toContain("Payment ready");
    expect(markup).toContain("Payment reference");
    expect(markup).toContain("pay_1");
    expect(markup).toContain("Order reference");
    expect(markup).toContain("ord_1, ord_2");
    expect(markup).toContain("Support reference");
    expect(markup).toContain("CS-CR_READY");
    expect(markup).toContain("Downstream details pending");
    expect(markup).toContain("Continue to payment");
    expect(markup).toContain('href="/account/payments/pay_1"');
    expect(markup).not.toContain("Sale complete");
    expect(markup).not.toContain("Label ready");
    expect(markup).not.toContain("Payout ready");
    expect(markup).not.toContain("provider payload");
  });
});
