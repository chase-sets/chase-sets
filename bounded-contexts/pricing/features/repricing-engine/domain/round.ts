import {
  evaluateRepricingListing,
  type RepricingListingEvaluation,
  type RepricingMarketInputSnapshot,
} from "./evaluate";
import type { RepricingEvaluationSkipReason, RepricingPolicyListingTrace } from "./fact";
import type { RepricingEnginePolicyValue } from "./policy";
import type { RepricingRoundInputs } from "../read-model/queries";

export function planRepricingRound(
  round: RepricingRoundInputs,
  capturedAt: string,
  policy: RepricingEnginePolicyValue,
): readonly RepricingListingEvaluation[] {
  return round.listings.map((listing) => {
    const snapshot: RepricingMarketInputSnapshot = {
      catalogItemId: listing.catalogItemId,
      productId: listing.productId,
      capturedAt,
      hardAskOutlierPriceRatio: policy.hardAskOutlierPriceRatio,
      marketEstimate: round.marketEstimate,
      lastSold: round.lastSold
        ? {
            amount: round.lastSold.amount,
            currencyCode: round.lastSold.currencyCode,
            freshUntil: new Date(
              Date.parse(round.lastSold.soldAt) + policy.lastSoldFreshForDays * 24 * 60 * 60 * 1_000,
            ).toISOString(),
          }
        : null,
      competingAsks: round.competingAsks,
    };
    return evaluateRepricingListing(
      {
        listingId: listing.listingId,
        sellerAccountId: listing.sellerAccountId,
        currentPriceAmount: listing.priceAmount,
        currentPriceCurrencyCode: listing.priceCurrencyCode,
        currentPriceSourceVersion: listing.listingVersion,
        quantityCap: listing.quantityCap,
        categoryIds: listing.categoryIds,
        grading: listing.grading,
        createdAt: listing.createdAt,
        costBasisAmount: listing.costBasisAmount,
        costBasisCurrencyCode: listing.costBasisCurrencyCode,
        rules: listing.rules,
      },
      snapshot,
    );
  });
}

export function traceFromEvaluation(
  evaluation: RepricingListingEvaluation,
  outcome: RepricingPolicyListingTrace["outcome"],
  skipReason: RepricingEvaluationSkipReason | null,
): RepricingPolicyListingTrace {
  return {
    listingId: evaluation.listingId,
    currentPriceAmount: evaluation.currentPriceAmount,
    targetPriceAmount: evaluation.targetPriceAmount,
    ruleIndex: evaluation.ruleIndex,
    anchor: evaluation.anchor,
    exhaustedAnchors: evaluation.exhaustedAnchors,
    clamps: evaluation.clamps,
    flags: evaluation.flags,
    outcome,
    skipReason,
  };
}
