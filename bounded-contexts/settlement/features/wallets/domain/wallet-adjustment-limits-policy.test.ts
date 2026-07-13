import { describe, expect, it } from "vitest";
import {
  decodeWalletAdjustmentLimitsPolicyValue,
  evaluateWalletAdjustmentLimits,
  WALLET_ADJUSTMENT_LIMITS_DEFAULT,
  walletAdjustmentLimitsPolicy,
} from "./wallet-adjustment-limits-policy";

describe("walletAdjustmentLimitsPolicy", () => {
  it("defaults to normal operation (kill switch off) with conservative window caps", () => {
    expect(walletAdjustmentLimitsPolicy.defaultValue).toEqual(WALLET_ADJUSTMENT_LIMITS_DEFAULT);
    expect(WALLET_ADJUSTMENT_LIMITS_DEFAULT.haltNewActions).toBe(false);
  });

  it("is registered under a settlement-owned policy key distinct from the ADR 0020 controls policy", () => {
    expect(walletAdjustmentLimitsPolicy.policyKey).toBe("settlement.wallet-adjustment-limits");
    expect(walletAdjustmentLimitsPolicy.contextName).toBe("settlement");
  });
});

describe("decodeWalletAdjustmentLimitsPolicyValue", () => {
  it("round-trips a valid policy document value", () => {
    expect(
      decodeWalletAdjustmentLimitsPolicyValue({
        haltNewActions: true,
        perAdjustmentMaxAmount: "500000.00",
        perAccountWindowMaxAmount: "1000.00",
        perAccountWindowMaxCount: 3,
        perOperatorWindowMaxAmount: "5000.00",
        perOperatorWindowMaxCount: 10,
        windowHours: 12,
      }),
    ).toEqual({
      haltNewActions: true,
      perAdjustmentMaxAmount: "500000.00",
      perAccountWindowMaxAmount: "1000.00",
      perAccountWindowMaxCount: 3,
      perOperatorWindowMaxAmount: "5000.00",
      perOperatorWindowMaxCount: 10,
      windowHours: 12,
    });
  });

  it("defaults haltNewActions to false when absent", () => {
    expect(
      decodeWalletAdjustmentLimitsPolicyValue({
        perAdjustmentMaxAmount: "500000.00",
        perAccountWindowMaxAmount: "1000.00",
        perAccountWindowMaxCount: 3,
        perOperatorWindowMaxAmount: "5000.00",
        perOperatorWindowMaxCount: 10,
        windowHours: 12,
      }),
    ).toMatchObject({ haltNewActions: false });
  });

  it("rejects a non-object policy value", () => {
    expect(() => decodeWalletAdjustmentLimitsPolicyValue("not-an-object" as never)).toThrow();
    expect(() => decodeWalletAdjustmentLimitsPolicyValue(null as never)).toThrow();
    expect(() => decodeWalletAdjustmentLimitsPolicyValue(["array"] as never)).toThrow();
  });

  it("rejects a non-boolean haltNewActions", () => {
    expect(() =>
      decodeWalletAdjustmentLimitsPolicyValue({
        haltNewActions: "yes",
        perAdjustmentMaxAmount: "500000.00",
        perAccountWindowMaxAmount: "1000.00",
        perAccountWindowMaxCount: 3,
        perOperatorWindowMaxAmount: "5000.00",
        perOperatorWindowMaxCount: 10,
        windowHours: 12,
      }),
    ).toThrow();
  });

  it("rejects a windowHours outside the bounded range", () => {
    expect(() =>
      decodeWalletAdjustmentLimitsPolicyValue({
        ...WALLET_ADJUSTMENT_LIMITS_DEFAULT,
        windowHours: 0,
      }),
    ).toThrow();
    expect(() =>
      decodeWalletAdjustmentLimitsPolicyValue({
        ...WALLET_ADJUSTMENT_LIMITS_DEFAULT,
        windowHours: 10_000,
      }),
    ).toThrow();
  });

  it("rejects a non-integer window count", () => {
    expect(() =>
      decodeWalletAdjustmentLimitsPolicyValue({
        ...WALLET_ADJUSTMENT_LIMITS_DEFAULT,
        perAccountWindowMaxCount: 2.5,
      }),
    ).toThrow();
  });

  it("rejects a negative amount", () => {
    expect(() =>
      decodeWalletAdjustmentLimitsPolicyValue({
        ...WALLET_ADJUSTMENT_LIMITS_DEFAULT,
        perAdjustmentMaxAmount: "-1.00",
      }),
    ).toThrow();
  });
});

