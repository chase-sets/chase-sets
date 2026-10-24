import { describe, expect, it } from "vitest";
import type { CurvePoint } from "../../market-estimates/domain/demand-curve/curve";
import { pricingGoalDefinitions, type RepricingRuleDirective } from "../../repricing-policies/domain/domain";
import { resolvedGoalEconomics } from "../../repricing-policies/tests/fixtures/goal-economics";
import { evaluateRepricingListing, type RepricingListingEconomics } from "../domain/evaluate";
import {
  freshUntil,
  goalAnchor,
  goalDirective,
  goalListing,
  goalSnapshot,
  otherSellerHardAsk,
  parityCurve,
  recordedDecision,
  typicalFeeTerms,
} from "./curve-objective-fixture";

const point = (percentile: number, priceAmount: string): CurvePoint => ({
  ...parityCurve.points[0]!,
  percentile,
  priceAmount,
});

describe("market-evidence floor stage", () => {
  // A single other-seller hard ask anchors a 7.00 target and supplies no Second Ask.
  const directive = (overrides: Parameters<typeof goalDirective>[0] = {}) =>
    goalDirective({
      anchorChain: [{ source: "lowest-competing-ask" }],
      guardrails: [{ kind: "market-evidence-floor", percentOfEstimate: 90 }],
      ...overrides,
    });
  const snapshot = (overrides: Parameters<typeof goalSnapshot>[0] = {}) =>
    goalSnapshot({ demandCurve: null, competingAsks: [otherSellerHardAsk("7.00")], ...overrides });

  it("raises a 7.00 target to 90 percent of a 10.00 estimate with evidence-floor-binding", () => {
    expect(evaluateRepricingListing(goalListing(directive()), snapshot())).toMatchObject({
      targetPriceAmount: "9.00",
      anchor: { source: "lowest-competing-ask", amount: "7.00", stratum: "hard-ask" },
      clamps: { floor: false, ceiling: false, maxMove: false, evidenceFloor: true },
      flags: ["evidence-floor-binding"],
      action: "update-price",
    });
  });

  it.each([
    {
      name: "a Second Ask of 8.50",
      overrides: { competingAsks: [otherSellerHardAsk("7.00"), otherSellerHardAsk("8.50")] },
      target: "8.50",
    },
    {
      name: "a Curve Low of 8.00",
      overrides: {
        demandCurve: { currencyCode: "USD", version: 4, freshUntil, points: [point(5, "8.00"), point(50, "11.00")] },
      },
      target: "8.00",
    },
  ])("releases the floor to $name", ({ overrides, target }) => {
    expect(evaluateRepricingListing(goalListing(directive()), snapshot(overrides))).toMatchObject({
      targetPriceAmount: target,
      clamps: { evidenceFloor: true },
      flags: ["evidence-floor-binding"],
    });
  });

  it("keeps the seller Floor Price as the terminal invariant when it is higher", () => {
    expect(
      evaluateRepricingListing(goalListing(directive({ floor: { mode: "absolute", amount: "9.50" } })), snapshot()),
    ).toMatchObject({
      targetPriceAmount: "9.50",
      clamps: { floor: true, ceiling: false, maxMove: false, evidenceFloor: true },
      flags: ["floor-binding", "evidence-floor-binding"],
    });
  });

  it.each([
    { name: "absent", marketEstimate: null },
    { name: "stale", marketEstimate: { amount: "10.00", currencyCode: "USD", freshUntil: "2026-10-13T11:00:00.000Z" } },
  ])("leaves the stage inert for an $name estimate", ({ marketEstimate }) => {
    const result = evaluateRepricingListing(goalListing(directive()), snapshot({ marketEstimate }));
    expect(result).toMatchObject({ targetPriceAmount: "7.00", flags: [], action: "update-price" });
    expect(result.clamps).toEqual({ floor: false, ceiling: false, maxMove: false });
  });
});

describe("hopeless-forecast hold stage", () => {
  const goals: readonly Readonly<{
    goalId: string;
    parameters: Readonly<Record<string, number>>;
    economics: RepricingListingEconomics | null;
  }>[] = [
    { goalId: "fixed-percentile", parameters: { percentile: 65 }, economics: null },
    { goalId: "target-horizon", parameters: { horizonDays: 30 }, economics: null },
    { goalId: "profit-per-day", parameters: {}, economics: resolvedGoalEconomics(typicalFeeTerms, 0.01) },
    { goalId: "hold-value", parameters: {}, economics: null },
    { goalId: "cash-target", parameters: { amount: 100, days: 30 }, economics: null },
  ];
  const hopelessCurve = {
    ...parityCurve,
    freshUntil,
    points: parityCurve.points.map((curvePoint) => ({ ...curvePoint, hopeless: true })),
  };
  const holdDirective = (anchorChain: RepricingRuleDirective["anchorChain"]) =>
    goalDirective({ anchorChain, guardrails: [{ kind: "hopeless-forecast-hold" }] });

  it("covers every registered Pricing Goal", () => {
    expect(goals.map(({ goalId }) => goalId).sort()).toEqual(pricingGoalDefinitions().map(({ id }) => id));
  });

  it.each(goals)(
    "holds the current price under $goalId with hopeless-forecast-hold and no target",
    ({ goalId, parameters, economics }) => {
      const result = evaluateRepricingListing(
        goalListing(holdDirective([goalAnchor(goalId, parameters)]), { currentPriceAmount: "9.50" }),
        goalSnapshot({ demandCurve: hopelessCurve, economics }),
      );
      // 9.50 is the parity curve's 70th-percentile point.
      const atCurrentPrice = recordedDecision("fixed-percentile", { percentile: 70 }, null);
      expect(result).toEqual({
        listingId: "lst_goal",
        currentPriceAmount: "9.50",
        targetPriceAmount: null,
        ruleIndex: 0,
        anchor: expect.objectContaining({
          source: "curve-objective",
          stratum: "curve-objective",
          goal: expect.objectContaining({
            goalId,
            goalVersion: 1,
            curveVersion: 1,
            equivalentPercentile: atCurrentPrice.equivalentPercentile,
            forecastMedianSellDays: atCurrentPrice.estimatedMedianSellDays,
            forecastStatus: atCurrentPrice.forecastStatus,
          }),
        }),
        exhaustedAnchors: [],
        clamps: { floor: false, ceiling: false, maxMove: false },
        tolerance: { mode: "absolute", amount: "0.01" },
        flags: [],
        action: "hold",
        skipReason: "hopeless-forecast-hold",
      });
    },
  );

  it("prices normally when the fastest forecast point is not hopeless", () => {
    expect(evaluateRepricingListing(goalListing(holdDirective([goalAnchor()])), goalSnapshot())).toMatchObject({
      targetPriceAmount: "8.75",
      action: "update-price",
      skipReason: null,
    });
  });

  it("stays inert when the resolved anchor is not the curve objective", () => {
    expect(
      evaluateRepricingListing(
        goalListing(holdDirective([{ source: "market-estimate" }, goalAnchor()])),
        goalSnapshot({
          demandCurve: hopelessCurve,
          marketEstimate: { amount: "12.00", currencyCode: "USD", freshUntil },
        }),
      ),
    ).toMatchObject({ targetPriceAmount: "12.00", anchor: { source: "market-estimate" }, skipReason: null });
  });
});
