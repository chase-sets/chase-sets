import { describe, expect, it } from "vitest";
import {
  createProductionTaxQuoteResolverBlocker,
  productionTaxQuoteProviderMissingMessage,
  shouldBlockProductionTaxQuotes,
} from "../src/tax-readiness";

describe("platform api tax readiness", () => {
  it("blocks production tax quotes when collection requires a provider-backed resolver", async () => {
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

  it("only installs the blocker when production tax collection requires provider-backed quotes", () => {
    expect(shouldBlockProductionTaxQuotes("production", true)).toBe(true);
    expect(shouldBlockProductionTaxQuotes("production", false)).toBe(false);
    expect(shouldBlockProductionTaxQuotes("staging", true)).toBe(false);
    expect(shouldBlockProductionTaxQuotes("dev", true)).toBe(false);
    expect(shouldBlockProductionTaxQuotes(null, true)).toBe(false);
  });
});
