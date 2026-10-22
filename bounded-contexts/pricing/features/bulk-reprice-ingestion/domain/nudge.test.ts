import { describe, expect, it } from "vitest";
import { deriveMigrationNudge } from "./nudge";

const row = (appliedPriceAmount: string, marketEstimateAmount: string, currencyCode = "USD") => ({
  appliedPriceAmount,
  marketEstimateAmount,
  currencyCode,
});

describe("migration nudge derivation", () => {
  it("uses the median of applied-to-estimate offsets and preserves an explicit zero", () => {
    expect(
      deriveMigrationNudge(
        [row("90.00", "100.00"), row("100.00", "100.00"), row("110.00", "100.00"), row("100.00", "100.00")],
        { minEstimateSamples: 4 },
      ),
    ).toEqual({ status: "available", offsetPercent: 0, currencyCode: "USD" });
  });

  it.each([
    [
      "mixed currency",
      [row("10.00", "10.00", "USD"), row("10.00", "10.00", "EUR")],
      { minEstimateSamples: 1 },
      "mixed-currency",
    ],
    ["too few estimates", [row("10.00", "10.00")], { minEstimateSamples: 2 }, "insufficient-estimates"],
    ["out of range", [row("200.00", "100.00")], { minEstimateSamples: 1, magnitudeCap: 50 }, "offset-out-of-range"],
    ["no samples", [], { minEstimateSamples: 1 }, "no-samples"],
    [
      "missing estimates",
      [{ ...row("10.00", "10.00"), marketEstimateAmount: null }],
      { minEstimateSamples: 1 },
      "insufficient-estimates",
    ],
    [
      "beyond cap before rounding",
      [row("150.004", "100")],
      { minEstimateSamples: 1, magnitudeCap: 50 },
      "offset-out-of-range",
    ],
  ] as const)("returns unavailable for %s", (_name, rows, params, reason) => {
    expect(deriveMigrationNudge(rows, params)).toMatchObject({
      status: "unavailable",
      reason,
      offsetPercent: null,
    });
  });
});
