import { describe, expect, it } from "vitest";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type CreateListingCommand,
  type MarketplaceListingFeeLock,
  type PublishListingCommand,
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

function feeLock(overrides: Partial<MarketplaceListingFeeLock> = {}): MarketplaceListingFeeLock {
  return {
    unitCount: 3,
    terms: {
      marketplaceSalesFeePercentageBps: 500,
      marketplaceSalesFeeFixedAmount: "0.00",
      marketplaceSalesFeeCapAmount: "25.00",
      shippingAllowancePercentageBps: 500,
      termsScheduleId: "cts_standard",
      termsAgreementId: null,
      termsResolvedAt: "2026-07-12T12:00:00.000Z",
    },
    marketplaceSalesFeeUnitAmount: "1.00",
    sellerNetUnitAmount: "9.00",
    feeQuoteFingerprint: "fee_test",
    ...overrides,
  };
}

const evidenceRequirements = {
  policyId: null,
  policyVersion: null,
  policyHash: "sha256:policy",
  evaluatedAt: "2026-07-13T00:00:00.000Z",
  requirementHash: "sha256:requirements",
  matchedRuleIds: [],
  explanationCodes: [],
  requirements: {
    minimumPhotoCount: 0,
    requiredSlots: [],
    sellerTrustRequirements: [],
    buyerAcknowledgment: "none",
  },
} as const;

const publishListingCommand = {
  type: "PublishListing",
  readiness: {
    ready: true,
    requirementHash: evidenceRequirements.requirementHash,
    unmetCodes: [],
    coverage: {
      complete: true,
      unmetCodes: [],
      slots: [],
      activePhotoCount: 0,
      minimumPhotoCount: 0,
    },
  },
} satisfies PublishListingCommand;

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
  feeLock: feeLock(),
  quantityCap: 3,
  evidenceRequirements,
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

