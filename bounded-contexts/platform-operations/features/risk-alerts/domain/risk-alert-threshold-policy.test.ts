import { describe, expect, it } from "vitest";
import {
  decodeRiskAlertThresholdPolicyValue,
  RISK_ALERT_THRESHOLD_LAUNCH_POLICY_VALUE,
} from "./risk-alert-threshold-policy";

describe("platform operations risk alert threshold currency", () => {
  it("retains the independently owned USD 250000-cent Listing threshold", () => {
    expect(RISK_ALERT_THRESHOLD_LAUNCH_POLICY_VALUE).toMatchObject({
      newSellerListingValue24hCents: 250_000,
      newSellerListingValueCurrencyCode: "USD",
    });
  });

  it("requires every future policy value to state the threshold currency", () => {
    const value = structuredClone(RISK_ALERT_THRESHOLD_LAUNCH_POLICY_VALUE) as Record<string, unknown>;
    delete value.newSellerListingValueCurrencyCode;

    expect(() => decodeRiskAlertThresholdPolicyValue(value as never)).toThrow(
      "minimum value currency must be a three-letter ISO-4217 code",
    );
  });
});
