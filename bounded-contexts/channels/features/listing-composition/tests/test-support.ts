import type {
  ChannelCompositionProfile,
  ChannelListingCompositionInput,
  ChannelListingLinkState,
} from "../domain/contracts";

export const syntheticProfile: ChannelCompositionProfile = {
  identity: { providerKey: "synthetic-provider", environment: "sandbox" },
  derivation: {
    sourceKind: "synthetic-test-fixture",
    sourceRef: "synthetic://channel-composition-profile",
    sourceVersion: "1",
    capturedAt: "2026-09-08T12:00:00Z",
  },
  snapshotPreservedPlaceholder: "chase-sets:snapshot-preserved:synthetic-provider",
  requiresProviderProductReference: true,
  requiresProviderCatalogItemReference: true,
  conditionDimensionId: "condition",
  title: { mode: "template", maxLength: 100, snapshotField: "title" },
  description: { mode: "template", maxLength: 500, snapshotField: "description" },
  category: { mode: "mapped", maxKeyLength: 100, snapshotField: "category" },
  condition: { mode: "mapped", maxKeyLength: 100, snapshotField: "condition" },
  attributes: {
    mode: "snapshot-preserved",
    maxCount: 20,
    maxKeyLength: 100,
    maxValueLength: 500,
    snapshotField: "attributes",
  },
  quantity: { max: 100, draftField: "quantity" },
  price: { maxAmountMinor: 999_999_999_999, allowedCurrencies: ["USD", "EUR"], draftField: "price" },
  forbiddenPatterns: ["forbidden"],
};

export function listingInput(overrides: Partial<ChannelListingCompositionInput> = {}): ChannelListingCompositionInput {
  return {
    connection: {
      connectionId: "connection-synthetic",
      accountId: "account-synthetic",
      providerKey: "synthetic-provider",
      environment: "sandbox",
      connectionStatus: "active",
      publicationScopeState: { kind: "not-applicable" },
    },
    listing: {
      kind: "present",
      listingId: "listing-synthetic",
      listingRevision: 7,
      listingStatus: "active",
      sellerAvailabilityStatus: "available",
      identity: {
        catalogItemId: "catalog-synthetic",
        selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
        selectedOptionKey: "condition:near-mint",
        categoryIds: ["cards"],
        itemTitle: { kind: "present", value: "Synthetic card" },
        itemSubtitle: { kind: "absent" },
        productSummary: { kind: "present", value: "Synthetic description" },
        gradedCard: { kind: "absent" },
      },
      offer: {
        price: { kind: "present", amount: "20.00", currencyCode: "USD" },
        publishableQuantity: { kind: "resolved", value: 3 },
      },
    },
    providerProductReference: { kind: "linked", providerKey: "synthetic-provider", externalKey: "sku:synthetic" },
    providerCatalogItemReference: {
      kind: "linked",
      providerKey: "synthetic-provider",
      externalKey: "product:synthetic",
    },
    settings: {
      kind: "configured",
      settings: {
        titlePrefix: "",
        titleSuffix: "",
        descriptionFooter: "",
        categoryAllowlist: ["cards"],
        excludedListingIds: [],
      },
    },
    link: { kind: "none" },
    profile: { kind: "registered", profile: syntheticProfile },
    mappings: [
      {
        dimension: "category",
        sourceKey: "catalog-category:cards",
        targetKey: "trading-cards",
        confidenceTier: "manual",
        reviewStatus: "accepted",
      },
      {
        dimension: "condition",
        sourceKey: "selected-option:condition:near-mint",
        targetKey: "near-mint",
        confidenceTier: "manual",
        reviewStatus: "accepted",
      },
    ],
    ...overrides,
  };
}

export function publishedLink(overrides: Partial<ChannelListingLinkState> = {}): ChannelListingLinkState {
  return {
    connectionId: "connection-synthetic",
    channelListingId: "cl_synthetic",
    listingId: "listing-synthetic",
    externalListingId: "external-listing",
    externalOfferId: "external-offer",
    providerRevision: "provider-r1",
    lastDesiredStateSequence: 1,
    lastDesiredListingRevision: 7,
    lastDesiredStateHash: "a".repeat(64),
    lastDesiredIntent: "publish",
    lastPushedListingRevision: 7,
    lastPushedPriceAmountMinor: 2_000,
    lastPushedPriceCurrency: "USD",
    lastPushedQuantity: 3,
    publishState: "published",
    blockingReasonCodes: [],
    failureReason: null,
    driftStatus: null,
    lastStreamVersion: 2,
    ...overrides,
  };
}