describe("evaluateWalletAdjustmentLimits", () => {
  const zeroActivity = { postedAmount: "0.00", requestedCount: 0 };

  it("returns no violations for an ordinary adjustment well within every limit", () => {
    const violations = evaluateWalletAdjustmentLimits(WALLET_ADJUSTMENT_LIMITS_DEFAULT, {
      amount: "10.00",
      targetAccountActivity: zeroActivity,
      operatorActivity: zeroActivity,
    });
    expect(violations).toEqual([]);
  });

  it("flags an amount exceeding the per-adjustment maximum", () => {
    const violations = evaluateWalletAdjustmentLimits(
      { ...WALLET_ADJUSTMENT_LIMITS_DEFAULT, perAdjustmentMaxAmount: "100.00" },
      { amount: "100.01", targetAccountActivity: zeroActivity, operatorActivity: zeroActivity },
    );
    expect(violations.map((v) => v.code)).toContain("per-adjustment-max-amount");
  });

  it("flags a target account window amount that would be exceeded by this adjustment", () => {
    const violations = evaluateWalletAdjustmentLimits(WALLET_ADJUSTMENT_LIMITS_DEFAULT, {
      amount: "500.00",
      targetAccountActivity: { postedAmount: "1600.00", requestedCount: 0 },
      operatorActivity: zeroActivity,
    });
    expect(violations.map((v) => v.code)).toContain("per-account-window-max-amount");
  });

  it("flags a target account window count that would be exceeded by this request", () => {
    const violations = evaluateWalletAdjustmentLimits(WALLET_ADJUSTMENT_LIMITS_DEFAULT, {
      amount: "1.00",
      targetAccountActivity: { postedAmount: "0.00", requestedCount: 5 },
      operatorActivity: zeroActivity,
    });
    expect(violations.map((v) => v.code)).toContain("per-account-window-max-count");
  });

  it("flags an operator window amount that would be exceeded by this adjustment", () => {
    const violations = evaluateWalletAdjustmentLimits(WALLET_ADJUSTMENT_LIMITS_DEFAULT, {
      amount: "500.00",
      targetAccountActivity: zeroActivity,
      operatorActivity: { postedAmount: "9600.00", requestedCount: 0 },
    });
    expect(violations.map((v) => v.code)).toContain("per-operator-window-max-amount");
  });

  it("flags an operator window count that would be exceeded by this request", () => {
    const violations = evaluateWalletAdjustmentLimits(WALLET_ADJUSTMENT_LIMITS_DEFAULT, {
      amount: "1.00",
      targetAccountActivity: zeroActivity,
      operatorActivity: { postedAmount: "0.00", requestedCount: 20 },
    });
    expect(violations.map((v) => v.code)).toContain("per-operator-window-max-count");
  });

  it("can flag more than one violation at once", () => {
    const violations = evaluateWalletAdjustmentLimits(WALLET_ADJUSTMENT_LIMITS_DEFAULT, {
      amount: "2000000.00",
      targetAccountActivity: { postedAmount: "0.00", requestedCount: 5 },
      operatorActivity: { postedAmount: "0.00", requestedCount: 20 },
    });
    expect(violations.length).toBeGreaterThanOrEqual(4);
  });
});
