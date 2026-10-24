export type CapitalCycle = Readonly<{
  profit: number;
  cycleDays: number;
  profitPerDay: number;
  dailyReturn: number;
}>;

/**
 * The one capital-cycle calculation shared by Pricing Health and later goal
 * comparison work. Values are intentionally signed: a loss is still a fact.
 * Unlike parity's zero sentinel at cycle <= 0, NaN represents unavailable
 * profit/day here; callers persist null plus the non-positive-cycle reason.
 */
export function capitalCycle(
  netProceeds: number,
  cost: number,
  horizonDays: number,
  turnaroundDays: number,
): CapitalCycle {
  const profit = netProceeds - cost;
  const cycleDays = horizonDays + turnaroundDays;
  const profitPerDay = cycleDays > 0 ? profit / cycleDays : Number.NaN;
  const dailyReturn =
    netProceeds > 0 && cost > 0 && cycleDays > 0 ? Math.log(netProceeds / cost) / cycleDays : Number.NaN;
  return { profit, cycleDays, profitPerDay, dailyReturn };
}
