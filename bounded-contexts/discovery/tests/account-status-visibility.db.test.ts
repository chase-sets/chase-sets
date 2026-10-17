import { describe, expect, it } from "vitest";
import {
  buyerVisibleListingPredicateSql,
  buyerVisibleOfferPredicateSql,
} from "../support/market-support/listing-visibility";

describe("account status visibility DB contract", () => {
  it("fails closed for missing or inactive account mirrors on Listing and Offer reads", () => {
    const listing = buyerVisibleListingPredicateSql("listing", "account");
    const offer = buyerVisibleOfferPredicateSql("offer", "account");
    expect(listing).toContain("account.status = 'active'");
    expect(offer).toContain("account.status = 'active'");
    expect(offer).toContain("offer.status = 'submitted'");
  });
});
