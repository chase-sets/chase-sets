import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

export type RepricingManagementPolicyValue = Readonly<{
  floorBindingAlertDays: number;
  digestSettleMinutes: number;
  digestLagWarnHours: number;
}>;

export const REPRICING_MANAGEMENT_LAUNCH_POLICY_VALUE: RepricingManagementPolicyValue = {
  floorBindingAlertDays: 7,
  digestSettleMinutes: 10,
  digestLagWarnHours: 6,
};

export function decodeRepricingManagementPolicyValue(raw: JsonValue): RepricingManagementPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Repricing-management policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) => !["floorBindingAlertDays", "digestSettleMinutes", "digestLagWarnHours"].includes(key),
    )
  ) {
    throw new Error("Unknown repricing-management policy key.");
  }
  const value =
    record.floorBindingAlertDays === undefined
      ? REPRICING_MANAGEMENT_LAUNCH_POLICY_VALUE.floorBindingAlertDays
      : record.floorBindingAlertDays;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 90) {
    throw new Error("floorBindingAlertDays must be an integer between 1 and 90.");
  }
  const digestSettleMinutes =
    record.digestSettleMinutes === undefined
      ? REPRICING_MANAGEMENT_LAUNCH_POLICY_VALUE.digestSettleMinutes
      : record.digestSettleMinutes;
  const digestLagWarnHours =
    record.digestLagWarnHours === undefined
      ? REPRICING_MANAGEMENT_LAUNCH_POLICY_VALUE.digestLagWarnHours
      : record.digestLagWarnHours;
  if (
    typeof digestSettleMinutes !== "number" ||
    !Number.isInteger(digestSettleMinutes) ||
    digestSettleMinutes < 1 ||
    digestSettleMinutes > 120
  ) {
    throw new Error("digestSettleMinutes must be an integer between 1 and 120.");
  }
  if (
    typeof digestLagWarnHours !== "number" ||
    !Number.isInteger(digestLagWarnHours) ||
    digestLagWarnHours < 1 ||
    digestLagWarnHours > 48
  ) {
    throw new Error("digestLagWarnHours must be an integer between 1 and 48.");
  }
  return { floorBindingAlertDays: value, digestSettleMinutes, digestLagWarnHours };
}

export const repricingManagementPolicy = definePolicy({
  policyKey: "pricing.repricing-management",
  contextName: "pricing",
  schemaSummary:
    "{ floorBindingAlertDays: integer 1-90 (default 7), digestSettleMinutes: integer 1-120 (default 10), digestLagWarnHours: integer 1-48 (default 6) }",
  defaultValue: REPRICING_MANAGEMENT_LAUNCH_POLICY_VALUE,
  decodeValue: decodeRepricingManagementPolicyValue,
});
