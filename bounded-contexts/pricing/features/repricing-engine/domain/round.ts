import { resolvePricingGoal, type RepricingRule } from "../../repricing-policies/domain/domain";
import {
  evaluateRepricingListing,
  matchRepricingRule,
  type RepricingListingEvaluation,
  type RepricingListingEvaluationInput,
  type RepricingMarketInputSnapshot,
} from "./evaluate";
import type { RepricingEvaluationSkipReason, RepricingPolicyListingTrace } from "./fact";
import type { RepricingEnginePolicyValue } from "./policy";
import type { RepricingRoundInputs, RepricingRoundListing } from "../read-model/queries";

export function planRepricingRound(
  round: RepricingRoundInputs,
  capturedAt: string,
  policy: RepricingEnginePolicyValue,
): readonly RepricingListingEvaluation[] {
  return round.listings.map((listing) =>
    evaluateRepricingListing(evaluationInput(listing), listingSnapshot(round, listing, capturedAt, policy)),
  );
}

/** A curve-objective anchor or any guardrail reads the product's Demand Curve. */
export function readsDemandCurve(rules: readonly RepricingRule[]): boolean {
  return rules.some(
    (rule) =>
      rule.directive.anchorChain.some((anchor) => anchor.source === "curve-objective") ||
      (rule.directive.guardrails?.length ?? 0) > 0,
  );
}

/**
 * Whether the listing's matched chain holds a curve-objective anchor whose
 * goal requires Economics. Rule matching reads only listing and market
 * inputs, never the Economics being decided.
 */
export function requiresGoalEconomics(
  round: RepricingRoundInputs,
  listing: RepricingRoundListing,
  capturedAt: string,
  policy: RepricingEnginePolicyValue,
): boolean {
  if (!listing.rules.some(holdsEconomicsGoal)) return false;
  const match = matchRepricingRule(evaluationInput(listing), listingSnapshot(round, listing, capturedAt, policy));
  return match !== null && holdsEconomicsGoal(match.rule);
}

function holdsEconomicsGoal(rule: RepricingRule): boolean {
  return rule.directive.anchorChain.some(
    (anchor) =>
      anchor.source === "curve-objective" &&
      resolvePricingGoal(anchor.goalId, anchor.goalVersion)?.requiresEconomics === true,
  );
}

function listingSnapshot(
  round: RepricingRoundInputs,
  listing: RepricingRoundListing,
  capturedAt: string,
  policy: RepricingEnginePolicyValue,
): RepricingMarketInputSnapshot {
  return {
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
    demandCurve: round.demandCurve,
    economics: listing.economics,
  };
}

function evaluationInput(listing: RepricingRoundListing): RepricingListingEvaluationInput {
  return {
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
  };
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
