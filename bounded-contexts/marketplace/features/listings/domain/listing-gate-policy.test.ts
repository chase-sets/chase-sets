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
        maxActiveAnonymousListingDrafts: 10,
        anonymousListingDraftTtlDays: 14,
        maxListingEvidenceUploadBytes: 5 * 1024 * 1024,
      }),
    ).toEqual({
      maxActiveAnonymousListingDrafts: 10,
      anonymousListingDraftTtlDays: 14,
      maxListingEvidenceUploadBytes: 5 * 1024 * 1024,
      maxListingEvidenceCount: 24,
      maxListingEvidenceTotalBytes: 60 * 1024 * 1024,
      evidenceGarbageCollectionSafeDelayHours: 24 * 7,
    });
  });

  it("declares the launch value as the compiled default fallback", () => {
    expect(marketplaceListingGatePolicy.defaultValue).toEqual(MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE);
    expect(MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE).toEqual({
      maxActiveAnonymousListingDrafts: 20,
      anonymousListingDraftTtlDays: 30,
      maxListingEvidenceUploadBytes: 10 * 1024 * 1024,
      maxListingEvidenceCount: 24,
      maxListingEvidenceTotalBytes: 60 * 1024 * 1024,
      evidenceGarbageCollectionSafeDelayHours: 24 * 7,
    });
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

  it("rejects an evidence upload cap above the 100 MB ceiling", () => {
    expect(() =>
      decodeMarketplaceListingGatePolicyValue({
        ...MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE,
        maxListingEvidenceUploadBytes: 200 * 1024 * 1024,
      }),
    ).toThrow(/cannot exceed/);
  });

  it("rejects a non-object policy value", () => {
    expect(() => decodeMarketplaceListingGatePolicyValue(null)).toThrow(/must be an object/);
    expect(() => decodeMarketplaceListingGatePolicyValue("nope")).toThrow(/must be an object/);
  });
});
