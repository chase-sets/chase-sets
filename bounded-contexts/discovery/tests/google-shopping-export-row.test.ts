import { describe, expect, it } from "vitest";
import {
  buildGoogleShoppingMappedFeedRow,
  buildGoogleShoppingExternalSellerId,
  buildGoogleShoppingMerchantOfferId,
  buildGoogleShoppingRowId,
  evaluateGoogleShoppingEligibility,
  hashGoogleShoppingPayload,
  mapGoogleShoppingOfferAttributes,
  mapGoogleShoppingPolicyAttributes,
  mapGoogleShoppingProductAttributes,
  selectGoogleShoppingImage,
  type GoogleShoppingFeedRowInput,
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
        "missing-link",
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

  it.each([
    ["inactive listings", { listingStatus: "paused" }, ["listing-not-active"]],
    ["unavailable sellers", { sellerListingAvailabilityStatus: "unavailable" }, ["seller-unavailable"]],
    ["suspended seller accounts", { sellerAccountStatus: "suspended" }, ["seller-not-active"]],
    ["sold-out quantity", { quantityCap: 0 }, ["sold-out"]],
    ["missing landing-page links", { canonicalUrl: "" }, ["missing-link", "not-crawlable"]],
    ["missing titles", { title: "" }, ["missing-title"]],
    ["missing descriptions", { description: "" }, ["missing-description"]],
    ["missing images", { imageUrl: null }, ["missing-image"]],
    ["missing prices", { priceAmount: "0.00" }, ["missing-price"]],
    ["missing card conditions", { condition: null }, ["missing-condition"]],
    ["missing shipping policy", { shippingPolicyReady: false }, ["missing-shipping-policy"]],
    ["missing product measure evidence", { productMeasureReady: false }, ["missing-product-measure"]],
    ["missing returns policy", { returnsPolicyReady: false }, ["missing-returns-policy"]],
    ["noindex crawl posture", { crawlable: false }, ["not-crawlable"]],
  ] satisfies Array<[string, Partial<GoogleShoppingFeedRowInput>, readonly string[]]>)(
    "isolates exclusion reasons for %s",
    (_label, overrides, expectedReasons) => {
      expect(evaluateGoogleShoppingEligibility(eligibleFeedRowInput(overrides))).toEqual({
        status: "excluded",
        reasons: expectedReasons,
      });
    },
  );

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

  it("records image eligibility and policy evidence columns for operator remediation", () => {
    expect(discoveryGoogleShoppingSchemaSql).toContain("image_eligibility_status text NOT NULL DEFAULT 'excluded'");
    expect(discoveryGoogleShoppingSchemaSql).toContain("image_exclusion_reasons jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(discoveryGoogleShoppingSchemaSql).toContain("shipping_policy_url text NULL");
    expect(discoveryGoogleShoppingSchemaSql).toContain("return_policy_url text NULL");
    expect(discoveryGoogleShoppingSchemaSql).toContain("return_policy_label text NULL");
    expect(discoveryGoogleShoppingSchemaSql).toContain("discovery_google_shopping_feed_rows_image_eligibility_idx");
  });

  it("maps a complete raw card listing into a stable eligible Merchant payload", () => {
    const row = buildGoogleShoppingMappedFeedRow({
      catalog: {
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::condition:near-mint",
        title: "Charizard 4/102",
        subtitle: "Base Set Holo",
        description: "Pokemon trading card from Base Set.",
        productSummary: "Near Mint Holofoil English",
        selectedOptions: [
          {
            dimensionId: "dim_condition",
            dimensionName: "Condition",
            optionId: "opt_near_mint",
            optionCode: "near-mint",
            optionLabel: "Near Mint",
          },
          {
            dimensionId: "dim_finish",
            dimensionName: "Finish",
            optionId: "opt_holo",
            optionCode: "holofoil",
            optionLabel: "Holofoil",
          },
        ],
        productAssetSets: [productAssetSet("https://assets.chasesets.com/catalog/charizard-detail.webp", 960, 1344)],
        brand: "Pokemon",
        productType: "Trading Cards > Pokemon",
        googleProductCategory: "Arts & Entertainment > Hobbies & Creative Arts > Collectibles > Trading Cards",
      },
      offer: {
        listingId: "lst_charizard",
        listingStatus: "active",
        sellerListingAvailabilityStatus: "available",
        sellerAccountStatus: "active",
        accountId: "acc_seller",
        canonicalUrl: "https://marketplace.chasesets.com/listings/charizard-lst_charizard",
        priceAmount: "199.99",
        quantityCap: 1,
        crawlable: true,
      },
      shipping: {
        ready: true,
        country: "US",
        service: "Standard",
        priceAmount: "4.99",
        currencyCode: "USD",
        shipFromCode: "US-IL",
        shippingAllowancePercentageBps: 500,
        productMeasureReady: true,
      },
      returns: {
        ready: true,
        policyUrl: "https://marketplace.chasesets.com/refunds-and-returns",
        policyLabel: "chase-sets-standard-returns",
      },
      targetCountry: "US",
      contentLanguage: "en",
      feedLabel: "US",
    });

    expect(row.eligibility).toEqual({ status: "eligible", reasons: [] });
    expect(row.imageEligibility).toEqual({
      status: "eligible",
      imageUrl: "https://assets.chasesets.com/catalog/charizard-detail.webp",
      source: "product-asset",
      reasons: [],
    });
    expect(row.payload).toMatchObject({
      offerId: "cs-listing-lst_charizard",
      externalSellerId: "cs-account-acc_seller",
      title: "Charizard 4/102 Base Set Holo",
      link: "https://marketplace.chasesets.com/listings/charizard-lst_charizard",
      imageLink: "https://assets.chasesets.com/catalog/charizard-detail.webp",
      priceAmount: "199.99",
      condition: "used",
      brand: "Pokemon",
      identifierExists: false,
      returnPolicyLabel: "chase-sets-standard-returns",
    });
    expect(row.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps sealed products conservatively as new when the product form is explicit", () => {
    const product = mapGoogleShoppingProductAttributes({
      catalogItemId: "cat_booster_box",
      productId: "prd_booster_box",
      title: "Pokemon Booster Box",
      description: "Factory sealed Pokemon booster box.",
      productForm: "sealed",
      selectedOptions: [],
      productAssetSets: [productAssetSet("https://assets.chasesets.com/catalog/booster-box.webp", 960, 960)],
    });

    expect(product.condition).toBe("new");
    expect(product.exclusionReasons).toEqual([]);
  });

  it("maps Marketplace offer facts into Merchant offer identifiers, price, availability, and crawl reasons", () => {
    expect(
      mapGoogleShoppingOfferAttributes({
        listingId: "lst_offer",
        listingStatus: "active",
        sellerListingAvailabilityStatus: "available",
        sellerAccountStatus: "active",
        accountId: "acc_seller",
        canonicalUrl: "https://marketplace.chasesets.com/listings/charizard-lst_offer",
        priceAmount: "17.5",
        quantityCap: 3,
        crawlable: true,
      }),
    ).toEqual({
      offerId: "cs-listing-lst_offer",
      externalSellerId: "cs-account-acc_seller",
      link: "https://marketplace.chasesets.com/listings/charizard-lst_offer",
      priceAmount: "17.50",
      currencyCode: "USD",
      availability: "in stock",
      exclusionReasons: [],
    });

    expect(
      mapGoogleShoppingOfferAttributes({
        listingId: "lst_sold",
        listingStatus: "active",
        sellerListingAvailabilityStatus: "available",
        sellerAccountStatus: "active",
        accountId: "acc_seller",
        canonicalUrl: "https://marketplace.chasesets.com/listings/sold-lst_sold",
        priceAmount: "17.50",
        quantityCap: 0,
        crawlable: true,
      }),
    ).toMatchObject({
      availability: "out of stock",
      exclusionReasons: ["sold-out"],
    });
  });

  it("excludes rows with ambiguous or missing trading-card condition facts", () => {
    const product = mapGoogleShoppingProductAttributes({
      catalogItemId: "cat_card",
      productId: "prd_card",
      title: "Test Card",
      description: "Test card.",
      selectedOptions: [
        {
          dimensionId: "dim_condition",
          dimensionName: "Condition",
          optionId: "opt_collectors_choice",
          optionLabel: "Collector Choice",
        },
      ],
      productAssetSets: [productAssetSet("https://assets.chasesets.com/catalog/test-card.webp", 960, 1344)],
    });

    expect(product.condition).toBeNull();
    expect(product.exclusionReasons).toContain("ambiguous-condition");
  });

  it("does not let subtitles mask missing Catalog titles", () => {
    const product = mapGoogleShoppingProductAttributes({
      catalogItemId: "cat_card",
      productId: "prd_card",
      title: "",
      subtitle: "Subtitle Only",
      description: "Test card.",
      selectedOptions: [
        {
          dimensionId: "dim_condition",
          dimensionName: "Condition",
          optionId: "opt_near_mint",
          optionLabel: "Near Mint",
        },
      ],
      productAssetSets: [productAssetSet("https://assets.chasesets.com/catalog/test-card.webp", 960, 1344)],
    });

    expect(product.title).toBeNull();
    expect(product.exclusionReasons).toContain("missing-title");
  });

  it("requires concrete shipping and public returns policy evidence", () => {
    const policy = mapGoogleShoppingPolicyAttributes(
      {
        ready: true,
        country: "US",
        service: "Standard",
        priceAmount: "4.99",
        currencyCode: "USD",
        shipFromCode: "",
        productMeasureReady: true,
      },
      {
        ready: true,
        policyUrl: "http://localhost/refunds-and-returns",
      },
    );

    expect(policy.shipping).toEqual({
      country: "US",
      service: "Standard",
      price: { amount: "4.99", currencyCode: "USD" },
    });
    expect(policy.exclusionReasons).toEqual(["missing-shipping-policy", "missing-returns-policy"]);
  });

  it("records image exclusion reasons for missing, invalid, fallback, and too-small candidates", () => {
    expect(selectGoogleShoppingImage({ productAssetSets: [] })).toMatchObject({
      status: "excluded",
      reasons: ["missing-image"],
    });
    expect(selectGoogleShoppingImage({ imageUrls: ["not a url"] })).toMatchObject({
      status: "excluded",
      reasons: ["invalid-image-url"],
    });
    expect(
      selectGoogleShoppingImage({
        imageFallback: {
          url: "https://assets.chasesets.com/catalog/card-back.webp",
          alt: "Pokemon card back",
          usage: "permanent",
          variants: {},
        },
      }),
    ).toMatchObject({
      status: "excluded",
      reasons: ["fallback-image-not-approved"],
    });
    expect(
      selectGoogleShoppingImage({
        productAssetSets: [productAssetSet("https://assets.chasesets.com/catalog/tiny.webp", 64, 64)],
      }),
    ).toMatchObject({
      status: "excluded",
      reasons: ["image-too-small"],
    });
  });

  it("excludes inactive, unavailable, sold-out, uncrawlable, and policy-incomplete offers", () => {
    const row = buildGoogleShoppingMappedFeedRow({
      catalog: {
        catalogItemId: "cat_card",
        productId: "prd_card",
        title: "Test Card",
        description: "Test card.",
        selectedOptions: [
          {
            dimensionId: "dim_condition",
            dimensionName: "Condition",
            optionId: "opt_damaged",
            optionLabel: "Damaged",
          },
        ],
        productAssetSets: [productAssetSet("https://assets.chasesets.com/catalog/test-card.webp", 960, 1344)],
      },
      offer: {
        listingId: "lst_card",
        listingStatus: "paused",
        sellerListingAvailabilityStatus: "unavailable",
        sellerAccountStatus: "suspended",
        accountId: "acc_seller",
        canonicalUrl: "",
        priceAmount: "0",
        quantityCap: 0,
        crawlable: false,
      },
      shipping: {
        ready: false,
        country: "US",
        productMeasureReady: false,
      },
      returns: {
        ready: false,
        policyUrl: null,
      },
      targetCountry: "US",
      contentLanguage: "en",
      feedLabel: "US",
    });

    expect(row.payload).toBeNull();
    expect(row.payloadHash).toBeNull();
    expect(row.eligibility).toEqual({
      status: "excluded",
      reasons: [
        "listing-not-active",
        "seller-unavailable",
        "seller-not-active",
        "sold-out",
        "missing-link",
        "missing-price",
        "not-crawlable",
        "missing-shipping-policy",
        "missing-product-measure",
        "missing-returns-policy",
      ],
    });
  });
});

function eligibleFeedRowInput(overrides: Partial<GoogleShoppingFeedRowInput> = {}): GoogleShoppingFeedRowInput {
  return {
    listingId: "lst_123",
    listingStatus: "active",
    sellerListingAvailabilityStatus: "available",
    sellerAccountStatus: "active",
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
    quantityCap: 1,
    productMeasureReady: true,
    ...overrides,
  };
}

function productAssetSet(publicUrl: string, width: number, height: number) {
  return {
    kind: "product-image" as const,
    sourceHash: "sha256:test",
    source: {
      role: "source" as const,
      width,
      height,
      density: null,
      mediaType: "image/webp" as const,
      storageKey: "catalog/source.webp",
      publicUrl,
      byteSize: 2048,
      generatedAt: "2026-06-03T00:00:00.000Z",
    },
    variants: [
      {
        role: "catalog-detail" as const,
        width,
        height,
        density: 2 as const,
        mediaType: "image/webp" as const,
        storageKey: "catalog/detail.webp",
        publicUrl,
        byteSize: 1024,
        generatedAt: "2026-06-03T00:00:00.000Z",
      },
    ],
  };
}
