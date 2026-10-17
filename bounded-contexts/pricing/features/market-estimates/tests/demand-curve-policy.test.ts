import { describe, expect, it } from "vitest";
import { decodeDemandCurvePolicyValue, DEMAND_CURVE_LAUNCH_POLICY_VALUE } from "../domain/demand-curve-policy";

describe("Demand Curve m110 policy value", () => {
  it("decodes recorded revisions without freshForHours to 48 and still requires original fields", () => {
    const { freshForHours: _freshness, ...legacy } = DEMAND_CURVE_LAUNCH_POLICY_VALUE;
    expect(decodeDemandCurvePolicyValue(legacy).freshForHours).toBe(48);
    const { historyDays: _history, ...missingRequired } = legacy;
    expect(() => decodeDemandCurvePolicyValue(missingRequired)).toThrow(/missing/);
  });

  it.each([1, 48, 336])("accepts freshForHours %i within the inclusive bounds", (freshForHours) => {
    expect(decodeDemandCurvePolicyValue({ ...DEMAND_CURVE_LAUNCH_POLICY_VALUE, freshForHours }).freshForHours).toBe(
      freshForHours,
    );
  });

  it.each([0, 337, 1.5, null, "48"])("rejects malformed freshForHours %s without defaulting", (freshForHours) => {
    expect(() => decodeDemandCurvePolicyValue({ ...DEMAND_CURVE_LAUNCH_POLICY_VALUE, freshForHours })).toThrow(
      /Freshness hours/,
    );
  });

  it("accepts its complete launch shape and rejects missing, unknown and malformed nested fields", () => {
    const value = structuredClone(DEMAND_CURVE_LAUNCH_POLICY_VALUE);
    expect(decodeDemandCurvePolicyValue(value)).toEqual(value);
    expect(() => decodeDemandCurvePolicyValue({ ...value, unknown: 1 })).toThrow(/unknown fields/);
    expect(() => decodeDemandCurvePolicyValue({ ...value, percentiles: [5, 5] })).toThrow(/strictly ascending/);
    expect(() => decodeDemandCurvePolicyValue({ ...value, conditionOrder: ["Near Mint", "Near Mint"] })).toThrow(
      /distinct/,
    );
    expect(() =>
      decodeDemandCurvePolicyValue({ ...value, zipfExponentBounds: { minimum: 0, maximum: 2, unknown: 3 } }),
    ).toThrow(/unknown fields/);
    expect(() => decodeDemandCurvePolicyValue({ ...value, zipfExponentBounds: { minimum: 3, maximum: 2 } })).toThrow(
      /Zipf maximum/,
    );
  });
});
