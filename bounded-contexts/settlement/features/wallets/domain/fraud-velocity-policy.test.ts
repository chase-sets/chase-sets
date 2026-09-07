import { describe, expect, it } from "vitest";
import {
  decodeSettlementFraudVelocityPolicyValue,
  SETTLEMENT_FRAUD_VELOCITY_LAUNCH_POLICY_VALUE,
} from "./fraud-velocity-policy";

describe("settlement fraud velocity policy currency", () => {
  it("retains the independently owned USD 250000-cent Listing threshold", () => {
    expect(SETTLEMENT_FRAUD_VELOCITY_LAUNCH_POLICY_VALUE.newSellerListingVelocity).toEqual({
      newAccountAgeDays: 30,
      windowHours: 24,
      minValueCents: 250_000,
      minValueCurrencyCode: "USD",
    });
  });

  it("requires every future policy value to state the threshold currency", () => {
    const value = structuredClone(SETTLEMENT_FRAUD_VELOCITY_LAUNCH_POLICY_VALUE) as Record<string, unknown>;
    const threshold = value.newSellerListingVelocity as Record<string, unknown>;
    delete threshold.minValueCurrencyCode;

    expect(() => decodeSettlementFraudVelocityPolicyValue(value as never)).toThrow(
      "minimum value currency must be a three-letter ISO-4217 code",
    );
  });
});
