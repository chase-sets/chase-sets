import type { StoredForecastGrade } from "../../forecast-ledger/read-model/queries";

type GradeIdentity = Pick<StoredForecastGrade, "closedOn" | "forecastKind" | "model" | "horizonDays">;
export type DisclosedForecastGrade = GradeIdentity &
  (
    | Readonly<{ status: "undisclosed" }>
    | Readonly<{
        status: "disclosed";
        values: Readonly<{
          soldShare: number;
          expectedShare: number;
          brier: number;
          baseRateBrier: number;
        }>;
      }>
  );
export type PricingHealthGrade = DisclosedForecastGrade & Readonly<{ goalId: string; goalVersion: number }>;

export function discloseForecastGrade(row: StoredForecastGrade, minimumCount: number): DisclosedForecastGrade {
  const identity = {
    closedOn: row.closedOn,
    forecastKind: row.forecastKind,
    model: row.model,
    horizonDays: row.horizonDays,
  };
  const { count, soldShare, expectedShare, brier, baseRateBrier } = row.grade;
  if (!Number.isSafeInteger(count) || count < minimumCount) return { ...identity, status: "undisclosed" };
  return { ...identity, status: "disclosed", values: { soldShare, expectedShare, brier, baseRateBrier } };
}