describe("marketplace listing no-op suppression", () => {
  it("canonicalizes listing prices before recording events", () => {
    const [event] = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      priceAmount: "007.50",
    });

    expect(event?.type).toBe("marketplace.listing.created");
    if (event?.type !== "marketplace.listing.created") {
      throw new Error("Expected a listing-created event.");
    }
    expect(event.data.priceAmount).toBe("7.50");
  });

  it("rejects listing prices above the shared money ceiling", () => {
    expect(() =>
      decideMarketplaceListing(initialMarketplaceListingState, {
        ...createListingCommand,
        priceAmount: "10000000000.00",
      }),
    ).toThrow();
  });

  function createdListing(overrides: Partial<CreateListingCommand> = {}) {
    return decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      ...overrides,
    }).reduce(evolveMarketplaceListing, initialMarketplaceListingState);
  }

  describe("fee-lock mutation semantics", () => {
    it("locks every creation-time unit to the resolved terms snapshot", () => {
      const listing = createdListing();

      expect(listing.feeLocks).toEqual([feeLock()]);
      expect(listing.quantityCap).toBe(3);
    });

    it("allows price edits while preserving fee-lock tranches", () => {
      const listing = createdListing();
      const requoted = feeLock({
        marketplaceSalesFeeUnitAmount: "1.25",
        sellerNetUnitAmount: "23.75",
        feeQuoteFingerprint: "fee_requoted",
      });

      const events = decideMarketplaceListing(listing, {
        type: "UpdateListingPrice",
        priceAmount: "25.00",
        feeLocks: [requoted],
      });

      expect(events).toEqual([
        expect.objectContaining({
          type: "marketplace.listing.price-updated",
          data: expect.objectContaining({ feeLocks: [requoted], termsScheduleId: "cts_standard" }),
        }),
      ]);
    });

    it("allows a terms session to refresh every preserved tranche during a price edit", () => {
      const listing = createdListing();
      const changedTerms = feeLock({
        terms: { ...feeLock().terms, marketplaceSalesFeePercentageBps: 900, termsScheduleId: "cts_current" },
      });

      expect(
        decideMarketplaceListing(listing, {
          type: "UpdateListingPrice",
          priceAmount: "25.00",
          feeLocks: [changedTerms],
        }),
      ).toEqual([
        expect.objectContaining({
          type: "marketplace.listing.price-updated",
          data: expect.objectContaining({ termsScheduleId: "cts_current", feeLocks: [changedTerms] }),
        }),
      ]);
    });

    it("suppresses an equivalent price and locked quote", () => {
      const listing = createdListing();

      expect(
        decideMarketplaceListing(listing, {
          type: "UpdateListingPrice",
          priceAmount: "10.0",
          feeLocks: [feeLock({ marketplaceSalesFeeUnitAmount: "1.0" })],
        }),
      ).toEqual([]);
    });

    it("locks only restocked units to the current rate", () => {
      const listing = createdListing();
      const restockLock = feeLock({
        unitCount: 2,
        terms: {
          ...feeLock().terms,
          marketplaceSalesFeePercentageBps: 900,
          termsScheduleId: "cts_current",
          termsResolvedAt: "2026-08-12T12:00:00.000Z",
        },
        marketplaceSalesFeeUnitAmount: "1.80",
        sellerNetUnitAmount: "8.20",
        feeQuoteFingerprint: "fee_restock",
      });

      const [event] = decideMarketplaceListing(listing, {
        type: "UpdateListingQuantityCap",
        quantityCap: 5,
        addedUnitsFeeLock: restockLock,
      });

      expect(event?.type).toBe("marketplace.listing.quantity-cap-updated");
      if (event?.type !== "marketplace.listing.quantity-cap-updated") throw new Error("Expected quantity update.");
      expect(event.data.feeLocks).toEqual([feeLock(), restockLock]);
    });

    it("retires newest locked units on a decrease and requires fresh terms to add them again", () => {
      const initial = createdListing();
      const restockLock = feeLock({ unitCount: 2, feeQuoteFingerprint: "fee_restock" });
      const increased = decideMarketplaceListing(initial, {
        type: "UpdateListingQuantityCap",
        quantityCap: 5,
        addedUnitsFeeLock: restockLock,
      }).reduce(evolveMarketplaceListing, initial);
      const reduced = decideMarketplaceListing(increased, {
        type: "UpdateListingQuantityCap",
        quantityCap: 2,
        addedUnitsFeeLock: null,
      }).reduce(evolveMarketplaceListing, increased);

      expect(reduced.feeLocks).toEqual([feeLock({ unitCount: 2 })]);
      expect(() =>
        decideMarketplaceListing(reduced, {
          type: "UpdateListingQuantityCap",
          quantityCap: 3,
          addedUnitsFeeLock: null,
        }),
      ).toThrow("Quantity increases require current fee terms");
    });

    it("allows purchase-limit changes without changing fee locks", () => {
      const listing = createdListing();
      const [event] = decideMarketplaceListing(listing, {
        type: "UpdateListingQuantityCap",
        quantityCap: 3,
        purchaseLimits: { maxUnitsPerOrder: 1 },
        addedUnitsFeeLock: null,
      });

      expect(event?.type).toBe("marketplace.listing.quantity-cap-updated");
      if (event?.type !== "marketplace.listing.quantity-cap-updated") throw new Error("Expected quantity update.");
      expect(event.data.feeLocks).toEqual(listing.feeLocks);
    });

    it("preserves fee locks across photos, publish, pause, automated unlisting, and resume", () => {
      const draft = createdListing();
      const withPhoto = decideMarketplaceListing(draft, {
        type: "AddListingPhotos",
        photos: [listingPhoto],
      }).reduce(evolveMarketplaceListing, draft);
      const active = decideMarketplaceListing(withPhoto, publishListingCommand).reduce(
        evolveMarketplaceListing,
        withPhoto,
      );
      const paused = decideMarketplaceListing(active, { type: "PauseListing" }).reduce(
        evolveMarketplaceListing,
        active,
      );
      const resumed = decideMarketplaceListing(paused, publishListingCommand).reduce(evolveMarketplaceListing, paused);
      const autoUnlisted = decideMarketplaceListing(resumed, {
        type: "AutoUnlistListing",
        reportId: "rpt_1",
        reportCount: 3,
        threshold: 3,
        autoUnlistedAt: "2026-07-12T13:00:00.000Z",
      }).reduce(evolveMarketplaceListing, resumed);

      for (const state of [withPhoto, active, paused, resumed, autoUnlisted]) {
        expect(state.feeLocks).toEqual(draft.feeLocks);
      }
    });

    it("makes withdrawal terminal so relisting requires a new listing identity", () => {
      const draft = createdListing();
      const withdrawn = decideMarketplaceListing(draft, { type: "WithdrawListing" }).reduce(
        evolveMarketplaceListing,
        draft,
      );

      expect(() => decideMarketplaceListing(withdrawn, publishListingCommand)).toThrow(
        "Withdrawn listings cannot be published",
      );
      expect(() =>
        decideMarketplaceListing(withdrawn, {
          type: "UpdateListingPrice",
          priceAmount: "11.00",
          feeLocks: withdrawn.feeLocks,
        }),
      ).toThrow("Withdrawn listings cannot be updated");
      expect(() => decideMarketplaceListing(withdrawn, createListingCommand)).toThrow(
        "Listing has already been created",
      );

      const replacementLock = feeLock({
        terms: { ...feeLock().terms, marketplaceSalesFeePercentageBps: 900, termsScheduleId: "cts_current" },
      });
      const replacement = decideMarketplaceListing(initialMarketplaceListingState, {
        ...createListingCommand,
        listingId: "lst_relisted" as never,
        feeLock: replacementLock,
      }).reduce(evolveMarketplaceListing, initialMarketplaceListingState);
      expect(replacement.listingId).toBe("lst_relisted");
      expect(replacement.feeLocks).toEqual([replacementLock]);
    });

    it("keeps item, product, and condition selection immutable for the listing identity", () => {
      const listing = createdListing({
        inventoryItemId: "itm_original",
        productId: "cat_test::dim_condition:near_mint" as never,
        selectedOptions: [{ dimensionId: "dim_condition", optionId: "near_mint" }],
      });
      const repriced = decideMarketplaceListing(listing, {
        type: "UpdateListingPrice",
        priceAmount: "12.00",
        feeLocks: [
          feeLock({
            marketplaceSalesFeeUnitAmount: "1.20",
            sellerNetUnitAmount: "10.80",
            feeQuoteFingerprint: "fee_repriced",
          }),
        ],
      }).reduce(evolveMarketplaceListing, listing);

      expect(repriced).toMatchObject({
        inventoryItemId: "itm_original",
        productId: "cat_test::dim_condition:near_mint",
        selectedOptions: [{ dimensionId: "dim_condition", optionId: "near_mint" }],
      });
    });
  });

  describe("UpdateListingPurchaseLimits", () => {
    it("returns no events when purchase limits are unchanged", () => {
      const listing = createdListing({
        purchaseLimits: { maxUnitsPerOrder: 1 },
      });

      const events = decideMarketplaceListing(listing, {
        type: "UpdateListingPurchaseLimits",
        purchaseLimits: { maxUnitsPerOrder: 1 },
      });

      expect(events).toEqual([]);
    });

    it("returns no events when purchase limits are unset both before and after", () => {
      const listing = createdListing();

      const events = decideMarketplaceListing(listing, {
        type: "UpdateListingPurchaseLimits",
        purchaseLimits: null,
      });

      expect(events).toEqual([]);
    });

    it("emits an event when purchase limits change", () => {
      const listing = createdListing({
        purchaseLimits: { maxUnitsPerOrder: 1 },
      });

      const events = decideMarketplaceListing(listing, {
        type: "UpdateListingPurchaseLimits",
        purchaseLimits: { maxUnitsPerOrder: 2 },
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("marketplace.listing.purchase-limits-updated");
    });
  });
});

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
        addedUnitsFeeLock: null,
      }),
    ).toThrow("Maximum units per order cannot exceed the listing quantity cap.");
  });
});

