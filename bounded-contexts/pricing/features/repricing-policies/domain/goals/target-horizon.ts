import { DEMAND_CURVE_LAUNCH_POLICY_VALUE } from "../../../market-estimates/domain/demand-curve-policy";
import { pointAtSellTime } from "./curve-math";
import { definePricingGoal } from "./registry";

/**
 * The app's `target-horizon` policy: the price whose median sell time meets the
 * horizon. The default is epic #7703 pillar 8 ("Sell steadily within 30
 * days"); the bound stops at the compiled hopeless horizon, while the app
 * accepts any positive horizon. Horizons beyond the curve clamp to its end.
 */
export const targetHorizonGoal = definePricingGoal({
  id: "target-horizon",
  version: 1,
  parameterSchema: {
    horizonDays: { default: 30, minimum: 1, maximum: DEMAND_CURVE_LAUNCH_POLICY_VALUE.hopelessHorizonDays },
  },
  requiredCurveFeatures: ["buyerArrivalIntervalDays", "storeWinShare"],
  requiresEconomics: false,
  select: ({ curve, parameters }) =>
    curve.bySellTime.length === 0
      ? { kind: "unavailable", reason: "curve-feature-missing:medianSellDays" }
      : pointAtSellTime(curve.bySellTime, parameters.horizonDays),
  drivers: ({ rationale, forecast }) => ({
    horizonDays: rationale.parameters.horizonDays ?? null,
    "forecast.status": forecast.status,
  }),
});
