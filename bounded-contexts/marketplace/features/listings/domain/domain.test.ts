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
  productMeasureSnapshot: {
    catalogItemId: "cat_test",
    productId: "cat_test::",
    selectedOptions: [],
    measureVersion: "pm_test_v1",
    unitLengthInches: 3.5,
    unitWidthInches: 2.5,
    unitHeightInches: 0.01,
    unitWeightOunces: 0.1,
    physicalFlags: ["raw-card"],
    stackBehavior: "stackable-thickness",
    source: "profile",
    confidence: "measured",
  },
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

  it("requires listing photos before publishing Mint, Pristine, or graded-card listings", () => {
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
    ).toThrow(
      "Pristine, Mint, and graded-card listings require at least one listing photo before publication; graded-card listings must include a slab photo.",
    );

    const gradedDraft = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      listingId: "lst_graded" as never,
      gradedCard: {
        gradingCompany: "PSA",
        grade: "10",
        certificationNumber: "12345678",
        population: null,
        conditionDescriptors: [],
      },
    }).reduce(evolveMarketplaceListing, initialMarketplaceListingState);

    expect(() =>
      decideMarketplaceListing(gradedDraft, {
        type: "PublishListing",
        marketplaceSalesFeeUnitAmount: "1.00",
        sellerNetUnitAmount: "9.00",
        feeQuoteFingerprint: "fee_test",
      }),
    ).toThrow(
      "Pristine, Mint, and graded-card listings require at least one listing photo before publication; graded-card listings must include a slab photo.",
    );

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

  it("requires a resolved shipping measure before publishing", () => {
    const draft = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      listingId: "lst_missing_measure" as never,
      productMeasureSnapshot: null,
    }).reduce(evolveMarketplaceListing, initialMarketplaceListingState);

    expect(() =>
      decideMarketplaceListing(draft, {
        type: "PublishListing",
        marketplaceSalesFeeUnitAmount: "1.00",
        sellerNetUnitAmount: "9.00",
        feeQuoteFingerprint: "fee_test",
      }),
    ).toThrow("Listings require a resolved shipping measure before publication.");
  });
});

describe("marketplace graded-card validation", () => {
  it.each([
    ["PSA", "12345678", "10.0", "10"],
    ["PSA", "12345678", "Gem Mint 10", "10"],
    ["PSA", "12345678", "NM-MT 8", "8"],
    ["BGS", "1234567890", "9.5", "9.5"],
    ["BGS", "1234567890", "Mint 9.5", "9.5"],
    ["CGC", "1234567", "Authentic", "Authentic"],
    ["SGC", "123456", " authentic ", "Authentic"],
  ])(
    "accepts %s certification numbers and normalizes grades",
    (gradingCompany, certificationNumber, grade, expected) => {
      const events = decideMarketplaceListing(initialMarketplaceListingState, {
        ...createListingCommand,
        gradedCard: {
          gradingCompany,
          grade,
          certificationNumber,
          population: null,
          conditionDescriptors: [" slabbed ", "slabbed"],
        },
      });

      expect(events[0]?.type).toBe("marketplace.listing.created");
      const [created] = events;
      if (created?.type !== "marketplace.listing.created") {
        throw new Error("Expected listing created event.");
      }
      expect(created.data.gradedCard).toMatchObject({
        gradingCompany,
        grade: expected,
        certificationNumber,
        conditionDescriptors: ["slabbed"],
      });
    },
  );

  it("normalizes the BGS catalog seed label alias to the supported grading company code", () => {
    const events = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      gradedCard: {
        gradingCompany: "BGS/Beckett",
        grade: "Mint 9.5",
        certificationNumber: "0012345678",
        population: null,
        conditionDescriptors: ["Encapsulated"],
      },
    });

    expect(events[0]?.type).toBe("marketplace.listing.created");
    const [created] = events;
    if (created?.type !== "marketplace.listing.created") {
      throw new Error("Expected listing created event.");
    }
    expect(created.data.gradedCard).toMatchObject({
      gradingCompany: "BGS",
      grade: "9.5",
      certificationNumber: "0012345678",
      conditionDescriptors: ["Encapsulated"],
    });
  });

  it.each([
    ["PSA", "ABC12345", "PSA certification numbers must use 8 to 10 digits."],
    ["BGS", "1234567", "BGS certification numbers must use 8 to 10 digits."],
    ["CGC", "123456", "CGC certification numbers must use 7 to 10 digits."],
    ["SGC", "12345", "SGC certification numbers must use 6 to 10 digits."],
  ])("rejects malformed %s certification numbers", (gradingCompany, certificationNumber, message) => {
    expect(() =>
      decideMarketplaceListing(initialMarketplaceListingState, {
        ...createListingCommand,
        gradedCard: {
          gradingCompany,
          grade: "9",
          certificationNumber,
          population: null,
          conditionDescriptors: [],
        },
      }),
    ).toThrow(message);
  });

  it("requires certification numbers for graded cards", () => {
    expect(() =>
      decideMarketplaceListing(initialMarketplaceListingState, {
        ...createListingCommand,
        gradedCard: {
          gradingCompany: "PSA",
          grade: "9",
          certificationNumber: null,
          population: null,
          conditionDescriptors: [],
        },
      }),
    ).toThrow("Graded cards require a certification number.");
  });

  it.each(["0.5", "10.5", "9.3", "Gem Mint"])("rejects unsupported grade value %s", (grade) => {
    expect(() =>
      decideMarketplaceListing(initialMarketplaceListingState, {
        ...createListingCommand,
        gradedCard: {
          gradingCompany: "PSA",
          grade,
          certificationNumber: "12345678",
          population: null,
          conditionDescriptors: [],
        },
      }),
    ).toThrow("PSA grades must be 1 through 10 in 0.5-point steps or an allowed label.");
  });

  it("rejects unsupported grading companies", () => {
    expect(() =>
      decideMarketplaceListing(initialMarketplaceListingState, {
        ...createListingCommand,
        gradedCard: {
          gradingCompany: "ACE",
          grade: "10",
          certificationNumber: "12345678",
          population: null,
          conditionDescriptors: [],
        },
      }),
    ).toThrow("Grading company must be one of PSA, BGS, CGC, SGC.");
  });
});
