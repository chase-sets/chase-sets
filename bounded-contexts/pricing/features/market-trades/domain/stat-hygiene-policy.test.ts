import { describe, expect, it } from "vitest";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  decodeMarketStatHygienePolicyValue,
  MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE,
  marketStatHygienePolicy,
} from "./stat-hygiene-policy";

function createEmptyPolicyDocumentDb(): PgQueryable {
  return {
    query: async () => ({ rows: [] }),
  } as unknown as PgQueryable;
}

describe("pricing market stat-hygiene policy (#4304)", () => {
  it("declares the policy with a compiled fallback matching the #4305 rollup slice's carried-forward defaults", () => {
    expect(marketStatHygienePolicy.policyKey).toBe("pricing.market-stat-hygiene");
    expect(marketStatHygienePolicy.contextName).toBe("pricing");
    expect(marketStatHygienePolicy.defaultValue).toEqual(MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE);
    expect(marketStatHygienePolicy.defaultValue.minimumTradeSample).toBe(3);
    expect(marketStatHygienePolicy.defaultValue.lookbackDays).toEqual({ short: 30, long: 90 });
  });

  it("resolves via the m110 mechanism to the compiled fallback when no policy document is active", async () => {
    const resolver = createPolicyResolver({ db: createEmptyPolicyDocumentDb() });

    const resolved = await resolver.resolvePolicy(marketStatHygienePolicy, { at: "2026-07-09T00:00:00.000Z" });

    expect(resolved.source).toBe("fallback");
    expect(resolved.value).toEqual(MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE);
    expect(resolved.documentId).toBeNull();
  });

  it("round-trips a revised value through decodeValue", () => {
    const decoded = decodeMarketStatHygienePolicyValue({
      minimumTradeSample: 5,
      lookbackDays: { short: 14, long: 60 },
      outlierTrimPercentile: 10,
    });

    expect(decoded).toEqual({
      minimumTradeSample: 5,
      lookbackDays: { short: 14, long: 60 },
      outlierTrimPercentile: 10,
    });
  });

  it("rejects a long lookback window shorter than the short window", () => {
    expect(() =>
      decodeMarketStatHygienePolicyValue({
        minimumTradeSample: 3,
        lookbackDays: { short: 90, long: 30 },
        outlierTrimPercentile: 5,
      }),
    ).toThrow(/at least the short lookback days/);
  });

  it("rejects an out-of-range outlier trim percentile", () => {
    expect(() =>
      decodeMarketStatHygienePolicyValue({
        minimumTradeSample: 3,
        lookbackDays: { short: 30, long: 90 },
        outlierTrimPercentile: 40,
      }),
    ).toThrow(/Outlier trim percentile/);
  });
});
