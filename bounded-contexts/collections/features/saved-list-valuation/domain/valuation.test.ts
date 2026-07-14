import { describe, expect, it } from "vitest";
import type { SavedListLineId } from "../../saved-lists/domain";
import type { SavedListMarketEstimate, SavedListValuationInputLine } from "./contracts";
import { calculateSavedListValuation } from "./valuation";

const valuedAt = "2026-07-13T12:00:00.000Z";

function line(id: string, productId: string, trackedQuantity: number): SavedListValuationInputLine {
  return {
    lineId: id as SavedListLineId,
    catalogItemId: `cat_${productId}`,
    productId,
    trackedQuantity,
  };
}

function estimate(productId: string, overrides: Partial<SavedListMarketEstimate> = {}): SavedListMarketEstimate {
  return {
    catalogItemId: `cat_${productId}`,
    productId,
    estimateVersion: "estimate-1",
    windowStartedAt: "2026-07-01T00:00:00.000Z",
    windowEndedAt: "2026-07-13T10:00:00.000Z",
    amount: "10.00",
    currencyCode: "usd",
    band: { lowAmount: "8.00", highAmount: "12.00" },
    confidence: "high",
    estimatedAt: "2026-07-13T10:00:00.000Z",
    freshUntil: "2026-07-14T10:00:00.000Z",
    disclosure: "account",
    ...overrides,
  };
}

describe("Saved List valuation", () => {
  it("multiplies tracked quantities and reports honest line and unit coverage", () => {
    const result = calculateSavedListValuation({
      lines: [
        line("sll_priced", "prd_priced", 3),
        line("sll_missing", "prd_missing", 2),
        line("sll_stale", "prd_stale", 4),
      ],
      estimates: [
        estimate("prd_priced", { amount: "2.50", band: { lowAmount: "2.00", highAmount: "3.00" }, confidence: "low" }),
        estimate("prd_stale", { freshUntil: "2026-07-13T11:59:59.999Z" }),
      ],
      audience: "account",
      currencyCode: "usd",
      valuedAt,
    });

    expect(result.summary).toMatchObject({
      estimatedTotalAmount: "7.50",
      estimatedTotalBand: { lowAmount: "6.00", highAmount: "9.00" },
      coverage: {
        priced: { lines: 1, units: 3 },
        total: { lines: 3, units: 9 },
        missing: { lines: 1, units: 2 },
        stale: { lines: 1, units: 4 },
        lowConfidence: { lines: 1, units: 3 },
      },
      estimateAsOf: "2026-07-13T10:00:00.000Z",
    });
    expect(result.lines.map((entry) => [entry.lineId, entry.status, entry.estimatedValueAmount])).toEqual([
      ["sll_priced", "priced", "7.50"],
      ["sll_missing", "missing", null],
      ["sll_stale", "stale", null],
    ]);
  });

  it("never turns missing estimates into zero and omits a partial confidence band", () => {
    const result = calculateSavedListValuation({
      lines: [line("sll_missing", "prd_missing", 5)],
      estimates: [],
      audience: "account",
      currencyCode: "usd",
      valuedAt,
    });
    expect(result.summary.estimatedTotalAmount).toBeNull();
    expect(result.summary.estimatedTotalBand).toBeNull();
    expect(result.lines[0]?.unitEstimateAmount).toBeNull();
  });

  it("uses the newest estimate and converges regardless of Pricing/List replay order", () => {
    const lines = [line("sll_one", "prd_one", 2)];
    const estimates = [
      estimate("prd_one", { estimateVersion: "estimate-1", amount: "4.00", estimatedAt: "2026-07-13T09:00:00.000Z" }),
      estimate("prd_one", { estimateVersion: "estimate-2", amount: "5.00", estimatedAt: "2026-07-13T10:00:00.000Z" }),
    ];
    const input = { audience: "account" as const, currencyCode: "usd", valuedAt };

    expect(calculateSavedListValuation({ lines, estimates, ...input })).toEqual(
      calculateSavedListValuation({ lines: [...lines].reverse(), estimates: [...estimates].reverse(), ...input }),
    );
    expect(calculateSavedListValuation({ lines, estimates, ...input }).summary.estimatedTotalAmount).toBe("10.00");
  });

  it("applies the shared public disclosure semantics", () => {
    const hidden = calculateSavedListValuation({
      lines: [line("sll_one", "prd_one", 2)],
      estimates: [estimate("prd_one", { disclosure: "account" })],
      audience: "public",
      currencyCode: "usd",
      valuedAt,
    });
    const shown = calculateSavedListValuation({
      lines: [line("sll_one", "prd_one", 2)],
      estimates: [estimate("prd_one", { disclosure: "public" })],
      audience: "public",
      currencyCode: "usd",
      valuedAt,
    });

    expect(hidden.summary.estimatedTotalAmount).toBeNull();
    expect(hidden.summary.coverage.missing.lines).toBe(1);
    expect(shown.summary.estimatedTotalAmount).toBe("20.00");
  });
});
