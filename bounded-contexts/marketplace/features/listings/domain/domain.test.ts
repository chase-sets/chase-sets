import { describe, expect, it } from "vitest";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type CreateListingCommand,
} from "./domain";

const shipFromAddress = {
  name: "Seller Shipping",
  company: null,
  line1: "1 Warehouse Way",
  line2: null,
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: null,
  email: null,
} as const;

const createListingCommand = {
  type: "CreateListing",
  listingId: "lst_test" as never,
  accountId: "acc_seller" as never,
  inventoryItemId: "itm_test",
  catalogItemId: "cat_test",
  productId: "cat_test::" as never,
  itemLanguageCode: "en",
  itemTitle: "Test Card",
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  storageLocationName: "Main",
  shipFromCode: "AUS",
  shipFromAddress,
  priceAmount: "10.00",
  marketplaceSalesFeeUnitAmount: "1.00",
  sellerNetUnitAmount: "9.00",
  feeQuoteFingerprint: "fee_test",
  quantityCap: 3,
} satisfies CreateListingCommand;

const listingPhoto = {
  photoId: "lpho_1",
  originalFilename: "front.png",
  altText: null,
  sortOrder: 0,
  uploadedAt: "2026-05-21T00:00:00.000Z",
  assetSet: {
    kind: "listing-photo",
    sourceHash: "hash_1",
    source: {
      role: "source",
      width: 600,
      height: 840,
      density: null,
      mediaType: "image/webp",
      storageKey: "marketplace/listings/acc_seller/lst_test/lpho_1/source.webp",
      publicUrl: "https://assets.test/source.webp",
      byteSize: 1234,
      generatedAt: "2026-05-21T00:00:00.000Z",
    },
    variants: [
      {
        role: "catalog-detail",
        width: 480,
        height: 672,
        density: 1,
        mediaType: "image/webp",
        storageKey: "marketplace/listings/acc_seller/lst_test/lpho_1/detail.webp",
        publicUrl: "https://assets.test/detail.webp",
        byteSize: 900,
        generatedAt: "2026-05-21T00:00:00.000Z",
      },
    ],
  },
} as const;

describe("marketplace listing purchase limits", () => {
  it("stores nullable buyer purchase limits on created listings", () => {
    const events = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      purchaseLimits: {
        maxUnitsPerOrder: 1,
        maxUnitsPerDay: null,
        maxUnitsPerCustomerAccount: 2,
      },
    });
    const state = events.reduce(evolveMarketplaceListing, initialMarketplaceListingState);

    expect(events[0]?.data).toMatchObject({
      purchaseLimits: {
        maxUnitsPerOrder: 1,
        maxUnitsPerDay: null,
        maxUnitsPerCustomerAccount: 2,
      },
    });
    expect(state.purchaseLimits).toEqual({
      maxUnitsPerOrder: 1,
      maxUnitsPerDay: null,
      maxUnitsPerCustomerAccount: 2,
    });
  });

  it("rejects purchase limits above the quantity cap or out of order", () => {
    expect(() =>
      decideMarketplaceListing(initialMarketplaceListingState, {
        ...createListingCommand,
        purchaseLimits: {
          maxUnitsPerOrder: 4,
        },
      }),
    ).toThrow("Maximum units per order cannot exceed the listing quantity cap.");

    expect(() =>
      decideMarketplaceListing(initialMarketplaceListingState, {
        ...createListingCommand,
        purchaseLimits: {
          maxUnitsPerOrder: 2,
          maxUnitsPerDay: 1,
        },
      }),
    ).toThrow("Maximum units per order cannot exceed maximum units per day.");
  });

  it("requires lowering affected limits when quantity cap is lowered", () => {
    const created = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      purchaseLimits: {
        maxUnitsPerOrder: 3,
      },
    }).reduce(evolveMarketplaceListing, initialMarketplaceListingState);

    expect(() =>
      decideMarketplaceListing(created, {
        type: "UpdateListingQuantityCap",
        quantityCap: 2,
        marketplaceSalesFeeUnitAmount: "1.00",
        sellerNetUnitAmount: "9.00",
        feeQuoteFingerprint: "fee_test_2",
      }),
    ).toThrow("Maximum units per order cannot exceed the listing quantity cap.");
  });
});

describe("marketplace listing photos", () => {
  it("stores normalized WebP listing photo asset sets on created listings", () => {
    const events = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      listingPhotos: [listingPhoto],
    });
    const state = events.reduce(evolveMarketplaceListing, initialMarketplaceListingState);

    expect(events[0]?.data).toMatchObject({
      listingPhotos: [
        {
          photoId: "lpho_1",
          assetSet: {
            kind: "listing-photo",
            source: { mediaType: "image/webp" },
          },
        },
      ],
    });
    expect(state.listingPhotos[0]?.assetSet.variants[0]?.mediaType).toBe("image/webp");
  });

  it("requires listing photos before publishing Mint or Pristine listings", () => {
    const mintDraft = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      selectedOptions: [{ dimensionId: "dim_condition", optionId: "mint" }],
      productSummary: "Condition: Mint",
    }).reduce(evolveMarketplaceListing, initialMarketplaceListingState);

    expect(() =>
      decideMarketplaceListing(mintDraft, {
        type: "PublishListing",
        marketplaceSalesFeeUnitAmount: "1.00",
        sellerNetUnitAmount: "9.00",
        feeQuoteFingerprint: "fee_test",
      }),
    ).toThrow("Pristine and Mint listings require at least one listing photo before publication.");

    const nearMintDraft = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      listingId: "lst_near_mint" as never,
      selectedOptions: [{ dimensionId: "dim_condition", optionId: "near_mint" }],
      productSummary: "Condition: Near Mint",
    }).reduce(evolveMarketplaceListing, initialMarketplaceListingState);

    expect(() =>
      decideMarketplaceListing(nearMintDraft, {
        type: "PublishListing",
        marketplaceSalesFeeUnitAmount: "1.00",
        sellerNetUnitAmount: "9.00",
        feeQuoteFingerprint: "fee_test",
      }),
    ).not.toThrow();
  });
});
