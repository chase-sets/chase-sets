import { afterEach, describe, expect, it, vi } from "vitest";
import { moneyToCents, sumMoneyAmounts, type MoneyAmount } from "@chase-sets/primitives/money";
import type { RepricingRule } from "../../repricing-policies/domain/domain";
import { holdValueGoal } from "../../repricing-policies/domain/goals/hold-value";
import type { PortfolioPlan } from "../../repricing-policies/domain/portfolio/portfolio";
import { evaluateRepricingListing, type RepricingListingEvaluation } from "../domain/evaluate";
import { REPRICING_ENGINE_LAUNCH_POLICY_VALUE } from "../domain/policy";
import { planRepricingRound } from "../domain/round";
import type { RepricingRoundInputs, RepricingRoundListing } from "../read-model/queries";
import {
  capturedAt,
  freshUntil,
  goalAnchor,
  goalDirective,
  goalListing,
  goalSnapshot,
  parityCurve,
} from "./curve-objective-fixture";

const product = { catalogItemId: "cat_portfolio_round", productId: "prod_portfolio_round" };
const holdValue = goalAnchor("hold-value", {});
// Quantity 2 matches the floored rule; both rules anchor at the same hold-value goal, so they share one plan.
const rules: RepricingRule[] = [
  {
    conditions: [{ type: "quantity-at-least", quantity: 2 }],
    directive: goalDirective({ anchorChain: [holdValue], floor: { mode: "absolute", amount: "12.00" } }),
  },
  { conditions: [], directive: goalDirective({ anchorChain: [holdValue, { source: "market-estimate" }] }) },
];

function listing(
  listingId: string,
  priceAmount: string,
  overrides: Partial<RepricingRoundListing> = {},
): RepricingRoundListing {
  return {
    listingId,
    sellerAccountId: "acc_portfolio_round",
    inventoryItemId: null,
    ...product,
    priceAmount,
    priceCurrencyCode: "USD",
    quantityCap: 1,
    listingVersion: 1,
    listingStatus: "active",
    pauseReason: null,
    categoryIds: [],
    grading: "raw",
    createdAt: "2026-07-01T00:00:00.000Z",
    costBasisAmount: null,
    costBasisCurrencyCode: null,
    policyId: "rpp_portfolio_round",
    policyRevision: "2026-10-13T00:00:00.000Z",
    rules,
    maxChangesPerDay: 100,
    economics: null,
    ...overrides,
  };
}

function round(listings: readonly RepricingRoundListing[], curveFreshUntil = freshUntil): RepricingRoundInputs {
  return {
    listings,
    competingAsks: [],
    marketEstimate: { amount: "11.00", currencyCode: "USD", freshUntil },
    lastSold: null,
    demandCurve: {
      ...product,
      version: 1,
      providerCondition: "Near Mint",
      providerVariant: "Normal",
      providerLanguage: "English",
      fingerprint: "synthetic-portfolio-round",
      modelVersion: "synthetic",
      policyRevisionId: "synthetic-policy",
      ladderMethod: "synthetic",
      anchorCondition: null,
      exposureStartReason: "history-window",
      salesCoverage: "synthetic",
      supplyStatus: "observed",
      ownSellerExclusionApplied: true,
      builtAt: "2026-10-13T11:00:00.000Z",
      currencyCode: "USD",
      freshUntil: curveFreshUntil,
      points: parityCurve.points.map((point) => ({ ...point, salesCoverage: "synthetic" })),
    },
  };
}

/** The price a listing ends the round at: its target when the round changes it, else its current price. */
const effectivePrice = (evaluation: RepricingListingEvaluation): MoneyAmount =>
  (evaluation.action === "update-price" ? evaluation.targetPriceAmount! : evaluation.currentPriceAmount) as MoneyAmount;

const plans = (spy: { mock: { results: readonly { value: unknown }[] } }) =>
  spy.mock.results.map((result) => result.value as PortfolioPlan);

