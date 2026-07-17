import { describe, expect, it } from "vitest";
import { encodePolicyValue } from "@chase-sets/platform-policy/define-policy";
import {
  decodeMarketEstimatePolicyValue,
  MARKET_ESTIMATE_LAUNCH_POLICY_VALUE,
  marketEstimatePolicy,
} from "./estimate-policy";

describe("marketEstimatePolicy", () => {
  it("round-trips the compiled launch fallback through its own decoder", () => {
    expect(decodeMarketEstimatePolicyValue(encodePolicyValue(MARKET_ESTIMATE_LAUNCH_POLICY_VALUE))).toEqual(
      MARKET_ESTIMATE_LAUNCH_POLICY_VALUE,
    );
    expect(marketEstimatePolicy.policyKey).toBe("pricing.market-estimate");
    expect(marketEstimatePolicy.contextName).toBe("pricing");
  });

  it("accepts a revision that changes algorithm parameters without a deploy", () => {
    const revised = decodeMarketEstimatePolicyValue(
      encodePolicyValue({
        ...MARKET_ESTIMATE_LAUNCH_POLICY_VALUE,
        decayHalfLifeDays: 14,
        minimumComparableSales: 5,
        sourceWeights: { platformVerifiedTrade: 1, platformTrade: 0.5, externalComp: 0.25 },
      }),
    );

    expect(revised.decayHalfLifeDays).toBe(14);
    expect(revised.minimumComparableSales).toBe(5);
    expect(revised.sourceWeights.externalComp).toBe(0.25);
  });

  it("rejects source weights that invert the blending order", () => {
    expect(() =>
      decodeMarketEstimatePolicyValue(
        encodePolicyValue({
          ...MARKET_ESTIMATE_LAUNCH_POLICY_VALUE,
          sourceWeights: { platformVerifiedTrade: 0.4, platformTrade: 0.7, externalComp: 1 },
        }),
      ),
    ).toThrow(/blending order/);
  });

  it("rejects band percentiles that do not contain the estimate percentile", () => {
    expect(() =>
      decodeMarketEstimatePolicyValue(
        encodePolicyValue({ ...MARKET_ESTIMATE_LAUNCH_POLICY_VALUE, bandLowPercentile: 60 }),
      ),
    ).toThrow(/contain the estimate percentile/);
  });

  it("rejects an out-of-bounds minimum-input gate", () => {
    expect(() =>
      decodeMarketEstimatePolicyValue(
        encodePolicyValue({ ...MARKET_ESTIMATE_LAUNCH_POLICY_VALUE, minimumComparableSales: 0 }),
      ),
    ).toThrow(/Minimum comparable sales/);
  });
});
