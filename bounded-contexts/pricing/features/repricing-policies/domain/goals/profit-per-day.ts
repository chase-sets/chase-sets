import { netProceedsAtPrice, pointAtSellTime } from "./curve-math";
import { definePricingGoal } from "./registry";

/** Log-spaced sell times scored before refinement, as the app's `pointAtBestReturn`. */
const BEST_RETURN_SAMPLE_COUNT = 64;
const GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2;
const REFINEMENT_ITERATIONS = 24;

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

/** Sell times spaced evenly in log space from minimum to maximum, endpoints exact. */
function logSpacedHorizons(minimumDays: number, maximumDays: number, count: number): number[] {
  const lastIndex = count - 1;
  return Array.from({ length: count }, (_, index) =>
    index === 0
      ? minimumDays
      : index === lastIndex
        ? maximumDays
        : minimumDays * (maximumDays / minimumDays) ** (index / lastIndex),
  );
}

/**
 * Every candidate is scored first so a score with more than one peak cannot
 * trap the search; golden-section search then sharpens between the best
 * candidate's neighbours, keeping the best candidate when refinement cannot
 * beat it.
 */
function maximizeOverCandidates(
  candidates: readonly number[],
  score: (argument: number) => number,
): Readonly<{ argument: number; value: number }> | undefined {
  const scores = candidates.map(score);
  const bestIndex = scores.indexOf(Math.max(...scores));
  if (bestIndex < 0) return undefined;
  const best = { argument: candidates[bestIndex]!, value: scores[bestIndex]! };
  let low = candidates[Math.max(0, bestIndex - 1)]!;
  let high = candidates[Math.min(candidates.length - 1, bestIndex + 1)]!;
  if (low === high) return best;
  let lower = high - GOLDEN_RATIO * (high - low);
  let upper = low + GOLDEN_RATIO * (high - low);
  let lowerScore = score(lower);
  let upperScore = score(upper);
  for (let iteration = 0; iteration < REFINEMENT_ITERATIONS; iteration += 1) {
    if (lowerScore < upperScore) {
      low = lower;
      lower = upper;
      lowerScore = upperScore;
      upper = low + GOLDEN_RATIO * (high - low);
      upperScore = score(upper);
    } else {
      high = upper;
      upper = lower;
      upperScore = lowerScore;
      lower = high - GOLDEN_RATIO * (high - low);
      lowerScore = score(lower);
    }
  }
  const refined = (low + high) / 2;
  const refinedScore = score(refined);
  return refinedScore > best.value ? { argument: refined, value: refinedScore } : best;
}
