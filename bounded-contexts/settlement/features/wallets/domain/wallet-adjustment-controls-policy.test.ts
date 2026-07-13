import { describe, expect, it } from "vitest";
import { WALLET_ADJUSTMENT_CONTROLS_DEFAULT } from "./wallet-adjustment";
import {
  decodeWalletAdjustmentControlsPolicyValue,
  walletAdjustmentControlsPolicy,
} from "./wallet-adjustment-controls-policy";

describe("walletAdjustmentControlsPolicy", () => {
  it("uses the ADR 0020 conservative compiled default", () => {
    expect(walletAdjustmentControlsPolicy.defaultValue).toEqual({
      highValueCreditThresholdAmount: "500.00",
      highValueDebitThresholdAmount: "500.00",
      recentAuthMaxAgeMinutes: 15,
    });
    expect(walletAdjustmentControlsPolicy.defaultValue).toEqual(WALLET_ADJUSTMENT_CONTROLS_DEFAULT);
  });

  it("is registered under the settlement-owned policy key ADR 0020 names", () => {
    expect(walletAdjustmentControlsPolicy.policyKey).toBe("settlement.wallet-adjustment-controls");
    expect(walletAdjustmentControlsPolicy.contextName).toBe("settlement");
  });
});

describe("decodeWalletAdjustmentControlsPolicyValue", () => {
  it("round-trips a valid policy document value", () => {
    expect(
      decodeWalletAdjustmentControlsPolicyValue({
        highValueCreditThresholdAmount: "750.00",
        highValueDebitThresholdAmount: "250.50",
        recentAuthMaxAgeMinutes: 10,
      }),
    ).toEqual({
      highValueCreditThresholdAmount: "750.00",
      highValueDebitThresholdAmount: "250.50",
      recentAuthMaxAgeMinutes: 10,
    });
  });

  it("rejects a non-object policy value", () => {
    expect(() => decodeWalletAdjustmentControlsPolicyValue("not-an-object" as never)).toThrow();
    expect(() => decodeWalletAdjustmentControlsPolicyValue(null as never)).toThrow();
    expect(() => decodeWalletAdjustmentControlsPolicyValue(["array"] as never)).toThrow();
  });

  it("rejects a negative-balance-elevation window of zero or negative minutes", () => {
    expect(() =>
      decodeWalletAdjustmentControlsPolicyValue({
        highValueCreditThresholdAmount: "500.00",
        highValueDebitThresholdAmount: "500.00",
        recentAuthMaxAgeMinutes: 0,
      }),
    ).toThrow("Recent-authentication window must be a whole number of minutes greater than zero.");
  });

  it("rejects a non-integer recent-auth window", () => {
    expect(() =>
      decodeWalletAdjustmentControlsPolicyValue({
        highValueCreditThresholdAmount: "500.00",
        highValueDebitThresholdAmount: "500.00",
        recentAuthMaxAgeMinutes: 12.5,
      }),
    ).toThrow();
  });

  it("rejects a negative threshold amount", () => {
    expect(() =>
      decodeWalletAdjustmentControlsPolicyValue({
        highValueCreditThresholdAmount: "-1.00",
        highValueDebitThresholdAmount: "500.00",
        recentAuthMaxAgeMinutes: 15,
      }),
    ).toThrow();
  });

  it("allows a zero threshold amount (every credit/debit is high-value)", () => {
    expect(
      decodeWalletAdjustmentControlsPolicyValue({
        highValueCreditThresholdAmount: "0.00",
        highValueDebitThresholdAmount: "0.00",
        recentAuthMaxAgeMinutes: 15,
      }),
    ).toEqual({
      highValueCreditThresholdAmount: "0.00",
      highValueDebitThresholdAmount: "0.00",
      recentAuthMaxAgeMinutes: 15,
    });
  });
});
