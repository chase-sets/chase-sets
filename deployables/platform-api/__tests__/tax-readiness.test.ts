import { describe, expect, it } from "vitest";
import {
  createProductionTaxQuoteResolverBlocker,
  productionTaxQuoteProviderMissingMessage,
  shouldBlockProductionTaxQuotes,
} from "../src/tax-readiness";

describe("platform api tax readiness", () => {
  it("blocks production tax quotes until a provider-backed resolver is composed", async () => {
    const resolver = createProductionTaxQuoteResolverBlocker();

    await expect(
      resolver.quoteTax({
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        currencyCode: "usd",
        destinationAddress: {
          name: "Buyer",
          line1: "123 Test St",
          line2: null,
          city: "Columbus",
          state: "OH",
          postalCode: "43215",
          country: "US",
        },
        itemSubtotalAmount: "12.00",
        shippingAmount: "1.00",
      }),
    ).rejects.toThrow(productionTaxQuoteProviderMissingMessage);
  });

  it("only installs the blocker for production deployment composition", () => {
    expect(shouldBlockProductionTaxQuotes("production")).toBe(true);
    expect(shouldBlockProductionTaxQuotes("staging")).toBe(false);
    expect(shouldBlockProductionTaxQuotes("dev")).toBe(false);
    expect(shouldBlockProductionTaxQuotes(null)).toBe(false);
  });
});
