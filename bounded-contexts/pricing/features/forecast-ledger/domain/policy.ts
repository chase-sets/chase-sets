import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

export type ForecastLedgerPolicyValue = Readonly<{
  /** Each Forecast Cohort follows its members for one of these horizons. */
  horizonsDays: readonly number[];
  /** Days between one pricing and the next that do not count as leaving early. */
  graceDays: number;
  /** The Forecast Kind the Adoption Gate compares, at its horizon. */
  adoptedForecastKind: string;
  adoptionHorizonDays: number;
  gradeDisclosureMinimumCount: number;
}>;

/** The parity app's horizons and grace, and the Demand Curve forecast that goals price on. */
export const FORECAST_LEDGER_LAUNCH_POLICY_VALUE: ForecastLedgerPolicyValue = {
  horizonsDays: [14, 21, 28],
  graceDays: 2,
  adoptedForecastKind: "curve",
  adoptionHorizonDays: 21,
  gradeDisclosureMinimumCount: 30,
};

const KEYS = ["horizonsDays", "graceDays", "adoptedForecastKind", "adoptionHorizonDays", "gradeDisclosureMinimumCount"];

export function decodeForecastLedgerPolicyValue(raw: JsonValue): ForecastLedgerPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Forecast-ledger policy value must be an object.");
  }
  if (Object.keys(raw).some((key) => !KEYS.includes(key))) throw new Error("Unknown forecast-ledger policy key.");
  const value = { ...FORECAST_LEDGER_LAUNCH_POLICY_VALUE, ...(raw as Partial<ForecastLedgerPolicyValue>) };
  const isDays = (days: unknown, maximum: number): days is number =>
    typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= maximum;
  if (
    !Array.isArray(value.horizonsDays) ||
    value.horizonsDays.length === 0 ||
    !value.horizonsDays.every(
      (days, index) => isDays(days, 90) && (index === 0 || days > value.horizonsDays[index - 1]!),
    )
  ) {
    throw new Error("horizonsDays must be ascending distinct integers between 1 and 90.");
  }
  if (
    typeof value.graceDays !== "number" ||
    !Number.isInteger(value.graceDays) ||
    value.graceDays < 0 ||
    value.graceDays >= value.horizonsDays[0]!
  ) {
    throw new Error("graceDays must be a nonnegative integer below the shortest horizon.");
  }
  if (typeof value.adoptedForecastKind !== "string" || !/^[a-z][a-z0-9-]*$/.test(value.adoptedForecastKind)) {
    throw new Error("adoptedForecastKind must name a Forecast Kind.");
  }
  if (!value.horizonsDays.includes(value.adoptionHorizonDays)) {
    throw new Error("adoptionHorizonDays must be one of horizonsDays.");
  }
  if (!Number.isSafeInteger(value.gradeDisclosureMinimumCount) || value.gradeDisclosureMinimumCount < 1) {
    throw new Error("gradeDisclosureMinimumCount must be a positive safe integer.");
  }
  return {
    horizonsDays: [...value.horizonsDays],
    graceDays: value.graceDays,
    adoptedForecastKind: value.adoptedForecastKind,
    adoptionHorizonDays: value.adoptionHorizonDays,
    gradeDisclosureMinimumCount: value.gradeDisclosureMinimumCount,
  };
}

export const forecastLedgerPolicy = definePolicy({
  policyKey: "pricing.forecast-ledger",
  contextName: "pricing",
  schemaSummary:
    "{ horizonsDays: ascending integers 1-90 (default [14, 21, 28]), graceDays: integer below the shortest horizon (default 2), adoptedForecastKind: Forecast Kind name (default curve), adoptionHorizonDays: one of horizonsDays (default 21), gradeDisclosureMinimumCount: positive safe integer (default 30) }",
  defaultValue: FORECAST_LEDGER_LAUNCH_POLICY_VALUE,
  decodeValue: decodeForecastLedgerPolicyValue,
});
