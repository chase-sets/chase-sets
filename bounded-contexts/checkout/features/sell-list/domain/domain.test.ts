import { describe, expect, it } from "vitest";
import { decideCheckoutSellList, evolveCheckoutSellList, initialCheckoutSellListState } from "./domain";

describe("checkout sell list domain", () => {
  it("adds, updates, removes, and clears sell list lines on checkout", () => {
    const added = decideCheckoutSellList(initialCheckoutSellListState, {
      type: "AddSellListLine",
      sellerAccountId: "acc_seller" as never,
      lineId: "sll_1" as never,
      lineType: "product",
      offerId: null,
      buyerAccountId: null,
      buyerDisplayName: null,
      offerPriceAmount: null,
      catalogItemId: "cat_1",
      productId: "cat_1::condition:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set",
      selectedOptions: [{ dimensionId: "condition", optionId: "raw" }],
      productSummary: "Raw / Near Mint",
      quantity: 1,
      fallbackMode: "create-listing",
      minimumListingPriceAmount: "399.00",
    });
    const addedState = added.reduce(evolveCheckoutSellList, initialCheckoutSellListState);

    const updated = decideCheckoutSellList(addedState, {
      type: "SetSellListLineQuantity",
      lineId: "sll_1" as never,
      quantity: 3,
    });
    const updatedState = updated.reduce(evolveCheckoutSellList, addedState);

    expect(updatedState.sellerAccountId).toBe("acc_seller");
    expect(updatedState.lines).toHaveLength(1);
    expect(updatedState.lines[0]?.quantity).toBe(3);
    expect(updatedState.lines[0]?.fallbackMode).toBe("create-listing");

    const removed = decideCheckoutSellList(updatedState, {
      type: "RemoveSellListLine",
      lineId: "sll_1" as never,
    });
    const removedState = removed.reduce(evolveCheckoutSellList, updatedState);

    expect(removedState.lines).toHaveLength(0);

    const repopulated = decideCheckoutSellList(removedState, {
      type: "AddSellListLine",
      sellerAccountId: "acc_seller" as never,
      lineId: "sll_2" as never,
      lineType: "selected-offer",
      offerId: "off_1",
      buyerAccountId: "acc_buyer",
      buyerDisplayName: "Ash Ketchum",
      offerPriceAmount: "350.00",
      catalogItemId: "cat_1",
      productId: "cat_1::condition:raw",
      itemTitle: "Charizard",
      itemSubtitle: null,
      selectedOptions: [{ dimensionId: "condition", optionId: "raw" }],
      productSummary: "Raw / Near Mint",
      quantity: 2,
      fallbackMode: "none",
      minimumListingPriceAmount: null,
    }).reduce(evolveCheckoutSellList, removedState);

    const checkedOut = decideCheckoutSellList(repopulated, {
      type: "CheckoutSellList",
      checkedOutAt: "2026-05-19T00:00:00.000Z",
    }).reduce(evolveCheckoutSellList, repopulated);

    expect(checkedOut.lines).toEqual([]);
    expect(checkedOut.lastCheckedOutAt).toBe("2026-05-19T00:00:00.000Z");
  });

  it("rejects invalid sell list line operations", () => {
    expect(() =>
      decideCheckoutSellList(initialCheckoutSellListState, {
        type: "AddSellListLine",
        sellerAccountId: "acc_seller" as never,
        lineId: "sll_1" as never,
        lineType: "selected-offer",
        offerId: null,
        buyerAccountId: null,
        buyerDisplayName: null,
        offerPriceAmount: null,
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
        fallbackMode: "none",
        minimumListingPriceAmount: null,
      }),
    ).toThrow("Selected offer sell-list lines must reference an offer.");

    expect(() =>
      decideCheckoutSellList(initialCheckoutSellListState, {
        type: "CheckoutSellList",
        checkedOutAt: "2026-05-19T00:00:00.000Z",
      }),
    ).toThrow("Sell list has not been initialized.");
  });

  it("clears only completed lines when Sell List checkout partially executes", () => {
    const withOffer = decideCheckoutSellList(initialCheckoutSellListState, {
      type: "AddSellListLine",
      sellerAccountId: "acc_seller" as never,
      lineId: "sll_offer" as never,
      lineType: "selected-offer",
      offerId: "off_1",
      buyerAccountId: "acc_buyer",
      buyerDisplayName: "Ash",
      offerPriceAmount: "20.00",
      catalogItemId: "cat_1",
      productId: "cat_1::condition:raw",
      itemTitle: "Charizard",
      itemSubtitle: null,
      selectedOptions: [{ dimensionId: "condition", optionId: "raw" }],
      productSummary: "Raw",
      quantity: 3,
      fallbackMode: "none",
      minimumListingPriceAmount: null,
    }).reduce(evolveCheckoutSellList, initialCheckoutSellListState);
    const withProduct = decideCheckoutSellList(withOffer, {
      type: "AddSellListLine",
      sellerAccountId: "acc_seller" as never,
      lineId: "sll_product" as never,
      lineType: "product",
      offerId: null,
      buyerAccountId: null,
      buyerDisplayName: null,
      offerPriceAmount: null,
      catalogItemId: "cat_1",
      productId: "cat_1::condition:raw",
      itemTitle: "Charizard",
      itemSubtitle: null,
      selectedOptions: [{ dimensionId: "condition", optionId: "raw" }],
      productSummary: "Raw",
      quantity: 3,
      fallbackMode: "create-listing",
      minimumListingPriceAmount: "25.00",
    }).reduce(evolveCheckoutSellList, withOffer);

    const checkedOut = decideCheckoutSellList(withProduct, {
      type: "CheckoutSellList",
      checkedOutAt: "2026-05-19T00:00:00.000Z",
      completedLineIds: ["sll_offer" as never],
      remainingLineQuantities: [{ lineId: "sll_product" as never, quantity: 2 }],
      executionSummary: {
        acceptedOfferCount: 1,
        createdListingCount: 0,
        skippedLineCount: 1,
        skippedReasons: ["Charizard: listing needs inventory, price, and quantity."],
      },
    }).reduce(evolveCheckoutSellList, withProduct);

    expect(checkedOut.lines.map((line) => line.lineId)).toEqual(["sll_product"]);
    expect(checkedOut.lines[0]?.quantity).toBe(2);
  });
});
