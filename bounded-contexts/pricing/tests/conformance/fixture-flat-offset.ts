import { pointAtPercentile } from "../../features/repricing-policies/domain/goals/curve-math";
import { definePricingGoal } from "../../features/repricing-policies/domain/goals/registry";
import type { GoalDeclaration } from "./goal-properties";

/**
 * A test-only Pricing Goal written the way the authoring guide says: the
 * curve's median moved by a flat number of percentiles. It is never
 * registered in production; `fixture-goal-end-to-end.test.ts` registers it.
 * A later version that offsets from another centre decides differently on the
 * same recorded parameters, so it is a new Goal Version.
 */
export const defineFixtureFlatOffsetGoal = (version: number, centrePercentile: number) =>
  definePricingGoal({
    id: "fixture-flat-offset",
    version,
    parameterSchema: { offsetPercentiles: { default: 10, minimum: -40, maximum: 40 } },
    requiredCurveFeatures: [],
    requiresEconomics: false,
    select: ({ curve, parameters }) => pointAtPercentile(curve, centrePercentile + parameters.offsetPercentiles),
    drivers: ({ rationale }) => ({ offsetPercentiles: rationale.parameters.offsetPercentiles ?? null }),
  });

export const fixtureFlatOffsetGoal = defineFixtureFlatOffsetGoal(1, 50);

/**
 * The fixture's kit declaration, reviewed with the goal like an entry in
 * `goal-declarations.ts`. At its default offset it prices at P60, which is the
 * pinned app's recorded `percentile` 60 decision on both fixture curves.
 */
export const fixtureFlatOffsetDeclaration: GoalDeclaration = {
  priceScalesWithCurve: true,
  golden: {
    observed: {
      kind: "decision",
      selectedPriceAmount: "7.99",
      unconstrainedPriceAmount: "7.99",
      equivalentPercentile: 60,
      forecast: { medianSellDays: 19.408121055678468, status: "interpolated" },
      unprofitable: false,
      rationale: { parameters: { offsetPercentiles: 10 }, dailyReturnHurdle: null, netProceeds: null },
    },
    "truncated-supply": {
      kind: "decision",
      selectedPriceAmount: "7.99",
      unconstrainedPriceAmount: "7.99",
      equivalentPercentile: 60,
      forecast: { medianSellDays: null, status: "unavailable" },
      unprofitable: false,
      rationale: { parameters: { offsetPercentiles: 10 }, dailyReturnHurdle: null, netProceeds: null },
    },
  },
};
