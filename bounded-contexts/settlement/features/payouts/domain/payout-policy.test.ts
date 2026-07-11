import { describe, expect, it } from "vitest";
import {
  assertPayoutAmountWithinPolicy,
  capPayoutAmountToPolicy,
  decodeSettlementPayoutBoundsPolicyValue,
  payoutAmountPolicy,
  resolvePayoutAmountSelection,
  settlementPayoutBoundsPolicy,
} from "./payout-policy";

describe("settlement payout-bounds policy", () => {
  it("decodes a valid revised bounds value", () => {
    expect(
      decodeSettlementPayoutBoundsPolicyValue({
        currencyCode: "usd",
        minimumAmount: "10.00",
        maximumAmount: "5000.00",
      }),
    ).toEqual({
      currencyCode: "usd",
      minimumAmount: "10.00",
      maximumAmount: "5000.00",
    });
  });

  it("rejects a minimum amount above the maximum amount (revise-time bounds guardrail)", () => {
    expect(() =>
      decodeSettlementPayoutBoundsPolicyValue({
        currencyCode: "usd",
        minimumAmount: "500.00",
        maximumAmount: "100.00",
      }),
    ).toThrow(/must not exceed/);
  });

  it("rejects a non-positive maximum amount", () => {
    expect(() =>
      decodeSettlementPayoutBoundsPolicyValue({
        currencyCode: "usd",
        minimumAmount: "5.00",
        maximumAmount: "0.00",
      }),
    ).toThrow();
  });

  it("declares the launch value as the compiled default fallback", () => {
    expect(settlementPayoutBoundsPolicy.defaultValue).toEqual(payoutAmountPolicy);
  });

  it("enforces bounds from the compiled default when no policy is passed", () => {
    expect(() => assertPayoutAmountWithinPolicy("1.00", "usd")).toThrow(/at least/);
    expect(() => assertPayoutAmountWithinPolicy("50000.00", "usd")).toThrow(/cannot exceed/);
    expect(assertPayoutAmountWithinPolicy("25.00", "usd")).toBe("25.00");
  });

  it("enforces bounds from a resolved (revised) policy when one is passed", () => {
    const revised = { currencyCode: "usd" as const, minimumAmount: "1.00", maximumAmount: "50.00" };

    expect(assertPayoutAmountWithinPolicy("25.00", "usd", revised)).toBe("25.00");
    expect(() => assertPayoutAmountWithinPolicy("100.00", "usd", revised)).toThrow(/cannot exceed/);
  });

  it("caps a requested amount to the resolved maximum", () => {
    expect(capPayoutAmountToPolicy("999999.00", { maximumAmount: "50.00" })).toBe("50.00");
    expect(capPayoutAmountToPolicy("10.00", { maximumAmount: "50.00" })).toBe("10.00");
  });

  it("resolves the minimum-amount shortcut from the resolved policy", () => {
    const revised = { minimumAmount: "1.00", maximumAmount: "50.00" };
    expect(resolvePayoutAmountSelection({ amount: "0", shortcut: "minimum" }, revised)).toBe("1.00");
  });
});
