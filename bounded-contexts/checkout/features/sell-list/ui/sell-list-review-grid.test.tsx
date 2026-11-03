// @vitest-environment jsdom
import { fireEvent, screen, within } from "@testing-library/react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import { SellListReviewGrid } from "./sell-list-review-grid";
import type { SellListOfferReview } from "./sell-list-page-types";

const line: CheckoutSellListLineRow = {
  seller_account_id: "acc_seller",
  line_id: "sll_review_grid",
  line_type: "selected-offer",
  offer_id: "off_review_grid",
  listing_id: "lst_review_grid",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Ash Ketchum",
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
  lineId: line.line_id,
  status: "ready",
  terms: {
    basis_amount: "380.00",
    marketplace_sales_fee_unit_amount: "0.00",
    seller_net_unit_amount: "380.00",
    shipping_allowance_percentage_bps: 0,
    fee_quote_fingerprint: "fingerprint",
  },
  comparison: null,
  message: null,
};

function renderGrid() {
  return (
    <form id="sell-list-checkout-form">
      <SellListReviewGrid
        lines={[line]}
        offerReviewsByLineId={new Map([[line.line_id, review]])}
        productOfferReviewsByLineId={new Map()}
        inventoryByProductId={new Map()}
        canAccept
      />
    </form>
  );
}

function assertDialogFormAssociations() {
  const dialog = screen.getByRole("dialog", { name: "Charizard offers and terms" });
  expect(within(dialog).getByRole("button", { name: "Continue to seller checkout" })).toHaveAttribute(
    "form",
    "sell-list-checkout-form",
  );
  expect(within(dialog).getByRole("button", { name: "Remove" }).closest("form")).not.toBeNull();
  for (const control of within(dialog).container.querySelectorAll<HTMLElement>("[form]")) {
    expect(document.getElementById(control.getAttribute("form") ?? "")).not.toBeNull();
  }
}

describe("SellListReviewGrid hydration and controls", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("hydrates without recoverable errors and opens one sheet for pointer, Enter, and Space", async () => {
    const serverMarkup = renderToString(renderGrid());
    document.body.innerHTML = `<div id="root">${serverMarkup}</div>`;
    const errors: unknown[] = [];
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(document.getElementById("root")!, renderGrid(), {
        onRecoverableError: (error) => errors.push(error),
      });
    });
    expect(errors).toHaveLength(0);

    const trigger = () => screen.getByRole("button", { name: "Review Charizard offers and terms" });
    fireEvent.click(trigger());
    expect(screen.getAllByRole("dialog", { name: "Charizard offers and terms" })).toHaveLength(1);
    assertDialogFormAssociations();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(screen.getAllByRole("dialog", { name: "Charizard offers and terms" })).toHaveLength(1);
    assertDialogFormAssociations();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.keyDown(trigger(), { key: " " });
    expect(screen.getAllByRole("dialog", { name: "Charizard offers and terms" })).toHaveLength(1);
    assertDialogFormAssociations();
    await act(async () => root.unmount());
  });
});
