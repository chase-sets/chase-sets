import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

/**
 * The Trades Tape's stat-hygiene policy: the runtime-configurable dials that
 * keep aggregate market stats manipulation-resistant and honest about small
 * samples -- minimum trade count before a median displays, the short/long
 * lookback windows, the outlier-trimming percentile applied to each tail
 * before computing aggregate stats, and the daily closer job's trailing
 * re-derive window. Declared here, on the m110 platform-policy machinery,
 * with a compiled fallback identical to this milestone's launch behavior.
 *
 * CONSUMED: every `rollup-maintenance.ts` / `queries.ts` call site resolves
 * this policy once per closer pass / request through pricing's own mounted
 * `PolicyRuntime` (see `support/runtime-support/services.ts`) and threads the
 * resolved value down as a plain parameter -- the read-model functions
 * themselves stay policy-machinery-free and pure. This is the single source
 * for these dials; no compiled constant duplicates them elsewhere.
 *
 * `outlierTrimPercentile` applies only to median inputs in recomputable Daily
 * Product Rollups and 30/90-day Product Market Aggregates. First/last/min/max,
 * volume, and counts remain raw recorded facts. A window is trimmed only when
 * `tradeCount * outlierTrimPercentile / 100 >= 1`; thinner windows retain every
 * included trade. The formula enables continuous-percentile boundary trimming;
 * it is not a floor-count of rows removed from each tail.
 */

export type MarketStatHygienePolicyValue = Readonly<{
  /** Minimum trade count in a window before its median is displayed rather than suppressed. */
  minimumTradeSample: number;
  /** Convenience lookback windows offered on market-stat surfaces, in days. */
  lookbackDays: Readonly<{ short: number; long: number }>;
  /**
   * Continuous percentile trimmed from EACH tail before computing a window
   * median (e.g. 5 excludes values below p5 and above p95). 0 disables
   * trimming; the trim is also disabled when the window cannot address at
   * least one trade per tail.
   */
  outlierTrimPercentile: number;
  /**
   * Trailing window (inclusive of today) the daily closer job re-derives on
   * every pass, so a late refund/cancellation exclusion on a recently-closed
   * day is reflected without a manual backfill. See
   * `market-rollups/read-model/rollup-maintenance.ts`'s module header for why
   * this is a re-derive-not-patch window.
   */
  rollupCloserTrailingWindowDays: number;
}>;

/** The rollup slice's existing hard-coded defaults, carried forward byte-identical as the compiled fallback. */
export const MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE: MarketStatHygienePolicyValue = {
  minimumTradeSample: 3,
  lookbackDays: { short: 30, long: 90 },
  outlierTrimPercentile: 5,
  rollupCloserTrailingWindowDays: 3,
};

const MIN_TRADE_SAMPLE = 1;
const MAX_TRADE_SAMPLE = 50;
const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 365;
const MIN_TRIM_PERCENTILE = 0;
const MAX_TRIM_PERCENTILE = 25;
const MIN_CLOSER_TRAILING_WINDOW_DAYS = 1;
const MAX_CLOSER_TRAILING_WINDOW_DAYS = 30;

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

  const rollupCloserTrailingWindowDays = normalizeBoundedInteger(
    record.rollupCloserTrailingWindowDays,
    "Rollup closer trailing window days",
    MIN_CLOSER_TRAILING_WINDOW_DAYS,
    MAX_CLOSER_TRAILING_WINDOW_DAYS,
  );

  return {
    minimumTradeSample,
    lookbackDays: { short, long },
    outlierTrimPercentile,
    rollupCloserTrailingWindowDays,
  };
}

export const marketStatHygienePolicy: PolicyDefinition<MarketStatHygienePolicyValue> = definePolicy({
  policyKey: "pricing.market-stat-hygiene",
  contextName: "pricing",
  schemaSummary:
    "{ minimumTradeSample: integer 1-50, lookbackDays: { short: integer 1-365, long: integer 1-365 (>= short) }, outlierTrimPercentile: integer 0-25 (each tail), rollupCloserTrailingWindowDays: integer 1-30 }",
  defaultValue: MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeMarketStatHygienePolicyValue,
});
