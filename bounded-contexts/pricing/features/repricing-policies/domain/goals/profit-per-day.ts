import { logSpacedHorizons, maximizeOverCandidates } from "../portfolio/search";
import { netProceedsAtPrice, pointAtSellTime } from "./curve-math";
import { definePricingGoal } from "./registry";

/** Log-spaced sell times scored before refinement, as the app's `pointAtBestReturn`. */
const BEST_RETURN_SAMPLE_COUNT = 64;

/**
 * The app's `profit-per-day` policy. Net Proceeds at each sell time are
 * discounted at the Daily Return Hurdle over the median wait. A loss is not
 * discounted, so when no price clears overhead the least loss wins whatever
 * its wait. The hurdle and every fee are Economics facts, never parameters.
 */
export const profitPerDayGoal = definePricingGoal({
  id: "profit-per-day",
  version: 1,
  parameterSchema: {},
  requiredCurveFeatures: ["buyerArrivalIntervalDays", "storeWinShare"],
  requiresEconomics: true,
  select: ({ curve, economics }) => {
    const points = curve.bySellTime;
    if (points.length === 0) return { kind: "unavailable", reason: "curve-feature-missing:medianSellDays" };
    const hurdle = economics.dailyReturnHurdle.effectiveValue;
    const discountedNet = (sellDays: number): number => {
      const net = netProceedsAtPrice(pointAtSellTime(points, sellDays).price, economics);
      return net > 0 ? net * Math.exp(-hurdle * sellDays) : net;
    };
    const best = maximizeOverCandidates(
      logSpacedHorizons(points[0]!.medianSellDays, points.at(-1)!.medianSellDays, BEST_RETURN_SAMPLE_COUNT),
      discountedNet,
    );
    if (best === undefined) throw new Error("Profit per day needs finite Net Proceeds and Daily Return Hurdle.");
    return pointAtSellTime(points, best.argument);
  },
  drivers: ({ rationale }) => ({
    dailyReturnHurdle: rationale.dailyReturnHurdle,
    netProceeds: rationale.netProceeds,
  }),
});
