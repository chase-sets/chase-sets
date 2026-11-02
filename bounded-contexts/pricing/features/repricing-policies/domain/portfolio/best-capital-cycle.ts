import { capitalCycle, type CapitalCycle } from "./capital-cycle";
import { horizonValue, type HorizonValueCurve } from "./horizon-value-curve";
import { PORTFOLIO_SOLVER_POLICY } from "./policy";
import { logSpacedHorizons, maximizeOverCandidates } from "./search";

/** Seller economics that turn the modeled sale value at a horizon into return on capital, in currency units. */
export type CapitalCycleEconomics = Readonly<{
  /** Cost basis as a share of market value. */
  costBasisShareOfMarket: number;
  /** Off the cost basis for every unit bought, as when a lot is priced at a share of market less an allowance per card. */
  costBasisDiscountPerUnit: number;
  /** Overhead as a fraction of sale value. */
  relativeOverhead: number;
  /** Overhead per unit sold. */
  staticOverheadPerUnit: number;
  /** Days from a sale until the proceeds are relisted as new inventory. */
  turnaroundDays: number;
}>;

export type CapitalCyclePortfolio = Readonly<{ marketValue: number; unitCount: number }>;

export type HorizonCapitalCycle = CapitalCycle & Readonly<{ horizonDays: number; netProceeds: number }>;

/**
 * One capital cycle at a target horizon, as the parity app's
 * `capitalCycleAtHorizon` (tcgplayer-automation-app at bdeffa01): sell at the
 * modeled value, pay overhead, recover the cost basis, and wait out the
 * turnaround before the money is working again. The cycle itself is the one
 * shared kernel.
 */
export function capitalCycleAtHorizon(
  curve: HorizonValueCurve,
  portfolio: CapitalCyclePortfolio,
  economics: CapitalCycleEconomics,
  horizonDays: number,
): HorizonCapitalCycle {
  const netProceeds =
    horizonValue(curve, horizonDays) * (1 - economics.relativeOverhead) -
    economics.staticOverheadPerUnit * portfolio.unitCount;
  const cost =
    economics.costBasisShareOfMarket * portfolio.marketValue - economics.costBasisDiscountPerUnit * portfolio.unitCount;
  return { horizonDays, netProceeds, ...capitalCycle(netProceeds, cost, horizonDays, economics.turnaroundDays) };
}

/** The cycle with the most profit per day within the observed range; null when no horizon in it turns a profit. */
export function bestCapitalCycle(
  curve: HorizonValueCurve,
  portfolio: CapitalCyclePortfolio,
  economics: CapitalCycleEconomics,
  range: Readonly<{ minimumHorizonDays: number; maximumHorizonDays: number }>,
): HorizonCapitalCycle | null {
  const best = maximizeOverCandidates(
    logSpacedHorizons(range.minimumHorizonDays, range.maximumHorizonDays, PORTFOLIO_SOLVER_POLICY.bestCycleSampleCount),
    (horizonDays) => capitalCycleAtHorizon(curve, portfolio, economics, horizonDays).profitPerDay,
  );
  return best && best.value > 0 ? capitalCycleAtHorizon(curve, portfolio, economics, best.argument) : null;
}
