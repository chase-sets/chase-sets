import { describe, expect, it } from "vitest";
import {
  assertOfferSubmissionAllowed,
  DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY,
  MarketplaceOfferAbuseControlError,
} from "./offer-abuse-policy";

describe("marketplace offer abuse policy", () => {
  it("admits a $1 Offer against $10, $14 and $20 Listings despite legacy controls", () => {
    const legacyInput = {
      buyerDailySubmissionCount: 3,
      now: new Date("2026-10-12T12:00:00.000Z"),
      offerPriceAmount: "1.00",
      offerPriceCurrencyCode: "USD",
      listingGuards: ["10.00", "14.00", "20.00"].map((listingPriceAmount, index) => ({
        listingId: `lst_${index}`,
        listingPriceAmount,
        listingPriceCurrencyCode: "USD",
        sellerAccountId: `acc_seller_${index}`,
        buyerListingDailyOfferCount: 3,
        mutedAt: "2026-10-01T00:00:00.000Z",
        lowballCooldownUntil: "2099-01-01T00:00:00.000Z",
        lastLowballDeclinedAmount: "2.00",
      })),
    };
    expect(() => assertOfferSubmissionAllowed(legacyInput)).not.toThrow();
  });

  it("retains only the unchanged daily cap under policy v2", () => {
    expect(DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY).toEqual({
      policyVersion: "marketplace-offer-abuse-controls-v2",
      buyerDailySubmissionCap: 25,
    });
    expect(() => assertOfferSubmissionAllowed({ buyerDailySubmissionCount: 24 })).not.toThrow();
    expect(() => assertOfferSubmissionAllowed({ buyerDailySubmissionCount: 25 })).toThrow(
      MarketplaceOfferAbuseControlError,
    );
    try {
      assertOfferSubmissionAllowed({ buyerDailySubmissionCount: 25 });
    } catch (error) {
      expect(error).toMatchObject({
        code: "offer_daily_submission_cap_reached",
        details: { policyVersion: "marketplace-offer-abuse-controls-v2", limit: 25 },
      });
    }
  });

  it("enforces the caller's daily cap at its boundary", () => {
    const policy = { ...DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY, buyerDailySubmissionCap: 2 };
    expect(() => assertOfferSubmissionAllowed({ policy, buyerDailySubmissionCount: 1 })).not.toThrow();
    expect(() => assertOfferSubmissionAllowed({ policy, buyerDailySubmissionCount: 2 })).toThrow(
      MarketplaceOfferAbuseControlError,
    );
  });
});
