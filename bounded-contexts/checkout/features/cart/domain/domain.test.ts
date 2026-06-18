import { describe, expect, it } from "vitest";
import { decideCheckoutCart, evolveCheckoutCart, initialCheckoutCartState } from "./domain";

describe("checkout cart domain", () => {
  it("adds, updates, removes, and clears cart lines on checkout", () => {
    const added = decideCheckoutCart(initialCheckoutCartState, {
      type: "AddCartLine",
      buyerAccountId: "acc_buyer" as never,
      lineId: "cli_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      itemLanguageCode: "ja",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set",
      itemImageUrl: null,
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
    expect(added[0]).toMatchObject({ data: { itemLanguageCode: "ja" } });
    expect(addedState.lines[0]?.itemLanguageCode).toBe("ja");
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
      itemImageUrl: null,
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

  it("persists selected listing snapshots on locked cart lines", () => {
    const [event] = decideCheckoutCart(initialCheckoutCartState, {
      type: "AddCartLine",
      buyerAccountId: "acc_buyer" as never,
      lineId: "cli_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      itemTitle: "Charizard",
      itemSubtitle: null,
      itemImageUrl: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_selected",
      sellerPreferenceId: "lst_selected",
      selectedListingSnapshot: {
        listingId: "lst_selected",
        sellerAccountId: "acc_seller",
        sellerDisplayName: "Card Vault",
        sellerSlug: "card-vault",
        priceAmount: "25",
        source: "discovery.item-detail.add-to-cart",
      },
    });
    const state = event ? evolveCheckoutCart(initialCheckoutCartState, event) : initialCheckoutCartState;

    expect(event).toMatchObject({
      data: {
        lockedListingId: "lst_selected",
        selectedListingSnapshot: {
          listingId: "lst_selected",
          sellerAccountId: "acc_seller",
          sellerDisplayName: "Card Vault",
          sellerSlug: "card-vault",
          priceAmount: "25.00",
          source: "discovery.item-detail.add-to-cart",
        },
      },
    });
    expect(state.lines[0]?.selectedListingSnapshot).toMatchObject({
      listingId: "lst_selected",
      priceAmount: "25.00",
    });
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
        itemImageUrl: null,
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

    expect(() =>
      decideCheckoutCart(initialCheckoutCartState, {
        type: "AddCartLine",
        buyerAccountId: "acc_buyer" as never,
        lineId: "cli_2" as never,
        catalogItemId: "cat_1",
        productId: "cat_1::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        itemImageUrl: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_selected",
        selectedListingSnapshot: {
          listingId: "lst_other",
          priceAmount: "25.00",
          source: "discovery.item-detail.add-to-cart",
        },
      }),
    ).toThrow("Selected listing snapshot must match the locked listing.");
  });
});