describe("marketplace listing photos", () => {
  it("stores normalized WebP listing photo asset sets on created listings", () => {
    const events = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      evidence: [listingPhoto],
    });
    const state = events.reduce(evolveMarketplaceListing, initialMarketplaceListingState);

    expect(events[0]?.data).toMatchObject({
      evidence: [
        {
          photoId: "lpho_1",
          assetSet: {
            kind: "listing-photo",
            source: { mediaType: "image/webp" },
          },
        },
      ],
    });
    expect(state.evidence[0]?.assetSet.variants[0]?.mediaType).toBe("image/webp");
  });

  it("publishes from generic readiness without interpreting product labels", () => {
    const draft = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      selectedOptions: [{ dimensionId: "localized-condition", optionId: "arbitrary-provider-value" }],
      productSummary: "Mint Pristine wording is display-only",
    }).reduce(evolveMarketplaceListing, initialMarketplaceListingState);

    expect(() => decideMarketplaceListing(draft, publishListingCommand)).not.toThrow();
    expect(() =>
      decideMarketplaceListing(draft, {
        ...publishListingCommand,
        readiness: { ...publishListingCommand.readiness, ready: false, unmetCodes: ["min-photo-count-unmet"] },
      }),
    ).toThrow("Listing evidence requirements are not met.");
    expect(() =>
      decideMarketplaceListing(draft, {
        ...publishListingCommand,
        readiness: { ...publishListingCommand.readiness, requirementHash: "sha256:stale" },
      }),
    ).toThrow("Listing evidence requirements changed.");
  });

  it("requires a resolved shipping measure before publishing", () => {
    const draft = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      listingId: "lst_missing_measure" as never,
      productMeasureSnapshot: null,
    }).reduce(evolveMarketplaceListing, initialMarketplaceListingState);

    expect(() => decideMarketplaceListing(draft, publishListingCommand)).toThrow(
      "Listings require a resolved shipping measure before publication.",
    );
  });
});

