import { REPRICING_POLICY_PERCENT_MAGNITUDE_CAP } from "../../repricing-policies/domain/policy-bounds";

export type MigrationNudgeRow = Readonly<{
  appliedPriceAmount: string;
  marketEstimateAmount: string | null;
  currencyCode: string | null;
}>;

export type MigrationNudge = Readonly<{
  status: "available" | "unavailable";
  offsetPercent: number | null;
  currencyCode: string | null;
  reason?:
    | "mixed-currency"
    | "insufficient-estimates"
    | "offset-out-of-range"
    | "no-samples"
    | "reliance-not-met"
    | "policy-unknown"
    | "unavailable";
}>;

function money(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function deriveMigrationNudge(
  rows: readonly MigrationNudgeRow[],
  params: Readonly<{ minEstimateSamples?: number; magnitudeCap?: number }>,
): MigrationNudge {
  if (rows.length === 0)
    return { status: "unavailable", offsetPercent: null, currencyCode: null, reason: "no-samples" };
  const currencies = new Set(rows.map((row) => row.currencyCode?.trim().toUpperCase() ?? ""));
  if (currencies.size !== 1 || !/^[A-Z]{3}$/.test([...currencies][0]!))
    return { status: "unavailable", offsetPercent: null, currencyCode: null, reason: "mixed-currency" };
  const ratios = rows.flatMap((row) => {
    const applied = money(row.appliedPriceAmount);
    const estimate = money(row.marketEstimateAmount);
    return applied !== null && estimate !== null ? [(applied / estimate - 1) * 100] : [];
  });
  if (params.minEstimateSamples === undefined || ratios.length < params.minEstimateSamples) {
    return {
      status: "unavailable",
      offsetPercent: null,
      currencyCode: [...currencies][0]!,
      reason: "insufficient-estimates",
    };
  }
  ratios.sort((a, b) => a - b);
  const middle = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[middle]! : (ratios[middle - 1]! + ratios[middle]!) / 2;
  const offsetPercent = Math.round(median * 100) / 100;
  const cap = params.magnitudeCap ?? REPRICING_POLICY_PERCENT_MAGNITUDE_CAP;
  if (Math.abs(median) > cap) {
    return {
      status: "unavailable",
      offsetPercent: null,
      currencyCode: [...currencies][0]!,
      reason: "offset-out-of-range",
    };
  }
  return { status: "available", offsetPercent, currencyCode: [...currencies][0]! };
}
