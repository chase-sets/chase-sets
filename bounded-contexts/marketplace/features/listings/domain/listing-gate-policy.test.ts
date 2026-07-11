import { describe, expect, it } from "vitest";
import {
  decodeMarketplaceListingGatePolicyValue,
  MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE,
  marketplaceListingGatePolicy,
} from "./listing-gate-policy";

describe("marketplace listing-gate policy", () => {
  it("decodes a valid revised gate value", () => {
    expect(
      decodeMarketplaceListingGatePolicyValue({
        highDollarListingAmount: "500.00",
        minTrustedReputationReviews: 5,
        maxActiveAnonymousListingDrafts: 10,
        anonymousListingDraftTtlDays: 14,
        maxListingPhotoUploadBytes: 5 * 1024 * 1024,
      }),
    ).toEqual({
      highDollarListingAmount: "500.00",
      minTrustedReputationReviews: 5,
      maxActiveAnonymousListingDrafts: 10,
      anonymousListingDraftTtlDays: 14,
      maxListingPhotoUploadBytes: 5 * 1024 * 1024,
    });
  });

  it("declares the launch value as the compiled default fallback", () => {
    expect(marketplaceListingGatePolicy.defaultValue).toEqual(MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE);
    expect(MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE).toEqual({
      highDollarListingAmount: "250.00",
      minTrustedReputationReviews: 3,
      maxActiveAnonymousListingDrafts: 20,
      anonymousListingDraftTtlDays: 30,
      maxListingPhotoUploadBytes: 10 * 1024 * 1024,
    });
  });

  it("rejects a negative high-dollar listing amount", () => {
    expect(() =>
      decodeMarketplaceListingGatePolicyValue({
        ...MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE,
        highDollarListingAmount: "-1.00",
      }),
    ).toThrow(/non-negative/);
  });

  it("rejects a non-integer or negative trusted-review minimum", () => {
    expect(() =>
      decodeMarketplaceListingGatePolicyValue({
        ...MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE,
        minTrustedReputationReviews: -1,
      }),
    ).toThrow(/zero or a positive whole number/);
    expect(() =>
      decodeMarketplaceListingGatePolicyValue({
        ...MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE,
        minTrustedReputationReviews: 1.5,
      }),
    ).toThrow();
  });

  it("rejects a non-positive anonymous listing draft cap", () => {
    expect(() =>
      decodeMarketplaceListingGatePolicyValue({
        ...MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE,
        maxActiveAnonymousListingDrafts: 0,
      }),
    ).toThrow(/positive whole number/);
  });

  it("rejects an anonymous listing draft TTL outside the 1-365 day range", () => {
    expect(() =>
      decodeMarketplaceListingGatePolicyValue({
        ...MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE,
        anonymousListingDraftTtlDays: 400,
      }),
    ).toThrow(/cannot exceed 365/);
  });

  it("rejects a photo upload cap above the 100 MB ceiling", () => {
    expect(() =>
      decodeMarketplaceListingGatePolicyValue({
        ...MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE,
        maxListingPhotoUploadBytes: 200 * 1024 * 1024,
      }),
    ).toThrow(/cannot exceed/);
  });

  it("rejects a non-object policy value", () => {
    expect(() => decodeMarketplaceListingGatePolicyValue(null)).toThrow(/must be an object/);
    expect(() => decodeMarketplaceListingGatePolicyValue("nope")).toThrow(/must be an object/);
  });
});
