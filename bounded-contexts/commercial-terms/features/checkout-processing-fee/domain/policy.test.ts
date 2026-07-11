import { describe, expect, it } from "vitest";
import {
  CHECKOUT_PROCESSING_FEE_LAUNCH_POLICY_VALUE,
  checkoutProcessingFeePolicy,
  decodeCheckoutProcessingFeePolicyValue,
} from "./policy";

describe("checkout processing-fee policy definition", () => {
  it("declares a policy key scoped to commercial-terms", () => {
    expect(checkoutProcessingFeePolicy.policyKey).toBe("commercial-terms.checkout-processing-fee");
    expect(checkoutProcessingFeePolicy.contextName).toBe("commercial-terms");
  });

  it("decodes its own launch default (definePolicy fails fast if this doesn't round-trip)", () => {
    expect(checkoutProcessingFeePolicy.defaultValue).toEqual(CHECKOUT_PROCESSING_FEE_LAUNCH_POLICY_VALUE);
  });

  it("round-trips a valid policy value through JSON", () => {
    const encoded = JSON.parse(JSON.stringify(CHECKOUT_PROCESSING_FEE_LAUNCH_POLICY_VALUE));
    expect(decodeCheckoutProcessingFeePolicyValue(encoded)).toEqual(CHECKOUT_PROCESSING_FEE_LAUNCH_POLICY_VALUE);
  });

  it("rejects a policy with no enabled jurisdictions", () => {
    expect(() =>
      decodeCheckoutProcessingFeePolicyValue({
        enabledJurisdictions: [],
        base: { percentageBps: 290, fixedAmount: "0.30" },
        methodAdjustments: [],
      }),
    ).toThrow("at least one jurisdiction");
  });

  it("rejects a base percentage outside 0-10000 bps", () => {
    expect(() =>
      decodeCheckoutProcessingFeePolicyValue({
        enabledJurisdictions: ["US"],
        base: { percentageBps: 10_001, fixedAmount: "0.30" },
        methodAdjustments: [],
      }),
    ).toThrow("cannot exceed 10000 basis points");
  });

  it("rejects a negative base fixed amount", () => {
    expect(() =>
      decodeCheckoutProcessingFeePolicyValue({
        enabledJurisdictions: ["US"],
        base: { percentageBps: 290, fixedAmount: "-0.30" },
        methodAdjustments: [],
      }),
    ).toThrow("base fixed amount must be a valid decimal");
  });

  it("accepts a negative method adjustment delta (deltas may reduce the base terms)", () => {
    const decoded = decodeCheckoutProcessingFeePolicyValue({
      enabledJurisdictions: ["US"],
      base: { percentageBps: 290, fixedAmount: "0.30" },
      methodAdjustments: [
        { paymentMethodCategory: "bank-account", percentageBpsDelta: -240, fixedAmountDelta: "-0.30" },
      ],
    });
    expect(decoded.methodAdjustments).toEqual([
      { paymentMethodCategory: "bank-account", percentageBpsDelta: -240, fixedAmountDelta: "-0.30" },
    ]);
  });

  it("rejects an unknown payment method category", () => {
    expect(() =>
      decodeCheckoutProcessingFeePolicyValue({
        enabledJurisdictions: ["US"],
        base: { percentageBps: 290, fixedAmount: "0.30" },
        methodAdjustments: [{ paymentMethodCategory: "crypto", percentageBpsDelta: 0, fixedAmountDelta: "0.00" }],
      }),
    ).toThrow("must be one of");
  });

  it("rejects a repeated payment method category", () => {
    expect(() =>
      decodeCheckoutProcessingFeePolicyValue({
        enabledJurisdictions: ["US"],
        base: { percentageBps: 290, fixedAmount: "0.30" },
        methodAdjustments: [
          { paymentMethodCategory: "card", percentageBpsDelta: 0, fixedAmountDelta: "0.00" },
          { paymentMethodCategory: "card", percentageBpsDelta: 10, fixedAmountDelta: "0.00" },
        ],
      }),
    ).toThrow("must not repeat a category");
  });
});
