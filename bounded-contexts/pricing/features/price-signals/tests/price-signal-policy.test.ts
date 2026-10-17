import { describe, expect, it } from "vitest";
import { decodePriceSignalPolicyValue, priceSignalPolicy } from "../domain/price-signal-policy";

describe("pricing.price-signal policy", () => {
  it("owns only the signal work bound", () => {
    expect(priceSignalPolicy.policyKey).toBe("pricing.price-signal");
    expect(decodePriceSignalPolicyValue({ productsPerPass: 5 })).toEqual({ productsPerPass: 5 });
  });

  it.each([undefined, null, 0, -1, 1.5, 6, "1"])("rejects invalid productsPerPass %j", (value) => {
    expect(() => decodePriceSignalPolicyValue({ productsPerPass: value } as never)).toThrow();
  });

  it("closes the owned policy object", () => {
    expect(() => decodePriceSignalPolicyValue({ productsPerPass: 1, capturesPerPass: 1 } as never)).toThrow();
  });
});
