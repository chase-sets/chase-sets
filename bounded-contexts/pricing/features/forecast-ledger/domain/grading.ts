import type { ForecastCohortMember } from "./cohort";

export type ForecastGradeDecile = Readonly<{
  count: number;
  medianDays: number;
  soldShare: number;
  expectedShare: number;
}>;

export type ForecastGrade = Readonly<{
  count: number;
  /** Share of the cohort that realized a sale within the horizon. */
  soldShare: number;
  /** Share the forecast implied would sell within the horizon. */
  expectedShare: number;
  brier: number;
  /** Brier of forecasting the sold share for every member; a useful forecast scores below it. */
  baseRateBrier: number;
  /** Fastest forecasts first. */
  deciles: readonly ForecastGradeDecile[];
}>;

/** Probability of a sale within the horizon when sell time has this median. */
export function saleProbability(medianDays: number, horizonDays: number): number {
  return 1 - Math.pow(0.5, horizonDays / medianDays);
}

/**
 * The parity app's `gradeForecast` (`forecastGrading.ts`, tcgplayer-automation-app
 * at bdeffa01), with the base rate's Brier reported beside the forecast's.
 * Every member must carry the named forecast; an empty cohort has no grade.
 */
export function gradeForecast(
  members: readonly ForecastCohortMember[],
  forecastName: string,
  horizonDays: number,
): ForecastGrade | null {
  if (members.length === 0) return null;
  const days = (member: ForecastCohortMember) => member.forecasts[forecastName]!;
  const sorted = [...members].sort((left, right) => days(left) - days(right));
  const probability = (member: ForecastCohortMember) => saleProbability(days(member), horizonDays);
  const outcome = (member: ForecastCohortMember) => (member.sold ? 1 : 0);
  const share = (items: readonly ForecastCohortMember[], value: (member: ForecastCohortMember) => number) =>
    items.reduce((sum, member) => sum + value(member), 0) / items.length;
  const deciles = Array.from({ length: 10 }, (_, decile) =>
    sorted.slice(Math.floor((decile * sorted.length) / 10), Math.floor(((decile + 1) * sorted.length) / 10)),
  )
    .filter((slice) => slice.length > 0)
    .map((slice) => ({
      count: slice.length,
      medianDays: days(slice[Math.floor(slice.length / 2)]!),
      soldShare: share(slice, outcome),
      expectedShare: share(slice, probability),
    }));
  const soldShare = share(members, outcome);
  return {
    count: members.length,
    soldShare,
    expectedShare: share(members, probability),
    brier: share(members, (member) => (probability(member) - outcome(member)) ** 2),
    baseRateBrier: share(members, (member) => (soldShare - outcome(member)) ** 2),
    deciles,
  };
}
