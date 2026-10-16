import { describe, expect, it } from "vitest";
import { capitalCycle } from "../domain/portfolio/capital-cycle";

describe("capital cycle", () => {
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
