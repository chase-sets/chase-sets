import { describe, expect, it } from "vitest";
import {
  decideMarketplaceOfferSellerControl,
  evolveMarketplaceOfferSellerControl,
  initialMarketplaceOfferSellerControlState,
} from "./offer-seller-controls";
import { DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY } from "./offer-abuse-policy";

const policy = {
  ...DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY,
  lowballCooldownWindowMs: 60_000,
};

const baseDecline = {
  type: "DeclineOfferMatch" as const,
  sellerAccountId: "acc_seller" as never,
  buyerAccountId: "acc_buyer" as never,
  listingId: "lst_1",
  productId: "cat_1::",
  offerPriceAmount: "40.00",
  listingPriceAmount: "100.00",
  declinedAt: "2026-07-05T12:00:00.000Z",
  policy,
};

describe("marketplace offer seller controls", () => {
  it("starts a lowball cooldown after the second below-ask decline", () => {
    const firstEvents = decideMarketplaceOfferSellerControl(initialMarketplaceOfferSellerControlState, {
      ...baseDecline,
      offerId: "off_1" as never,
    });
    const firstState = firstEvents.reduce(
      evolveMarketplaceOfferSellerControl,
      initialMarketplaceOfferSellerControlState,
    );
    expect(firstState.lowballCooldownUntil).toBeNull();

    const secondEvents = decideMarketplaceOfferSellerControl(firstState, {
      ...baseDecline,
      offerId: "off_2" as never,
    });
    const secondState = secondEvents.reduce(evolveMarketplaceOfferSellerControl, firstState);

    expect(secondState.lowballDeclineCount).toBe(2);
    expect(secondState.lastLowballDeclinedAmount).toBe("40.00");
    expect(secondState.lowballCooldownUntil).toBe("2026-07-05T12:01:00.000Z");
  });

  it("records and removes buyer offer mutes", () => {
    const mutedState = decideMarketplaceOfferSellerControl(initialMarketplaceOfferSellerControlState, {
      type: "MuteBuyerOffers",
      sellerAccountId: "acc_seller" as never,
      buyerAccountId: "acc_buyer" as never,
      listingId: "lst_1",
      productId: "cat_1::",
      offerId: "off_1" as never,
      mutedAt: "2026-07-05T12:00:00.000Z",
    }).reduce(evolveMarketplaceOfferSellerControl, initialMarketplaceOfferSellerControlState);
    expect(mutedState.mutedAt).toBe("2026-07-05T12:00:00.000Z");

    const unmutedState = decideMarketplaceOfferSellerControl(mutedState, {
      type: "UnmuteBuyerOffers",
      sellerAccountId: "acc_seller" as never,
      buyerAccountId: "acc_buyer" as never,
      listingId: "lst_1",
      productId: "cat_1::",
      unmutedAt: "2026-07-05T12:02:00.000Z",
    }).reduce(evolveMarketplaceOfferSellerControl, mutedState);
    expect(unmutedState.mutedAt).toBeNull();
  });
});
