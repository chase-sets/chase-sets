import { describe, expect, it } from "vitest";
import { buyerVisibleListingPredicateSql, buyerVisibleOfferPredicateSql } from "./listing-visibility";

describe("Listing and Offer visibility parity", () => {
  it("keeps the account-status counterpart in both rules", () => {
    expect(buyerVisibleListingPredicateSql("listing", "account")).toContain("account.status = 'active'");
    expect(buyerVisibleOfferPredicateSql("offer", "account")).toContain("account.status = 'active'");
  });
});