describe("marketplace listing evidence lifecycle", () => {
  function draftWithPhotos(photos: Array<Record<string, unknown>>) {
    return decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      evidence: photos as never,
    }).reduce(evolveMarketplaceListing, initialMarketplaceListingState);
  }

  const secondPhoto = {
    ...listingPhoto,
    photoId: "lpho_2",
    assetSet: { ...listingPhoto.assetSet, sourceHash: "hash_2" },
  };

  it("migrates legacy untyped photos into active, unclassified evidence with a derived revision", () => {
    const state = draftWithPhotos([listingPhoto]);
    expect(state.evidence[0]).toMatchObject({
      photoId: "lpho_1",
      status: "active",
      slotId: null,
      viewKind: null,
      assetRevision: "rev-hash_1",
    });
  });

  it("classifies an active evidence entry into a configured slot/view kind", () => {
    const state = draftWithPhotos([listingPhoto]);
    const next = decideMarketplaceListing(state, {
      type: "ClassifyListingPhoto",
      photoId: "lpho_1",
      slotId: "front",
      viewKind: "front",
      altText: "Front of the card",
    }).reduce(evolveMarketplaceListing, state);
    expect(next.evidence[0]).toMatchObject({ slotId: "front", viewKind: "front", altText: "Front of the card" });
  });

  it("replaces an active entry, retaining the prior entry as replaced", () => {
    const state = draftWithPhotos([listingPhoto]);
    const events = decideMarketplaceListing(state, {
      type: "ReplaceListingPhoto",
      replacedPhotoId: "lpho_1",
      photo: secondPhoto as never,
    });
    const next = events.reduce(evolveMarketplaceListing, state);
    expect(next.evidence.find((photo) => photo.photoId === "lpho_1")?.status).toBe("replaced");
    const replacement = next.evidence.find((photo) => photo.photoId === "lpho_2");
    expect(replacement?.status).toBe("active");
    expect(replacement?.replacesPhotoId).toBe("lpho_1");
  });

  it("removes an active entry, keeping it resolvable as removed", () => {
    const state = draftWithPhotos([listingPhoto]);
    const next = decideMarketplaceListing(state, { type: "RemoveListingPhoto", photoId: "lpho_1" }).reduce(
      evolveMarketplaceListing,
      state,
    );
    expect(next.evidence[0]?.status).toBe("removed");
  });

  it("reorders active evidence and rejects an incomplete id set", () => {
    const state = draftWithPhotos([listingPhoto, secondPhoto]);
    const next = decideMarketplaceListing(state, {
      type: "ReorderListingPhotos",
      orderedPhotoIds: ["lpho_2", "lpho_1"],
    }).reduce(evolveMarketplaceListing, state);
    expect(next.evidence.find((photo) => photo.photoId === "lpho_2")?.sortOrder).toBe(0);
    expect(next.evidence.find((photo) => photo.photoId === "lpho_1")?.sortOrder).toBe(1);

    expect(() =>
      decideMarketplaceListing(state, { type: "ReorderListingPhotos", orderedPhotoIds: ["lpho_1"] }),
    ).toThrow("Reorder must list exactly the current active evidence ids.");
  });

  it("allows seller evidence remediation while the listing is active", () => {
    const draft = decideMarketplaceListing(initialMarketplaceListingState, {
      ...createListingCommand,
      evidence: [listingPhoto] as never,
    }).reduce(evolveMarketplaceListing, initialMarketplaceListingState);
    const active = decideMarketplaceListing(draft, publishListingCommand).reduce(evolveMarketplaceListing, draft);
    const classified = decideMarketplaceListing(active, {
      type: "ClassifyListingPhoto",
      photoId: "lpho_1",
      slotId: "front",
      viewKind: "front",
    }).reduce(evolveMarketplaceListing, active);
    expect(classified.evidence[0]).toMatchObject({ slotId: "front", viewKind: "front" });
    expect(decideMarketplaceListing(classified, { type: "RemoveListingPhoto", photoId: "lpho_1" })).toHaveLength(1);
  });

  it("replays the full lifecycle deterministically from events", () => {
    const state = draftWithPhotos([listingPhoto]);
    const events = [
      ...decideMarketplaceListing(state, {
        type: "ClassifyListingPhoto",
        photoId: "lpho_1",
        slotId: "front",
        viewKind: "front",
      }),
    ];
    const afterClassify = events.reduce(evolveMarketplaceListing, state);
    const replaceEvents = decideMarketplaceListing(afterClassify, {
      type: "ReplaceListingPhoto",
      replacedPhotoId: "lpho_1",
      photo: secondPhoto as never,
    });
    const afterReplace = replaceEvents.reduce(evolveMarketplaceListing, afterClassify);

    // Fold the same event sequence from scratch and expect identical state.
    const allEvents = [
      ...decideMarketplaceListing(initialMarketplaceListingState, {
        ...createListingCommand,
        evidence: [listingPhoto] as never,
      }),
    ];
    const rebuiltBase = allEvents.reduce(evolveMarketplaceListing, initialMarketplaceListingState);
    const rebuilt = [...events, ...replaceEvents].reduce(evolveMarketplaceListing, rebuiltBase);
    expect(rebuilt.evidence).toEqual(afterReplace.evidence);
    // The replacement inherits the classified slot when not overridden.
    expect(rebuilt.evidence.find((photo) => photo.photoId === "lpho_2")?.slotId).toBe("front");
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
