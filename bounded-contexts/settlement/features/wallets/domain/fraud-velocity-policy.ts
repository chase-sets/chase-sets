import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { SettlementDomainError } from "../../../support/runtime-support/common";

/**
 * Settlement's m107 fraud/velocity heuristic policy: the chargeback-rate,
 * new-seller-listing, review, and young-buyer-spend window lengths and
 * thresholds that feed `settlement_account_risk_sources`' velocity counters
 * and `velocity_alert_flags`. These numbers predate the m110 platform-policy
 * machinery and were compiled directly into the account-risk-source
 * projection's SQL (`../integrations/account-risk-source/account-risk-source-projection.ts`);
 * this migrates them onto `definePolicy` with the exact current literals as
 * the conservative compiled default -- a byte-identical migration, no
 * threshold loosens or tightens by this change.
 *
 * The CASE/EXISTS structure that decides which counters gate which alert
 * kind stays domain logic in the projection's SQL predicate -- only the
 * NUMBERS (window lengths, counts, rates, and cent thresholds) move onto
 * this policy, following the same split as `./clearance-policy.ts`.
 *
 * Settlement owns and is the only consumer of this policy: the
 * account-risk-source projection resolves it once per counter refresh and
 * stamps the resolved numbers onto the SQL as parameters. Platform
 * Operations' risk-alert queue projection tracks the same m107 signal shape
 * for its own operator-facing alert queue but deliberately defines its own
 * separate policy (`../../../../platform-operations/features/risk-alerts/domain/risk-alert-threshold-policy.ts`)
 * rather than sharing this one: settlement's flags are today a write-only
 * input reserved for future payout-gating use, while Platform Operations'
 * thresholds already drive a live operator queue -- coupling the two now
 * would let an ops-tuned alert threshold silently move settlement's
 * payout-risk signal (or vice versa) with no shared review step.
 */

export type SettlementFraudVelocityPolicyValue = Readonly<{
  /** Chargeback velocity: lookback window and the count/rate that flags manual payout review. */
  chargebackVelocity: Readonly<{
    lookbackDays: number;
    minCount: number;
    minRateBps: number;
  }>;
  /** Reporting-only chargeback counter window; recorded on the risk-source row but not itself compared against a threshold. */
  chargebackReportingWindowDays: number;
  /** New-seller listing velocity: account age under which a listing-value spike in `windowHours` flags. */
  newSellerListingVelocity: Readonly<{
    newAccountAgeDays: number;
    windowHours: number;
    minValueCents: number;
  }>;
  /** Review velocity: review count in `windowHours` against a young median reviewer age that flags a review-farm pattern. */
  reviewVelocity: Readonly<{
    windowHours: number;
    minCount: number;
    maxMedianReviewerAgeDays: number;
  }>;
  /** Young-buyer spend velocity: account age under which a spend spike in `windowHours` flags. */
  youngBuyerSpendVelocity: Readonly<{
    newAccountAgeDays: number;
    windowHours: number;
    minSpendCents: number;
  }>;
}>;

/** The m107 launch values -- the migration's byte-identical seed and compiled fallback. */
export const SETTLEMENT_FRAUD_VELOCITY_LAUNCH_POLICY_VALUE: SettlementFraudVelocityPolicyValue = {
  chargebackVelocity: { lookbackDays: 30, minCount: 2, minRateBps: 200 },
  chargebackReportingWindowDays: 7,
  newSellerListingVelocity: { newAccountAgeDays: 30, windowHours: 24, minValueCents: 250_000 },
  reviewVelocity: { windowHours: 24, minCount: 5, maxMedianReviewerAgeDays: 7 },
  youngBuyerSpendVelocity: { newAccountAgeDays: 7, windowHours: 24, minSpendCents: 200_000 },
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
    throw new SettlementDomainError(`${fieldName} must be a whole number between ${min} and ${max}.`);
  }
  return numeric;
}

function decodeChargebackVelocity(raw: unknown): SettlementFraudVelocityPolicyValue["chargebackVelocity"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Fraud/velocity policy 'chargebackVelocity' must be an object.");
  }
  const record = raw as Record<string, unknown>;
  return {
    lookbackDays: normalizeIntegerField(
      record.lookbackDays,
      "Chargeback velocity lookback days",
      MIN_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
    ),
    minCount: normalizeIntegerField(record.minCount, "Chargeback velocity minimum count", MIN_COUNT, MAX_COUNT),
    minRateBps: normalizeIntegerField(
      record.minRateBps,
      "Chargeback velocity minimum rate (bps)",
      MIN_RATE_BPS,
      MAX_RATE_BPS,
    ),
  };
}

