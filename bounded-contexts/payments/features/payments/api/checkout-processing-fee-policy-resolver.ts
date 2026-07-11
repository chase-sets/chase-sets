import type { MarketplaceCheckoutFeePolicyValue } from "./marketplace-checkout-fee-policy";

export type ResolvedMarketplaceCheckoutFeePolicy = Readonly<{
  value: MarketplaceCheckoutFeePolicyValue;
  /** "policy" when an admin-managed document was active, "fallback" when the compiled default was used. */
  source: "policy" | "fallback";
  documentId: string | null;
  effectiveFrom: string | null;
  resolvedAt: string;
}>;

/**
 * Payments-owned port for resolving the checkout processing-fee policy at
 * quote time. Commercial Terms provides the concrete implementation (see
 * `@chase-sets/commercial-terms/server`'s `createCheckoutProcessingFeePolicyResolver`)
 * and it is wired in as the `checkoutProcessingFeePolicyResolver` host port
 * declared in `payments/context.json` -- Payments depends only on this
 * interface, never on Commercial Terms' package or storage.
 */
export interface CheckoutProcessingFeePolicyResolver {
  resolveCheckoutProcessingFeePolicy(params?: Readonly<{ at?: string }>): Promise<ResolvedMarketplaceCheckoutFeePolicy>;
}
