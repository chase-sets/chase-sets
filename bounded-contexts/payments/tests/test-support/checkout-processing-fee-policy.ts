import type { CheckoutProcessingFeePolicyResolver } from "../../features/payments/api/checkout-processing-fee-policy-resolver";
import type { MarketplaceCheckoutFeePolicyValue } from "../../features/payments/api/marketplace-checkout-fee-policy";

/**
 * The checkout processing-fee policy value Payments tests quote against:
 * 2.9% plus $0.30 for card, 0.5% for bank account and nothing for platform
 * credit. It is an input to the quote calculation under test, stated here so
 * every expected amount in those tests can be derived from it. It is not a
 * default: production quotes only from the value the wired resolver supplies.
 */
export const quotedCheckoutProcessingFeePolicyValue: MarketplaceCheckoutFeePolicyValue = {
  enabledJurisdictions: ["US"],
  base: { percentageBps: 290, fixedAmount: "0.30" },
  methodAdjustments: [
    { paymentMethodCategory: "card", percentageBpsDelta: 0, fixedAmountDelta: "0.00" },
    { paymentMethodCategory: "bank-account", percentageBpsDelta: -240, fixedAmountDelta: "-0.30" },
    { paymentMethodCategory: "platform-credit", percentageBpsDelta: -290, fixedAmountDelta: "-0.30" },
  ],
};

/** A resolver that answers every quote with the given policy value, as the host port does for an active document. */
export function checkoutProcessingFeePolicyResolverFor(
  value: MarketplaceCheckoutFeePolicyValue,
): CheckoutProcessingFeePolicyResolver {
  return {
    resolveCheckoutProcessingFeePolicy: async () => ({
      value,
      source: "policy",
      documentId: "pol_synthetic_checkout_processing_fee",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      resolvedAt: "2026-01-01T00:00:00.000Z",
    }),
  };
}
