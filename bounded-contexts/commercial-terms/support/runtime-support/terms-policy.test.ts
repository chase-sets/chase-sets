import { describe, expect, it } from "vitest";
import {
  commercialTermsAgreementPolicy,
  commercialTermsSchedulePolicy,
  decodeCommercialTermsAgreementPolicyValue,
  decodeCommercialTermsSchedulePolicyValue,
} from "./terms-policy";

const ALLOWANCE_KEY = "shippingAllowancePercentageBps";

const scheduleValue = {
  label: "Business Default",
  accountType: "business",
  marketplaceSalesFeePercentageBps: 850,
  marketplaceSalesFeeFixedAmount: "0.10",
};

const agreementValue = {
  label: "Founders window",
  accountId: "acc_seller",
  marketplaceSalesFeePercentageBps: 0,
  marketplaceSalesFeeFixedAmount: "0.00",
};

describe("commercial terms schedule policy value", () => {
  it("always states a Shipping Allowance, defaulting an absent one", () => {
    expect(decodeCommercialTermsSchedulePolicyValue(scheduleValue)).toStrictEqual({
      ...scheduleValue,
      [ALLOWANCE_KEY]: 500,
    });
    expect(decodeCommercialTermsSchedulePolicyValue({ ...scheduleValue, [ALLOWANCE_KEY]: 0 })[ALLOWANCE_KEY]).toBe(0);
    expect(decodeCommercialTermsSchedulePolicyValue({ ...scheduleValue, [ALLOWANCE_KEY]: 725 })[ALLOWANCE_KEY]).toBe(
      725,
    );
    expect(commercialTermsSchedulePolicy("business").defaultValue[ALLOWANCE_KEY]).toBe(500);
  });

  it.each([-1, 10001, 12.5, "five"])("rejects the Shipping Allowance %s", (value) => {
    expect(() => decodeCommercialTermsSchedulePolicyValue({ ...scheduleValue, [ALLOWANCE_KEY]: value })).toThrow(
      "Shipping allowance percentage",
    );
  });
});

describe("commercial terms agreement policy value", () => {
  it.each([
    ["absent", agreementValue],
    ["null", { ...agreementValue, [ALLOWANCE_KEY]: null }],
  ])("leaves an %s Shipping Allowance absent instead of defaulting it", (_case, raw) => {
    const decoded = decodeCommercialTermsAgreementPolicyValue(raw);

    expect(decoded).toStrictEqual(agreementValue);
    expect(Object.keys(decoded)).not.toContain(ALLOWANCE_KEY);
  });

  it.each([0, 500, 725])("keeps a stated Shipping Allowance of %i bps", (value) => {
    expect(decodeCommercialTermsAgreementPolicyValue({ ...agreementValue, [ALLOWANCE_KEY]: value })).toStrictEqual({
      ...agreementValue,
      [ALLOWANCE_KEY]: value,
    });
  });

  it.each([-1, 10001, 12.5, "five"])("rejects the stated Shipping Allowance %s", (value) => {
    expect(() => decodeCommercialTermsAgreementPolicyValue({ ...agreementValue, [ALLOWANCE_KEY]: value })).toThrow(
      "Shipping allowance percentage",
    );
  });

  it("declares a default that states no Shipping Allowance", () => {
    expect(Object.keys(commercialTermsAgreementPolicy("acc_seller").defaultValue)).not.toContain(ALLOWANCE_KEY);
  });
});
