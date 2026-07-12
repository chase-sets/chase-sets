import { describe, expect, it } from "vitest";
import { resolveRepricingFloorAmount, worstCaseRepricingFloorAmount } from "./floor-resolution";
import type { RepricingFloor } from "./domain";

describe("resolveRepricingFloorAmount", () => {
  it("returns the absolute floor amount unchanged", () => {
    const floor: RepricingFloor = { mode: "absolute", amount: "12.50" };
    expect(resolveRepricingFloorAmount(floor, "9.00")).toBe("12.50");
    expect(resolveRepricingFloorAmount(floor, null)).toBe("12.50");
  });

  it("resolves a cost-basis-plus-margin floor from Inventory's acquisition_cost_amount fact", () => {
    const floor: RepricingFloor = { mode: "cost-basis-plus-margin", marginPercent: 20, absoluteFallbackAmount: "5.00" };
    // cost basis 10.00 + 20% margin = 12.00
    expect(resolveRepricingFloorAmount(floor, "10.00")).toBe("12.00");
  });

  it("falls back to the seller-authored absolute floor when the cost-basis fact is missing", () => {
    const floor: RepricingFloor = { mode: "cost-basis-plus-margin", marginPercent: 20, absoluteFallbackAmount: "5.00" };
    expect(resolveRepricingFloorAmount(floor, null)).toBe("5.00");
  });

  it("rounds the margin amount to the nearest cent", () => {
    const floor: RepricingFloor = {
      mode: "cost-basis-plus-margin",
      marginPercent: 33.33,
      absoluteFallbackAmount: "1.00",
    };
    // 10.00 * 33.33% = 3.333 -> nearest cent 3.33; floor = 13.33
    expect(resolveRepricingFloorAmount(floor, "10.00")).toBe("13.33");
  });
});

describe("worstCaseRepricingFloorAmount", () => {
  it("is the amount itself for an absolute floor", () => {
    expect(worstCaseRepricingFloorAmount({ mode: "absolute", amount: "8.00" })).toBe("8.00");
  });

  it("is the absolute fallback for a cost-basis-plus-margin floor", () => {
    expect(
      worstCaseRepricingFloorAmount({
        mode: "cost-basis-plus-margin",
        marginPercent: 50,
        absoluteFallbackAmount: "6.00",
      }),
    ).toBe("6.00");
  });
});
