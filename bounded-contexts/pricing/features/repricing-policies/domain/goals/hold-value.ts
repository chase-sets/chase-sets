import { priceAtHorizon, valueToleranceCents } from "../portfolio/portfolio";
import { closestHorizon } from "../portfolio/search";
import { definePortfolioGoal } from "./portfolio-goal";

/**
 * The app's value-matched portfolio plan (`resolveValueMatchedPortfolioPlan`):
 * the one target horizon at which the one-copy value of every listing with a
 * current price, summed after each listing's constraint, matches today's
 * listed value. Held listings add their current price at every horizon, so
 * they move neither side. The plan is matched within tolerance, at a boundary
 * when the listed value lies outside the reachable range, and otherwise
 * infeasible, as it is when nothing is modeled.
 */
export const holdValueGoal = definePortfolioGoal({
  id: "hold-value",
  version: 1,
  parameterSchema: {},
  requiredCurveFeatures: ["buyerArrivalIntervalDays", "storeWinShare"],
  resolve: (portfolio) => {
    const target = portfolio.baselineCents;
    const { best, samples } = closestHorizon(
      portfolio.range,
      (horizonDays) => ({
        horizonDays,
        value: Number(
          portfolio.baseline.reduce((sum, listing) => sum + priceAtHorizon(listing, horizonDays).selectedCents, 0n),
        ),
      }),
      Number(target),
    );
    const tolerance = valueToleranceCents(target);
    const resolved = BigInt(best.value);
    const minimum = BigInt(Math.min(...samples.map(({ value }) => value)));
    const maximum = BigInt(Math.max(...samples.map(({ value }) => value)));
    const difference = resolved > target ? resolved - target : target - resolved;
    return {
      status:
        portfolio.modeledCount === 0
          ? "infeasible"
          : difference <= tolerance
            ? "matched"
            : target < minimum - tolerance || target > maximum + tolerance
              ? "boundary"
              : "infeasible",
      horizonDays: best.horizonDays,
      targetCents: target,
      resolvedCents: resolved,
      toleranceCents: tolerance,
      reachableCents: { minimum, maximum },
    };
  },
  drivers: ({ forecast }) => ({
    "forecast.medianSellDays": forecast.medianSellDays,
    "forecast.status": forecast.status,
  }),
});
