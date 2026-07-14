import { describe, expect, it } from "vitest";
import {
  classifyMarketEstimateForDisplay,
  multiplyMarketValueAmount,
  sumMarketValueAmounts,
  type MarketEstimateForDisplay,
} from "./index";

const estimate: MarketEstimateForDisplay = {
  amount: "12.34",
  currencyCode: "usd",
  band: { lowAmount: "10.00", highAmount: "14.00" },
  confidence: "medium",
  estimatedAt: "2026-07-13T10:00:00.000Z",
  freshUntil: "2026-07-14T10:00:00.000Z",
  disclosure: "account",
};

describe("market estimate display semantics", () => {
  it("shares disclosure, currency, and staleness eligibility across consumers", () => {
    expect(
      classifyMarketEstimateForDisplay(estimate, {
        audience: "account",
        currencyCode: "USD",
        asOf: "2026-07-13T12:00:00.000Z",
      }),
    ).toMatchObject({ status: "current", reason: null });

    expect(
      classifyMarketEstimateForDisplay(estimate, {
        audience: "public",
        currencyCode: "usd",
        asOf: "2026-07-13T12:00:00.000Z",
      }),
    ).toEqual({ status: "missing", reason: "not-disclosed", estimate: null });

    expect(
      classifyMarketEstimateForDisplay(estimate, {
        audience: "account",
        currencyCode: "usd",
        asOf: "2026-07-14T10:00:00.001Z",
      }),
    ).toMatchObject({ status: "stale", reason: "stale" });
  });

  it("uses exact decimal arithmetic for quantities and totals", () => {
    expect(multiplyMarketValueAmount("0.10", 3)).toBe("0.30");
    expect(sumMarketValueAmounts(["0.10", "0.20", "12.34"])).toBe("12.64");
    expect(multiplyMarketValueAmount("9999999999.99", 1_000_000)).toBe("9999999999990000.00");
    expect(sumMarketValueAmounts(["9999999999990000.00", "1.00"])).toBe("9999999999990001.00");
  });
});
