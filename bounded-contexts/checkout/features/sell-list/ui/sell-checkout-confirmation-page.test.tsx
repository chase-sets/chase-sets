// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckoutSellListConfirmationRow } from "../read-model/queries";
import { SellCheckoutConfirmationPage } from "./sell-checkout-confirmation-page";

afterEach(cleanup);

function factsForRowTitle(title: string) {
  const titleNode = screen.getByText(title);
  const rowContent = titleNode.parentElement as HTMLElement;
  const factsContainer = rowContent.querySelector(".mt-1.flex");
  return Array.from(factsContainer?.children ?? []).map((node) => node.textContent);
}

function priceColumnCountForRowTitle(title: string) {
  const titleNode = screen.getByText(title);
  const row = titleNode.closest(".grid") as HTMLElement;
  return row.children.length;
}

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

    expect(markup).toContain("Sale review saved");
    expect(markup).toContain("CS-SL-CHK_SELL_1");
    expect(markup).not.toContain("slc_chk_sell_1");
    expect(markup).toContain("Support reference");
    expect(markup).toContain("Your reviewed sale actions are saved");
    expect(markup).toContain("Sale actions");
    expect(markup).toContain("Use this reference if any next step needs help.");
    expect(markup).not.toContain("Marketplace handoff");
    expect(markup).not.toContain("Support can track");
    expect(markup).not.toContain("downstream work");
    expect(markup).toContain("Acerola&#x27;s Mischief");
    expect(markup).toContain("Mixed");
    expect(markup).toContain("Partial");
    expect(markup).toContain("Accepted offers");
    expect(markup).toContain("Listings published");
    expect(markup).toContain("View seller activity");
    expect(markup).toContain("View sales");
    expect(markup).not.toContain("Sale complete");
    expect(markup).not.toContain("Label ready");
    expect(markup).not.toContain("Payout ready");
    expect(markup).not.toContain("Settlement complete");
    expect(markup).not.toContain("Account history updated");
  });
});

type LineOutcome = NonNullable<CheckoutSellListConfirmationRow["handoff_summary"]["lineOutcomes"]>[number];

function confirmationWithLineOutcomes(lineOutcomes: readonly LineOutcome[]): CheckoutSellListConfirmationRow {
  return {
    ...confirmation,
    handoff_summary: {
      ...confirmation.handoff_summary,
      lineOutcomes,
    },
  };
}

describe("sell checkout confirmation page line status placement (#7183)", () => {
  const sixStateOutcomes: readonly LineOutcome[] = [
    {
      lineId: "l1",
      itemTitle: "Completed zero remaining",
      status: "completed",
      action: "accepted-offer",
      quantity: 1,
      remainingQuantity: 0,
      detail: "Completed zero remaining detail.",
    },
    {
      lineId: "l2",
      itemTitle: "Completed positive remaining",
      status: "completed",
      action: "accepted-offer",
      quantity: 3,
      remainingQuantity: 1,
      detail: "Completed positive remaining detail.",
    },
    {
      lineId: "l3",
      itemTitle: "Partial zero remaining",
      status: "partial",
      action: "mixed",
      quantity: 4,
      remainingQuantity: 0,
      detail: "Partial zero remaining detail.",
    },
    {
      lineId: "l4",
      itemTitle: "Partial positive remaining",
      status: "partial",
      action: "mixed",
      quantity: 4,
      remainingQuantity: 2,
      detail: "Partial positive remaining detail.",
    },
    {
      lineId: "l5",
      itemTitle: "Skipped zero remaining",
      status: "skipped",
      action: "kept-in-sell-list",
      quantity: 2,
      remainingQuantity: 0,
      detail: "Skipped zero remaining detail.",
    },
    {
      lineId: "l6",
      itemTitle: "Skipped positive remaining",
      status: "skipped",
      action: "kept-in-sell-list",
      quantity: 2,
      remainingQuantity: 2,
      detail: "Skipped positive remaining detail.",
    },
  ];

  it("omits price and renders each row's own status exactly once in the frozen facts order across the six-state matrix", () => {
    render(<SellCheckoutConfirmationPage confirmation={confirmationWithLineOutcomes(sixStateOutcomes)} />);

    expect(factsForRowTitle("Completed zero remaining")).toEqual(["Accepted offer", "Completed"]);
    expect(factsForRowTitle("Completed positive remaining")).toEqual(["Accepted offer", "Completed", "Remaining"]);
    expect(factsForRowTitle("Partial zero remaining")).toEqual(["Mixed", "Partial"]);
    expect(factsForRowTitle("Partial positive remaining")).toEqual(["Mixed", "Partial", "Remaining"]);
    expect(factsForRowTitle("Skipped zero remaining")).toEqual(["Kept in Sell List", "Skipped"]);
    expect(factsForRowTitle("Skipped positive remaining")).toEqual(["Kept in Sell List", "Skipped", "Remaining"]);

    for (const outcome of sixStateOutcomes) {
      expect(priceColumnCountForRowTitle(outcome.itemTitle)).toBe(2);
    }
  });

  it("does not restore the remainder-derived Completed fact on a zero-remaining partial or skipped row", () => {
    render(
      <SellCheckoutConfirmationPage
        confirmation={confirmationWithLineOutcomes([sixStateOutcomes[2], sixStateOutcomes[4]])}
      />,
    );

    expect(factsForRowTitle("Partial zero remaining")).not.toContain("Completed");
    expect(factsForRowTitle("Skipped zero remaining")).not.toContain("Completed");
  });

  it("keeps a zero-remaining completed row's own status exactly once, not twice", () => {
    render(<SellCheckoutConfirmationPage confirmation={confirmationWithLineOutcomes([sixStateOutcomes[0]])} />);

    const facts = factsForRowTitle("Completed zero remaining");
    expect(facts.filter((fact) => fact === "Completed")).toHaveLength(1);
  });
});
