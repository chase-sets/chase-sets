import { describe, expect, it } from "vitest";
import { decodeRepricingManagementPolicyValue, repricingManagementPolicy } from "./management-policy";

describe("repricing management policy", () => {
  const launchValue = { floorBindingAlertDays: 7, digestSettleMinutes: 10, digestLagWarnHours: 6 };

  it("defaults absent stored keys to the exact launch values", () => {
    expect(decodeRepricingManagementPolicyValue({})).toEqual(launchValue);
    expect(repricingManagementPolicy.defaultValue).toEqual(launchValue);
    expect(repricingManagementPolicy.policyKey).toBe("pricing.repricing-management");
  });
  it.each(["floorBindingAlertDays", "digestSettleMinutes", "digestLagWarnHours"] as const)(
    "defaults an explicitly undefined %s independently of other stored keys",
    (key) => {
      const stored = { floorBindingAlertDays: 2, digestSettleMinutes: 3, digestLagWarnHours: 4 };
      expect(decodeRepricingManagementPolicyValue({ ...stored, [key]: undefined })).toEqual({
        ...stored,
        [key]: launchValue[key],
      });
      const { [key]: _omitted, ...remaining } = stored;
      expect(decodeRepricingManagementPolicyValue(remaining)).toEqual({ ...stored, [key]: launchValue[key] });
    },
  );
  it.each([1, 10, 120])("accepts %s settle minutes", (digestSettleMinutes) => {
    expect(decodeRepricingManagementPolicyValue({ digestSettleMinutes })).toEqual({
      ...launchValue,
      digestSettleMinutes,
    });
  });
  it.each([1, 6, 48])("accepts %s lag warning hours", (digestLagWarnHours) => {
    expect(decodeRepricingManagementPolicyValue({ digestLagWarnHours })).toEqual({
      ...launchValue,
      digestLagWarnHours,
    });
  });
  it.each([0, -1, 121, 1.5, null, "10", true, {}, []])("rejects invalid settle minutes: %j", (digestSettleMinutes) => {
    expect(() => decodeRepricingManagementPolicyValue({ digestSettleMinutes })).toThrow("digestSettleMinutes");
  });
  it.each([0, -1, 49, 1.5, null, "6", true, {}, []])("rejects invalid lag warning hours: %j", (digestLagWarnHours) => {
    expect(() => decodeRepricingManagementPolicyValue({ digestLagWarnHours })).toThrow("digestLagWarnHours");
  });
  it.each([1, 7, 90])("accepts %s days", (floorBindingAlertDays) => {
    expect(decodeRepricingManagementPolicyValue({ floorBindingAlertDays })).toEqual({
      ...launchValue,
      floorBindingAlertDays,
    });
  });
  it.each([0, -1, 91, 1.5, null, "7", true, {}, []])("rejects invalid days: %j", (floorBindingAlertDays) => {
    expect(() => decodeRepricingManagementPolicyValue({ floorBindingAlertDays })).toThrow("floorBindingAlertDays");
  });
  it.each([null, [], "7", 7, { unknown: { floorBindingAlertDays: 7 } }])("rejects invalid documents: %j", (raw) => {
    expect(() => decodeRepricingManagementPolicyValue(raw)).toThrow();
  });
});
