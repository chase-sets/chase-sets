import { compareMoney, addMoney, normalizeMoneyAmount, subtractMoney } from "../../../support/runtime-support/common";
import { addSignedMoneyAmounts, grossUpMoneyAmountByBasisPoints } from "@chase-sets/primitives/money";

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

/**
 * The quote-fingerprint schema/format identifier. This stays a fixed
 * constant across policy revisions -- it identifies *how* a quote is
 * assembled (field order, method resolution), not the fee values in effect
 * when it was computed. A revised policy still changes `quote_fingerprint`
 * because the amounts embedded in it change, which is what drives the
 * existing `fee_quote_stale` re-quote flow; bumping this constant is
 * reserved for actual quote-schema changes.
 */
export const MARKETPLACE_CHECKOUT_FEE_QUOTE_FORMAT_VERSION = "marketplace-checkout-fee-v1";

/** The launch policy's effective-at, used only when no policy document resolver is wired (compiled fallback). */
export const DEFAULT_MARKETPLACE_CHECKOUT_FEE_EFFECTIVE_AT = "2026-05-03T00:00:00.000Z";

export type MarketplaceCheckoutFeeMethodAdjustment = Readonly<{
  paymentMethodCategory: MarketplaceCheckoutFeePaymentMethodCategory;
  percentageBpsDelta: number;
  fixedAmountDelta: string;
}>;

/**
 * The runtime-configurable checkout processing-fee policy value: base
 * percentage/fixed terms plus per-payment-method-category adjustments and
 * the jurisdictions the policy is enabled for. This is the `Value` shape
 * Commercial Terms declares via `definePolicy` (see
 * `@chase-sets/commercial-terms/server`'s `checkoutProcessingFeePolicy`);
 * Payments only depends on this plain-data shape, never on Commercial
 * Terms' storage, so the migration invariant (compiled struct becomes the
 * fallback default only) holds without a compile-time context dependency.
 */
export type MarketplaceCheckoutFeePolicyValue = Readonly<{
  enabledJurisdictions: readonly string[];
  base: Readonly<{
    percentageBps: number;
    fixedAmount: string;
  }>;
  methodAdjustments: readonly MarketplaceCheckoutFeeMethodAdjustment[];
}>;

/** The compiled launch values (290bps + $0.30 card, 50bps bank, 0bps credit) -- the migration's byte-identical fallback default. */
export const defaultMarketplaceCheckoutFeePolicyValue: MarketplaceCheckoutFeePolicyValue = {
  enabledJurisdictions: ["US"],
  base: {
    percentageBps: 290,
    fixedAmount: "0.30",
  },
  methodAdjustments: [
    {
      paymentMethodCategory: "card",
      percentageBpsDelta: 0,
      fixedAmountDelta: "0.00",
    },
    {
      paymentMethodCategory: "bank-account",
      percentageBpsDelta: -240,
      fixedAmountDelta: "-0.30",
    },
    {
      paymentMethodCategory: "platform-credit",
      percentageBpsDelta: -290,
      fixedAmountDelta: "-0.30",
    },
  ],
};

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

/**
 * Resolves the effective percentage/fixed terms for one payment method
 * category: the policy's base terms plus that method's adjustment delta,
 * floored at zero (a policy can only reduce or waive the fee per method, never
 * invert it into a negative amount).
 */
function resolveMarketplaceCheckoutFeeMethodTerms(
  policy: MarketplaceCheckoutFeePolicyValue,
  method: MarketplaceCheckoutFeePaymentMethodCategory,
): Readonly<{ resultingPercentageBps: number; resultingFixedAmount: string }> {
  const adjustment = policy.methodAdjustments.find((candidate) => candidate.paymentMethodCategory === method);
  const percentageBpsDelta = adjustment?.percentageBpsDelta ?? 0;
  const fixedAmountDelta = adjustment?.fixedAmountDelta ?? "0.00";
  const resultingPercentageBps = Math.max(0, policy.base.percentageBps + percentageBpsDelta);
  const resultingFixedAmountSigned = addSignedMoneyAmounts(policy.base.fixedAmount, fixedAmountDelta);
  const resultingFixedAmount =
    compareMoney(resultingFixedAmountSigned, "0.00") > 0 ? normalizeMoneyAmount(resultingFixedAmountSigned) : "0.00";

  return { resultingPercentageBps, resultingFixedAmount };
}

