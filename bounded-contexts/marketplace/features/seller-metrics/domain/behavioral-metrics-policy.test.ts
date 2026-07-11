import { describe, expect, it } from "vitest";
import {
  decodeMarketplaceSellerBehavioralMetricsPolicyValue,
  MARKETPLACE_SELLER_BEHAVIORAL_METRICS_LAUNCH_POLICY_VALUE,
  marketplaceSellerBehavioralMetricsPolicy,
} from "./behavioral-metrics-policy";

describe("marketplace seller-behavioral-metrics policy", () => {
  it("decodes a valid revised value", () => {
    expect(
      decodeMarketplaceSellerBehavioralMetricsPolicyValue({
        windowDays: 60,
        minDisplayOrderCount: 20,
        dispatchWindowHours: 24,
        buyerFacingChipsEnabled: true,
      }),
    ).toEqual({
      windowDays: 60,
      minDisplayOrderCount: 20,
      dispatchWindowHours: 24,
      buyerFacingChipsEnabled: true,
    });
  });

  it("declares the launch value as the compiled default fallback", () => {
    expect(marketplaceSellerBehavioralMetricsPolicy.defaultValue).toEqual(
      MARKETPLACE_SELLER_BEHAVIORAL_METRICS_LAUNCH_POLICY_VALUE,
    );
    expect(MARKETPLACE_SELLER_BEHAVIORAL_METRICS_LAUNCH_POLICY_VALUE).toEqual({
      windowDays: 90,
      minDisplayOrderCount: 10,
      dispatchWindowHours: 48,
      buyerFacingChipsEnabled: false,
    });
  });

  it("rejects a non-integer or out-of-range window", () => {
    expect(() =>
      decodeMarketplaceSellerBehavioralMetricsPolicyValue({
        ...MARKETPLACE_SELLER_BEHAVIORAL_METRICS_LAUNCH_POLICY_VALUE,
        windowDays: 3,
      }),
    ).toThrow(/between 7 and 365/);
    expect(() =>
      decodeMarketplaceSellerBehavioralMetricsPolicyValue({
        ...MARKETPLACE_SELLER_BEHAVIORAL_METRICS_LAUNCH_POLICY_VALUE,
        windowDays: 90.5,
      }),
    ).toThrow(/whole number/);
  });

  it("rejects a non-boolean buyer-facing chips flag", () => {
    expect(() =>
      decodeMarketplaceSellerBehavioralMetricsPolicyValue({
        ...MARKETPLACE_SELLER_BEHAVIORAL_METRICS_LAUNCH_POLICY_VALUE,
        buyerFacingChipsEnabled: "yes",
      }),
    ).toThrow(/must be a boolean/);
  });

  it("rejects a non-object value", () => {
    expect(() => decodeMarketplaceSellerBehavioralMetricsPolicyValue(null)).toThrow(/must be an object/);
    expect(() => decodeMarketplaceSellerBehavioralMetricsPolicyValue([] as unknown as null)).toThrow(
      /must be an object/,
    );
  });

  it("rejects a minDisplayOrderCount or dispatchWindowHours outside bounds", () => {
    expect(() =>
      decodeMarketplaceSellerBehavioralMetricsPolicyValue({
        ...MARKETPLACE_SELLER_BEHAVIORAL_METRICS_LAUNCH_POLICY_VALUE,
        minDisplayOrderCount: 0,
      }),
    ).toThrow(/between 1 and 1000/);
    expect(() =>
      decodeMarketplaceSellerBehavioralMetricsPolicyValue({
        ...MARKETPLACE_SELLER_BEHAVIORAL_METRICS_LAUNCH_POLICY_VALUE,
        dispatchWindowHours: 0,
      }),
    ).toThrow(/between 1 and 720/);
  });
});
