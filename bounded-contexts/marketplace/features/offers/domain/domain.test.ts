import { describe, expect, it } from "vitest";
import {
  decideMarketplaceOffer,
  evolveMarketplaceOffer,
  initialMarketplaceOfferState,
  normalizeOfferPriceCurrencyCode,
} from "./domain";

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
  it("reports a missing Offer currency as the named domain assertion", () => {
    expect(() => normalizeOfferPriceCurrencyCode(undefined as never)).toThrow(
      "Offer price currency code must be a three-letter ISO-4217 code.",
    );
  });

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
      priceCurrencyCode: "USD",
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
      priceCurrencyCode: "USD",
      quantityRequested: 1,
      shippingDestinationSnapshot,
    });

    expect(event?.type).toBe("marketplace.offer.submitted");
    if (event?.type !== "marketplace.offer.submitted") throw new Error("Expected Offer submission.");
    expect(event.data.priceAmount).toBe("7.50");
    expect(event?.data.priceCurrencyCode).toBe("USD");
  });

  it("treats a currency-only Offer price edit as material and an unchanged normalized pair as a no-op", () => {
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
      priceCurrencyCode: "usd",
      quantityRequested: 1,
      shippingDestinationSnapshot,
    }).reduce(evolveMarketplaceOffer, initialMarketplaceOfferState);

    expect(
      decideMarketplaceOffer(submittedState, {
        type: "UpdateOfferPrice",
        buyerAccountId: "acc_buyer" as never,
        priceAmount: "10.0",
        priceCurrencyCode: "USD",
      }),
    ).toEqual([]);
    expect(
      decideMarketplaceOffer(submittedState, {
        type: "UpdateOfferPrice",
        buyerAccountId: "acc_buyer" as never,
        priceAmount: "10.00",
        priceCurrencyCode: "EUR",
      }),
    ).toMatchObject([{ type: "marketplace.offer.price-updated", data: { priceCurrencyCode: "EUR" } }]);
  });

  it("keeps a historical amount-only Offer ineligible for acceptance", () => {
    const legacyState = evolveMarketplaceOffer(initialMarketplaceOfferState, {
      type: "marketplace.offer.submitted",
      data: {
        offerId: "off_legacy" as never,
        buyerAccountId: "acc_buyer" as never,
        catalogItemId: "cat_charizard" as never,
        productId: "cat_charizard::" as never,
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot,
        priceAmount: "10.00",
        quantityRequested: 1,
      },
    });

    expect(() =>
      decideMarketplaceOffer(legacyState, {
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
      }),
    ).toThrow("Offer price is incomplete. The buyer must supply an amount and currency before acceptance.");
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
        priceCurrencyCode: "USD",
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
        priceCurrencyCode: "USD",
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
        priceCurrencyCode: "USD",
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
      priceCurrencyCode: "USD",
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
        priceCurrencyCode: "USD",
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
        priceCurrencyCode: "USD",
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
      priceCurrencyCode: "USD",
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
      priceCurrencyCode: "USD",
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

describe("marketplace offer lifecycle", () => {
  const at = "2026-10-14T00:00:00.000Z";
  const acceptCommand = {
    type: "AcceptOffer",
    sellerAccountId: "acc_seller" as never,
    ...listingCommitment,
    acceptedAt: at,
    marketplaceSalesFeePercentageBps: 500,
    marketplaceSalesFeeFixedAmount: "0.00",
    marketplaceSalesFeeCapAmount: "25.00",
    marketplaceSalesFeeUnitAmount: "0.50",
    sellerNetUnitAmount: "9.50",
    termsScheduleId: "sch_standard",
    termsAgreementId: null,
    termsResolvedAt: at,
    feeQuoteFingerprint: "10.00|0.50|9.50|sch_standard|",
  } as const;
  const submitted = decideMarketplaceOffer(initialMarketplaceOfferState, {
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
    priceCurrencyCode: "USD",
    quantityRequested: 1,
    shippingDestinationSnapshot,
  }).reduce(evolveMarketplaceOffer, initialMarketplaceOfferState);
  const run = (state: typeof submitted, type: "PauseOffer" | "ResumeOffer" | "WithdrawOffer", buyer = "acc_buyer") =>
    decideMarketplaceOffer(state, { type, buyerAccountId: buyer as never, at });
  const apply = (state: typeof submitted, type: "PauseOffer" | "ResumeOffer" | "WithdrawOffer") =>
    run(state, type).reduce(evolveMarketplaceOffer, state);
  const paused = apply(submitted, "PauseOffer");
  const withdrawn = apply(submitted, "WithdrawOffer");
  const accepted = decideMarketplaceOffer(submitted, acceptCommand).reduce(evolveMarketplaceOffer, submitted);

  it.each([
    ["submitted", "PauseOffer", "marketplace.offer.paused", "paused"],
    ["paused", "ResumeOffer", "marketplace.offer.resumed", "submitted"],
    ["submitted", "WithdrawOffer", "marketplace.offer.withdrawn", "withdrawn"],
    ["paused", "WithdrawOffer", "marketplace.offer.withdrawn", "withdrawn"],
  ] as const)("moves a %s Offer through %s to %s's status", (from, type, eventType, to) => {
    const state = from === "submitted" ? submitted : paused;
    const events = run(state, type);
    expect(events).toEqual([{ type: eventType, data: { offerId: "off_test", buyerAccountId: "acc_buyer", at } }]);
    expect(events.reduce(evolveMarketplaceOffer, state).status).toBe(to);
  });

  it("keeps accepting a submitted Offer as the existing terminal transition", () => {
    expect(accepted.status).toBe("accepted");
  });

  it.each([
    ["paused", "PauseOffer"],
    ["submitted", "ResumeOffer"],
    ["withdrawn", "WithdrawOffer"],
  ] as const)("emits nothing when a %s Offer receives %s", (from, type) => {
    const state = from === "submitted" ? submitted : from === "paused" ? paused : withdrawn;
    expect(run(state, type)).toEqual([]);
  });

  it.each([
    ["withdrawn", "PauseOffer"],
    ["withdrawn", "ResumeOffer"],
    ["accepted", "PauseOffer"],
    ["accepted", "ResumeOffer"],
    ["accepted", "WithdrawOffer"],
  ] as const)("rejects %s Offers receiving %s", (from, type) => {
    const state = from === "withdrawn" ? withdrawn : accepted;
    expect(() => run(state, type)).toThrow(`A ${from} Offer cannot change its lifecycle.`);
  });

  it("rejects another buyer's lifecycle command before any no-op", () => {
    expect(() => run(submitted, "PauseOffer", "acc_other")).toThrow("Only the Offer's buyer can change its lifecycle.");
    expect(() => run(paused, "PauseOffer", "acc_other")).toThrow("Only the Offer's buyer can change its lifecycle.");
    expect(() => run(initialMarketplaceOfferState, "WithdrawOffer")).toThrow("Offer must be submitted first.");
  });

  it("lets the buyer re-price a paused Offer and keeps it paused until resumed at the new price", () => {
    const repriced = decideMarketplaceOffer(paused, {
      type: "UpdateOfferPrice",
      buyerAccountId: "acc_buyer" as never,
      priceAmount: "12.00",
      priceCurrencyCode: "USD",
    }).reduce(evolveMarketplaceOffer, paused);
    expect(repriced).toMatchObject({ status: "paused", priceAmount: "12.00" });
    expect(apply(repriced, "ResumeOffer")).toMatchObject({ status: "submitted", priceAmount: "12.00" });
  });

  it("rejects re-pricing and accepting a withdrawn Offer, and accepting a paused Offer", () => {
    expect(() =>
      decideMarketplaceOffer(withdrawn, {
        type: "UpdateOfferPrice",
        buyerAccountId: "acc_buyer" as never,
        priceAmount: "12.00",
        priceCurrencyCode: "USD",
      }),
    ).toThrow("Only open or paused Offers can change price.");
    expect(() => decideMarketplaceOffer(withdrawn, acceptCommand)).toThrow("Only submitted offers can be accepted.");
    expect(() => decideMarketplaceOffer(paused, acceptCommand)).toThrow("Only submitted offers can be accepted.");
  });
});