function decodeNewSellerListingVelocity(raw: unknown): SettlementFraudVelocityPolicyValue["newSellerListingVelocity"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Fraud/velocity policy 'newSellerListingVelocity' must be an object.");
  }
  const record = raw as Record<string, unknown>;
  return {
    newAccountAgeDays: normalizeIntegerField(
      record.newAccountAgeDays,
      "New-seller listing velocity account age (days)",
      MIN_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
    ),
    windowHours: normalizeIntegerField(
      record.windowHours,
      "New-seller listing velocity window (hours)",
      MIN_WINDOW_HOURS,
      MAX_WINDOW_HOURS,
    ),
    minValueCents: normalizeIntegerField(
      record.minValueCents,
      "New-seller listing velocity minimum value (cents)",
      MIN_CENTS,
      MAX_CENTS,
    ),
  };
}

function decodeReviewVelocity(raw: unknown): SettlementFraudVelocityPolicyValue["reviewVelocity"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Fraud/velocity policy 'reviewVelocity' must be an object.");
  }
  const record = raw as Record<string, unknown>;
  return {
    windowHours: normalizeIntegerField(
      record.windowHours,
      "Review velocity window (hours)",
      MIN_WINDOW_HOURS,
      MAX_WINDOW_HOURS,
    ),
    minCount: normalizeIntegerField(record.minCount, "Review velocity minimum count", MIN_COUNT, MAX_COUNT),
    maxMedianReviewerAgeDays: normalizeIntegerField(
      record.maxMedianReviewerAgeDays,
      "Review velocity maximum median reviewer age (days)",
      MIN_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
    ),
  };
}

function decodeYoungBuyerSpendVelocity(raw: unknown): SettlementFraudVelocityPolicyValue["youngBuyerSpendVelocity"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Fraud/velocity policy 'youngBuyerSpendVelocity' must be an object.");
  }
  const record = raw as Record<string, unknown>;
  return {
    newAccountAgeDays: normalizeIntegerField(
      record.newAccountAgeDays,
      "Young-buyer spend velocity account age (days)",
      MIN_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
    ),
    windowHours: normalizeIntegerField(
      record.windowHours,
      "Young-buyer spend velocity window (hours)",
      MIN_WINDOW_HOURS,
      MAX_WINDOW_HOURS,
    ),
    minSpendCents: normalizeIntegerField(
      record.minSpendCents,
      "Young-buyer spend velocity minimum spend (cents)",
      MIN_CENTS,
      MAX_CENTS,
    ),
  };
}

export function decodeSettlementFraudVelocityPolicyValue(raw: JsonValue): SettlementFraudVelocityPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Fraud/velocity policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;

  return {
    chargebackVelocity: decodeChargebackVelocity(record.chargebackVelocity),
    chargebackReportingWindowDays: normalizeIntegerField(
      record.chargebackReportingWindowDays,
      "Chargeback reporting window (days)",
      MIN_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
    ),
    newSellerListingVelocity: decodeNewSellerListingVelocity(record.newSellerListingVelocity),
    reviewVelocity: decodeReviewVelocity(record.reviewVelocity),
    youngBuyerSpendVelocity: decodeYoungBuyerSpendVelocity(record.youngBuyerSpendVelocity),
  };
}

export const settlementFraudVelocityPolicy: PolicyDefinition<SettlementFraudVelocityPolicyValue> = definePolicy({
  policyKey: "settlement.fraud-velocity-thresholds",
  contextName: "settlement",
  schemaSummary:
    "{ chargebackVelocity: { lookbackDays, minCount, minRateBps }, chargebackReportingWindowDays, " +
    "newSellerListingVelocity: { newAccountAgeDays, windowHours, minValueCents }, " +
    "reviewVelocity: { windowHours, minCount, maxMedianReviewerAgeDays }, " +
    "youngBuyerSpendVelocity: { newAccountAgeDays, windowHours, minSpendCents } }",
  defaultValue: SETTLEMENT_FRAUD_VELOCITY_LAUNCH_POLICY_VALUE,
  decodeValue: decodeSettlementFraudVelocityPolicyValue,
});
