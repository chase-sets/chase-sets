import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignedInSellCheckoutPage, signedInSellCheckoutDefaultValues } from "./signed-in-sell-checkout-page";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import type { SellListReadinessSnapshot } from "../domain/readiness";

const selectedOfferLine: CheckoutSellListLineRow = {
  seller_account_id: "acc_seller",
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
    listingEvidence: "ready",
    risk: "ready",
    provider: "ready",
    freshness: "ready",
    outcomes: [
      { dimension: "ship-from", status: "ready", reason: "ready" },
      { dimension: "payout", status: "ready", reason: "ready" },
      { dimension: "label", status: "ready", reason: "ready" },
      { dimension: "listing-evidence", status: "ready", reason: "ready" },
      { dimension: "risk", status: "ready", reason: "ready" },
      { dimension: "provider", status: "ready", reason: "ready" },
      { dimension: "freshness", status: "ready", reason: "ready" },
    ],
  },
  customerSafeFacts: ["Ready for seller checkout."],
};

const savedShipFromAddress = {
  shippingAddressId: "adr_seller",
  label: "Warehouse",
  name: "Jane Seller",
  company: "",
  line1: "100 Market Street",
  line2: "",
  city: "Wichita",
  state: "KS",
  postalCode: "67202",
  country: "US",
  phone: "316-555-0110",
  email: "seller@example.com",
  isDefault: true,
};

const payoutSummary = {
  status: "ready" as const,
  displayLabel: "Saved payout setup",
  supportingText: "Ready for seller payout after sale verification.",
  missingRequirements: [],
};

const sellListReviewPlan = '{"version":1,"lines":[{"lineId":"sll_1","lineType":"selected-offer"}]}';

const defaultValues = {
  ...signedInSellCheckoutDefaultValues,
  sellerName: "Jane Seller",
  email: "seller@example.com",
  phone: "316-555-0110",
  shipFromAddressId: "adr_seller",
  shipFromName: "Jane Seller",
  shipFromLine1: "100 Market Street",
  shipFromCity: "Wichita",
  shipFromState: "KS",
  shipFromPostalCode: "67202",
  shipFromCountry: "US",
};

describe("signed-in sell checkout page", () => {
  it("renders concise saved seller checkout rows with summary and sticky action", () => {
    const markup = renderToString(
      <SignedInSellCheckoutPage
        sessionId="chk_sell_1"
        lines={[selectedOfferLine]}
        readiness={readyReadiness}
        recovery={null}
        defaultValues={defaultValues}
        savedShipFromAddresses={[savedShipFromAddress]}
        payoutSummary={payoutSummary}
        readinessDecisions='{"lineActions":[{"lineId":"sll_1","action":"selected-offer"}],"lineOutcomes":[]}'
        sellListReviewPlan={sellListReviewPlan}
      />,
    );

    expect(markup).toContain("Seller checkout details");
    expect(markup).toContain("seller@example.com");
    expect(markup).toContain("Sale and label updates / 316-555-0110");
    expect(markup).toContain("Ship from");
    expect(markup).toContain("100 Market Street, Wichita, KS 67202, US");
    expect(markup).toContain("Saved payout setup");
    expect(markup).toContain("Seller account ready");
    expect(markup).toContain("Prepare a prepaid label");
    expect(markup).toContain("Review sale details");
    expect(markup).not.toContain("Review sale handoff");
    expect(markup).toContain(
      "Offers, listings, labels, payout, notifications, and seller history wait until you confirm",
    );
    expect(markup).not.toContain("side effect");
    expect(markup).toContain("Checkout policies");
    expect(markup).toContain("Terms of service");
    expect(markup).toContain('href="/terms"');
    expect(markup).toContain("Privacy policy");
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain("Refunds and returns");
    expect(markup).toContain('href="/refunds-and-returns"');
    expect(markup).not.toContain("Guest seller contact and ship-from details are used");
    expect(markup).not.toContain("provider diagnostics");
    expect(markup).not.toContain("settlement internals");
  });

  it("opens focused edit sections and preserves hidden saved values", () => {
    const markup = renderToString(
      <SignedInSellCheckoutPage
        sessionId="chk_sell_1"
        lines={[selectedOfferLine]}
        readiness={readyReadiness}
        recovery={null}
        defaultValues={defaultValues}
        savedShipFromAddresses={[savedShipFromAddress]}
        payoutSummary={payoutSummary}
        readinessDecisions='{"lineActions":[],"lineOutcomes":[]}'
        sellListReviewPlan={sellListReviewPlan}
        initialEditSection="ship-from"
      />,
    );

    expect(markup).toContain("Saved ship-from address");
    expect(markup).toContain("Address line 1");
    expect(markup).toContain('name="email"');
    expect(markup).toContain('value="seller@example.com"');
    expect(markup).toContain('name="sellListReviewPlan"');
  });

  it("falls back to the ship-from form when saved ship-from is incomplete", () => {
    const markup = renderToString(
      <SignedInSellCheckoutPage
        sessionId="chk_sell_1"
        lines={[selectedOfferLine]}
        readiness={readyReadiness}
        recovery={null}
        defaultValues={{ ...defaultValues, shipFromLine1: "" }}
        savedShipFromAddresses={[{ ...savedShipFromAddress, line1: "" }]}
        payoutSummary={payoutSummary}
        readinessDecisions='{"lineActions":[],"lineOutcomes":[]}'
        sellListReviewPlan={sellListReviewPlan}
      />,
    );

    expect(markup).toContain("Address line 1");
    expect(markup).not.toContain("100 Market Street, Wichita, KS 67202, US");
  });

  it("renders readiness recovery before signed-in checkout work starts", () => {
    const markup = renderToString(
      <SignedInSellCheckoutPage
        sessionId="chk_sell_1"
        lines={[selectedOfferLine]}
        readiness={readyReadiness}
        recovery={{ kind: "readiness-stale" }}
        defaultValues={defaultValues}
        savedShipFromAddresses={[savedShipFromAddress]}
        payoutSummary={payoutSummary}
        readinessDecisions='{"lineActions":[],"lineOutcomes":[]}'
        sellListReviewPlan={sellListReviewPlan}
      />,
    );

    expect(markup).toContain("Sell List changed");
    expect(markup).toContain("Refresh the Sell List review so payout and sale facts are current.");
    expect(markup).toContain("Review Sell List");
    expect(markup).toContain("disabled");
  });
});
