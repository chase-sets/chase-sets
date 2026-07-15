import { describe, expect, it } from "vitest";
import { decideMarketplaceOffer, evolveMarketplaceOffer, initialMarketplaceOfferState } from "./domain";

const shippingDestinationSnapshot = {
  name: "Jane Smith",
  company: null,
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: null,
  email: "jane@example.com",
} as const;

const listingCommitment = {
  listingId: "lst_1",
  inventoryItemId: "inv_1",
  listingVersion: 3,
  listingEvidencePolicyId: "pol_1",
  listingEvidencePolicyVersion: 2,
  listingEvidencePolicyHash: "sha256:policy",
  listingEvidenceSnapshot: {
    schemaVersion: 1,
    policyHash: "sha256:policy",
    snapshotHash: "sha256:evidence",
    createdAt: "2026-03-31T00:00:00.000Z",
    evidence: [],
  },
} as const;

describe("marketplace offer domain", () => {
  it("submits an offer with a normalized buyer intent snapshot", () => {
    const events = decideMarketplaceOffer(initialMarketplaceOfferState, {
      type: "SubmitOffer",
      offerId: "off_test" as never,
      buyerAccountId: "acc_buyer" as never,
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::" as never,
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Form: Raw",
      priceAmount: "350.00",
      quantityRequested: 1,
      shippingDestinationSnapshot,
    });
    const state = events.reduce(evolveMarketplaceOffer, initialMarketplaceOfferState);

    expect(state.offerId).toBe("off_test");
    expect(state.status).toBe("submitted");
    expect(state.priceAmount).toBe("350.00");
    expect(state.quantityRequested).toBe(1);
    expect(state.selectedOptions).toEqual([{ dimensionId: "form", optionId: "raw" }]);
  });

  it("canonicalizes offer prices before recording events", () => {
    const [event] = decideMarketplaceOffer(initialMarketplaceOfferState, {
      type: "SubmitOffer",
      offerId: "off_test" as never,
      buyerAccountId: "acc_buyer" as never,
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::" as never,
      itemTitle: "Charizard",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      priceAmount: "007.50",
      quantityRequested: 1,
      shippingDestinationSnapshot,
    });

    expect(event?.data.priceAmount).toBe("7.50");
  });

  it("rejects offer prices above the shared money ceiling", () => {
    expect(() =>
      decideMarketplaceOffer(initialMarketplaceOfferState, {
        type: "SubmitOffer",
        offerId: "off_test" as never,
        buyerAccountId: "acc_buyer" as never,
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        priceAmount: "10000000000.00",
        quantityRequested: 1,
        shippingDestinationSnapshot,
      }),
    ).toThrow();
  });

  it("rejects invalid monetary and quantity inputs", () => {
    expect(() =>
      decideMarketplaceOffer(initialMarketplaceOfferState, {
        type: "SubmitOffer",
        offerId: "off_test" as never,
        buyerAccountId: "acc_buyer" as never,
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        priceAmount: "0",
        quantityRequested: 1,
        shippingDestinationSnapshot,
      }),
    ).toThrow("Offer price amount must be greater than zero.");

    expect(() =>
      decideMarketplaceOffer(initialMarketplaceOfferState, {
        type: "SubmitOffer",
        offerId: "off_test" as never,
        buyerAccountId: "acc_buyer" as never,
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        priceAmount: "10.00",
        quantityRequested: 0,
        shippingDestinationSnapshot,
      }),
    ).toThrow("Offer quantity requested must be a positive whole number.");
  });

  it("rejects duplicate offer submission on an existing aggregate", () => {
    const submittedState = decideMarketplaceOffer(initialMarketplaceOfferState, {
      type: "SubmitOffer",
      offerId: "off_test" as never,
      buyerAccountId: "acc_buyer" as never,
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::" as never,
      itemTitle: "Charizard",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      priceAmount: "10.00",
      quantityRequested: 1,
      shippingDestinationSnapshot,
    }).reduce(evolveMarketplaceOffer, initialMarketplaceOfferState);

    expect(() =>
      decideMarketplaceOffer(submittedState, {
        type: "SubmitOffer",
        offerId: "off_test" as never,
        buyerAccountId: "acc_buyer" as never,
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        priceAmount: "10.00",
        quantityRequested: 1,
        shippingDestinationSnapshot,
      }),
    ).toThrow("Offer has already been submitted.");
  });

  it("rejects offers on the buyer account's own active listing", () => {
    expect(() =>
      decideMarketplaceOffer(initialMarketplaceOfferState, {
        type: "SubmitOffer",
        offerId: "off_test" as never,
        buyerAccountId: "acc_same" as never,
        sellerAccountId: "acc_same" as never,
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        priceAmount: "10.00",
        quantityRequested: 1,
        shippingDestinationSnapshot,
      }),
    ).toThrow("Accounts cannot offer on their own listings.");
  });

  it("accepts a submitted offer once and records the seller", () => {
    const submittedState = decideMarketplaceOffer(initialMarketplaceOfferState, {
      type: "SubmitOffer",
      offerId: "off_test" as never,
      buyerAccountId: "acc_buyer" as never,
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::" as never,
      itemTitle: "Charizard",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      priceAmount: "10.00",
      quantityRequested: 1,
      shippingDestinationSnapshot,
    }).reduce(evolveMarketplaceOffer, initialMarketplaceOfferState);

    const acceptedState = decideMarketplaceOffer(submittedState, {
      type: "AcceptOffer",
      sellerAccountId: "acc_seller" as never,
      ...listingCommitment,
      acceptedAt: "2026-03-31T00:00:00.000Z",
      marketplaceSalesFeePercentageBps: 500,
      marketplaceSalesFeeFixedAmount: "0.00",
      marketplaceSalesFeeCapAmount: "25.00",
      marketplaceSalesFeeUnitAmount: "0.50",
      sellerNetUnitAmount: "9.50",
      termsScheduleId: "sch_standard",
      termsAgreementId: null,
      termsResolvedAt: "2026-03-31T00:00:00.000Z",
      feeQuoteFingerprint: "10.00|0.50|9.50|sch_standard|",
    }).reduce(evolveMarketplaceOffer, submittedState);

    expect(acceptedState.status).toBe("accepted");
    expect(acceptedState.acceptedSellerAccountId).toBe("acc_seller");
    expect(acceptedState.acceptedListingId).toBe("lst_1");
    expect(acceptedState.listingEvidenceSnapshot?.snapshotHash).toBe("sha256:evidence");
    expect(acceptedState.marketplaceSalesFeeUnitAmount).toBe("0.50");
    expect(acceptedState.sellerNetUnitAmount).toBe("9.50");
  });

  it("rejects same-account offer acceptance", () => {
    const submittedState = decideMarketplaceOffer(initialMarketplaceOfferState, {
      type: "SubmitOffer",
      offerId: "off_test" as never,
      buyerAccountId: "acc_same" as never,
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::" as never,
      itemTitle: "Charizard",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      priceAmount: "10.00",
      quantityRequested: 1,
      shippingDestinationSnapshot,
    }).reduce(evolveMarketplaceOffer, initialMarketplaceOfferState);

    expect(() =>
      decideMarketplaceOffer(submittedState, {
        type: "AcceptOffer",
        sellerAccountId: "acc_same" as never,
        ...listingCommitment,
        acceptedAt: "2026-03-31T00:00:00.000Z",
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: "25.00",
        marketplaceSalesFeeUnitAmount: "0.50",
        sellerNetUnitAmount: "9.50",
        termsScheduleId: "sch_standard",
        termsAgreementId: null,
        termsResolvedAt: "2026-03-31T00:00:00.000Z",
        feeQuoteFingerprint: "10.00|0.50|9.50|sch_standard|",
      }),
    ).toThrow("Accounts cannot accept their own offers.");
  });
});
