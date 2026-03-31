import { describe, expect, it } from "vitest";
import {
  decideMarketplaceOffer,
  evolveMarketplaceOffer,
  initialMarketplaceOfferState,
} from "./domain";

describe("marketplace offer domain", () => {
  it("submits an offer with a normalized buyer intent snapshot", () => {
    const events = decideMarketplaceOffer(initialMarketplaceOfferState, {
      type: "SubmitOffer",
      offerId: "off_test" as never,
      buyerAccountId: "acc_buyer" as never,
      catalogItemId: "cat_charizard",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      versionSelection: [{ dimensionId: "form", choiceId: "raw" }],
      versionSummary: "Form: Raw",
      priceAmount: "350.00",
      quantityRequested: 1,
    });
    const state = events.reduce(evolveMarketplaceOffer, initialMarketplaceOfferState);

    expect(state.offerId).toBe("off_test");
    expect(state.status).toBe("submitted");
    expect(state.priceAmount).toBe("350.00");
    expect(state.quantityRequested).toBe(1);
    expect(state.versionSelection).toEqual([
      { dimensionId: "form", choiceId: "raw" },
    ]);
  });

  it("rejects invalid monetary and quantity inputs", () => {
    expect(() =>
      decideMarketplaceOffer(initialMarketplaceOfferState, {
        type: "SubmitOffer",
        offerId: "off_test" as never,
        buyerAccountId: "acc_buyer" as never,
        catalogItemId: "cat_charizard",
        itemTitle: "Charizard",
        itemSubtitle: null,
        versionSelection: [],
        versionSummary: null,
        priceAmount: "0",
        quantityRequested: 1,
      }),
    ).toThrow("Offer price amount must be greater than zero.");

    expect(() =>
      decideMarketplaceOffer(initialMarketplaceOfferState, {
        type: "SubmitOffer",
        offerId: "off_test" as never,
        buyerAccountId: "acc_buyer" as never,
        catalogItemId: "cat_charizard",
        itemTitle: "Charizard",
        itemSubtitle: null,
        versionSelection: [],
        versionSummary: null,
        priceAmount: "10.00",
        quantityRequested: 0,
      }),
    ).toThrow("Offer quantity requested must be a positive whole number.");
  });

  it("rejects duplicate offer submission on an existing aggregate", () => {
    const submittedState = decideMarketplaceOffer(initialMarketplaceOfferState, {
      type: "SubmitOffer",
      offerId: "off_test" as never,
      buyerAccountId: "acc_buyer" as never,
      catalogItemId: "cat_charizard",
      itemTitle: "Charizard",
      itemSubtitle: null,
      versionSelection: [],
      versionSummary: null,
      priceAmount: "10.00",
      quantityRequested: 1,
    }).reduce(evolveMarketplaceOffer, initialMarketplaceOfferState);

    expect(() =>
      decideMarketplaceOffer(submittedState, {
        type: "SubmitOffer",
        offerId: "off_test" as never,
        buyerAccountId: "acc_buyer" as never,
        catalogItemId: "cat_charizard",
        itemTitle: "Charizard",
        itemSubtitle: null,
        versionSelection: [],
        versionSummary: null,
        priceAmount: "10.00",
        quantityRequested: 1,
      }),
    ).toThrow("Offer has already been submitted.");
  });
});
