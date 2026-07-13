import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

/**
 * Platform Operations' m107 risk-alert threshold policy: the chargeback-rate,
 * new-seller-listing, review, and young-buyer-spend window lengths and
 * counts that decide when the risk-alert queue projection
 * (`../read-model/projection.ts`) opens an operator-facing alert for an
 * account. These numbers predate the m110 platform-policy machinery and were
 * compiled as `riskAlertThresholdDefaults` plus hardcoded SQL interval
 * literals; this migrates them onto `definePolicy` with the exact current
 * literals as the conservative compiled default -- a byte-identical
 * migration, no threshold loosens or tightens by this change.
 *
 * Platform Operations owns and is the only consumer of this policy: the
 * risk-alert queue projection resolves it once per counter refresh and
 * stamps the resolved numbers onto both the SQL window parameters and the
 * JS-side threshold comparisons. Settlement's account-risk-source projection
 * tracks the same m107 signal shape for its own (currently write-only)
 * payout-risk read model but deliberately defines its own separate policy
 * (`../../../../settlement/features/wallets/domain/fraud-velocity-policy.ts`)
 * -- see that file's header comment for why the two are not shared.
 */

export class RiskAlertPolicyDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskAlertPolicyDomainError";
  }
}

export type RiskAlertThresholdPolicyValue = Readonly<{
  /** Lookback window (days) for both the chargeback count and its seller-payment-count rate denominator. */
  chargebackLookbackDays: number;
  /** Chargeback count in the lookback window that alone flags chargeback-velocity. */
  chargebackMinCount: number;
  /** Chargeback rate (bps of seller payments) that alone flags chargeback-velocity. */
  chargebackMinRateBps: number;
  /** Account age (days) under which a listing-value spike flags new-seller-listing-velocity. */
  newSellerAgeDays: number;
  /** Window (hours) the listing-value spike is measured over. */
  newSellerListingWindowHours: number;
  /** Listing value (cents) in the window that flags new-seller-listing-velocity. */
  newSellerListingValue24hCents: number;
  /** Window (hours) review count and median reviewer age are measured over. */
  reviewWindowHours: number;
  /** Review count in the window that, combined with a young median reviewer age, flags review-velocity. */
  review24hCount: number;
  /** Median reviewer account age (days) below which review-velocity flags. */
  medianReviewerAgeDays: number;
  /** Account age (days) under which a spend spike flags young-buyer-spend-velocity. */
  youngBuyerAgeDays: number;
  /** Window (hours) the buyer spend spike is measured over. */
  youngBuyerSpendWindowHours: number;
  /** Buyer spend (cents) in the window that flags young-buyer-spend-velocity. */
  youngBuyerSpend24hCents: number;
}>;

/** The m107 launch values -- the migration's byte-identical seed and compiled fallback. */
export const RISK_ALERT_THRESHOLD_LAUNCH_POLICY_VALUE: RiskAlertThresholdPolicyValue = {
  chargebackLookbackDays: 30,
  chargebackMinCount: 2,
  chargebackMinRateBps: 200,
  newSellerAgeDays: 30,
  newSellerListingWindowHours: 24,
  newSellerListingValue24hCents: 250_000,
  reviewWindowHours: 24,
  review24hCount: 5,
  medianReviewerAgeDays: 7,
  youngBuyerAgeDays: 7,
  youngBuyerSpendWindowHours: 24,
  youngBuyerSpend24hCents: 200_000,
};

const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 180;
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 168;
const MIN_COUNT = 1;
const MAX_COUNT = 100_000;
const MIN_RATE_BPS = 1;
const MAX_RATE_BPS = 10_000;
const MIN_CENTS = 0;
const MAX_CENTS = 100_000_000;

function normalizeIntegerField(value: unknown, fieldName: string, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new RiskAlertPolicyDomainError(`${fieldName} must be a whole number between ${min} and ${max}.`);
  }
  return numeric;
}

export function decodeRiskAlertThresholdPolicyValue(raw: JsonValue): RiskAlertThresholdPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RiskAlertPolicyDomainError("Risk-alert threshold policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;

  return {
    chargebackLookbackDays: normalizeIntegerField(
      record.chargebackLookbackDays,
      "Chargeback lookback window (days)",
      MIN_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
    ),
    chargebackMinCount: normalizeIntegerField(
      record.chargebackMinCount,
      "Chargeback minimum count",
      MIN_COUNT,
      MAX_COUNT,
    ),
    chargebackMinRateBps: normalizeIntegerField(
      record.chargebackMinRateBps,
      "Chargeback minimum rate (bps)",
      MIN_RATE_BPS,
      MAX_RATE_BPS,
    ),
    newSellerAgeDays: normalizeIntegerField(
      record.newSellerAgeDays,
      "New-seller account age (days)",
      MIN_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
    ),
    newSellerListingWindowHours: normalizeIntegerField(
      record.newSellerListingWindowHours,
      "New-seller listing window (hours)",
      MIN_WINDOW_HOURS,
      MAX_WINDOW_HOURS,
    ),
    newSellerListingValue24hCents: normalizeIntegerField(
      record.newSellerListingValue24hCents,
      "New-seller listing minimum value (cents)",
      MIN_CENTS,
      MAX_CENTS,
    ),
    reviewWindowHours: normalizeIntegerField(
      record.reviewWindowHours,
      "Review window (hours)",
      MIN_WINDOW_HOURS,
      MAX_WINDOW_HOURS,
    ),
    review24hCount: normalizeIntegerField(record.review24hCount, "Review minimum count", MIN_COUNT, MAX_COUNT),
    medianReviewerAgeDays: normalizeIntegerField(
      record.medianReviewerAgeDays,
      "Maximum median reviewer age (days)",
      MIN_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
    ),
    youngBuyerAgeDays: normalizeIntegerField(
      record.youngBuyerAgeDays,
      "Young-buyer account age (days)",
      MIN_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
    ),
    youngBuyerSpendWindowHours: normalizeIntegerField(
      record.youngBuyerSpendWindowHours,
      "Young-buyer spend window (hours)",
      MIN_WINDOW_HOURS,
      MAX_WINDOW_HOURS,
    ),
    youngBuyerSpend24hCents: normalizeIntegerField(
      record.youngBuyerSpend24hCents,
      "Young-buyer minimum spend (cents)",
      MIN_CENTS,
      MAX_CENTS,
    ),
  };
}

export const riskAlertThresholdPolicy: PolicyDefinition<RiskAlertThresholdPolicyValue> = definePolicy({
  policyKey: "platform-operations.risk-alert-thresholds",
  contextName: "platform-operations",
  schemaSummary:
    "{ chargebackLookbackDays, chargebackMinCount, chargebackMinRateBps, newSellerAgeDays, " +
    "newSellerListingWindowHours, newSellerListingValue24hCents, reviewWindowHours, review24hCount, " +
    "medianReviewerAgeDays, youngBuyerAgeDays, youngBuyerSpendWindowHours, youngBuyerSpend24hCents }",
  defaultValue: RISK_ALERT_THRESHOLD_LAUNCH_POLICY_VALUE,
  decodeValue: decodeRiskAlertThresholdPolicyValue,
});
