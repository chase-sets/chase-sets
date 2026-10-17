import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capitalCycle } from "../domain/portfolio/capital-cycle";

describe("capital cycle", () => {
  it("keeps the health consumer on the one portfolio kernel", () => {
    const health = readFileSync(new URL("../../repricing-engine/api/health-summary.ts", import.meta.url), "utf8");
    expect(health).toContain('import { capitalCycle } from "../../repricing-policies/domain/portfolio/capital-cycle"');
    expect(health).toContain("capitalCycle(net, cost, wait, turnaround)");
    expect(health).not.toContain("Math.log(");
  });
  it("adapts a synthetic portfolio through the pinned app capitalCycle formulas", () => {
    // tcgplayer-automation-app@bdeffa019 app/features/pricing/domain/capitalCycle.ts:66-92.
    const saleValue = 120;
    const portfolio = { unitCount: 3, marketValue: 100 };
    const economics = {
      relativeOverhead: 0.1,
      staticOverheadPerUnit: 1,
      costBasisShareOfMarket: 0.7,
      costBasisDiscountPerUnit: 2,
      turnaroundDays: 10,
    };
    const result = capitalCycle(
      saleValue * (1 - economics.relativeOverhead) - economics.staticOverheadPerUnit * portfolio.unitCount,
      economics.costBasisShareOfMarket * portfolio.marketValue -
        economics.costBasisDiscountPerUnit * portfolio.unitCount,
      20,
      economics.turnaroundDays,
    );
    expect(result).toEqual({ profit: 41, cycleDays: 30, profitPerDay: 41 / 30, dailyReturn: Math.log(105 / 64) / 30 });
  });
  it("matches the parity profit/day and capital-turn formulas", () => {
    const result = capitalCycle(90, 60, 20, 10);
    expect(result.profit).toBe(30);
    expect(result.cycleDays).toBe(30);
    expect(result.profitPerDay).toBe(1);
    expect(result.dailyReturn).toBeCloseTo(Math.log(1.5) / 30, 12);
  });

  it("keeps signed losses visible and marks invalid returns unavailable", () => {
    const result = capitalCycle(4, 10, 0, 0);
    expect(result.profit).toBe(-6);
    expect(result.cycleDays).toBe(0);
    expect(result.profitPerDay).toBeNaN();
    expect(result.dailyReturn).toBeNaN();
  });
});