describe("a round with a portfolio goal", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves one plan per policy and goal, applies it through the stages, and records its id on every listing", () => {
    const solve = vi.spyOn(holdValueGoal, "solvePortfolio");
    const floored = listing("lst_portfolio_a", "6.00", { quantityCap: 2 });
    const members = [floored, listing("lst_portfolio_b", "9.00"), listing("lst_portfolio_c", "15.00")];
    const other = listing("lst_portfolio_d", "10.00", { sellerAccountId: "acc_other", policyId: "rpp_other" });
    const evaluations = planRepricingRound(
      round([...members, other]),
      capturedAt,
      REPRICING_ENGINE_LAUNCH_POLICY_VALUE,
    );

    expect(solve).toHaveBeenCalledTimes(2);
    const [plan, otherPlan] = plans(solve);
    expect(plan!.listings.map((entry) => entry.listingId)).toEqual(members.map((member) => member.listingId));
    expect(otherPlan!.listings.map((entry) => entry.listingId)).toEqual(["lst_portfolio_d"]);
    expect(otherPlan!.planId).not.toBe(plan!.planId);
    expect(evaluations.map((evaluation) => evaluation.portfolioPlanId)).toEqual([
      plan!.planId,
      plan!.planId,
      plan!.planId,
      otherPlan!.planId,
    ]);

    // The floor raises one listing, and the plan moved the others down so the listed value still holds.
    const byId = new Map(evaluations.map((evaluation) => [evaluation.listingId, evaluation]));
    expect(byId.get("lst_portfolio_a")).toMatchObject({ targetPriceAmount: "12.00", flags: ["floor-binding"] });
    expect(plan!.status).toBe("matched");
    expect(plan!.targetValueAmount).toBe("30.00");
    const applied = members.map((member) => effectivePrice(byId.get(member.listingId)!));
    expect(sumMoneyAmounts(applied)).toBe(plan!.resolvedValueAmount);
    expect(Number(moneyToCents(plan!.resolvedValueAmount) - moneyToCents(plan!.targetValueAmount))).toBeLessThanOrEqual(
      Number(moneyToCents(plan!.valueToleranceAmount)),
    );
    // Without re-summing the constrained prices, the anchors alone miss the held value.
    const anchors = members.map((member) => byId.get(member.listingId)!.anchor!.amount as MoneyAmount);
    expect(sumMoneyAmounts(anchors)).not.toBe(plan!.targetValueAmount);
    for (const member of members) {
      const decision = plan!.listings.find((entry) => entry.listingId === member.listingId)!.decision!;
      expect(byId.get(member.listingId)!.anchor).toMatchObject({
        source: "curve-objective",
        amount: decision.unconstrainedPriceAmount,
        goal: { goalId: "hold-value", goalVersion: 1, curveVersion: 1 },
      });
    }
  });

  it("holds listings it cannot model inside the plan and lets each chain decide them, still recording the plan", () => {
    const solve = vi.spyOn(holdValueGoal, "solvePortfolio");
    const evaluations = planRepricingRound(
      round([listing("lst_portfolio_b", "9.00"), listing("lst_portfolio_c", "15.00")], "2026-10-13T11:00:00.000Z"),
      capturedAt,
      REPRICING_ENGINE_LAUNCH_POLICY_VALUE,
    );
    expect(solve).toHaveBeenCalledTimes(1);
    const [plan] = plans(solve);
    expect(plan!.status).toBe("infeasible");
    expect(plan!.listings.map((entry) => [entry.planPriceAmount, entry.heldReason])).toEqual([
      ["9.00", "curve-empty"],
      ["15.00", "curve-empty"],
    ]);
    for (const evaluation of evaluations) {
      expect(evaluation).toMatchObject({
        portfolioPlanId: plan!.planId,
        exhaustedAnchors: [{ source: "curve-objective", state: "stale" }],
        anchor: { source: "market-estimate", amount: "11.00" },
      });
    }
  });

  it("is reproducible: the same captured inputs resolve the same plan id", () => {
    const solve = vi.spyOn(holdValueGoal, "solvePortfolio");
    const inputs = round([listing("lst_portfolio_b", "9.00"), listing("lst_portfolio_c", "15.00")]);
    const first = planRepricingRound(inputs, capturedAt, REPRICING_ENGINE_LAUNCH_POLICY_VALUE);
    const second = planRepricingRound(
      { ...inputs, listings: [...inputs.listings].reverse() },
      capturedAt,
      REPRICING_ENGINE_LAUNCH_POLICY_VALUE,
    );
    expect(plans(solve)[0]).toEqual(plans(solve)[1]);
    expect(first[0]!.portfolioPlanId).toBe(second[1]!.portfolioPlanId);
  });

  it("decides a lone listing as a one-listing portfolio outside a round, and records no plan", () => {
    const evaluation = evaluateRepricingListing(
      goalListing(goalDirective({ anchorChain: [holdValue] })),
      goalSnapshot(),
    );
    expect(evaluation).toMatchObject({ anchor: { source: "curve-objective", amount: "10.00" }, action: "hold" });
    expect(evaluation).not.toHaveProperty("portfolioPlanId");
  });

  it("leaves a round without a portfolio goal exactly as before", () => {
    const solve = vi.spyOn(holdValueGoal, "solvePortfolio");
    const percentile = rules.map((rule) => ({ ...rule, directive: goalDirective() }));
    const evaluations = planRepricingRound(
      round([listing("lst_portfolio_b", "9.00", { rules: percentile })]),
      capturedAt,
      REPRICING_ENGINE_LAUNCH_POLICY_VALUE,
    );
    expect(solve).not.toHaveBeenCalled();
    expect(evaluations[0]).not.toHaveProperty("portfolioPlanId");
    expect(evaluations[0]).toMatchObject({ targetPriceAmount: "8.75" });
  });
});
