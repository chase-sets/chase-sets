import { MONEY_AMOUNT_MAX } from "@chase-sets/primitives/money";
import { saleProbability } from "../../../forecast-ledger/domain/grading";
import { DEMAND_CURVE_LAUNCH_POLICY_VALUE } from "../../../market-estimates/domain/demand-curve-policy";
import {
  forecastAtSelectedPrice,
  priceAtHorizon,
  valueToleranceCents,
  type PreparedPortfolio,
} from "../portfolio/portfolio";
import { longestHorizonMeeting, maximizeOverCandidates, type HorizonCandidate } from "../portfolio/search";
import { definePortfolioGoal } from "./portfolio-goal";

/**
 * Expected Realized Value in cents at one horizon: each modeled listing's
 * one-copy price times its chance of a sale within the window, at the median
 * sell time read back at that price, as Pricing Health's expected sales value.
 * A held listing has no forecast and adds nothing.
 */
function expectedRealizedCents(portfolio: PreparedPortfolio, horizonDays: number, windowDays: number): number {
  return portfolio.baseline.reduce((sum, listing) => {
    const priced = priceAtHorizon(listing, horizonDays);
    const forecast = forecastAtSelectedPrice(priced);
    return forecast === null || forecast.status === "unavailable" || !(forecast.medianSellDays! > 0)
      ? sum
      : sum + Number(priced.selectedCents) * saleProbability(forecast.medianSellDays!, windowDays);
  }, 0);
}

/**
 * "Reach this amount within these days": the longest target horizon whose
 * Expected Realized Value within the window meets the amount, so a reachable
 * target is met at the highest prices that still meet it. When no horizon
 * meets it, the plan prices at the most reachable value and reports a
 * boundary with the reachable range; with nothing modeled it is infeasible.
 * The amount is in the portfolio currency, to the cent.
 */
export const cashTargetGoal = definePortfolioGoal({
  id: "cash-target",
  version: 1,
  parameterSchema: {
    amount: { default: 100, minimum: 0.01, maximum: Number(MONEY_AMOUNT_MAX) },
    days: { default: 30, minimum: 1, maximum: DEMAND_CURVE_LAUNCH_POLICY_VALUE.hopelessHorizonDays },
  },
  requiredCurveFeatures: ["buyerArrivalIntervalDays", "storeWinShare"],
  resolve: (portfolio, { amount, days }) => {
    const target = BigInt(Math.round(amount * 100));
    const tolerance = valueToleranceCents(target);
    const evaluate = (horizonDays: number): HorizonCandidate => ({
      horizonDays,
      value: expectedRealizedCents(portfolio, horizonDays, days),
    });
    const meeting = longestHorizonMeeting(
      portfolio.range,
      evaluate,
      ({ value }) => value >= Number(target - tolerance),
    );
    const reachable =
      meeting.best ??
      evaluate(
        maximizeOverCandidates(
          meeting.samples.map(({ horizonDays }) => horizonDays),
          (horizonDays) => evaluate(horizonDays).value,
        )!.argument,
      );
    const values = [...meeting.samples, reachable].map(({ value }) => Math.round(value));
    return {
      status: portfolio.modeledCount === 0 ? "infeasible" : meeting.best === null ? "boundary" : "matched",
      horizonDays: reachable.horizonDays,
      targetCents: target,
      resolvedCents: BigInt(Math.round(reachable.value)),
      toleranceCents: tolerance,
      reachableCents: { minimum: BigInt(Math.min(...values)), maximum: BigInt(Math.max(...values)) },
    };
  },
  drivers: ({ rationale, forecast }) => ({
    amount: rationale.parameters.amount ?? null,
    days: rationale.parameters.days ?? null,
    "forecast.medianSellDays": forecast.medianSellDays,
    "forecast.status": forecast.status,
  }),
});
