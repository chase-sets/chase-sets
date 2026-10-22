import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { RepricingSourceShareWeek } from "../read-model/source-share";

export type BulkRepriceSunsetPolicyValue = Readonly<{
  maxBulkSharePercent: number;
  consecutiveCompleteWeeks: number;
  relianceListingThreshold: number;
}>;

export type BulkRepriceSunsetDecision = Readonly<{
  status: "eligible" | "ineligible" | "unknown";
  reasons: readonly string[];
}>;

export class BulkRepriceSunsetPolicyError extends Error {}

function integer(raw: unknown, field: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new BulkRepriceSunsetPolicyError(`${field} must be an integer between ${min} and ${max}.`);
  }
  return raw;
}

export function decodeBulkRepriceSunsetPolicyValue(raw: JsonValue): BulkRepriceSunsetPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BulkRepriceSunsetPolicyError("Bulk reprice sunset policy must be an object.");
  }
  const value = raw as Record<string, unknown>;
  const allowedKeys = new Set(["maxBulkSharePercent", "consecutiveCompleteWeeks", "relianceListingThreshold"]);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new BulkRepriceSunsetPolicyError(`Unknown bulk reprice sunset policy field: ${unknownKey}.`);
  }
  return {
    maxBulkSharePercent: integer(value.maxBulkSharePercent, "maxBulkSharePercent", 0, 100),
    consecutiveCompleteWeeks: integer(value.consecutiveCompleteWeeks, "consecutiveCompleteWeeks", 1, 26),
    relianceListingThreshold: integer(value.relianceListingThreshold, "relianceListingThreshold", 0, Number.MAX_SAFE_INTEGER),
  };
}

export const bulkRepriceSunsetPolicy: PolicyDefinition<BulkRepriceSunsetPolicyValue> = definePolicy({
  policyKey: "pricing.bulk-reprice-sunset",
  contextName: "pricing",
  schemaSummary:
    "{ maxBulkSharePercent: integer 0-100, consecutiveCompleteWeeks: integer 1-26, relianceListingThreshold: integer >=0 }",
  defaultValue: { maxBulkSharePercent: 100, consecutiveCompleteWeeks: 1, relianceListingThreshold: 0 },
  decodeValue: decodeBulkRepriceSunsetPolicyValue,
});

export function evaluateBulkRepriceSunset(
  weeks: readonly RepricingSourceShareWeek[],
  policy: BulkRepriceSunsetPolicyValue | null,
  policyConfigured = policy !== null,
): BulkRepriceSunsetDecision {
  if (!policy || !policyConfigured) return { status: "unknown", reasons: ["policy-not-configured"] };
  const recent = weeks.slice(-policy.consecutiveCompleteWeeks);
  if (recent.length < policy.consecutiveCompleteWeeks) {
    return { status: "unknown", reasons: ["insufficient-weeks"] };
  }
  const reasons: string[] = [];
  for (const week of recent) {
    if (week.status !== "complete") reasons.push(`${week.weekStart}:incomplete`);
    if (week.shares.bulk * 100 > policy.maxBulkSharePercent) reasons.push(`${week.weekStart}:bulk-share-over-limit`);
    for (const seller of week.topSellers) {
      if (
        seller.bulkListingCount > policy.relianceListingThreshold &&
        seller.bulkCount > seller.policyCount &&
        seller.bulkCount > seller.manualCount
      ) {
        reasons.push(`${week.weekStart}:${seller.accountId}:bulk-reliance`);
      }
    }
  }
  if (recent.some((week) => week.status !== "complete")) return { status: "unknown", reasons };
  return reasons.length === 0 ? { status: "eligible", reasons: [] } : { status: "ineligible", reasons };
}
