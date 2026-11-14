// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import type { SellListOfferReview, SellListProductOfferReview } from "./sell-list-page-types";
import { SellListReviewGrid } from "./sell-list-review-grid";

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

const selected: CheckoutSellListLineRow = {
  seller_account_id: "acc_seller",
  line_id: "selected",
  line_type: "selected-offer",
  offer_id: "off_selected",
  listing_id: "lst_selected",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Ash",
  offer_price_amount: "100.00",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "charizard",
  item_title: "Charizard",
  item_subtitle: null,
  selected_options: [],
  product_summary: null,
  quantity: 1,
  fallback_mode: "none",
  minimum_listing_price_amount: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const product: CheckoutSellListLineRow = {
  ...selected,
  line_id: "product",
  line_type: "product",
  item_title: "Blastoise",
  product_id: "blastoise",
  offer_id: null,
  listing_id: null,
  offer_price_amount: null,
};
const selectedReview: SellListOfferReview = {
  lineId: selected.line_id,
  status: "ready",
  comparison: null,
  message: null,
  terms: {
    basis_amount: "100.00",
    seller_net_unit_amount: "90.00",
    marketplace_sales_fee_unit_amount: "10.00",
    shipping_allowance_percentage_bps: 0,
    fee_quote_fingerprint: "fee_selected",
  },
};
const productReview: SellListProductOfferReview = {
  lineId: product.line_id,
  status: "ready",
  message: null,
  offers: [
    {
      offer: {
        offer_id: "off_product",
        buyer_account_id: "acc_misty",
        buyer_display_name: "Misty",
        price_amount: "80.00",
        quantity_requested: 1,
        offer_to_listing_price_bps: 10000,
      },
      terms: {
        basis_amount: "80.00",
        seller_net_unit_amount: "72.00",
        marketplace_sales_fee_unit_amount: "8.00",
        fee_quote_fingerprint: "fee_product",
      },
    },
  ],
};

function Review({ canAccept = true }: { canAccept?: boolean }) {
  return (
    <>
      <form id="sell-list-checkout-form" method="post" />
      <SellListReviewGrid
        lines={[selected, product]}
        offerReviewsByLineId={new Map([[selected.line_id, selectedReview]])}
        productOfferReviewsByLineId={new Map([[product.line_id, productReview]])}
        inventoryByProductId={new Map()}
        canAccept={canAccept}
      />
    </>
  );
}

describe("Sell List offer review activation", () => {
  it.each(["pointer", "Enter", "Space"])("hydrates and opens exactly one named sheet with %s", async (activation) => {
    const ui = <Review />;
    const container = document.createElement("div");
    container.innerHTML = renderToString(ui);
    document.body.append(container);
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, ui, { onRecoverableError });
      });
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      const user = userEvent.setup();
      const trigger = screen.getByRole("button", { name: "Review Charizard offers and terms" });
      if (activation === "pointer") await user.click(trigger);
      else {
        trigger.focus();
        await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
      }

      const dialog = screen.getByRole("dialog", { name: "Charizard offers and terms" });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(within(dialog).getByRole("checkbox", { name: "Select Ash offer" })).toBeTruthy();
      expect(within(dialog).getAllByText("Seller net").length).toBeGreaterThan(0);
      expect(within(dialog).getAllByText("$90.00").length).toBeGreaterThan(0);
      const remove = within(dialog).getByRole("button", { name: "Remove" }) as HTMLButtonElement;
      expect(remove.type).toBe("submit");
      expect(remove.form?.querySelector('input[name="intent"]')?.getAttribute("value")).toBe("remove-sell-list-line");
      await user.click(within(dialog).getByRole("checkbox", { name: "Select Ash offer" }));
      for (const [label, intent] of [
        ["Accept selected", "review-sell-list-checkout"],
        ["Decline selected", "decline-sell-list-offers"],
      ]) {
        const button = within(dialog).getByRole("button", { name: label }) as HTMLButtonElement;
        expect(button.type).toBe("submit");
        expect(button.form?.id).toBe("sell-list-checkout-form");
        expect(button.name).toBe("intent");
        expect(button.value).toBe(intent);
      }
      await user.click(within(dialog).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await user.click(trigger);
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(
        (within(screen.getByRole("dialog")).getByRole("checkbox", { name: "Select Ash offer" }) as HTMLInputElement)
          .checked,
      ).toBe(true);
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
      await user.click(screen.getByRole("button", { name: "Review Blastoise offers and terms" }));
      const next = screen.getByRole("dialog", { name: "Blastoise offers and terms" });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(within(next).queryByRole("checkbox", { name: "Select Ash offer" })).toBeNull();
      expect(within(next).getByRole("checkbox", { name: "Select Misty offer" })).toBeTruthy();
      expect(within(next).getAllByText("$72.00").length).toBeGreaterThan(0);
      expect(onRecoverableError).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
  });

  it("keeps acceptance blocked while review, decline, and removal remain available", () => {
    render(<Review canAccept={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Review Charizard offers and terms" }));
    const dialog = screen.getByRole("dialog", { name: "Charizard offers and terms" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Select Ash offer" }));
    expect((within(dialog).getByRole("button", { name: "Accept selected" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Decline selected" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((within(dialog).getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
