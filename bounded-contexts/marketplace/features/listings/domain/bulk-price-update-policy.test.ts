import { describe, expect, it } from "vitest";
import {
  decodeMarketplaceListingBulkPriceUpdatePolicyValue,
  MARKETPLACE_LISTING_BULK_PRICE_UPDATE_LAUNCH_POLICY_VALUE,
  marketplaceListingBulkPriceUpdatePolicy,
} from "./bulk-price-update-policy";

describe("marketplace bulk listing price-update policy", () => {
  it("decodes a valid revised value", () => {
    expect(
      decodeMarketplaceListingBulkPriceUpdatePolicyValue({
        chunkSize: 25,
        yieldIntervalMs: 100,
      }),
    ).toEqual({ chunkSize: 25, yieldIntervalMs: 100 });
  });

  it("declares the launch value as the compiled default fallback", () => {
    expect(marketplaceListingBulkPriceUpdatePolicy.defaultValue).toEqual(
      MARKETPLACE_LISTING_BULK_PRICE_UPDATE_LAUNCH_POLICY_VALUE,
    );
    expect(MARKETPLACE_LISTING_BULK_PRICE_UPDATE_LAUNCH_POLICY_VALUE).toEqual({
      chunkSize: 50,
      yieldIntervalMs: 25,
    });
  });

  it("rejects a non-integer chunk size", () => {
    expect(() => decodeMarketplaceListingBulkPriceUpdatePolicyValue({ chunkSize: 25.5, yieldIntervalMs: 25 })).toThrow(
      /whole number/,
    );
  });

  it("rejects a chunk size outside 1-500", () => {
    expect(() => decodeMarketplaceListingBulkPriceUpdatePolicyValue({ chunkSize: 0, yieldIntervalMs: 25 })).toThrow(
      /between 1 and 500/,
    );
    expect(() => decodeMarketplaceListingBulkPriceUpdatePolicyValue({ chunkSize: 501, yieldIntervalMs: 25 })).toThrow(
      /between 1 and 500/,
    );
  });

  it("rejects a yield interval outside 0-60000ms", () => {
    expect(() => decodeMarketplaceListingBulkPriceUpdatePolicyValue({ chunkSize: 50, yieldIntervalMs: -1 })).toThrow(
      /between 0 and 60000/,
    );
    expect(() =>
      decodeMarketplaceListingBulkPriceUpdatePolicyValue({ chunkSize: 50, yieldIntervalMs: 60_001 }),
    ).toThrow(/between 0 and 60000/);
  });

  it("allows a zero yield interval (still yields one event-loop tick at the lane level)", () => {
    expect(decodeMarketplaceListingBulkPriceUpdatePolicyValue({ chunkSize: 50, yieldIntervalMs: 0 })).toEqual({
      chunkSize: 50,
      yieldIntervalMs: 0,
    });
  });

  it("rejects a non-object value", () => {
    expect(() => decodeMarketplaceListingBulkPriceUpdatePolicyValue(null)).toThrow(/must be an object/);
    expect(() => decodeMarketplaceListingBulkPriceUpdatePolicyValue([])).toThrow(/must be an object/);
  });

  it("declares the marketplace-owned policy key and context", () => {
    expect(marketplaceListingBulkPriceUpdatePolicy.policyKey).toBe("marketplace.listing-bulk-price-update");
    expect(marketplaceListingBulkPriceUpdatePolicy.contextName).toBe("marketplace");
  });
});
