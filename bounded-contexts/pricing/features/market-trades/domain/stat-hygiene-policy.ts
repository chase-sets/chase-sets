import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

/**
 * The Trades Tape's stat-hygiene policy: the runtime-configurable dials that
 * keep aggregate market stats manipulation-resistant and honest about small
 * samples -- minimum trade count before a median displays, the short/long
 * lookback windows, and the outlier-trimming percentile applied to each tail
 * before computing aggregate stats. Declared here, on the m110 platform-
 * policy machinery, with a compiled fallback identical to the values
 * `market-rollups/read-model/rollup-policy.ts` has hard-coded (that file's
 * own header comment names this exact seam).
 *
 * DEFERRED, not this slice: wiring `rollup-maintenance.ts` / `queries.ts`
 * call sites to resolve through this policy instead of the hard-coded
 * constants. This slice lands only the declaration (this file) plus the
 * outlier-trimming dial, which is new -- no prior slice had a call site for
 * it yet. The m110 policy-consolidation slice (deliberately LAST in the
 * market-analytics epic's sequencing) is where every pricing constant this
 * shape migrates onto live resolution.
 */

export type MarketStatHygienePolicyValue = Readonly<{
  /** Minimum trade count in a window before its median is displayed rather than suppressed. */
  minimumTradeSample: number;
  /** Convenience lookback windows offered on market-stat surfaces, in days. */
  lookbackDays: Readonly<{ short: number; long: number }>;
  /**
   * Percentile trimmed from EACH tail before computing aggregate stats over a
   * window (e.g. 5 trims below p5 and above p95). 0 disables trimming.
   */
  outlierTrimPercentile: number;
}>;

/** The rollup slice's existing hard-coded defaults, carried forward byte-identical as the compiled fallback. */
export const MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE: MarketStatHygienePolicyValue = {
  minimumTradeSample: 3,
  lookbackDays: { short: 30, long: 90 },
  outlierTrimPercentile: 5,
};

const MIN_TRADE_SAMPLE = 1;
const MAX_TRADE_SAMPLE = 50;
const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 365;
const MIN_TRIM_PERCENTILE = 0;
const MAX_TRIM_PERCENTILE = 25;

function normalizeBoundedInteger(value: unknown, fieldName: string, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`${fieldName} must be a whole number between ${min} and ${max}.`);
  }
  return numeric;
}

export function decodeMarketStatHygienePolicyValue(raw: JsonValue): MarketStatHygienePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Market stat-hygiene policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;

  const minimumTradeSample = normalizeBoundedInteger(
    record.minimumTradeSample,
    "Minimum trade sample",
    MIN_TRADE_SAMPLE,
    MAX_TRADE_SAMPLE,
  );

  if (typeof record.lookbackDays !== "object" || record.lookbackDays === null || Array.isArray(record.lookbackDays)) {
    throw new Error("Lookback days must be an object with short and long day counts.");
  }
  const lookbackRecord = record.lookbackDays as Record<string, unknown>;
  const short = normalizeBoundedInteger(
    lookbackRecord.short,
    "Short lookback days",
    MIN_LOOKBACK_DAYS,
    MAX_LOOKBACK_DAYS,
  );
  const long = normalizeBoundedInteger(lookbackRecord.long, "Long lookback days", MIN_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS);
  if (long < short) {
    throw new Error("Long lookback days must be at least the short lookback days.");
  }

  const outlierTrimPercentile = normalizeBoundedInteger(
    record.outlierTrimPercentile,
    "Outlier trim percentile",
    MIN_TRIM_PERCENTILE,
    MAX_TRIM_PERCENTILE,
  );

  return {
    minimumTradeSample,
    lookbackDays: { short, long },
    outlierTrimPercentile,
  };
}

export const marketStatHygienePolicy: PolicyDefinition<MarketStatHygienePolicyValue> = definePolicy({
  policyKey: "pricing.market-stat-hygiene",
  contextName: "pricing",
  schemaSummary:
    "{ minimumTradeSample: integer 1-50, lookbackDays: { short: integer 1-365, long: integer 1-365 (>= short) }, outlierTrimPercentile: integer 0-25 (each tail) }",
  defaultValue: MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeMarketStatHygienePolicyValue,
});
