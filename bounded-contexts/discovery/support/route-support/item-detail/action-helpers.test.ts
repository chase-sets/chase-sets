import { describe, expect, it } from "vitest";
import { normalizeMoneyAmount } from "./action-helpers";

describe("normalizeMoneyAmount", () => {
  it("normalizer output preservation", () => {
    const required: string = normalizeMoneyAmount("  1.5  ", { invalidMessage: "invalid" });
    const leadingZeros: string = normalizeMoneyAmount("0001.5", { invalidMessage: "invalid" });
    const optional: string | null = normalizeMoneyAmount(null, { optional: true, invalidMessage: "invalid" });

    expect(required).toBe("1.50");
    expect(leadingZeros).toBe("1.50");
    expect(optional).toBeNull();
    expect(normalizeMoneyAmount("9999999999.99", { invalidMessage: "invalid" })).toBe("9999999999.99");
    expect(normalizeMoneyAmount("0.00", { allowZero: true, invalidMessage: "invalid" })).toBe("0.00");
  });

  it("normalizer range rejection", () => {
    for (const value of ["10000000000.00", "-1.00", "1e2", "1.005"]) {
      expect(() => normalizeMoneyAmount(value, { invalidMessage: "invalid" })).toThrow("invalid");
    }
  });

  it("normalizer zero matrix", () => {
    expect(() => normalizeMoneyAmount("0.00", { invalidMessage: "invalid" })).toThrow("invalid");
    expect(normalizeMoneyAmount("0.00", { allowZero: true, invalidMessage: "invalid" })).toBe("0.00");
    expect(() => normalizeMoneyAmount(null, { invalidMessage: "required" })).toThrow("required");
    expect(normalizeMoneyAmount(null, { optional: true, invalidMessage: "optional" })).toBeNull();
  });
});
