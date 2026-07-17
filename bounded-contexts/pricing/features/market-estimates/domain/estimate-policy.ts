import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { MarketEstimateSourceWeights } from "./blended-estimate";

/**
 * The Market-Estimate Policy: every algorithm parameter of the blended
 * Market-Value Estimate is an m110 platform-policy dial from birth, an
 * explicit m112 acceptance criterion -- decay half-life, source weights,
 * percentiles, the minimum-input
 * gate, confidence sample sizes, the comparable-sale lookback window, and
 * the published estimate's freshness horizon. A revision through the policy
 * console changes estimation behavior without a deploy.
 *
 * CONSUMED: the market-price-estimate closer pass (../api/runtime.ts)
 * resolves this policy ONCE per pass through pricing's mounted
 * `PolicyRuntime` and threads the resolved value down as a plain parameter,
 * exactly like the Stat-Hygiene Policy's closer consumption
 * (../../market-trades/domain/stat-hygiene-policy.ts) -- the domain
 * calculation stays policy-machinery-free and pure.
 */

export type MarketEstimatePolicyValue = Readonly<{
  /** Exponential time-decay half-life applied to every Comparable Sale, in days. */
  decayHalfLifeDays: number;
  /** How far back Comparable Sales are gathered, in days. */
  lookbackDays: number;
  /** Weighted percentile published as the Market Price estimate. */
  estimatePercentile: number;
  /** Weighted percentiles bounding the Confidence Band. */
  bandLowPercentile: number;
  bandHighPercentile: number;
  /**
   * Blending weights by Comparable Sale source: platform verified trades
   * highest, platform unverified trades next, external comps least.
   */
  sourceWeights: MarketEstimateSourceWeights;
  /** The minimum-input gate: below this many Comparable Sales, NO estimate is produced. */
  minimumComparableSales: number;
  /** Total-input thresholds that raise the published confidence from low. */
  confidenceSampleSizes: Readonly<{ medium: number; high: number }>;
  /** How long a published estimate stays fresh (`freshUntil = estimatedAt + freshForHours`). */
  freshForHours: number;
}>;

export const MARKET_ESTIMATE_LAUNCH_POLICY_VALUE: MarketEstimatePolicyValue = {
  decayHalfLifeDays: 7,
  lookbackDays: 90,
  estimatePercentile: 50,
  bandLowPercentile: 20,
  bandHighPercentile: 80,
  sourceWeights: {
    platformVerifiedTrade: 1,
    platformTrade: 0.7,
    externalComp: 0.4,
  },
  minimumComparableSales: 3,
  confidenceSampleSizes: { medium: 8, high: 20 },
  freshForHours: 48,
};

const MIN_HALF_LIFE_DAYS = 1;
const MAX_HALF_LIFE_DAYS = 365;
const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 365;
const MIN_MINIMUM_COMPARABLE_SALES = 1;
const MAX_MINIMUM_COMPARABLE_SALES = 50;
const MIN_FRESH_FOR_HOURS = 1;
const MAX_FRESH_FOR_HOURS = 24 * 14;

export function decodeMarketEstimatePolicyValue(raw: JsonValue): MarketEstimatePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Market-estimate policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;

  const decayHalfLifeDays = boundedInteger(
    record.decayHalfLifeDays,
    "Decay half-life days",
    MIN_HALF_LIFE_DAYS,
    MAX_HALF_LIFE_DAYS,
  );
  const lookbackDays = boundedInteger(record.lookbackDays, "Lookback days", MIN_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS);

  const estimatePercentile = boundedInteger(record.estimatePercentile, "Estimate percentile", 1, 99);
  const bandLowPercentile = boundedInteger(record.bandLowPercentile, "Band low percentile", 0, 99);
  const bandHighPercentile = boundedInteger(record.bandHighPercentile, "Band high percentile", 1, 100);
  if (!(bandLowPercentile <= estimatePercentile && estimatePercentile <= bandHighPercentile)) {
    throw new Error("Band percentiles must contain the estimate percentile.");
  }

  if (
    typeof record.sourceWeights !== "object" ||
    record.sourceWeights === null ||
    Array.isArray(record.sourceWeights)
  ) {
    throw new Error("Source weights must be an object.");
  }
  const weightsRecord = record.sourceWeights as Record<string, unknown>;
  const platformVerifiedTrade = boundedWeight(weightsRecord.platformVerifiedTrade, "Platform verified trade weight");
  const platformTrade = boundedWeight(weightsRecord.platformTrade, "Platform trade weight");
  const externalComp = boundedWeight(weightsRecord.externalComp, "External comp weight");
  if (!(platformVerifiedTrade >= platformTrade && platformTrade >= externalComp)) {
    throw new Error(
      "Source weights must keep the blending order: platform verified >= platform unverified >= external comps.",
    );
  }

  const minimumComparableSales = boundedInteger(
    record.minimumComparableSales,
    "Minimum comparable sales",
    MIN_MINIMUM_COMPARABLE_SALES,
    MAX_MINIMUM_COMPARABLE_SALES,
  );

  if (
    typeof record.confidenceSampleSizes !== "object" ||
    record.confidenceSampleSizes === null ||
    Array.isArray(record.confidenceSampleSizes)
  ) {
    throw new Error("Confidence sample sizes must be an object.");
  }
  const confidenceRecord = record.confidenceSampleSizes as Record<string, unknown>;
  const medium = boundedInteger(confidenceRecord.medium, "Medium-confidence sample size", 1, 500);
  const high = boundedInteger(confidenceRecord.high, "High-confidence sample size", 1, 500);
  if (high < medium) {
    throw new Error("High-confidence sample size must be at least the medium-confidence sample size.");
  }

  const freshForHours = boundedInteger(
    record.freshForHours,
    "Fresh-for hours",
    MIN_FRESH_FOR_HOURS,
    MAX_FRESH_FOR_HOURS,
  );

  return {
    decayHalfLifeDays,
    lookbackDays,
    estimatePercentile,
    bandLowPercentile,
    bandHighPercentile,
    sourceWeights: { platformVerifiedTrade, platformTrade, externalComp },
    minimumComparableSales,
    confidenceSampleSizes: { medium, high },
    freshForHours,
  };
}

function boundedInteger(value: unknown, fieldName: string, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`${fieldName} must be a whole number between ${min} and ${max}.`);
  }
  return numeric;
}

function boundedWeight(value: unknown, fieldName: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 1) {
    throw new Error(`${fieldName} must be a number greater than 0 and at most 1.`);
  }
  return numeric;
}

export const marketEstimatePolicy: PolicyDefinition<MarketEstimatePolicyValue> = definePolicy({
  policyKey: "pricing.market-estimate",
  contextName: "pricing",
  schemaSummary:
    "{ decayHalfLifeDays: integer 1-365, lookbackDays: integer 1-365, estimatePercentile: integer 1-99, " +
    "bandLowPercentile: integer 0-99 (<= estimatePercentile), bandHighPercentile: integer 1-100 (>= estimatePercentile), " +
    "sourceWeights: { platformVerifiedTrade: 0-1, platformTrade: 0-1, externalComp: 0-1 (descending) }, " +
    "minimumComparableSales: integer 1-50, confidenceSampleSizes: { medium: integer 1-500, high: integer 1-500 (>= medium) }, " +
    "freshForHours: integer 1-336 }",
  defaultValue: MARKET_ESTIMATE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeMarketEstimatePolicyValue,
});