export function quoteMarketplaceCheckoutFee(
  params: Readonly<{
    orderAmount: string;
    externalBasisAmount: string;
    balanceCreditAmount: string;
    paymentMethodCategory: MarketplaceCheckoutFeePaymentMethodCategory;
    quotedAt?: string;
  }>,
  policy: MarketplaceCheckoutFeePolicyValue = defaultMarketplaceCheckoutFeePolicyValue,
): MarketplaceCheckoutFeeQuote {
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
  const { resultingPercentageBps: rateBps, resultingFixedAmount: fixedAmount } =
    resolveMarketplaceCheckoutFeeMethodTerms(policy, method);
  const feeAmount =
    rateBps > 0 || compareMoney(fixedAmount, "0.00") > 0
      ? grossUpMoneyAmountByBasisPoints({
          basisAmount: externalBasisAmount,
          percentageBps: rateBps,
          fixedAmount,
          roundingMode: "ceil",
        })
      : "0.00";
  const cardTerms = resolveMarketplaceCheckoutFeeMethodTerms(policy, "card");
  const cardFeeAmount =
    compareMoney(externalBasisAmount, "0.00") > 0
      ? grossUpMoneyAmountByBasisPoints({
          basisAmount: externalBasisAmount,
          percentageBps: cardTerms.resultingPercentageBps,
          fixedAmount: cardTerms.resultingFixedAmount,
          roundingMode: "ceil",
        })
      : "0.00";
  const reductionAmount = compareMoney(cardFeeAmount, feeAmount) > 0 ? subtractMoney(cardFeeAmount, feeAmount) : "0.00";
  const totalAmount = addMoney(orderAmount, feeAmount);
  const processorAmount = addMoney(externalBasisAmount, feeAmount);
  const quotedAt = params.quotedAt ?? new Date().toISOString();
  const quoteFingerprint = [
    MARKETPLACE_CHECKOUT_FEE_QUOTE_FORMAT_VERSION,
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
    policy_version: MARKETPLACE_CHECKOUT_FEE_QUOTE_FORMAT_VERSION,
    quote_fingerprint: quoteFingerprint,
    quoted_at: quotedAt,
  };
}

/**
 * Builds the publishable policy struct (the `/marketplace-checkout-fee-policy`
 * endpoint payload) from a resolved policy value. Defaults to the compiled
 * fallback so existing callers that don't pass a resolved policy keep
 * publishing the launch values unchanged.
 */
export function marketplaceCheckoutFeePolicy(
  policy: MarketplaceCheckoutFeePolicyValue = defaultMarketplaceCheckoutFeePolicyValue,
  meta: Readonly<{ effectiveAt?: string | null }> = {},
): MarketplaceCheckoutFeePolicy {
  return {
    policy_version: MARKETPLACE_CHECKOUT_FEE_QUOTE_FORMAT_VERSION,
    effective_at: meta.effectiveAt ?? DEFAULT_MARKETPLACE_CHECKOUT_FEE_EFFECTIVE_AT,
    enabled_jurisdictions: policy.enabledJurisdictions,
    base: {
      percentage_bps: policy.base.percentageBps,
      fixed_amount: policy.base.fixedAmount,
    },
    method_adjustments: marketplaceCheckoutFeePaymentMethodCategories.map((category) => {
      const adjustment = policy.methodAdjustments.find((candidate) => candidate.paymentMethodCategory === category);
      const terms = resolveMarketplaceCheckoutFeeMethodTerms(policy, category);
      return {
        payment_method_category: category,
        percentage_bps_delta: adjustment?.percentageBpsDelta ?? 0,
        fixed_amount_delta: adjustment?.fixedAmountDelta ?? "0.00",
        resulting_percentage_bps: terms.resultingPercentageBps,
        resulting_fixed_amount: terms.resultingFixedAmount,
      };
    }),
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
