import { describe, expect, it } from "vitest";
import {
  decideMarketplaceOfferSellerControl,
  evolveMarketplaceOfferSellerControl,
  initialMarketplaceOfferSellerControlState,
} from "./offer-seller-controls";

const baseDecline = {
  type: "DeclineOfferMatch" as const,
  sellerAccountId: "acc_seller" as never,
  buyerAccountId: "acc_buyer" as never,
  listingId: "lst_1",
  productId: "cat_1::",
  offerPriceAmount: "40.00",
  offerPriceCurrencyCode: "USD",
  listingPriceAmount: "100.00",
  listingPriceCurrencyCode: "USD",
  declinedAt: "2026-07-05T12:00:00.000Z",
};

describe("marketplace offer seller controls", () => {
  it("does not start a cooldown after two below-ask declines", () => {
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
    expect(secondEvents[0]?.data).toMatchObject({ lowballCooldownUntil: null });
    expect(secondState.lowballCooldownUntil).toBeNull();
  });

  it("replays historical buyer mutes, unmute and cooldown-bearing Decline events", () => {
    const identity = {
      sellerAccountId: baseDecline.sellerAccountId,
      buyerAccountId: baseDecline.buyerAccountId,
      listingId: baseDecline.listingId,
      productId: baseDecline.productId,
    };
    const mutedState = evolveMarketplaceOfferSellerControl(initialMarketplaceOfferSellerControlState, {
      type: "marketplace.offer.buyer-muted",
      data: { ...identity, offerId: "off_1" as never, mutedAt: "2026-07-05T12:00:00.000Z" },
    });
    expect(mutedState.mutedAt).toBe("2026-07-05T12:00:00.000Z");

    const unmutedState = evolveMarketplaceOfferSellerControl(mutedState, {
      type: "marketplace.offer.buyer-unmuted",
      data: { ...identity, unmutedAt: "2026-07-05T12:02:00.000Z" },
    });
    expect(unmutedState.mutedAt).toBeNull();
    const historicalState = evolveMarketplaceOfferSellerControl(unmutedState, {
      type: "marketplace.offer.match-declined",
      data: {
        ...identity,
        offerId: "off_historical" as never,
        offerPriceAmount: "40.00",
        offerPriceCurrencyCode: "USD",
        listingPriceAmount: "100.00",
        listingPriceCurrencyCode: "USD",
        declinedAt: baseDecline.declinedAt,
        lowballDeclineCount: 2,
        lowballCooldownUntil: "2026-07-12T12:00:00.000Z",
      },
    });
    expect(historicalState).toMatchObject({
      ...identity,
      declinedOfferIds: ["off_historical"],
      declinedOfferCount: 1,
      lowballDeclineCount: 2,
      lastLowballDeclinedAmount: "40.00",
      lastLowballDeclinedCurrencyCode: "USD",
      lowballCooldownUntil: "2026-07-12T12:00:00.000Z",
      mutedAt: null,
    });
    const newEvents = decideMarketplaceOfferSellerControl(historicalState, {
      ...baseDecline,
      offerId: "off_new" as never,
    });
    expect(newEvents[0]?.data).toMatchObject({ lowballCooldownUntil: null });
    expect(newEvents.reduce(evolveMarketplaceOfferSellerControl, historicalState).declinedOfferIds).toEqual([
      "off_historical",
      "off_new",
    ]);
  });
});
