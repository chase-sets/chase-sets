import { describe, expect, it } from "vitest";
import {
  MONEY_AMOUNT_MAX,
  addMoneyAmounts,
  allocateMoneyByLargestRemainder,
  applyBasisPointsToMoneyAmount,
  centsToMoneyAmount,
  compareMoneyAmounts,
  grossUpMoneyAmountByBasisPoints,
  moneyToCents,
  normalizeMoneyAmount,
  normalizeSignedMoneyAmount,
  roundRational,
  subtractMoneyAmounts,
  sumMoneyAmounts,
} from "./money";

function exactBps(cents: number, bps: number, roundingMode: "ceil" | "floor" | "nearest") {
  return centsToMoneyAmount(roundRational(BigInt(cents) * BigInt(bps), 10_000n, roundingMode));
}

describe("money primitive", () => {
  it("canonicalizes valid decimal strings to two decimal places", () => {
    expect(normalizeMoneyAmount("5")).toBe("5.00");
    expect(normalizeMoneyAmount("5.5")).toBe("5.50");
    expect(normalizeMoneyAmount("0005.05")).toBe("5.05");
    expect(normalizeSignedMoneyAmount("-0.10")).toBe("-0.10");
    expect(normalizeSignedMoneyAmount("-0.00")).toBe("0.00");
  });

  it("rejects malformed and out-of-range money strings", () => {
    for (const value of ["", "1e2", "12.999", "12.34abc", "-0.01"]) {
      expect(() => normalizeMoneyAmount(value)).toThrow();
    }
    expect(() => normalizeMoneyAmount("10000000000.00")).toThrow(MONEY_AMOUNT_MAX);
  });

  it("converts between canonical money strings and integer cents", () => {
    expect(moneyToCents("12.34")).toBe(1234n);
    expect(centsToMoneyAmount(1234n)).toBe("12.34");
  });

  it("adds, subtracts, compares, and sums without floating point arithmetic", () => {
    expect(addMoneyAmounts("0.10", "0.20")).toBe("0.30");
    expect(subtractMoneyAmounts("0.10", "0.20")).toBe("-0.10");
    expect(compareMoneyAmounts("10.00", "9.99")).toBe(1);
    expect(sumMoneyAmounts(["0.10", "0.20", "0.30"])).toBe("0.60");
  });

  it("pins verified basis-point regressions", () => {
    expect(applyBasisPointsToMoneyAmount("0.10", 1000, "ceil")).toBe("0.01");
    expect(applyBasisPointsToMoneyAmount("1.40", 500, "floor")).toBe("0.07");
  });

  it.each(["0.20", "0.40", "0.80", "0.90", "1.10", "1.50"])(
    "does not over-ceil exact-cent sales fees for %s at 1000 bps",
    (amount) => {
      expect(applyBasisPointsToMoneyAmount(amount, 1000, "ceil")).toBe(
        exactBps(Number(moneyToCents(amount)), 1000, "ceil"),
      );
    },
  );

  it("matches exact rational rounding across realistic cents and bps ranges", () => {
    const centsCases = [
      0, 1, 2, 3, 4, 5, 9, 10, 11, 19, 20, 33, 40, 80, 90, 99, 100, 101, 140, 199, 999, 10_001, 100_000, 200_000,
    ];
    const bpsCases = [0, 1, 2, 3, 5, 10, 50, 125, 290, 500, 850, 1000, 2500, 5000, 9999, 10_000];
    for (let seed = 1; seed <= 100; seed += 1) {
      centsCases.push((seed * 48271) % 200_001);
      bpsCases.push((seed * 6961) % 10_001);
    }

    for (const cents of centsCases) {
      const amount = centsToMoneyAmount(cents);
      for (const bps of bpsCases) {
        expect(applyBasisPointsToMoneyAmount(amount, bps, "floor")).toBe(exactBps(cents, bps, "floor"));
        expect(applyBasisPointsToMoneyAmount(amount, bps, "ceil")).toBe(exactBps(cents, bps, "ceil"));
        expect(applyBasisPointsToMoneyAmount(amount, bps, "nearest")).toBe(exactBps(cents, bps, "nearest"));
      }
    }
  });

  it("grosses up percentage-plus-fixed fees with integer cents", () => {
    expect(
      grossUpMoneyAmountByBasisPoints({
        basisAmount: "26.00",
        percentageBps: 290,
        fixedAmount: "0.30",
        roundingMode: "ceil",
      }),
    ).toBe("1.09");
  });

  it("allocates pennies by largest remainder while preserving the exact total", () => {
    expect(allocateMoneyByLargestRemainder("0.05", ["1.00", "1.00", "1.00"])).toEqual(["0.02", "0.02", "0.01"]);
    expect(allocateMoneyByLargestRemainder("10.00", ["16.00", "4.00"])).toEqual(["8.00", "2.00"]);
  });
});
