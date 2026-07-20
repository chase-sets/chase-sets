import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { encodePolicyValue } from "@chase-sets/platform-policy/define-policy";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import {
  decodeMarketEstimatePolicyValue,
  MARKET_ESTIMATE_LAUNCH_POLICY_VALUE,
  marketEstimatePolicy,
} from "./estimate-policy";

function createEmptyPolicyDocumentDb(): PgQueryable {
  return { query: async () => ({ rows: [] }) } as unknown as PgQueryable;
}

describe("marketEstimatePolicy", () => {
  it("round-trips the compiled launch fallback through its own decoder", () => {
    expect(decodeMarketEstimatePolicyValue(encodePolicyValue(MARKET_ESTIMATE_LAUNCH_POLICY_VALUE))).toEqual(
      MARKET_ESTIMATE_LAUNCH_POLICY_VALUE,
    );
    expect(marketEstimatePolicy.policyKey).toBe("pricing.market-estimate");
    expect(marketEstimatePolicy.contextName).toBe("pricing");
  });

  it("resolves the compiled launch fallback when no valid policy document is active", async () => {
    const resolver = createPolicyResolver({ db: createEmptyPolicyDocumentDb() });

    const resolved = await resolver.resolvePolicy(marketEstimatePolicy, { at: "2026-07-20T00:00:00.000Z" });

    expect(resolved.source).toBe("fallback");
    expect(resolved.value).toEqual(MARKET_ESTIMATE_LAUNCH_POLICY_VALUE);
  });

  it("accepts a revision that changes algorithm parameters without a deploy", () => {
    const revised = decodeMarketEstimatePolicyValue(
      encodePolicyValue({
        ...MARKET_ESTIMATE_LAUNCH_POLICY_VALUE,
        decayHalfLifeDays: 14,
        minimumComparableSales: 5,
        maximumParticipantWeightShare: 0.25,
        sourceWeights: { platformVerifiedTrade: 1, platformTrade: 0.5, externalComp: 0.25 },
      }),
    );

    expect(revised.decayHalfLifeDays).toBe(14);
    expect(revised.minimumComparableSales).toBe(5);
    expect(revised.maximumParticipantWeightShare).toBe(0.25);
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

  it("decodes a pre-guard-dial policy value to the compiled fallbacks (additive m110 shape change)", () => {
    const { minimumEffectiveSampleSize, outlierPriceRatio, maximumParticipantWeightShare, ...preGuardShape } =
      MARKET_ESTIMATE_LAUNCH_POLICY_VALUE;

    const decoded = decodeMarketEstimatePolicyValue(encodePolicyValue(preGuardShape));

    expect(decoded.minimumEffectiveSampleSize).toBe(minimumEffectiveSampleSize);
    expect(decoded.outlierPriceRatio).toBe(outlierPriceRatio);
    expect(decoded.maximumParticipantWeightShare).toBe(maximumParticipantWeightShare);
  });

  it("accepts fractional effective-sample-size gates and rejects out-of-bounds guard dials", () => {
    const revised = decodeMarketEstimatePolicyValue(
      encodePolicyValue({
        ...MARKET_ESTIMATE_LAUNCH_POLICY_VALUE,
        minimumEffectiveSampleSize: 2.5,
        outlierPriceRatio: 4,
      }),
    );
    expect(revised.minimumEffectiveSampleSize).toBe(2.5);
    expect(revised.outlierPriceRatio).toBe(4);

    expect(() =>
      decodeMarketEstimatePolicyValue(
        encodePolicyValue({ ...MARKET_ESTIMATE_LAUNCH_POLICY_VALUE, minimumEffectiveSampleSize: 0.5 }),
      ),
    ).toThrow(/Minimum effective sample size/);
    expect(() =>
      decodeMarketEstimatePolicyValue(
        encodePolicyValue({ ...MARKET_ESTIMATE_LAUNCH_POLICY_VALUE, outlierPriceRatio: 1 }),
      ),
    ).toThrow(/Outlier price ratio/);
  });

  it("rejects an out-of-bounds minimum-input gate", () => {
    expect(() =>
      decodeMarketEstimatePolicyValue(
        encodePolicyValue({ ...MARKET_ESTIMATE_LAUNCH_POLICY_VALUE, minimumComparableSales: 0 }),
      ),
    ).toThrow(/Minimum comparable sales/);
  });

  it("enforces participant-weight-cap bounds", () => {
    expect(() =>
      decodeMarketEstimatePolicyValue(
        encodePolicyValue({ ...MARKET_ESTIMATE_LAUNCH_POLICY_VALUE, maximumParticipantWeightShare: 0 }),
      ),
    ).toThrow(/Maximum participant weight share/);
    expect(() =>
      decodeMarketEstimatePolicyValue(
        encodePolicyValue({ ...MARKET_ESTIMATE_LAUNCH_POLICY_VALUE, maximumParticipantWeightShare: 1.01 }),
      ),
    ).toThrow(/Maximum participant weight share/);
  });
});
