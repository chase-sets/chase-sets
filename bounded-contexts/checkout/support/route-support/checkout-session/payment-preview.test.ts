import { describe, expect, it } from "vitest";
import { quoteMarketplaceCheckoutFee } from "@chase-sets/payments/server";
import { buildCheckoutPaymentPreviewStatus } from "./payment-preview";

describe("checkout payment preview", () => {
  it("uses the Payments-owned marketplace checkout fee policy", () => {
    const preview = buildCheckoutPaymentPreviewStatus({
      amount: "26.00",
      requestedBalanceCreditAmount: "0.00",
      paymentMethodCategory: "card",
      quotedAt: "2026-05-03T00:00:00.000Z",
    });

    expect(preview.marketplace_checkout_fee).toMatchObject({
      payment_method_category: "card",
      marketplace_checkout_fee_amount: "1.09",
      total_amount: "27.09",
      quote_fingerprint: "marketplace-checkout-fee-v1|card|26.00|0.00|26.00|1.09|27.09|27.09",
    });
  });

  it.each([
    { amount: "0.01", credit: "0.00", method: "card" },
    { amount: "26.00", credit: "10.00", method: "card" },
    { amount: "37.99", credit: "0.00", method: "bank-account" },
    { amount: "42.25", credit: "42.25", method: "platform-credit" },
  ])("matches the Payments quote for $amount using $method", ({ amount, credit, method }) => {
    const preview = buildCheckoutPaymentPreviewStatus({
      amount,
      requestedBalanceCreditAmount: credit,
      paymentMethodCategory: method,
      quotedAt: "2026-05-03T00:00:00.000Z",
    });

    expect(preview.marketplace_checkout_fee).toEqual(
      quoteMarketplaceCheckoutFee({
        orderAmount: amount,
        externalBasisAmount: preview.wallet_credit.external_amount,
        balanceCreditAmount: preview.wallet_credit.applied_amount,
        paymentMethodCategory: preview.marketplace_checkout_fee.payment_method_category,
        quotedAt: "2026-05-03T00:00:00.000Z",
      }),
    );
  });

  it.each(["1e2", "12.999", "12.34abc"])("rejects malformed preview amount %s", (amount) => {
    expect(() =>
      buildCheckoutPaymentPreviewStatus({
        amount,
        requestedBalanceCreditAmount: "0.00",
        paymentMethodCategory: "card",
      }),
    ).toThrow("Checkout money amount must be a valid decimal.");
  });

  it("rejects negative preview amounts", () => {
    expect(() =>
      buildCheckoutPaymentPreviewStatus({
        amount: "-0.75",
        requestedBalanceCreditAmount: "0.00",
        paymentMethodCategory: "card",
      }),
    ).toThrow("Checkout amount must be a valid decimal.");
  });
});
