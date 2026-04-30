import { describe, expect, it } from "vitest";
import { normalizeRequestedBalanceCreditAmount } from "./balance-credit-request";

describe("balance credit request normalization", () => {
  it("keeps explicit nullish and empty balance credit requests as null", () => {
    expect(normalizeRequestedBalanceCreditAmount(null)).toBeNull();
    expect(normalizeRequestedBalanceCreditAmount(undefined)).toBeNull();
    expect(normalizeRequestedBalanceCreditAmount("")).toBeNull();
  });

  it("normalizes form and JSON values to trimmed strings", () => {
    expect(normalizeRequestedBalanceCreditAmount(" 7.25 ")).toBe("7.25");
    expect(normalizeRequestedBalanceCreditAmount(7.25)).toBe("7.25");
  });
});
