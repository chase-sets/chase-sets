import { describe, expect, it } from "vitest";
import {
  buildGoogleShoppingExternalSellerId,
  buildGoogleShoppingMerchantOfferId,
  buildGoogleShoppingRowId,
  evaluateGoogleShoppingEligibility,
  hashGoogleShoppingPayload,
} from "../support/google-shopping-support/export-row";
import { discoveryGoogleShoppingSchemaSql } from "../support/google-shopping-support/schema";

describe("google shopping export rows", () => {
  it("derives stable row, offer, and seller identifiers from source ids", () => {
    expect(buildGoogleShoppingRowId("lst_123")).toBe("google-shopping:listing:lst_123");
    expect(buildGoogleShoppingMerchantOfferId("lst_123")).toBe("cs-listing-lst_123");
    expect(buildGoogleShoppingExternalSellerId("acc_456")).toBe("cs-account-acc_456");
  });

  it("marks complete active rows as eligible", () => {
    expect(
      evaluateGoogleShoppingEligibility({
        listingId: "lst_123",
        listingStatus: "active",
        sellerListingAvailabilityStatus: "available",
        accountId: "acc_456",
        catalogItemId: "cat_789",
        productId: "cat_789::raw",
        canonicalUrl: "https://marketplace.chasesets.com/listings/charizard-lst_123",
        title: "Charizard 4/102",
        description: "Pokemon trading card listing with verified condition.",
        imageUrl: "https://assets.chasesets.com/catalog/charizard.webp",
        priceAmount: "19.99",
        condition: "used",
        shippingPolicyReady: true,
        returnsPolicyReady: true,
        crawlable: true,
      }),
    ).toEqual({ status: "eligible", reasons: [] });
  });

  it("keeps excluded rows explainable for inactive or incomplete listings", () => {
    expect(
      evaluateGoogleShoppingEligibility({
        listingId: "lst_123",
        listingStatus: "paused",
        sellerListingAvailabilityStatus: "unavailable",
        accountId: "acc_456",
        catalogItemId: "cat_789",
        productId: "cat_789::raw",
        canonicalUrl: "",
        title: "",
        description: null,
        imageUrl: null,
        priceAmount: "0.00",
        condition: "",
        shippingPolicyReady: false,
        returnsPolicyReady: false,
        crawlable: false,
      }),
    ).toEqual({
      status: "excluded",
      reasons: [
        "listing-not-active",
        "seller-unavailable",
        "missing-title",
        "missing-description",
        "missing-image",
        "missing-price",
        "missing-condition",
        "missing-shipping-policy",
        "missing-returns-policy",
        "not-crawlable",
      ],
    });
  });

  it("hashes payload content independently of object key order", () => {
    const first = hashGoogleShoppingPayload({
      offerId: "cs-listing-lst_123",
      title: "Charizard",
      description: "Pokemon card",
      link: "https://marketplace.chasesets.com/listings/charizard-lst_123",
      imageLink: "https://assets.chasesets.com/catalog/charizard.webp",
      priceAmount: "19.99",
      currencyCode: "USD",
      availability: "in stock",
      condition: "used",
      externalSellerId: "cs-account-acc_456",
      targetCountry: "US",
      contentLanguage: "en",
      feedLabel: "US",
    });
    const second = hashGoogleShoppingPayload({
      feedLabel: "US",
      contentLanguage: "en",
      targetCountry: "US",
      externalSellerId: "cs-account-acc_456",
      condition: "used",
      availability: "in stock",
      currencyCode: "USD",
      priceAmount: "19.99",
      imageLink: "https://assets.chasesets.com/catalog/charizard.webp",
      link: "https://marketplace.chasesets.com/listings/charizard-lst_123",
      description: "Pokemon card",
      title: "Charizard",
      offerId: "cs-listing-lst_123",
    });

    expect(second).toBe(first);
  });

  it("creates sync and tombstone indexes for Merchant operations", () => {
    expect(discoveryGoogleShoppingSchemaSql).toContain("discovery_google_shopping_feed_rows_pending_sync_idx");
    expect(discoveryGoogleShoppingSchemaSql).toContain("discovery_google_shopping_feed_rows_stale_refresh_idx");
    expect(discoveryGoogleShoppingSchemaSql).toContain("discovery_google_shopping_feed_rows_tombstone_idx");
  });
});
