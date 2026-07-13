import { loadPublicPolicyValues } from "../../features/help/integrations/public-policy-values-client";
import {
  toPublicMarketplaceFeeSchedule,
  type PublicMarketplaceFeeSchedule,
} from "../../features/waitlist/ui/fee-comparison-calculator";
import {
  buildCheckoutFeePreview,
  fallbackCheckoutFeePreview,
  selectCheckoutProcessingTerms,
  type CheckoutFeePreview,
} from "../../features/waitlist/ui/checkout-fee-preview";

// One whitelisted public policy read powers every public fee surface (the
// landing page and the /compare/* pages), each with its own failure doctrine:
// - Buyer-side checkout fee preview: falls back to the compiled launch terms
//   when the read is unavailable (the same compiled-fallback doctrine
//   Payments applies to this policy), so the landing page always renders.
// - Seller fee calculator: truth-gated — its Chase Sets numbers come only
//   from the live schedule, so on failure it hides (null) rather than
//   showing stale or invented numbers.
// A short in-process cache (only when both derivations succeed) keeps the
// highest-traffic pages from hitting the uncached policy read on every SSR
// while staying inside the six-minute propagation bound the /sales-fees
// article promises, and the read itself is bounded so a slow policy source
// can never stall public SSR.
export type LandingFeePresentation = Readonly<{
  checkoutFeePreview: CheckoutFeePreview;
  feeSchedule: PublicMarketplaceFeeSchedule | null;
}>;
const LANDING_FEE_CACHE_MS = 5 * 60 * 1000;
const LANDING_FEE_READ_TIMEOUT_MS = 2_000;
let landingFeeCache: Readonly<{ presentation: LandingFeePresentation; expiresAt: number }> | null = null;

export async function loadLandingFeePresentation(request: Request): Promise<LandingFeePresentation> {
  if (landingFeeCache && landingFeeCache.expiresAt > Date.now()) {
    return landingFeeCache.presentation;
  }

  let checkoutFeePreview: CheckoutFeePreview = fallbackCheckoutFeePreview;
  let feeSchedule: PublicMarketplaceFeeSchedule | null = null;
  let policyValues: Awaited<ReturnType<typeof loadPublicPolicyValues>> | null = null;
  const failures: unknown[] = [];
  try {
    policyValues = await loadPublicPolicyValues(request, {
      signal: AbortSignal.timeout(LANDING_FEE_READ_TIMEOUT_MS),
    });
  } catch (error) {
    failures.push(error);
  }
  if (policyValues) {
    try {
      checkoutFeePreview = buildCheckoutFeePreview(selectCheckoutProcessingTerms(policyValues.values));
    } catch (error) {
      failures.push(error);
    }
    try {
      feeSchedule = toPublicMarketplaceFeeSchedule(policyValues);
    } catch (error) {
      failures.push(error);
    }
  }

  if (checkoutFeePreview === fallbackCheckoutFeePreview && process.env.NODE_ENV !== "production") {
    const error = failures[0];
    console.warn(
      `[public-presence] Live checkout processing terms are unavailable; the landing preview is using the compiled launch terms. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (feeSchedule === null) {
    console.error(
      "[public-presence] Fee-calculator policy read failed; the fee calculator will not render.",
      failures[failures.length - 1],
    );
  }

  const presentation: LandingFeePresentation = { checkoutFeePreview, feeSchedule };
  if (failures.length === 0) {
    landingFeeCache = { presentation, expiresAt: Date.now() + LANDING_FEE_CACHE_MS };
  }
  return presentation;
}
