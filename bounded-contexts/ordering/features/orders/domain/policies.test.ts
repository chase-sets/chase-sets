import { describe, expect, it } from "vitest";
import {
  calculateOrderFulfillmentEconomics,
  quoteMarketplaceSalesFeeFromSnapshot,
  resolveOrderPaymentDeadline,
  resolveTerminalPaymentFailureDeadline,
} from "./policies";

describe("ordering Order Protection economics (#4098)", () => {
  it.each([
    ["10.00", "0.10", "0.40", "4.10", "4.10", "13.50"],
    ["50.00", "0.50", "2.00", "2.50", "2.50", "49.50"],
    ["125.00", "1.25", "4.50", "0.00", "0.00", "117.50"],
    ["500.00", "5.00", "4.50", "0.00", "0.00", "470.00"],
  ])(
    "documents the $%s buyer Shipping line, seller payout, and reserve split byte-exactly",
    (itemSubtotal, protection, shippingAllowance, shippingOverage, buyerShipping, sellerPayout) => {
      const economics = calculateOrderFulfillmentEconomics({
        itemSubtotalAmount: itemSubtotal,
        shippingBaseAmount: "4.50",
        shippingAllowancePercentageBps: 500,
      });
      const fee = quoteMarketplaceSalesFeeFromSnapshot(itemSubtotal, {
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: "25.00",
      });
      const payoutCents =
        BigInt(fee.sellerNetUnitAmount.replace(".", "")) +
        BigInt(economics.sellerShippingPayoutAmount.replace(".", "")) -
        BigInt(economics.protectionAllowanceAmount.replace(".", ""));

      expect(economics).toEqual({
        shippingBaseAmount: "4.50",
        shippingDiscountAmount: shippingAllowance,
        shippingAllowanceAmount: shippingAllowance,
        shippingOverageAmount: shippingOverage,
        sellerShippingPayoutAmount: shippingOverage,
        protectionAmount: protection,
        protectionAllowanceAmount: protection,
        protectionOverageAmount: "0.00",
        shippingChargeAmount: buyerShipping,
      });
      expect(`${payoutCents / 100n}.${String(payoutCents % 100n).padStart(2, "0")}`).toBe(sellerPayout);
    },
  );

  it("funds protection before shipping and rounds up to keep every positive order covered", () => {
    expect(
      calculateOrderFulfillmentEconomics({
        itemSubtotalAmount: "0.01",
        shippingBaseAmount: "0.00",
        shippingAllowancePercentageBps: 0,
      }),
    ).toMatchObject({
      protectionAmount: "0.01",
      protectionAllowanceAmount: "0.00",
      protectionOverageAmount: "0.01",
      shippingChargeAmount: "0.01",
    });
  });
});

describe("ordering marketplace sales fee snapshots", () => {
  it.each([
    ["10.00", "0.50", "9.50"],
    ["400.00", "20.00", "380.00"],
    ["600.00", "25.00", "575.00"],
    ["1000.00", "25.00", "975.00"],
  ])("recomputes $%s from the byte-exact locked formula", (unitPriceAmount, fee, sellerNet) => {
    expect(
      quoteMarketplaceSalesFeeFromSnapshot(unitPriceAmount, {
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: "25.00",
      }),
    ).toEqual({ marketplaceSalesFeeUnitAmount: fee, sellerNetUnitAmount: sellerNet });
  });
});

describe("ordering payment deadline policies", () => {
  it.each([
    ["card", "2026-03-31T01:00:00.000Z", "ordering-payment-deadline-card-v1"],
    ["bank-account", "2026-04-05T00:00:00.000Z", "ordering-payment-deadline-bank-account-v1"],
    ["platform-credit", "2026-03-31T00:15:00.000Z", "ordering-payment-deadline-platform-credit-v1"],
  ] as const)(
    "resolves %s deadlines through policy tokens",
    (methodCategory, paymentDeadlineAt, paymentDeadlinePolicy) => {
      expect(resolveOrderPaymentDeadline("2026-03-31T00:00:00.000Z", methodCategory)).toEqual({
        paymentDeadlineAt,
        paymentDeadlinePolicy,
      });
    },
  );

  it("uses the terminal-failure grace token for failed payment windows", () => {
    expect(resolveTerminalPaymentFailureDeadline("2026-03-31T00:00:00.000Z")).toEqual({
      paymentDeadlineAt: "2026-03-31T00:05:00.000Z",
      paymentDeadlinePolicy: "ordering-payment-deadline-terminal-failure-grace-v1",
    });
  });
});
