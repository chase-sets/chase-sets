import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CheckoutSellListConfirmationRow } from "../read-model/queries";
import { SellCheckoutConfirmationPage } from "./sell-checkout-confirmation-page";

const confirmation: CheckoutSellListConfirmationRow = {
  seller_account_id: "acc_seller",
  confirmation_id: "slc_chk_sell_1",
  confirmed_at: "2026-06-10T00:00:00.000Z",
  readiness_evidence: {},
  seller_evidence: {},
  handoff_summary: {
    acceptedOfferCount: 1,
    publishedListingCount: 1,
    skippedLineCount: 0,
    skippedReasons: [],
    lineOutcomes: [
      {
        lineId: "sll_product",
        itemTitle: "Acerola's Mischief",
        status: "partial",
        action: "mixed",
        quantity: 4,
        remainingQuantity: 2,
        detail: "Acerola's Mischief: some quantity remains in your Sell List.",
        references: {
          offerIds: ["off_1"],
          listingId: "lst_1",
        },
      },
    ],
    sideEffects: {
      sale: "handoff-recorded",
      label: "pending-downstream",
      payout: "pending-downstream",
      settlement: "pending-downstream",
      notification: "pending-downstream",
      accountHistory: "pending-downstream",
    },
  },
};

describe("sell checkout confirmation page", () => {
  it("renders a reloadable seller confirmation with support-safe handoff copy", () => {
    const markup = renderToString(<SellCheckoutConfirmationPage confirmation={confirmation} />);

    expect(markup).toContain("Sale review ready");
    expect(markup).toContain("CS-SL-CHK_SELL_1");
    expect(markup).not.toContain("slc_chk_sell_1");
    expect(markup).toContain("Support reference");
    expect(markup).toContain("Your sale confirmation was recorded");
    expect(markup).toContain("Sale actions");
    expect(markup).toContain("Support can track pending or failed next steps from this confirmation.");
    expect(markup).not.toContain("Marketplace handoff");
    expect(markup).not.toContain("downstream work");
    expect(markup).toContain("Acerola&#x27;s Mischief");
    expect(markup).toContain("Mixed");
    expect(markup).toContain("Partial");
    expect(markup).toContain("Accepted offers");
    expect(markup).toContain("Listings published");
    expect(markup).toContain("View seller activity");
    expect(markup).toContain("View committed sales");
    expect(markup).not.toContain("Sale complete");
    expect(markup).not.toContain("Label ready");
    expect(markup).not.toContain("Payout ready");
    expect(markup).not.toContain("Settlement complete");
    expect(markup).not.toContain("Account history updated");
  });
});
