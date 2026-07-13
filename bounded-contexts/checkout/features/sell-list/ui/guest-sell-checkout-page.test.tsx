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
  listing_id: "lst_1",
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
    status: "ready",
    evidenceRevision: "slr_seller_evidence",
    payout: "ready",
    shipFrom: "ready",
    label: "ready",
    conditionReview: "ready",
    risk: "ready",
    provider: "ready",
    freshness: "ready",
    outcomes: [
      { dimension: "ship-from", status: "ready", reason: "ready" },
      { dimension: "payout", status: "ready", reason: "ready" },
      { dimension: "label", status: "ready", reason: "ready" },
      { dimension: "condition-review", status: "ready", reason: "ready" },
      { dimension: "risk", status: "ready", reason: "ready" },
      { dimension: "provider", status: "ready", reason: "ready" },
      { dimension: "freshness", status: "ready", reason: "ready" },
    ],
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
    expect(markup).toContain("Continue to account setup");
    expect(markup).toContain("Acerola&#x27;s Mischief");
    expect(markup).toContain("$38.00");
    expect(markup).toContain('id="guest-sell-checkout-form"');
    expect(markup).toContain('name="readinessSnapshotId"');
    expect(markup).toContain("You are only reviewing these sale details.");
    expect(markup).toContain("Checkout policies");
    expect(markup).toContain("Terms of service");
    expect(markup).toContain('href="/terms"');
    expect(markup).toContain("Privacy policy");
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain("Refunds and returns");
    expect(markup).toContain('href="/refunds-and-returns"');
    expect(markup).toContain("Guest seller contact and ship-from details are used");
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
    expect(markup).toContain("Continue to account setup");
  });

  it("keeps guest seller checkout registration-first without confirmation chrome", () => {
    const markup = renderToString(
      <GuestSellCheckoutPage
        sessionId="chk_sell_1"
        lines={[selectedOfferLine]}
        readiness={readyReadiness}
        recovery={null}
        defaultValues={guestSellCheckoutDefaultValues}
      />,
    );

    expect(markup).toContain("Final sale steps come after account setup.");
    expect(markup).toContain("Continue to account setup");
    expect(markup).not.toContain("Sale review ready");
    expect(markup).not.toContain("Sale review saved");
    expect(markup).not.toContain("Support reference");
    expect(markup).not.toContain("Review reference");
    expect(markup).not.toContain("execution receipt");
  });
});
