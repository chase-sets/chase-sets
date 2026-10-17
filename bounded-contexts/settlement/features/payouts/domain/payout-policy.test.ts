import { describe, expect, it } from "vitest";
import { SettlementDomainError } from "../../../support/runtime-support/common";
import {
  assertPayoutAmountWithinPolicy,
  capPayoutAmountToPolicy,
  decodeSettlementPayoutFeePolicyValue,
  decodeSettlementPayoutBoundsPolicyValue,
  payoutAmountPolicy,
  quotePayoutFee,
  resolvePayoutAmountSelection,
  settlementPayoutBoundsPolicy,
  settlementPayoutFeePolicy,
  SETTLEMENT_PAYOUT_FEE_LAUNCH_POLICY_VALUE,
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

  it("cap payout amount to policy requested amount matrix", () => {
    const cases = [
      ["", "0.00"],
      ["abc", "0.00"],
      ["0.00", "0.00"],
      ["-5.00", "0.00"],
      ["10.005", "0.00"],
      ["+10.00", "0.00"],
      ["1e2", "0.00"],
      ["10.00abc", "0.00"],
      ["999999.00", "10000.00"],
      ["99999999999.00", "0.00"],
      ["10.00", "10.00"],
    ] as const;

    for (const [amount, expected] of cases) {
      const result = capPayoutAmountToPolicy(amount);
      expect(result, amount).toBe(expected);
      expect(result, amount).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("cap payout amount to policy rejects a non-canonical policy maximum", () => {
    const invalidShapeOrRange = ["", "abc", "-5.00", "10.005", "+10.00", "1e2", "10.00abc", "99999999999.00"];

    for (const maximumAmount of invalidShapeOrRange) {
      let rejection: unknown;
      try {
        capPayoutAmountToPolicy("10.00", { maximumAmount });
      } catch (error) {
        rejection = error;
      }
      expect(rejection, maximumAmount).toBeInstanceOf(SettlementDomainError);
      expect(rejection, maximumAmount).toMatchObject({
        name: "SettlementDomainError",
        message: "Payout maximum amount must be a valid decimal.",
      });
    }

    let zeroRejection: unknown;
    try {
      capPayoutAmountToPolicy("10.00", { maximumAmount: "0.00" });
    } catch (error) {
      zeroRejection = error;
    }
    expect(zeroRejection).toBeInstanceOf(SettlementDomainError);
    expect(zeroRejection).toMatchObject({
      name: "SettlementDomainError",
      message: "Payout maximum amount must be greater than zero.",
    });

    expect(capPayoutAmountToPolicy("10.00", { maximumAmount: "999999.00" })).toBe("10.00");
    expect(capPayoutAmountToPolicy("999999.00", { maximumAmount: "10000.00" })).toBe("10000.00");
  });

  it("resolves the minimum-amount shortcut from the resolved policy", () => {
    const revised = { minimumAmount: "1.00", maximumAmount: "50.00" };
    expect(resolvePayoutAmountSelection({ amount: "0", shortcut: "minimum" }, revised)).toBe("1.00");
  });
});

describe("payout-fee-quote-and-decode", () => {
  it("keeps the compiled fallback byte-identical to the declared policy default with the monthly amount absorbed", () => {
    expect(JSON.stringify(settlementPayoutFeePolicy.defaultValue)).toBe(
      JSON.stringify(SETTLEMENT_PAYOUT_FEE_LAUNCH_POLICY_VALUE),
    );
    expect(SETTLEMENT_PAYOUT_FEE_LAUNCH_POLICY_VALUE).toEqual({
      label: "Payout fee",
      percentageBps: 25,
      fixedAmount: "0.25",
      firstPayoutOfMonthFixedAmount: "0.00",
    });
  });

  it("quotes the minimum payout and preserves percentage-ceiling rounding", () => {
    expect(quotePayoutFee("5.00")).toEqual({ feeAmount: "0.27", netAmount: "4.73" });

    // A nearest/floor mutant produces 0.26: 25 bps of 5.00 is 1.25 cents and must round up.
    expect(quotePayoutFee("5.00").feeAmount).not.toBe("0.26");
  });

  it("quotes an amount where percentage exceeds the fixed component", () => {
    expect(quotePayoutFee("200.00")).toEqual({ feeAmount: "0.75", netAmount: "199.25" });
  });

  it("adds the monthly component only for the first payout of the month", () => {
    const revised = {
      percentageBps: 25,
      fixedAmount: "0.25",
      firstPayoutOfMonthFixedAmount: "0.50",
    };

    expect(quotePayoutFee("10.00", revised, { isFirstPayoutOfMonth: false })).toEqual({
      feeAmount: "0.28",
      netAmount: "9.72",
    });
    expect(quotePayoutFee("10.00", revised, { isFirstPayoutOfMonth: true })).toEqual({
      feeAmount: "0.78",
      netAmount: "9.22",
    });
  });

  it("rejects requested amounts at or below the fee instead of fabricating a negative valid net", () => {
    expect(() => quotePayoutFee("0.10")).toThrow("Payout requested amount must exceed the payout fee.");
    expect(() =>
      quotePayoutFee("0.25", {
        percentageBps: 0,
        fixedAmount: "0.25",
        firstPayoutOfMonthFixedAmount: "0.00",
      }),
    ).toThrow("Payout requested amount must exceed the payout fee.");
  });

  it("decodes the exact closed value shape and canonicalizes its money amounts", () => {
    expect(
      decodeSettlementPayoutFeePolicyValue({
        label: " Revised payout fee ",
        percentageBps: 1000,
        fixedAmount: "5",
        firstPayoutOfMonthFixedAmount: "0",
      }),
    ).toEqual({
      label: "Revised payout fee",
      percentageBps: 1000,
      fixedAmount: "5.00",
      firstPayoutOfMonthFixedAmount: "0.00",
    });
    expect(
      decodeSettlementPayoutFeePolicyValue({
        label: "Monthly-only boundary",
        percentageBps: 0,
        fixedAmount: "0.00",
        firstPayoutOfMonthFixedAmount: "5.00",
      }),
    ).toEqual({
      label: "Monthly-only boundary",
      percentageBps: 0,
      fixedAmount: "0.00",
      firstPayoutOfMonthFixedAmount: "5.00",
    });
  });

  it.each([
    ["non-object", null],
    ["missing field", { label: "Payout fee", percentageBps: 25, fixedAmount: "0.25" }],
    [
      "extra field",
      {
        label: "Payout fee",
        percentageBps: 25,
        fixedAmount: "0.25",
        firstPayoutOfMonthFixedAmount: "0.00",
        currencyCode: "usd",
      },
    ],
    [
      "wrong scalar type",
      {
        label: "Payout fee",
        percentageBps: "25",
        fixedAmount: "0.25",
        firstPayoutOfMonthFixedAmount: "0.00",
      },
    ],
    [
      "empty label",
      {
        label: " ",
        percentageBps: 25,
        fixedAmount: "0.25",
        firstPayoutOfMonthFixedAmount: "0.00",
      },
    ],
    [
      "fractional percentage",
      {
        label: "Payout fee",
        percentageBps: 25.5,
        fixedAmount: "0.25",
        firstPayoutOfMonthFixedAmount: "0.00",
      },
    ],
    [
      "negative percentage",
      {
        label: "Payout fee",
        percentageBps: -1,
        fixedAmount: "0.25",
        firstPayoutOfMonthFixedAmount: "0.00",
      },
    ],
    [
      "percentage above maximum",
      {
        label: "Payout fee",
        percentageBps: 1001,
        fixedAmount: "0.25",
        firstPayoutOfMonthFixedAmount: "0.00",
      },
    ],
    [
      "fixed amount above maximum",
      {
        label: "Payout fee",
        percentageBps: 25,
        fixedAmount: "5.01",
        firstPayoutOfMonthFixedAmount: "0.00",
      },
    ],
    [
      "malformed fixed amount",
      {
        label: "Payout fee",
        percentageBps: 25,
        fixedAmount: "NaN",
        firstPayoutOfMonthFixedAmount: "0.00",
      },
    ],
    [
      "monthly amount above maximum",
      {
        label: "Payout fee",
        percentageBps: 25,
        fixedAmount: "0.25",
        firstPayoutOfMonthFixedAmount: "5.01",
      },
    ],
    [
      "negative monthly amount",
      {
        label: "Payout fee",
        percentageBps: 25,
        fixedAmount: "0.25",
        firstPayoutOfMonthFixedAmount: "-0.01",
      },
    ],
  ])("rejects a malformed %s value", (_case, raw) => {
    expect(() => decodeSettlementPayoutFeePolicyValue(raw as never)).toThrow(SettlementDomainError);
  });
});
