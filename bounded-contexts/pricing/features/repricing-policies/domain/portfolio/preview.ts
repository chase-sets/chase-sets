import { centsToMoneyAmount, moneyToCents, type MoneyAmount } from "@chase-sets/primitives/money";
import type { EconomicsForPricingGoal } from "../../../economics/domain/resolution";
import { readBackAtPrice, toGoalCurveViews } from "../goals/curve-math";
import { holdValueGoal } from "../goals/hold-value";
import { profitPerDayGoal } from "../goals/profit-per-day";
import { fitHorizonValueCurve, horizonKneeDays, type HorizonValueCurve } from "./horizon-value-curve";
import { PORTFOLIO_SOLVER_POLICY } from "./policy";
import { preparePortfolio, priceAtHorizon, sha256, type PortfolioListing } from "./portfolio";
import { logSpacedHorizons, type HorizonRange } from "./search";

/**
 * Preview-only computations over an explicit, caller-supplied portfolio, such
 * as one Product Line's listings assembled through every keyset page. Neither
 * prices a listing; a round never runs them.
 */

type PortfolioInput<Listing extends PortfolioListing = PortfolioListing> = Readonly<{
  currencyCode: string;
  listings: readonly Listing[];
}>;

export type PortfolioHorizonModel = Readonly<{
  range: HorizonRange | null;
  /** The one-copy value of the listings with a current price, every modeled one priced at the horizon. */
  samples: readonly Readonly<{ horizonDays: number; valueAmount: MoneyAmount }>[];
  curve: HorizonValueCurve | null;
  kneeDays: number | null;
}>;

/**
 * The portfolio's Horizon Value Curve, as the app's horizon model: log-spaced
 * samples across the observed range, whose end points pin every listing at its
 * fastest or slowest curve point and so are the exact floor and ceiling. Values
 * are hold-value's, after each listing's constraint.
 */
export function portfolioHorizonModel(input: PortfolioInput): PortfolioHorizonModel {
  const portfolio = preparePortfolio({ ...input, parameters: {} }, holdValueGoal.requiredCurveFeatures);
  if (portfolio.modeledCount === 0) return { range: null, samples: [], curve: null, kneeDays: null };
  const { range } = portfolio;
  const samples = logSpacedHorizons(
    range.minimumDays,
    range.maximumDays,
    PORTFOLIO_SOLVER_POLICY.horizonFitSampleCount,
  ).map((horizonDays) => ({
    horizonDays,
    cents: portfolio.baseline.reduce((sum, listing) => sum + priceAtHorizon(listing, horizonDays).selectedCents, 0n),
  }));
  const values = samples.map(({ horizonDays, cents }) => ({ horizonDays, value: Number(cents) / 100 }));
  const curve = fitHorizonValueCurve(values, values[0]!.value, values.at(-1)!.value);
  return {
    range,
    samples: samples.map(({ horizonDays, cents }) => ({ horizonDays, valueAmount: centsToMoneyAmount(cents) })),
    curve,
    kneeDays: curve === null ? null : horizonKneeDays(curve),
  };
}

/** A sweep listing carries the Economics its profit-per-day decision reads. */
export type HurdleSweepListing = PortfolioListing & Readonly<{ economics: EconomicsForPricingGoal | null }>;

/** The portfolio under profit per day at one Daily Return Hurdle, as the app's hurdle sweep summarizes it. */
export type HurdleScenario = Readonly<{
  dailyReturnHurdle: number;
  /** One copy of every listing with a current price, at its decided price or else its current price. */
  oneCopyValueAmount: MoneyAmount;
  modeled: number;
  raised: number;
  lowered: number;
  held: number;
  /** Median and P90 of the modeled decisions' forecast sell times; null when none is modeled. */
  wait: Readonly<{ medianDays: number; p90Days: number }> | null;
}>;

export type HurdleSweep = Readonly<{ snapshotHash: string; scenarios: readonly HurdleScenario[] }>;

/**
 * Profit per day across the portfolio at each Daily Return Hurdle, ascending,
 * with each listing's resolved Economics at the swept hurdle. A listing without
 * a current price is outside the portfolio's value; one without a decision is
 * held at its current price, and a decided price still passes the listing's
 * constraint.
 */
export function sweepDailyReturnHurdles(
  input: PortfolioInput<HurdleSweepListing> & Readonly<{ dailyReturnHurdles?: readonly number[] }>,
): HurdleSweep {
  const portfolio = preparePortfolio({ ...input, parameters: {} }, profitPerDayGoal.requiredCurveFeatures);
  const byId = new Map(input.listings.map((listing) => [listing.listingId, listing]));
  const hurdles = [...new Set(input.dailyReturnHurdles ?? PORTFOLIO_SOLVER_POLICY.sweepDailyReturnHurdles)].sort(
    (left, right) => left - right,
  );
  const scenarios = hurdles.map((dailyReturnHurdle): HurdleScenario => {
    const summary = { valueCents: 0n, modeled: 0, raised: 0, lowered: 0, held: 0 };
    const waits: number[] = [];
    for (const { listingId, currentCents } of portfolio.baseline) {
      const listing = byId.get(listingId)!;
      const decided = decideAtHurdle(listing, dailyReturnHurdle);
      const cents = decided?.cents ?? currentCents;
      summary.valueCents += cents;
      if (cents > currentCents) summary.raised += 1;
      else if (cents < currentCents) summary.lowered += 1;
      else summary.held += 1;
      if (decided?.forecast.status === undefined || decided.forecast.status === "unavailable") continue;
      summary.modeled += 1;
      if (decided.forecast.medianSellDays !== null) waits.push(decided.forecast.medianSellDays);
    }
    return {
      dailyReturnHurdle,
      oneCopyValueAmount: centsToMoneyAmount(summary.valueCents),
      modeled: summary.modeled,
      raised: summary.raised,
      lowered: summary.lowered,
      held: summary.held,
      wait: waits.length === 0 ? null : { medianDays: quantile(waits, 0.5), p90Days: quantile(waits, 0.9) },
    };
  });
  return {
    snapshotHash: sha256({
      portfolio: portfolio.snapshotHash,
      economics: portfolio.baseline.map(({ listingId }) => [listingId, byId.get(listingId)!.economics]),
    }),
    scenarios,
  };
}

function decideAtHurdle(listing: HurdleSweepListing, dailyReturnHurdle: number) {
  if (listing.curve === null || listing.economics?.availability !== "resolved") return null;
  const decision = profitPerDayGoal.solve({
    curve: listing.curve,
    economics: {
      ...listing.economics,
      dailyReturnHurdle: { ...listing.economics.dailyReturnHurdle, effectiveValue: dailyReturnHurdle },
    },
    parameters: {},
  });
  if (decision.kind === "unavailable") return null;
  const selected =
    listing.constraint === undefined
      ? decision.selectedPriceAmount
      : listing.constraint.apply(decision.selectedPriceAmount);
  const cents = moneyToCents(selected);
  return { cents, forecast: readBackAtPrice(toGoalCurveViews(listing.curve.points)!, Number(cents) / 100).forecast };
}

/** The app's weighted quantile at one copy per listing: the first value whose running count reaches the share. */
function quantile(values: readonly number[], share: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * share) - 1)]!;
}
