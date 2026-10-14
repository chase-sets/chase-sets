import { buildForecastCohort, type RealizedOutcomes } from "./cohort";
import type { Forecast } from "./forecast-kinds";
import { gradeForecast, type ForecastGrade } from "./grading";
import type { ForecastLedgerRole } from "./ledger";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The ledger entries of one goal version in one role, as grading reads them. */
export type GradedLedgerEntry = Readonly<{
  listingId: string;
  pricedAt: number;
  quantity: number | null;
  forecasts: Readonly<Record<string, Forecast>>;
}>;

export type ForecastGradeScope = Readonly<{ goalId: string; goalVersion: number; role: ForecastLedgerRole }>;

export type GradedForecast = Readonly<{
  forecastKind: string;
  model: string;
  horizonDays: number;
  grade: ForecastGrade;
}>;

/**
 * Grades every forecast the ledger recorded, by Forecast Kind, model, and
 * horizon, over one goal version's entries in one role; grading reads kinds
 * from the entries, so a newly registered kind needs no change here. Each
 * horizon reads its own newest complete Forecast Cohort: entries priced within
 * two horizons before the cohort closed. A forecast is graded only against
 * entries carrying it under the same model, so one model's forecasts are never
 * graded beside another's; an entry under another model still counts as the
 * listing being priced.
 */
export function gradeLedgerScope(
  entries: readonly GradedLedgerEntry[],
  outcomes: RealizedOutcomes,
  input: Readonly<{ horizonsDays: readonly number[]; graceDays: number; closedAt: number }>,
): readonly GradedForecast[] {
  return input.horizonsDays.flatMap((horizonDays) => {
    const windowStart = input.closedAt - 2 * horizonDays * DAY_MS;
    const window = entries.filter((entry) => entry.pricedAt >= windowStart && entry.pricedAt < input.closedAt);
    const recorded = new Map<string, Readonly<{ forecastKind: string; model: string }>>();
    for (const entry of window) {
      for (const [forecastKind, { model }] of Object.entries(entry.forecasts)) {
        recorded.set(JSON.stringify([forecastKind, model]), { forecastKind, model });
      }
    }
    return [...recorded.keys()].sort().flatMap((key): GradedForecast[] => {
      const { forecastKind, model } = recorded.get(key)!;
      const history = window.map((entry) => {
        const forecast = entry.forecasts[forecastKind];
        return {
          listingId: entry.listingId,
          pricedAt: entry.pricedAt,
          quantity: entry.quantity,
          forecasts: forecast?.model === model ? { [forecastKind]: forecast.medianSellDays } : {},
        };
      });
      const cohort = buildForecastCohort(history, [forecastKind], outcomes, {
        horizonDays,
        graceDays: input.graceDays,
      });
      const grade = gradeForecast(cohort, forecastKind, horizonDays);
      return grade === null ? [] : [{ forecastKind, model, horizonDays, grade }];
    });
  });
}
