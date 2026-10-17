import { describe, expect, it } from "vitest";
import { buildConditionLadder } from "../domain/condition-ladder/condition-ladder";
import { DEMAND_CURVE_LAUNCH_POLICY_VALUE as policy } from "../domain/demand-curve-policy";

const asOf = "2026-09-01T15:00:00.000Z";
const sales = Array.from({ length: 30 }, (_, index) => ({
  condition: index % 2 ? "Lightly Played" : "Near Mint",
  price: index % 2 ? 6 : 10,
  soldAt: new Date(Date.parse(asOf) - index * 86_400_000).toISOString(),
}));

describe("Condition Ladder method and anchor", () => {
  it("fits time-controlled Zipf when condition timelines overlap", () => {
    const ladder = buildConditionLadder({
      sales,
      siblingMarketPrices: new Map(),
      targetCondition: "Near Mint",
      asOf,
      policy,
    });
    expect(ladder.method).toBe("time-controlled-zipf");
    expect(ladder.conditionValues.get("Near Mint")!).toBeGreaterThanOrEqual(ladder.conditionValues.get("Damaged")!);
  });

  it("uses a clamped sibling ratio, with the nearest better condition as anchor", () => {
    const ladder = buildConditionLadder({
      sales: [],
      siblingMarketPrices: new Map([
        ["Near Mint", 10],
        ["Moderately Played", 12],
        ["Damaged", 1],
      ]),
      targetCondition: "Lightly Played",
      asOf,
      policy,
    });
    expect(ladder.method).toBe("sibling-market-ratio");
    expect(ladder.anchorCondition).toBe("Near Mint");
    expect([...ladder.conditionValues.values()]).toEqual([10, 10, 10, 10, 1]);
  });

  it("uses neutral only when neither fit nor sibling evidence exists, and rejects unknown conditions", () => {
    const input = {
      sales: [],
      siblingMarketPrices: new Map<string, number>(),
      targetCondition: "Damaged",
      asOf,
      policy,
    };
    expect(buildConditionLadder(input)).toMatchObject({ method: "neutral-condition-fallback", anchorCondition: null });
    expect(() => buildConditionLadder({ ...input, targetCondition: "Unopened" })).toThrow(/Unknown target/);
  });
});
