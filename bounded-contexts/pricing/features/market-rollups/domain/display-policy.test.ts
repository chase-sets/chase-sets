import { describe, expect, it } from "vitest";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  decodeMarketAnalyticsDisplayPolicyValue,
  MARKET_ANALYTICS_DISPLAY_LAUNCH_POLICY_VALUE,
  marketAnalyticsDisplayPolicy,
} from "./display-policy";

function createEmptyPolicyDocumentDb(): PgQueryable {
  return {
    query: async () => ({ rows: [] }),
  } as unknown as PgQueryable;
}

describe("pricing market-analytics display policy (#4310)", () => {
  it("declares the policy with a compiled fallback matching this milestone's launch behavior", () => {
    expect(marketAnalyticsDisplayPolicy.policyKey).toBe("pricing.market-analytics-display");
    expect(marketAnalyticsDisplayPolicy.contextName).toBe("pricing");
    expect(marketAnalyticsDisplayPolicy.defaultValue).toEqual(MARKET_ANALYTICS_DISPLAY_LAUNCH_POLICY_VALUE);
    expect(marketAnalyticsDisplayPolicy.defaultValue.showVerifiedMarkers).toBe(true);
    expect(marketAnalyticsDisplayPolicy.defaultValue.publicPageHistoryWindowDays).toBe(180);
    expect(marketAnalyticsDisplayPolicy.defaultValue.publicPageCacheTtlSeconds).toBe(86400);
  });

  it("resolves via the m110 mechanism to the compiled fallback when no policy document is active", async () => {
    const resolver = createPolicyResolver({ db: createEmptyPolicyDocumentDb() });

    const resolved = await resolver.resolvePolicy(marketAnalyticsDisplayPolicy, { at: "2026-07-09T00:00:00.000Z" });

    expect(resolved.source).toBe("fallback");
    expect(resolved.value).toEqual(MARKET_ANALYTICS_DISPLAY_LAUNCH_POLICY_VALUE);
    expect(resolved.documentId).toBeNull();
  });

  it("round-trips a revised value through decodeValue", () => {
    const decoded = decodeMarketAnalyticsDisplayPolicyValue({
      showVerifiedMarkers: false,
      publicPageHistoryWindowDays: 90,
      publicPageCacheTtlSeconds: 3600,
    });

    expect(decoded).toEqual({
      showVerifiedMarkers: false,
      publicPageHistoryWindowDays: 90,
      publicPageCacheTtlSeconds: 3600,
    });
  });

  it("rejects a non-boolean showVerifiedMarkers", () => {
    expect(() =>
      decodeMarketAnalyticsDisplayPolicyValue({
        showVerifiedMarkers: "yes",
        publicPageHistoryWindowDays: 180,
        publicPageCacheTtlSeconds: 86400,
      }),
    ).toThrow(/showVerifiedMarkers/);
  });

  it("rejects an out-of-range public page history window", () => {
    expect(() =>
      decodeMarketAnalyticsDisplayPolicyValue({
        showVerifiedMarkers: true,
        publicPageHistoryWindowDays: 5,
        publicPageCacheTtlSeconds: 86400,
      }),
    ).toThrow(/Public page history window days/);
  });

  it("rejects an out-of-range public page cache TTL", () => {
    expect(() =>
      decodeMarketAnalyticsDisplayPolicyValue({
        showVerifiedMarkers: true,
        publicPageHistoryWindowDays: 180,
        publicPageCacheTtlSeconds: 10,
      }),
    ).toThrow(/Public page cache TTL seconds/);
  });
});
