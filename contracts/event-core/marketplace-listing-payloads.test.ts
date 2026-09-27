import { describe, expect, it } from "vitest";
import type {
  MarketplaceListingCreatedPayload,
  MarketplaceListingQuantityCapUpdatedPayload,
  MarketplaceListingPriceUpdatedPayload,
} from "./public-event-payloads/marketplace";

const channelOnly = {
  schemaVersion: 2,
  publicationScope: "channel-only",
  nativeVisibility: "disabled",
  nativeFeeState: "not-enrolled",
  listingId: "listing_synthetic",
  accountId: "account_synthetic" as never,
  inventoryItemId: "inventory_synthetic",
  catalogItemId: "catalog_synthetic",
  productId: "product_synthetic",
  itemTitle: null,
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  storageLocationName: null,
  shipFromCode: null,
  shipFromAddress: {},
  priceAmount: "12.00",
  priceCurrencyCode: "CAD",
  marketplaceSalesFeeUnitAmount: null,
  sellerNetUnitAmount: null,
  termsScheduleId: null,
  termsAgreementId: null,
  termsResolvedAt: null,
  feeLocks: [],
  quantityCap: 1,
} as const satisfies MarketplaceListingCreatedPayload;
const historicalPrice = {
  priceAmount: "12.00",
  marketplaceSalesFeeUnitAmount: "1.00",
  sellerNetUnitAmount: "11.00",
  termsScheduleId: null,
  termsAgreementId: null,
  termsResolvedAt: "2026-01-01",
  feeLocks: [],
} as const satisfies MarketplaceListingPriceUpdatedPayload;

describe("Marketplace Listing historical and scoped public payloads", () => {
  it("keeps absent historical currency distinct from complete scoped creation", () => {
    expect(historicalPrice).not.toHaveProperty("priceCurrencyCode");
    expect(channelOnly).toMatchObject({
      nativeVisibility: "disabled",
      nativeFeeState: "not-enrolled",
      priceCurrencyCode: "CAD",
    });
  });

  it("rejects partial scoped discriminators and mixed native fee states at the type boundary", () => {
    // @ts-expect-error channel-only creation cannot grant native visibility.
    const enabled: MarketplaceListingCreatedPayload = { ...channelOnly, nativeVisibility: "enabled" };
    const { schemaVersion: _version, ...withoutVersion } = channelOnly;
    // @ts-expect-error scoped fields without their schema version are not historical payloads.
    const partial: MarketplaceListingCreatedPayload = withoutVersion;
    // @ts-expect-error unversioned native price history cannot carry new null fee state.
    const noFees: MarketplaceListingPriceUpdatedPayload = { ...historicalPrice, marketplaceSalesFeeUnitAmount: null };
    // @ts-expect-error modern native updates cannot bypass canonical accepted identity.
    const missingAcceptance: MarketplaceListingPriceUpdatedPayload = {
      ...historicalPrice,
      schemaVersion: 2,
      priceCurrencyCode: "CAD",
    };
    expect([enabled, partial, noFees, missingAcceptance]).toHaveLength(4);
  });

  it("does not require or authorize a price pair on quantity snapshots", () => {
    const quantity: MarketplaceListingQuantityCapUpdatedPayload = {
      schemaVersion: 2,
      quantityCap: 3,
      marketplaceSalesFeeUnitAmount: null,
      sellerNetUnitAmount: null,
      termsScheduleId: null,
      termsAgreementId: null,
      termsResolvedAt: null,
      feeLocks: [],
    };
    expect(quantity).not.toHaveProperty("priceAmount");
    expect(quantity).not.toHaveProperty("acceptedTargetPrice");
  });
});
