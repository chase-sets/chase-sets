import { describe, expect, it } from "vitest";
import {
  marketplaceCheckoutFeePaymentMethodCategories,
  marketplaceCheckoutFeePolicy,
  normalizeMarketplaceCheckoutFeePaymentMethodCategory,
  quoteMarketplaceCheckoutFee,
} from "./marketplace-checkout-fee-policy";

describe("marketplace checkout fee policy", () => {
  it("quotes the canonical card checkout fee fingerprint", () => {
    expect(
      quoteMarketplaceCheckoutFee({
        orderAmount: "26.00",
        externalBasisAmount: "26.00",
        balanceCreditAmount: "0.00",
        paymentMethodCategory: "card",
        quotedAt: "2026-05-03T00:00:00.000Z",
      }),
    ).toMatchObject({
      payment_method_category: "card",
      marketplace_checkout_fee_amount: "1.09",
      total_amount: "27.09",
      processor_amount: "27.09",
      quote_fingerprint: "marketplace-checkout-fee-v1|card|26.00|0.00|26.00|1.09|27.09|27.09",
    });
  });

  it("normalizes aliases and publishes matching policy categories", () => {
    expect(normalizeMarketplaceCheckoutFeePaymentMethodCategory("bank_account")).toBe("bank-account");
    expect(normalizeMarketplaceCheckoutFeePaymentMethodCategory("credit")).toBe("platform-credit");
    expect(
      marketplaceCheckoutFeePolicy().method_adjustments.map((adjustment) => adjustment.payment_method_category),
    ).toEqual([...marketplaceCheckoutFeePaymentMethodCategories]);
  });

  it.each(["1e2", "12.999", "12.34abc", "-0.75"])("rejects malformed checkout fee amount %s", (amount) => {
    expect(() =>
      quoteMarketplaceCheckoutFee({
        orderAmount: amount,
        externalBasisAmount: amount,
        balanceCreditAmount: "0.00",
        paymentMethodCategory: "card",
      }),
    ).toThrow("Checkout amount must be a valid decimal.");
  });
});
