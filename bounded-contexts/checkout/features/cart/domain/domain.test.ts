import { describe, expect, it } from "vitest";
import {
  decideCheckoutCart,
  evolveCheckoutCart,
  initialCheckoutCartState,
} from "./domain";

describe("checkout cart domain", () => {
  it("adds, updates, removes, and clears cart lines on checkout", () => {
    const added = decideCheckoutCart(initialCheckoutCartState, {
      type: "AddCartLine",
      buyerAccountId: "acc_buyer" as never,
      lineId: "cli_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      itemTitle: "Charizard",
      itemSubtitle: "Base Set",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Form: Raw",
      quantity: 1,
    });
    const addedState = added.reduce(evolveCheckoutCart, initialCheckoutCartState);
    const updated = decideCheckoutCart(addedState, {
      type: "SetCartLineQuantity",
      lineId: "cli_1" as never,
      quantity: 2,
    });
    const updatedState = updated.reduce(evolveCheckoutCart, addedState);

    expect(updatedState.lines).toHaveLength(1);
    expect(updatedState.lines[0]?.quantity).toBe(2);

    const removed = decideCheckoutCart(updatedState, {
      type: "RemoveCartLine",
      lineId: "cli_1" as never,
    });
    const removedState = removed.reduce(evolveCheckoutCart, updatedState);
    expect(removedState.lines).toHaveLength(0);

    const repopulated = decideCheckoutCart(removedState, {
      type: "AddCartLine",
      buyerAccountId: "acc_buyer" as never,
      lineId: "cli_2" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      itemTitle: "Charizard",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
    }).reduce(evolveCheckoutCart, removedState);

    const checkedOut = decideCheckoutCart(repopulated, {
      type: "CheckoutCart",
      checkedOutAt: "2026-03-31T00:00:00.000Z",
    }).reduce(evolveCheckoutCart, repopulated);

    expect(checkedOut.lines).toEqual([]);
    expect(checkedOut.lastCheckedOutAt).toBe("2026-03-31T00:00:00.000Z");
  });

  it("rejects invalid cart line operations", () => {
    expect(() =>
      decideCheckoutCart(initialCheckoutCartState, {
        type: "AddCartLine",
        buyerAccountId: "acc_buyer" as never,
        lineId: "cli_1" as never,
        catalogItemId: "cat_1",
        productId: "cat_1::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 0,
      }),
    ).toThrow("Cart quantity must be a positive whole number.");

    expect(() =>
      decideCheckoutCart(initialCheckoutCartState, {
        type: "CheckoutCart",
        checkedOutAt: "2026-03-31T00:00:00.000Z",
      }),
    ).toThrow("Cart has not been initialized.");
  });
});
