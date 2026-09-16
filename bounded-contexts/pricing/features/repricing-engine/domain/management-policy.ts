import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

export type RepricingManagementPolicyValue = Readonly<{ floorBindingAlertDays: number }>;

export const REPRICING_MANAGEMENT_LAUNCH_POLICY_VALUE: RepricingManagementPolicyValue = {
  floorBindingAlertDays: 7,
};

export function decodeRepricingManagementPolicyValue(raw: JsonValue): RepricingManagementPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Repricing-management policy value must be an object.");
  }
  if (Object.keys(raw).some((key) => key !== "floorBindingAlertDays")) {
    throw new Error("Unknown repricing-management policy key.");
  }
  const value =
    raw.floorBindingAlertDays === undefined
      ? REPRICING_MANAGEMENT_LAUNCH_POLICY_VALUE.floorBindingAlertDays
      : raw.floorBindingAlertDays;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 90) {
    throw new Error("floorBindingAlertDays must be an integer between 1 and 90.");
  }
  return { floorBindingAlertDays: value };
}

export const repricingManagementPolicy = definePolicy({
  policyKey: "pricing.repricing-management",
  contextName: "pricing",
  schemaSummary: "{ floorBindingAlertDays: integer 1-90 (default 7) }",
  defaultValue: REPRICING_MANAGEMENT_LAUNCH_POLICY_VALUE,
  decodeValue: decodeRepricingManagementPolicyValue,
});
