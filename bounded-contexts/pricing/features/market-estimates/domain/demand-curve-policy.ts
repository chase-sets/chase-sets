import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

export type DemandCurvePolicyValue = Readonly<{
  conditionOrder: readonly string[];
  decayHalfLifeDays: number;
  historyDays: number;
  salesLimit: number;
  hopelessHorizonDays: number;
  minimumObservationsPerCondition: number;
  percentiles: readonly number[];
  siblingRatioReachLimit: number;
  zipfExponentBounds: Readonly<{ minimum: number; maximum: number }>;
}>;

export const DEMAND_CURVE_LAUNCH_POLICY_VALUE: DemandCurvePolicyValue = {
  conditionOrder: ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"],
  decayHalfLifeDays: 7,
  historyDays: 90,
  salesLimit: 100,
  hopelessHorizonDays: 365,
  minimumObservationsPerCondition: 2,
  percentiles: Array.from({ length: 19 }, (_, index) => (index + 1) * 5),
  siblingRatioReachLimit: 25,
  zipfExponentBounds: { minimum: 0, maximum: 2 },
};

function object(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object.`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)) || keys.some((key) => !(key in result))) {
    throw new Error(`${name} has missing or unknown fields.`);
  }
  return result;
}

function number(value: unknown, name: string, minimum: number, maximum: number, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function decodeDemandCurvePolicyValue(raw: JsonValue): DemandCurvePolicyValue {
  const value = object(raw, "Demand-curve policy", Object.keys(DEMAND_CURVE_LAUNCH_POLICY_VALUE));
  const conditions = value.conditionOrder;
  if (
    !Array.isArray(conditions) ||
    conditions.length < 2 ||
    conditions.length > 20 ||
    conditions.some((condition) => typeof condition !== "string" || condition.trim() !== condition || !condition) ||
    new Set(conditions).size !== conditions.length
  )
    throw new Error("Condition order must contain distinct verbatim conditions.");
  const percentiles = value.percentiles;
  if (
    !Array.isArray(percentiles) ||
    percentiles.length < 1 ||
    percentiles.length > 99 ||
    percentiles.some(
      (p, i) => typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 99 || (i > 0 && p <= percentiles[i - 1]),
    )
  ) {
    throw new Error("Percentiles must be strictly ascending integers between 1 and 99.");
  }
  const zipf = object(value.zipfExponentBounds, "Zipf exponent bounds", ["minimum", "maximum"]);
  const minimum = number(zipf.minimum, "Zipf minimum", 0, 5);
  const maximum = number(zipf.maximum, "Zipf maximum", minimum, 5);
  return {
    conditionOrder: conditions as string[],
    decayHalfLifeDays: number(value.decayHalfLifeDays, "Decay half-life", 1, 365),
    historyDays: number(value.historyDays, "History days", 1, 365, true),
    salesLimit: number(value.salesLimit, "Sales limit", 1, 1000, true),
    hopelessHorizonDays: number(value.hopelessHorizonDays, "Hopeless horizon", 1, 3650, true),
    minimumObservationsPerCondition: number(
      value.minimumObservationsPerCondition,
      "Minimum condition observations",
      1,
      100,
      true,
    ),
    percentiles: percentiles as number[],
    siblingRatioReachLimit: number(value.siblingRatioReachLimit, "Sibling ratio reach", 1, 1000),
    zipfExponentBounds: { minimum, maximum },
  };
}

export const demandCurvePolicy = definePolicy({
  policyKey: "pricing.demand-curve",
  contextName: "pricing",
  schemaSummary:
    "Closed demand-curve policy: ordered provider conditions, decay/history/sales cap, horizon, percentiles, sibling reach, and Zipf bounds.",
  defaultValue: DEMAND_CURVE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeDemandCurvePolicyValue,
});
