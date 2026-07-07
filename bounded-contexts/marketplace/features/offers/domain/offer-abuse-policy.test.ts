import { describe, expect, it } from "vitest";
import {
  assertOfferSubmissionAllowed,
  DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY,
  MarketplaceOfferAbuseControlError,
  requiredOfferFloorAmount,
} from "./offer-abuse-policy";

const policy = {
  ...DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY,
  buyerDailySubmissionCap: 2,
  buyerListingDailySubmissionCap: 2,
  lowballCooldownWindowMs: 60_000,
};

const listingGuard = {
  listingId: "lst_1",
  sellerAccountId: "acc_seller",
  listingPriceAmount: "100.00",
  buyerListingDailyOfferCount: 1,
  mutedAt: null,
  lowballCooldownUntil: null,
  lastLowballDeclinedAmount: null,
} as const;

function expectControlCode(callback: () => void, code: string) {
  expect(callback).toThrow(MarketplaceOfferAbuseControlError);
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(MarketplaceOfferAbuseControlError);
    expect((error as MarketplaceOfferAbuseControlError).code).toBe(code);
  }
}

describe("marketplace offer abuse policy", () => {
  it("calculates listing-relative price floors with cent rounding", () => {
    expect(requiredOfferFloorAmount("99.99", 5000)).toBe("50.00");
    expect(requiredOfferFloorAmount("100.00", 5000)).toBe("50.00");
  });

  it("allows cap and floor boundary values", () => {
    expect(() =>
      assertOfferSubmissionAllowed({
        policy,
        now: new Date("2026-07-05T12:00:00.000Z"),
        buyerDailySubmissionCount: 1,
        offerPriceAmount: "50.00",
        listingGuards: [listingGuard],
      }),
    ).not.toThrow();
  });

  it("rejects buyer and listing cap boundaries once reached", () => {
    expectControlCode(
      () =>
        assertOfferSubmissionAllowed({
          policy,
          now: new Date("2026-07-05T12:00:00.000Z"),
          buyerDailySubmissionCount: 2,
          offerPriceAmount: "50.00",
          listingGuards: [listingGuard],
        }),
      "offer_daily_submission_cap_reached",
    );

    expectControlCode(
      () =>
        assertOfferSubmissionAllowed({
          policy,
          now: new Date("2026-07-05T12:00:00.000Z"),
          buyerDailySubmissionCount: 1,
          offerPriceAmount: "50.00",
          listingGuards: [{ ...listingGuard, buyerListingDailyOfferCount: 2 }],
        }),
      "offer_listing_submission_cap_reached",
    );
  });

  it("rejects offers below every matching listing floor", () => {
    expectControlCode(
      () =>
        assertOfferSubmissionAllowed({
          policy,
          now: new Date("2026-07-05T12:00:00.000Z"),
          buyerDailySubmissionCount: 0,
          offerPriceAmount: "49.99",
          listingGuards: [listingGuard],
        }),
      "offer_price_floor_not_met",
    );
  });

  it("rejects lower repeated lowball offers during the cooldown window", () => {
    expectControlCode(
      () =>
        assertOfferSubmissionAllowed({
          policy,
          now: new Date("2026-07-05T12:00:00.000Z"),
          buyerDailySubmissionCount: 0,
          offerPriceAmount: "60.00",
          listingGuards: [
            {
              ...listingGuard,
              lowballCooldownUntil: "2026-07-05T12:01:00.000Z",
              lastLowballDeclinedAmount: "70.00",
            },
          ],
        }),
      "offer_lowball_cooldown",
    );
  });

  it("rejects when every matching seller has muted the buyer", () => {
    expectControlCode(
      () =>
        assertOfferSubmissionAllowed({
          policy,
          now: new Date("2026-07-05T12:00:00.000Z"),
          buyerDailySubmissionCount: 0,
          offerPriceAmount: "80.00",
          listingGuards: [{ ...listingGuard, mutedAt: "2026-07-05T11:00:00.000Z" }],
        }),
      "offer_muted_by_sellers",
    );
  });
});
