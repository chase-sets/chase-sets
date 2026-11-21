import { describe, expect, it, vi } from "vitest";
import type { PaymentsCheckoutStatus } from "@chase-sets/payments/server";
import { readCheckoutPaymentPreviewStatus } from "./payment-preview";

// A quote under a revised checkout processing fee policy: not what the compiled default would give.
const revisedCardQuote = {
  payment_method_category: "card" as const,
  external_basis_amount: "26.00",
  marketplace_checkout_fee_amount: "2.50",
  marketplace_checkout_fee_reduction_amount: "0.00",
  total_amount: "28.50",
  processor_amount: "28.50",
  policy_version: "checkout-processing-fee@2",
  quote_fingerprint: "marketplace-checkout-fee-v1|card|26.00|0.00|26.00|2.50|28.50|28.50",
  quoted_at: "2026-11-21T00:00:00.000Z",
};

const paymentsStatus: PaymentsCheckoutStatus = {
  order_ids: [],
  currency_code: "usd",
  amount: "26.00",
  marketplace_checkout_fee: revisedCardQuote,
  payment_method_quotes: [revisedCardQuote],
  wallet_credit: { requested_amount: "0.00", applied_amount: "0.00", external_amount: "26.00" },
  can_start_payment: true,
  unavailable_reasons: [],
  unavailable_reason_details: [],
};

describe("checkout payment preview", () => {
  it("shows the quote Payments makes from its resolved policy, for the checkout's orders", async () => {
    const previewCheckoutStatus = vi.fn(async () => paymentsStatus);

    const preview = await readCheckoutPaymentPreviewStatus(
      { previewCheckoutStatus },
      {
        orderIds: ["ord_1"],
        amount: "26.00",
        currencyCode: "usd",
        requestedBalanceCreditAmount: "0.00",
        paymentMethodCategory: "card",
      },
    );

    expect(previewCheckoutStatus).toHaveBeenCalledExactlyOnceWith({
      amount: "26.00",
      currencyCode: "usd",
      requestedBalanceCreditAmount: "0.00",
      paymentMethodCategory: "card",
    });
    expect(preview).toEqual({ ...paymentsStatus, order_ids: ["ord_1"] });
    expect(preview?.marketplace_checkout_fee.quote_fingerprint).toBe(revisedCardQuote.quote_fingerprint);
  });

  it("gives no preview when Payments cannot quote", async () => {
    const preview = await readCheckoutPaymentPreviewStatus(
      {
        previewCheckoutStatus: async () => {
          throw new Error("payments unavailable");
        },
      },
      {
        orderIds: [],
        amount: "26.00",
        currencyCode: "usd",
        requestedBalanceCreditAmount: "0.00",
        paymentMethodCategory: "card",
      },
    );

    expect(preview).toBeNull();
  });
});
