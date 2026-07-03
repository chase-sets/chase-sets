import { compareMoney, addMoney, normalizeMoneyAmount, subtractMoney } from "../../../support/runtime-support/common";
import { grossUpMoneyAmountByBasisPoints } from "@chase-sets/primitives/money";

export const marketplaceCheckoutFeePaymentMethodCategories = ["card", "bank-account", "platform-credit"] as const;

export type MarketplaceCheckoutFeePaymentMethodCategory =
  (typeof marketplaceCheckoutFeePaymentMethodCategories)[number];

export type MarketplaceCheckoutFeeQuote = Readonly<{
  payment_method_category: MarketplaceCheckoutFeePaymentMethodCategory;
  external_basis_amount: string;
  marketplace_checkout_fee_amount: string;
  marketplace_checkout_fee_reduction_amount: string;
  total_amount: string;
  processor_amount: string;
  policy_version: string;
  quote_fingerprint: string;
  quoted_at: string;
}>;

export type MarketplaceCheckoutFeePolicy = Readonly<{
  policy_version: string;
  effective_at: string;
  enabled_jurisdictions: readonly string[];
  base: Readonly<{
    percentage_bps: number;
    fixed_amount: string;
  }>;
  method_adjustments: readonly Readonly<{
    payment_method_category: MarketplaceCheckoutFeePaymentMethodCategory;
    percentage_bps_delta: number;
    fixed_amount_delta: string;
    resulting_percentage_bps: number;
    resulting_fixed_amount: string;
  }>[];
  unsupported_methods_default: "no-positive-fee";
  quote_audit: Readonly<{
    confirmation_required: true;
    stale_response_code: 409;
    stale_response_error: "fee_quote_stale";
    snapshot_fields: readonly string[];
  }>;
}>;

export function normalizeMarketplaceCheckoutFeePaymentMethodCategory(
  value: string | null | undefined,
): MarketplaceCheckoutFeePaymentMethodCategory {
  switch ((value ?? "card").trim()) {
    case "bank-account":
    case "bank_account":
    case "bank":
      return "bank-account";
    case "platform-credit":
    case "platform_credit":
    case "credit":
      return "platform-credit";
    default:
      return "card";
  }
}

export function quoteMarketplaceCheckoutFee(
  params: Readonly<{
    orderAmount: string;
    externalBasisAmount: string;
    balanceCreditAmount: string;
    paymentMethodCategory: MarketplaceCheckoutFeePaymentMethodCategory;
    quotedAt?: string;
  }>,
): MarketplaceCheckoutFeeQuote {
  const policyVersion = "marketplace-checkout-fee-v1";
  const orderAmount = normalizeMoneyAmount(params.orderAmount, {
    fieldName: "Checkout amount",
    allowZero: true,
  });
  const externalBasisAmount = normalizeMoneyAmount(params.externalBasisAmount, {
    fieldName: "External payment amount",
    allowZero: true,
  });
  const balanceCreditAmount = normalizeMoneyAmount(params.balanceCreditAmount, {
    fieldName: "Balance credit amount",
    allowZero: true,
  });
  const method = compareMoney(externalBasisAmount, "0.00") === 0 ? "platform-credit" : params.paymentMethodCategory;
  const rateBps = method === "platform-credit" ? 0 : method === "bank-account" ? 50 : 290;
  const fixedAmount = method === "card" ? "0.30" : "0.00";
  const feeAmount =
    rateBps > 0 || compareMoney(fixedAmount, "0.00") > 0
      ? grossUpMoneyAmountByBasisPoints({
          basisAmount: externalBasisAmount,
          percentageBps: rateBps,
          fixedAmount,
          roundingMode: "ceil",
        })
      : "0.00";
  const cardFeeAmount =
    compareMoney(externalBasisAmount, "0.00") > 0
      ? grossUpMoneyAmountByBasisPoints({
          basisAmount: externalBasisAmount,
          percentageBps: 290,
          fixedAmount: "0.30",
          roundingMode: "ceil",
        })
      : "0.00";
  const reductionAmount = compareMoney(cardFeeAmount, feeAmount) > 0 ? subtractMoney(cardFeeAmount, feeAmount) : "0.00";
  const totalAmount = addMoney(orderAmount, feeAmount);
  const processorAmount = addMoney(externalBasisAmount, feeAmount);
  const quotedAt = params.quotedAt ?? new Date().toISOString();
  const quoteFingerprint = [
    policyVersion,
    method,
    orderAmount,
    balanceCreditAmount,
    externalBasisAmount,
    feeAmount,
    totalAmount,
    processorAmount,
  ].join("|");

  return {
    payment_method_category: method,
    external_basis_amount: externalBasisAmount,
    marketplace_checkout_fee_amount: feeAmount,
    marketplace_checkout_fee_reduction_amount: reductionAmount,
    total_amount: totalAmount,
    processor_amount: processorAmount,
    policy_version: policyVersion,
    quote_fingerprint: quoteFingerprint,
    quoted_at: quotedAt,
  };
}

export function marketplaceCheckoutFeePolicy(): MarketplaceCheckoutFeePolicy {
  return {
    policy_version: "marketplace-checkout-fee-v1",
    effective_at: "2026-05-03T00:00:00.000Z",
    enabled_jurisdictions: ["US"],
    base: {
      percentage_bps: 290,
      fixed_amount: "0.30",
    },
    method_adjustments: [
      {
        payment_method_category: "card",
        percentage_bps_delta: 0,
        fixed_amount_delta: "0.00",
        resulting_percentage_bps: 290,
        resulting_fixed_amount: "0.30",
      },
      {
        payment_method_category: "bank-account",
        percentage_bps_delta: -240,
        fixed_amount_delta: "-0.30",
        resulting_percentage_bps: 50,
        resulting_fixed_amount: "0.00",
      },
      {
        payment_method_category: "platform-credit",
        percentage_bps_delta: -290,
        fixed_amount_delta: "-0.30",
        resulting_percentage_bps: 0,
        resulting_fixed_amount: "0.00",
      },
    ],
    unsupported_methods_default: "no-positive-fee",
    quote_audit: {
      confirmation_required: true,
      stale_response_code: 409,
      stale_response_error: "fee_quote_stale",
      snapshot_fields: [
        "marketplace_checkout_fee_amount",
        "marketplace_checkout_fee_policy_version",
        "marketplace_checkout_fee_quote_fingerprint",
        "payment_method_category",
      ],
    },
  };
}
