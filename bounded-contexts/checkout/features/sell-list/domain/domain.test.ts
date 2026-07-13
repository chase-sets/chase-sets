import { describe, expect, it } from "vitest";
import { decideCheckoutSellList, evolveCheckoutSellList, initialCheckoutSellListState } from "./domain";

describe("checkout sell list domain", () => {
  it("adds, updates, removes, and clears sell list lines on confirmation", () => {
    const added = decideCheckoutSellList(initialCheckoutSellListState, {
      type: "AddSellListLine",
      sellerAccountId: "acc_seller" as never,
      lineId: "sll_1" as never,
      lineType: "product",
      offerId: null,
      listingId: null,
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
    expect(updated[0]).toMatchObject({
      type: "checkout.sell-list.line-quantity-set",
      data: { sellerAccountId: "acc_seller", lineId: "sll_1", quantity: 3 },
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
    expect(removed[0]).toMatchObject({
      type: "checkout.sell-list.line-removed",
      data: { sellerAccountId: "acc_seller", lineId: "sll_1" },
    });
    const removedState = removed.reduce(evolveCheckoutSellList, updatedState);

    expect(removedState.lines).toHaveLength(0);

    const repopulated = decideCheckoutSellList(removedState, {
      type: "AddSellListLine",
      sellerAccountId: "acc_seller" as never,
      lineId: "sll_2" as never,
      lineType: "selected-offer",
      offerId: "off_1",
      listingId: "lst_1",
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

    const confirmed = decideCheckoutSellList(repopulated, {
      type: "ConfirmSellListCheckout",
      confirmationId: "slc_1",
      confirmedAt: "2026-05-19T00:00:00.000Z",
      readinessEvidence: readinessEvidence(["sll_2"]),
      sellerEvidence: sellerEvidence(),
      handoffSummary: handoffSummary({ acceptedOfferCount: 1 }),
    }).reduce(evolveCheckoutSellList, repopulated);

    expect(confirmed.lines).toEqual([]);
    expect(confirmed.lastConfirmedAt).toBe("2026-05-19T00:00:00.000Z");
    expect(confirmed.confirmationIds).toEqual(["slc_1"]);
  });

  it("rejects invalid sell list line operations", () => {
    expect(() =>
      decideCheckoutSellList(initialCheckoutSellListState, {
        type: "AddSellListLine",
        sellerAccountId: "acc_seller" as never,
        lineId: "sll_1" as never,
        lineType: "selected-offer",
        offerId: null,
        listingId: null,
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
    ).toThrow("Selected offer sell-list lines must reference an Offer and exact Listing.");

    expect(() =>
      decideCheckoutSellList(initialCheckoutSellListState, {
        type: "ConfirmSellListCheckout",
        confirmationId: "slc_1",
        confirmedAt: "2026-05-19T00:00:00.000Z",
        readinessEvidence: readinessEvidence(["sll_1"]),
        sellerEvidence: sellerEvidence(),
        handoffSummary: handoffSummary({ acceptedOfferCount: 1 }),
      }),
    ).toThrow("Sell list has not been initialized.");
  });

  it("clears only completed lines when Sell List confirmation is partial", () => {
    const withOffer = decideCheckoutSellList(initialCheckoutSellListState, {
      type: "AddSellListLine",
      sellerAccountId: "acc_seller" as never,
      lineId: "sll_offer" as never,
      lineType: "selected-offer",
      offerId: "off_1",
      listingId: "lst_1",
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
      listingId: null,
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

    const confirmed = decideCheckoutSellList(withProduct, {
      type: "ConfirmSellListCheckout",
      confirmationId: "slc_partial",
      confirmedAt: "2026-05-19T00:00:00.000Z",
      completedLineIds: ["sll_offer" as never],
      remainingLineQuantities: [{ lineId: "sll_product" as never, quantity: 2 }],
      readinessEvidence: readinessEvidence(["sll_offer", "sll_product"]),
      sellerEvidence: sellerEvidence(),
      handoffSummary: handoffSummary({
        acceptedOfferCount: 1,
        publishedListingCount: 0,
        skippedLineCount: 1,
        skippedReasons: ["Charizard: listing needs inventory, price, and quantity."],
      }),
    }).reduce(evolveCheckoutSellList, withProduct);

    expect(confirmed.lines.map((line) => line.lineId)).toEqual(["sll_product"]);
    expect(confirmed.lines[0]?.quantity).toBe(2);

    expect(() =>
      decideCheckoutSellList(withProduct, {
        type: "ConfirmSellListCheckout",
        confirmationId: "slc_duplicate_remaining",
        confirmedAt: "2026-05-19T00:00:00.000Z",
        completedLineIds: ["sll_offer" as never],
        remainingLineQuantities: [
          { lineId: "sll_product" as never, quantity: 2 },
          { lineId: "sll_product" as never, quantity: 1 },
        ],
        readinessEvidence: readinessEvidence(["sll_offer", "sll_product"]),
        sellerEvidence: sellerEvidence(),
        handoffSummary: handoffSummary(),
      }),
    ).toThrow("Remaining Sell List lines must be unique.");
  });
});

function readinessEvidence(includedLineIds: readonly string[]) {
  return {
    schemaVersion: "checkout.sell-list-readiness.v1" as const,
    snapshotId: "slr_ready",
    sourceRevision: "slr_source",
    includedLineIds,
    lineOutcomes: includedLineIds.map((lineId) => ({ lineId, action: "selected-offer" as const })),
  };
}

function sellerEvidence() {
  return {
    shipFrom: {
      status: "ready" as const,
      addressId: "adr_seller",
      country: "US",
      region: "KS",
      postalCode: "67202",
    },
    payout: {
      status: "ready" as const,
      method: "saved-payout" as const,
      readinessStatus: "ready",
      lastCheckedAt: "2026-05-19T00:00:00.000Z",
    },
    label: {
      status: "ready" as const,
      preference: "prepaid-label" as const,
    },
    conditionReview: {
      status: "accepted" as const,
      acceptedAt: "2026-05-19T00:00:00.000Z",
    },
    risk: { status: "clear" as const },
    provider: { status: "ready" as const },
    freshness: { status: "current" as const },
  };
}

function handoffSummary(
  overrides: Partial<{
    acceptedOfferCount: number;
    publishedListingCount: number;
    skippedLineCount: number;
    skippedReasons: readonly string[];
  }> = {},
) {
  return {
    acceptedOfferCount: overrides.acceptedOfferCount ?? 0,
    publishedListingCount: overrides.publishedListingCount ?? 0,
    skippedLineCount: overrides.skippedLineCount ?? 0,
    skippedReasons: overrides.skippedReasons ?? [],
    lineOutcomes: [],
    sideEffects: {
      sale: overrides.acceptedOfferCount ? ("handoff-recorded" as const) : ("not-applicable" as const),
      label: "pending-downstream" as const,
      payout: "pending-downstream" as const,
      settlement: "pending-downstream" as const,
      notification: "pending-downstream" as const,
      accountHistory: "pending-downstream" as const,
    },
  };
}
