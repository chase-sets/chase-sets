import { describe, expect, it } from "vitest";
import {
  AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE,
  authenticityFeePolicy,
  decodeAuthenticityFeePolicyValue,
} from "./policy";

describe("authenticity fee policy definition", () => {
  it("declares a policy key scoped to commercial-terms", () => {
    expect(authenticityFeePolicy.policyKey).toBe("commercial-terms.authenticity-fee");
    expect(authenticityFeePolicy.contextName).toBe("commercial-terms");
  });

  it("decodes its own launch default (definePolicy fails fast if this doesn't round-trip)", () => {
    expect(authenticityFeePolicy.defaultValue).toEqual(AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE);
  });

  it("round-trips a valid policy value through JSON", () => {
    const encoded = JSON.parse(JSON.stringify(AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE));
    expect(decodeAuthenticityFeePolicyValue(encoded)).toEqual(AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE);
  });

  it("rejects a policy with no bands", () => {
    expect(() => decodeAuthenticityFeePolicyValue({ optInThresholdAmount: "100.00", bands: [] })).toThrow(
      "at least one band",
    );
  });

  it("rejects a negative opt-in threshold", () => {
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "-1.00",
        bands: AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE.bands,
      }),
    ).toThrow("must be a valid decimal");
  });

  it("rejects a band percentage outside 0-10000 bps", () => {
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "100.00",
        bands: [
          {
            minOrderValueAmount: "0.00",
            category: "any",
            flatAmount: "8.00",
            percentageBps: 10_001,
            capAmount: "50.00",
          },
        ],
      }),
    ).toThrow("cannot exceed 10000 basis points");
  });

  it("rejects an unknown band category", () => {
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "100.00",
        bands: [
          {
            minOrderValueAmount: "0.00",
            category: "slabbed",
            flatAmount: "8.00",
            percentageBps: 200,
            capAmount: "50.00",
          },
        ],
      }),
    ).toThrow("must be one of");
  });

  it("rejects a zero cap amount", () => {
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "100.00",
        bands: [
          { minOrderValueAmount: "0.00", category: "any", flatAmount: "8.00", percentageBps: 200, capAmount: "0.00" },
        ],
      }),
    ).toThrow("greater than zero");
  });

  it("rejects a repeated category and minimum order value pair", () => {
    expect(() =>
      decodeAuthenticityFeePolicyValue({
        optInThresholdAmount: "100.00",
        bands: [
          { minOrderValueAmount: "0.00", category: "any", flatAmount: "8.00", percentageBps: 200, capAmount: "50.00" },
          { minOrderValueAmount: "0.00", category: "any", flatAmount: "10.00", percentageBps: 150, capAmount: "40.00" },
        ],
      }),
    ).toThrow("must not repeat");
  });

  it("accepts category-specific bands layered above an any-category floor", () => {
    const decoded = decodeAuthenticityFeePolicyValue({
      optInThresholdAmount: "100.00",
      bands: [
        { minOrderValueAmount: "0.00", category: "any", flatAmount: "8.00", percentageBps: 200, capAmount: "50.00" },
        {
          minOrderValueAmount: "1000.00",
          category: "graded",
          flatAmount: "15.00",
          percentageBps: 150,
          capAmount: "75.00",
        },
      ],
    });
    expect(decoded.bands).toHaveLength(2);
  });
});
