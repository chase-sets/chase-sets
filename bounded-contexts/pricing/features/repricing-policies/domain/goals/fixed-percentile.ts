import { REPRICING_POLICY_COMP_PERCENTILE_MAX, REPRICING_POLICY_COMP_PERCENTILE_MIN } from "../policy-bounds";
import { pointAtPercentile } from "./curve-math";
import { definePricingGoal } from "./registry";

/**
 * The app's `percentile` policy. The default is the app's compiled default
 * percentile. The bounds are the comp-percentile authoring bounds, wider than
 * the app's 5-95 grid; a percentile beyond the curve's end points prices at
 * that end point.
 */
export const fixedPercentileGoal = definePricingGoal({
  id: "fixed-percentile",
  version: 1,
  parameterSchema: {
    percentile: {
      default: 65,
      minimum: REPRICING_POLICY_COMP_PERCENTILE_MIN,
      maximum: REPRICING_POLICY_COMP_PERCENTILE_MAX,
    },
  },
  requiredCurveFeatures: [],
  requiresEconomics: false,
  select: ({ curve, parameters }) => pointAtPercentile(curve, parameters.percentile),
  drivers: ({ rationale }) => ({ percentile: rationale.parameters.percentile ?? null }),
});
