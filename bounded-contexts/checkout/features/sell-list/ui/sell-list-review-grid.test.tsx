// @vitest-environment jsdom
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import { CheckoutSellListPage } from "./sell-list-page";
import type { SellListOfferReview } from "./sell-list-page-types";

const charizard: CheckoutSellListLineRow = {
  seller_account_id: "acc_seller",
  line_id: "sll_charizard",
  line_type: "selected-offer",
  offer_id: "off_seed_charizard_base_set_high_roller",
  listing_id: "lst_charizard",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "High Roller",
  offer_price_amount: "380.00",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::condition:raw",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [{ dimensionId: "condition", optionId: "raw" }],
  product_summary: "Raw / Near Mint",
  quantity: 1,
  fallback_mode: "none",
  minimum_listing_price_amount: null,
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};
const review: SellListOfferReview = {
  lineId: charizard.line_id,
  status: "ready",
  terms: {
    basis_amount: "380.00",
    marketplace_sales_fee_unit_amount: "38.00",
    seller_net_unit_amount: "342.00",
    shipping_allowance_percentage_bps: 0,
    fee_quote_fingerprint: "synthetic-charizard-quote",
  },
  comparison: null,
  message: null,
};

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  cleanup();
  document.body.replaceChildren();
});

describe("hydrated Sell List offer review", () => {
  it("opens, closes, reopens and switches the existing sheet without hydration recovery", async () => {
    const user = userEvent.setup();
    const recoverableErrors: unknown[] = [];
    const blastoise = { ...charizard, line_id: "sll_blastoise", item_title: "Blastoise", offer_id: "off_blastoise" };
    const page = (
      <CheckoutSellListPage
        sellListPath="/account/desk/offers"
        sellListLines={[charizard, blastoise]}
        offerReviews={[review, { ...review, lineId: blastoise.line_id }]}
        payoutReadiness={{ status: "not-started", missing_requirements: ["provider-onboarding", "seller-agreement"] }}
      />
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(page);
    document.body.append(container);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      root = hydrateRoot(container, page, { onRecoverableError: (error) => recoverableErrors.push(error) });
    });
    expect(recoverableErrors).toEqual([]);

    for (const activation of ["pointer", "Enter", " "] as const) {
      const card = screen.getByRole("button", { name: "Review Charizard offers and terms" });
      if (activation === "pointer") await user.click(card);
      else {
        card.focus();
        await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
      }
      const dialog = await screen.findByRole("dialog", { name: "Charizard offers and terms" });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(within(dialog).getByText("Seller terms")).toBeTruthy();
      expect(within(dialog).getAllByText("$342.00").length).toBeGreaterThan(0);
      await user.click(within(dialog).getByRole("checkbox", { name: "Select High Roller offer" }));
      const accept = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Accept selected" });
      const decline = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Decline selected" });
      expect(accept.disabled).toBe(true);
      expect(accept.form?.id).toBe("sell-list-checkout-form");
      expect(accept.name).toBe("intent");
      expect(accept.value).toBe("review-sell-list-checkout");
      expect(decline.form?.id).toBe("sell-list-checkout-form");
      expect(decline.value).toBe("decline-sell-list-offers");
      const remove = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Remove" });
      expect(remove.form).not.toBeNull();
      expect(new FormData(remove.form!).get("intent")).toBe("remove-sell-list-line");
      await user.click(within(dialog).getByRole("button", { name: "Clear selection" }));
      await user.click(within(dialog).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    await user.click(screen.getByRole("button", { name: "Review Blastoise offers and terms" }));
    expect(await screen.findByRole("dialog", { name: "Blastoise offers and terms" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Charizard offers and terms" })).toBeNull();
    expect(recoverableErrors).toEqual([]);
  });
});
