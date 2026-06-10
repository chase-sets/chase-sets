import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  GuestSellCheckoutPage,
  guestSellCheckoutDefaultValues,
  type GuestSellCheckoutActionState,
} from "./guest-sell-checkout-page";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import type { SellListReadinessSnapshot } from "../domain/readiness";

const selectedOfferLine: CheckoutSellListLineRow = {
  seller_account_id: "anon_sell_1",
  line_id: "sll_1",
  line_type: "selected-offer",
  offer_id: "off_1",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Buyer",
  offer_price_amount: "38.00",
  catalog_catalog_item_id: "cat_1",
  product_id: "prod_1",
  item_title: "Acerola's Mischief",
  item_subtitle: "Raw / Damaged",
  selected_options: [{ dimensionId: "Condition", optionId: "Damaged" }],
  product_summary: "Raw card",
  quantity: 1,
  fallback_mode: "none",
  minimum_listing_price_amount: null,
  created_at: "2026-06-10T00:00:00.000Z",
  updated_at: "2026-06-10T00:00:00.000Z",
};

const readyReadiness: SellListReadinessSnapshot = {
  schemaVersion: "checkout.sell-list-readiness.v1",
  source: "sell-list",
  sourceRevision: "slr_source",
  snapshotId: "slr_ready",
  status: "ready",
  lineCount: 1,
  includedLineIds: ["sll_1"],
  unresolvedLineIds: [],
  lineOutcomes: [{ lineId: "sll_1", outcome: "checkout", reason: "ready", action: "selected-offer" }],
  sellerReadiness: {
    payout: "not-evaluated",
    shipFrom: "not-evaluated",
    label: "not-evaluated",
  },
  customerSafeFacts: ["Ready for seller checkout."],
};

describe("guest sell checkout page", () => {
  it("renders the form-first guest seller checkout shell with summary and sticky action", () => {
    const markup = renderToString(
      <GuestSellCheckoutPage
        sessionId="chk_sell_1"
        lines={[selectedOfferLine]}
        readiness={readyReadiness}
        recovery={null}
        defaultValues={guestSellCheckoutDefaultValues}
      />,
    );

    expect(markup).toContain("Review sale checkout");
    expect(markup).toContain("Sale summary");
    expect(markup).toContain("Contact");
    expect(markup).toContain("Ship from");
    expect(markup).toContain("Payout");
    expect(markup).toContain("Label");
    expect(markup).toContain("Review sale intent");
    expect(markup).toContain("Acerola&#x27;s Mischief");
    expect(markup).toContain("$38.00");
    expect(markup).toContain('id="guest-sell-checkout-form"');
    expect(markup).toContain('name="readinessSnapshotId"');
    expect(markup).toContain("This page records a guest review state only.");
    expect(markup).not.toContain("provider diagnostics");
    expect(markup).not.toContain("settlement internals");
  });

  it("renders readiness recovery before checkout form work starts", () => {
    const markup = renderToString(
      <GuestSellCheckoutPage
        sessionId="chk_sell_1"
        lines={[selectedOfferLine]}
        readiness={readyReadiness}
        recovery={{ kind: "readiness-stale" }}
        defaultValues={guestSellCheckoutDefaultValues}
      />,
    );

    expect(markup).toContain("Sell List changed");
    expect(markup).toContain("Refresh the Sell List review so payout and sale facts are current.");
    expect(markup).toContain("Review Sell List");
    expect(markup).toContain("disabled");
  });

  it("renders inline action errors without replacing the simple checkout page", () => {
    const actionState: GuestSellCheckoutActionState = {
      status: "error",
      values: {
        ...guestSellCheckoutDefaultValues,
        sellerName: "Jane Seller",
        email: "",
      },
      fieldErrors: {
        email: "Enter a valid email address.",
        form: "The payout estimate changed. Return to the Sell List and refresh the review.",
      },
    };

    const markup = renderToString(
      <GuestSellCheckoutPage
        sessionId="chk_sell_1"
        lines={[selectedOfferLine]}
        readiness={readyReadiness}
        recovery={null}
        defaultValues={guestSellCheckoutDefaultValues}
        actionState={actionState}
      />,
    );

    expect(markup).toContain("Fix seller checkout details");
    expect(markup).toContain("The payout estimate changed.");
    expect(markup).toContain("Enter a valid email address.");
    expect(markup).toContain("Review sale intent");
  });

  it("renders a confirmation handoff that states side effects have not started", () => {
    const actionState: GuestSellCheckoutActionState = {
      status: "confirmed",
      values: {
        ...guestSellCheckoutDefaultValues,
        sellerName: "Jane Seller",
        email: "jane@example.com",
      },
      confirmation: {
        referenceId: "guest-sell-chk_sell_1",
        sellerName: "Jane Seller",
        estimatedTotal: "$38.00",
        sideEffects: {
          label: "not-attempted",
          payout: "not-attempted",
          sale: "not-attempted",
          notification: "not-attempted",
          accountHistory: "not-attempted",
        },
      },
    };

    const markup = renderToString(
      <GuestSellCheckoutPage
        sessionId="chk_sell_1"
        lines={[selectedOfferLine]}
        readiness={readyReadiness}
        recovery={null}
        defaultValues={guestSellCheckoutDefaultValues}
        actionState={actionState}
      />,
    );

    expect(markup).toContain("Sale review ready");
    expect(markup).toContain("guest-sell-chk_sell_1");
    expect(markup).toContain("No seller-committing side effects have started.");
    expect(markup).toContain("Sale, payout, label, notification, and account-history work stay pending.");
    expect(markup).toContain("Create account");
  });
});
