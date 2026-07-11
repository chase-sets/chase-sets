import { addMoneyAmounts, applyBasisPointsToMoneyAmount, compareMoneyAmounts } from "@chase-sets/primitives/money";
import { normalizeMoneyAmount } from "./common";

/**
 * The authenticity-check fee quote engine (m109). Mirrors
 * `quoteMarketplaceCheckoutFee` (`@chase-sets/payments/server`): a pure,
 * fingerprinted quote function operating on a plain-data policy value.
 * Ordering owns this because it is the context that both offers the
 * provisional quote (`previewCheckoutFulfillment`) and freezes the
 * authoritative quote onto the order at creation time -- unlike the
 * marketplace checkout fee, this fee is fixed before payment, not at
 * payment-method-selection time, so there is a single consumer and no
 * separate host-port-holding context is warranted.
 */

export const authenticityCheckFeeCategories = ["raw", "graded", "any"] as const;

export type AuthenticityCheckFeeCategory = (typeof authenticityCheckFeeCategories)[number];

export type AuthenticityCheckFeeBand = Readonly<{
  minOrderValueAmount: string;
  category: AuthenticityCheckFeeCategory;
  flatAmount: string;
  percentageBps: number;
  capAmount: string;
}>;

/**
 * The plain-data policy shape Ordering depends on. Commercial Terms
 * declares the authoritative version via `definePolicy` (see
 * `@chase-sets/commercial-terms/server`'s `authenticityFeePolicy`);
 * Ordering only depends on this shape, never on Commercial Terms' storage.
 */
export type AuthenticityCheckFeePolicyValue = Readonly<{
  optInThresholdAmount: string;
  bands: readonly AuthenticityCheckFeeBand[];
}>;

export const AUTHENTICITY_CHECK_FEE_QUOTE_FORMAT_VERSION = "authenticity-check-fee-v1";

export const defaultAuthenticityCheckFeePolicyValue: AuthenticityCheckFeePolicyValue = {
  optInThresholdAmount: "100.00",
  bands: [
    {
      minOrderValueAmount: "0.00",
      category: "any",
      flatAmount: "8.00",
      percentageBps: 200,
      capAmount: "50.00",
    },
  ],
};

export type AuthenticityCheckFeeQuote = Readonly<{
  eligible: boolean;
  order_value_amount: string;
  threshold_amount: string;
  category: AuthenticityCheckFeeCategory;
  fee_amount: string;
  policy_version: string;
  quote_fingerprint: string;
  quoted_at: string;
}>;

function resolveBand(
  policy: AuthenticityCheckFeePolicyValue,
  orderValueAmount: string,
  category: AuthenticityCheckFeeCategory,
): AuthenticityCheckFeeBand | null {
  const matching = policy.bands.filter(
    (band) =>
      (band.category === category || band.category === "any") &&
      compareMoneyAmounts(orderValueAmount, band.minOrderValueAmount) >= 0,
  );
  if (matching.length === 0) {
    return null;
  }

  return matching.reduce((best, candidate) => {
    const minValueComparison = compareMoneyAmounts(candidate.minOrderValueAmount, best.minOrderValueAmount);
    if (minValueComparison !== 0) {
      return minValueComparison > 0 ? candidate : best;
    }
    // Tie on minimum order value: prefer the band whose category matches
    // exactly over the "any" catch-all band.
    return candidate.category === category && best.category !== category ? candidate : best;
  });
}

/**
 * Quotes the authenticity-check fee for a declared order value. Eligibility
 * (order value at/above `optInThresholdAmount`) and the banded flat +
 * percentage-of-order-value fee (capped) are both derived from the
 * resolved policy. Always returns a quote (with `eligible: false` and a
 * zero fee amount when the order value is below threshold or no band
 * matches) so callers can render a consistent "not offered" state and so
 * the fingerprint always covers the full decision, not just the amount.
 */
export function quoteAuthenticityCheckFee(
  params: Readonly<{
    orderValueAmount: string;
    category?: AuthenticityCheckFeeCategory;
    quotedAt?: string;
  }>,
  policy: AuthenticityCheckFeePolicyValue = defaultAuthenticityCheckFeePolicyValue,
): AuthenticityCheckFeeQuote {
  const orderValueAmount = normalizeMoneyAmount(params.orderValueAmount, {
    fieldName: "Order value",
    allowZero: true,
  });
  const category = params.category ?? "any";
  const thresholdAmount = normalizeMoneyAmount(policy.optInThresholdAmount, {
    fieldName: "Authenticity fee opt-in threshold",
    allowZero: true,
  });
  const quotedAt = params.quotedAt ?? new Date().toISOString();
  const meetsThreshold = compareMoneyAmounts(orderValueAmount, thresholdAmount) >= 0;
  const band = meetsThreshold ? resolveBand(policy, orderValueAmount, category) : null;
  const eligible = band !== null;

  const feeAmount = band
    ? minMoney(
        addMoneyAmounts(band.flatAmount, applyBasisPointsToMoneyAmount(orderValueAmount, band.percentageBps, "ceil")),
        band.capAmount,
      )
    : "0.00";

  const quoteFingerprint = [
    AUTHENTICITY_CHECK_FEE_QUOTE_FORMAT_VERSION,
    eligible ? "eligible" : "ineligible",
    orderValueAmount,
    thresholdAmount,
    category,
    feeAmount,
  ].join("|");

  return {
    eligible,
    order_value_amount: orderValueAmount,
    threshold_amount: thresholdAmount,
    category,
    fee_amount: feeAmount,
    policy_version: AUTHENTICITY_CHECK_FEE_QUOTE_FORMAT_VERSION,
    quote_fingerprint: quoteFingerprint,
    quoted_at: quotedAt,
  };
}

function minMoney(left: string, right: string) {
  return compareMoneyAmounts(left, right) <= 0 ? left : right;
}
