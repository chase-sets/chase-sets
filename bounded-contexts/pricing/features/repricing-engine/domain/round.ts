import { pricingGoalDefinitions, resolvePricingGoal, type RepricingRule } from "../../repricing-policies/domain/domain";
import { validateParameters, type PricingGoalDefinition } from "../../repricing-policies/domain/goals/registry";
import type { PortfolioListing } from "../../repricing-policies/domain/portfolio/portfolio";
import {
  evaluateRepricingListing,
  matchRepricingRule,
  reachPortfolioAnchor,
  type RepricingListingEvaluation,
  type RepricingListingEvaluationInput,
  type RepricingMarketInputSnapshot,
  type RepricingPortfolioAssignment,
  type RepricingPortfolioReach,
} from "./evaluate";
import type { RepricingEvaluationSkipReason, RepricingPolicyListingTrace, ShadowGoalTrace } from "./fact";
import type { RepricingEnginePolicyValue } from "./policy";
import type { RepricingRoundInputs, RepricingRoundListing } from "../read-model/queries";

export function planRepricingRound(
  round: RepricingRoundInputs,
  capturedAt: string,
  policy: RepricingEnginePolicyValue,
): readonly RepricingListingEvaluation[] {
  const entries = round.listings.map((listing) => ({
    listing,
    input: evaluationInput(listing),
    snapshot: listingSnapshot(round, listing, capturedAt, policy),
  }));
  const portfolios = planRoundPortfolios(entries);
  return entries.map(({ input, snapshot }) =>
    evaluateRepricingListing(input, snapshot, undefined, portfolios.get(input.listingId)),
  );
}

/**
 * One Portfolio Plan per policy and portfolio goal anchor in the round,
 * resolved once over every listing whose chain reaches that anchor, then
 * applied to each through its own stages. A plan never spans policies, so one
 * seller's listings never move another's.
 */
function planRoundPortfolios(
  entries: readonly Readonly<{
    listing: RepricingRoundListing;
    input: RepricingListingEvaluationInput;
    snapshot: RepricingMarketInputSnapshot;
  }>[],
): ReadonlyMap<string, RepricingPortfolioAssignment> {
  const groups = new Map<
    string,
    { reach: RepricingPortfolioReach; members: { listingId: string; reach: RepricingPortfolioReach }[] }
  >();
  for (const { listing, input, snapshot } of entries) {
    const reach = reachPortfolioAnchor(input, snapshot);
    if (reach === null) continue;
    const parameters = Object.entries(reach.parameters).sort(([left], [right]) => (left < right ? -1 : 1));
    const key = JSON.stringify([listing.policyId, reach.currencyCode, reach.goal.id, reach.goal.version, parameters]);
    const group = groups.get(key) ?? { reach, members: [] };
    group.members.push({ listingId: listing.listingId, reach });
    groups.set(key, group);
  }
  const assignments = new Map<string, RepricingPortfolioAssignment>();
  for (const { reach, members } of groups.values()) {
    const plan = reach.goal.solvePortfolio!({
      currencyCode: reach.currencyCode,
      listings: members.map(
        ({ listingId, reach: member }): PortfolioListing => ({
          listingId,
          currentPriceAmount: member.currentPriceAmount,
          curve: member.curve,
          constraint: member.constraint,
        }),
      ),
      parameters: reach.parameters,
    });
    const results = new Map(plan.listings.map((result) => [result.listingId, result]));
    for (const { listingId, reach: member } of members)
      assignments.set(listingId, {
        planId: plan.planId,
        anchorIndex: member.anchorIndex,
        result: results.get(listingId)!,
      });
  }
  return assignments;
}

/** Live-only evidence, separate from the incumbent plan consumed by every money path. */
export function planRepricingShadows(
  round: RepricingRoundInputs,
  capturedAt: string,
  policy: RepricingEnginePolicyValue,
): ReadonlyMap<string, readonly ShadowGoalTrace[]> {
  const shadows = pricingGoalDefinitions().filter((goal) => goal.lifecycle === "shadow");
  const traces = new Map<string, readonly ShadowGoalTrace[]>();
  if (shadows.length === 0) return traces;
  for (const listing of round.listings) {
    const entries = evaluateShadowGoals(
      evaluationInput(listing),
      listingSnapshot(round, listing, capturedAt, policy),
      shadows,
    );
    if (entries.length > 0) traces.set(listing.listingId, entries);
  }
  return traces;
}

export function evaluateShadowGoals(
  listing: RepricingListingEvaluationInput,
  snapshot: RepricingMarketInputSnapshot,
  definitions: readonly PricingGoalDefinition[],
): readonly ShadowGoalTrace[] {
  const shadows = definitions.filter((goal) => goal.lifecycle === "shadow");
  if (shadows.length === 0) return [];
  const match = matchRepricingRule(listing, snapshot);
  if (match === null) return [];
  return match.rule.directive.anchorChain.flatMap((anchor, anchorIndex): ShadowGoalTrace[] => {
    if (anchor.source !== "curve-objective") return [];
    const shadow = shadows.find((goal) => goal.id === anchor.goalId);
    if (!shadow) return [];
    const identity = { goalId: shadow.id, goalVersion: shadow.version, anchorIndex };
    if (validateParameters(shadow.parameterSchema, anchor.parameters).kind === "rejected") {
      return [
        {
          ...identity,
          curveVersion: null,
          targetPriceAmount: null,
          action: null,
          skipReason: null,
          anchor: null,
          flags: [],
          skipped: "parameters-incompatible",
        },
      ];
    }
    const rules = listing.rules.map((rule, ruleIndex) =>
      ruleIndex !== match.ruleIndex
        ? rule
        : {
            ...rule,
            directive: {
              ...rule.directive,
              anchorChain: rule.directive.anchorChain.map((candidate, index) =>
                index === anchorIndex ? { ...anchor, goalVersion: shadow.version } : candidate,
              ),
            },
          },
    );
    const {
      targetPriceAmount,
      action,
      skipReason,
      anchor: resolvedAnchor,
      flags,
    } = evaluateRepricingListing({ ...listing, rules }, snapshot, anchorIndex);
    return [
      {
        ...identity,
        curveVersion: snapshot.demandCurve?.version ?? null,
        targetPriceAmount,
        action,
        skipReason,
        anchor: resolvedAnchor,
        flags,
        skipped: null,
      },
    ];
  });
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
  return rule.directive.anchorChain.some((anchor) => {
    if (anchor.source !== "curve-objective") return false;
    const goal = resolvePricingGoal(anchor.goalId, anchor.goalVersion);
    return goal?.lifecycle === "selectable" && goal.requiresEconomics;
  });
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
    ...(evaluation.portfolioPlanId === undefined ? {} : { portfolioPlanId: evaluation.portfolioPlanId }),
    outcome,
    skipReason,
  };
}
