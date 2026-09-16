import { describe, expect, it } from "vitest";
import { decodeRepricingManagementPolicyValue, repricingManagementPolicy } from "./management-policy";

describe("repricing management policy", () => {
  it("defaults absent stored keys to the seven-day launch value", () => {
    expect(decodeRepricingManagementPolicyValue({})).toEqual({ floorBindingAlertDays: 7 });
    expect(repricingManagementPolicy.defaultValue).toEqual({ floorBindingAlertDays: 7 });
    expect(repricingManagementPolicy.policyKey).toBe("pricing.repricing-management");
  });
  it.each([1, 7, 90])("accepts %s days", (floorBindingAlertDays) => {
    expect(decodeRepricingManagementPolicyValue({ floorBindingAlertDays })).toEqual({ floorBindingAlertDays });
  });
  it.each([0, -1, 91, 1.5, null, "7", true, {}, []])("rejects invalid days: %j", (floorBindingAlertDays) => {
    expect(() => decodeRepricingManagementPolicyValue({ floorBindingAlertDays })).toThrow("floorBindingAlertDays");
  });
  it.each([null, [], "7", 7, { unknown: { floorBindingAlertDays: 7 } }])("rejects invalid documents: %j", (raw) => {
    expect(() => decodeRepricingManagementPolicyValue(raw)).toThrow();
  });
});
