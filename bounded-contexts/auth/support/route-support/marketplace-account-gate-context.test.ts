import { describe, expect, it } from "vitest";
import { marketplaceAccountGateContextMessage } from "./marketplace-account-gate-context";

describe("marketplace account gate context", () => {
  it("explains seller checkout account gates for local return paths", () => {
    expect(marketplaceAccountGateContextMessage("/account/sell-list?registrationReturn=seller-checkout")).toEqual({
      title: "Use an account to continue seller checkout",
      description:
        "Your Sell List is saved. An account is required before offer acceptance, listing publication, payout, or shipping label work starts.",
    });
  });

  it("explains listing draft account gates for local return paths", () => {
    expect(marketplaceAccountGateContextMessage("/account/listings/new?claimListingIntent=ldi_1")).toEqual({
      title: "Use an account to publish this listing",
      description:
        "Your listing draft is saved. An account is required before inventory, payout, and listing publication can be confirmed.",
    });
  });

  it("does not classify external return paths", () => {
    expect(
      marketplaceAccountGateContextMessage("https://example.test/account/sell-list?registrationReturn=seller-checkout"),
    ).toBeNull();
  });
});
