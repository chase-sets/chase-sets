import { withSyntheticListingPrincipal } from "@chase-sets/event-core/test-support";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createMarketplaceListingRuntime } from "./runtime";
import type { ListingTargetAuthority } from "./target-contracts";
import { createSyntheticListingAuthority } from "./authority-test-support";
import { createListingEvidenceRequirementSnapshot } from "../domain/evidence-requirement-snapshot";

const currentMeasure = {
  catalogItemId: "cat_test",
  productId: "cat_test::",
  selectedOptions: [],
  measureVersion: "synthetic-current-measure",
  unitLengthInches: 3.5,
  unitWidthInches: 2.5,
  unitHeightInches: 0.01,
  unitWeightOunces: 0.1,
  physicalFlags: ["raw-card"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "measured",
} as const;
const requirements = createListingEvidenceRequirementSnapshot(
  {
    policyId: "synthetic-evidence-policy",
    policyVersion: 1,
    policyHash: "synthetic-policy-hash",
    matchedRuleIds: [],
    explanationCodes: [],
    effectiveInterval: { from: null, until: null },
    requirements: { minimumPhotoCount: 0, requiredSlots: [], sellerTrustRequirements: [], buyerAcknowledgment: "none" },
  },
  "2026-09-27T12:00:00.000Z",
);

function fixture(
  capability = true,
  availableQuantity = 2,
  selectedOptions: readonly { dimensionId: string; optionId: string }[] = [],
) {
  const { eventStore } = createInMemoryEventStore();
  const resolveListingTerms = vi.fn(async () => ({
    accountType: "personal",
    basisAmount: "10.00",
    marketplaceSalesFeeUnitAmount: "0.50",
    sellerNetUnitAmount: "9.50",
    marketplaceSalesFeePercentageBps: 500,
    marketplaceSalesFeeFixedAmount: "0.00",
    marketplaceSalesFeeCapAmount: null,
    shippingAllowancePercentageBps: 500,
    scheduleId: "synthetic-terms",
    agreementId: null,
    resolvedAt: "2026-09-27T12:00:00.000Z",
  }));
  const participants = createSyntheticListingAuthority(eventStore);
  const authority: ListingTargetAuthority = {
    ...participants.authority,
    readCatalogProduct: async (operation) => ({
      value: {
        catalogItemId: "cat_test",
        productId: "cat_test::",
        selectedOptions,
        blueprintId: "bpt_synthetic",
        categoryIds: [],
        productMeasureSnapshot: null,
        productMeasureRevision: 0,
      },
      reservations: await participants.reserve("product-measures", operation),
    }),
    authorizeManage: async (_input, context, operation) => ({
      value: capability,
      reservations: await participants.reserve("manage-listing", operation, context),
    }),
    verifyNativeFeeQuote: vi.fn(async (_input, operation) => ({
      value: true,
      reservations: await participants.reserve("native-fee", operation),
    })),
    readInventory: vi.fn(async (_input, operation) => [
      {
        value: {
          accountId: "acc_seller",
          inventoryItemId: "inv_test",
          catalogItemId: "cat_test",
          productId: "cat_test::",
          availableQuantity,
        },
        reservations: await participants.reserve("stock-allocation", operation),
      },
    ]),
    readNativeReadiness: vi.fn(async (_input, operation) => [
      {
        value: {
          listingId: "lst_test",
          accountId: "acc_seller",
          productMeasureSnapshot: currentMeasure,
          productMeasureRevision: 1,
          evidenceRequirements: requirements,
          seller: { reviewCount: 0, badgeKeys: [] },
        },
        reservations: [
          ...(await participants.reserve("product-measures", operation)),
          ...(await participants.reserve("native-readiness", operation)),
        ],
      },
    ]),
  };
  const db = {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM marketplace_supply_items AS item")
        ? [
            {
              item_id: "inv_test",
              account_id: "acc_seller",
              catalog_catalog_item_id: "cat_test",
              product_id: "cat_test::",
              selected_options: selectedOptions.map(({ dimensionId, optionId }) => ({ optionId, dimensionId })),
              item_title: "Synthetic product",
              item_subtitle: null,
              item_language_code: null,
              product_summary: null,
              product_measure_snapshot: null,
              graded_card: null,
              storage_location_name: null,
              ship_from_code: null,
              ship_from_address: {
                name: "Seller",
                company: null,
                line1: "1 Test St",
                line2: null,
                city: "Austin",
                state: "TX",
                postalCode: "78701",
                country: "US",
                phone: null,
                email: null,
              },
              available_quantity: availableQuantity,
            },
          ]
        : [],
      rowCount: 0,
    })),
  };
  const services = createMarketplaceListingRuntime({
    eventStore,
    db,
    listingTargetAuthority: authority,
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
    commercialTermsResolver: { resolveListingTerms } as never,
  });
  const input = {
    publicationScope: "channel-only" as const,
    accountId: "acc_seller" as never,
    inventoryItemId: "inv_test",
    listingIdOverride: "lst_test" as never,
    priceAmount: "10.00",
    priceCurrencyCode: "CAD",
    quantityCap: 2,
  };
  const context = withSyntheticListingPrincipal({
    tenantId: "tnt_test" as never,
    audit: { forAccountId: "acc_seller" as never, performedByUserId: "usr_test" as never },
  });
  return { services, resolveListingTerms, eventStore, input, context, authority, db, participants };
}

async function nativeFixture() {
  const fixtureState = fixture(true, 3);
  await fixtureState.services.createListing(fixtureState.input, fixtureState.context);
  const enable = {
    accountId: "acc_seller",
    listingId: "lst_test",
    expectedListingVersion: 1,
    idempotencyKey: "synthetic-enable",
    nativeVisibility: "enabled" as const,
    feeQuoteFingerprint: "10.00|0.50|9.50|500|synthetic-terms|",
  };
  return { ...fixtureState, enable };
}

describe("current native enable authority", () => {
  it("creates from equivalent Catalog selection objects with different JSON key order", async () => {
    const f = fixture(true, 2, [{ dimensionId: "dim_synthetic", optionId: "opt_synthetic" }]);
    await f.services.createListing(f.input, f.context);
    expect((await f.services.loadListingState("lst_test")).selectedOptions).toEqual([
      { dimensionId: "dim_synthetic", optionId: "opt_synthetic" },
    ]);
  });

  it("keeps native-off quantity edits free of fee enrollment and replays the exact capacity request", async () => {
    const { services, context, authority } = await nativeFixture();
    const input = {
      accountId: "acc_seller",
      listingId: "lst_test",
      quantityCap: 3,
      expectedVersion: 1,
      idempotencyKey: "synthetic-capacity",
    };
    const result = await services.updateListingQuantityCap(input, context);
    expect(await services.updateListingQuantityCap(input, context)).toEqual(result);
    expect(authority.verifyNativeFeeQuote).not.toHaveBeenCalled();
    expect(await services.loadListingState("lst_test")).toMatchObject({
      quantityCap: 3,
      nativeVisibility: "disabled",
      feeLocks: [],
    });
  });
  it("rejects a native restock when current fee authority is revoked before commitment", async () => {
    const { services, context, enable, authority, participants } = await nativeFixture();
    await services.setNativeListingVisibility(enable, context);
    vi.spyOn(authority, "verifyNativeFeeQuote").mockImplementation(async (_input, operation) => {
      const reservations = await participants.reserve("native-fee", operation);
      await participants.change("native-fee", context, false);
      return { value: true, reservations };
    });
    await expect(
      services.updateListingQuantityCap(
        {
          accountId: "acc_seller",
          listingId: "lst_test",
          quantityCap: 3,
          feeQuoteFingerprint: enable.feeQuoteFingerprint,
          idempotencyKey: "synthetic-restock",
        },
        context,
      ),
    ).rejects.toThrow();
    expect(await services.loadListingState("lst_test")).toMatchObject({ quantityCap: 2, feeLocks: [{ unitCount: 2 }] });
  });
  it("publishes through current native authority when the creation-time measure is absent", async () => {
    const { services, context, enable, authority } = await nativeFixture();
    const input = {
      accountId: enable.accountId,
      listingId: enable.listingId,
      idempotencyKey: "synthetic-legacy-publish",
      feeQuoteFingerprint: enable.feeQuoteFingerprint,
    };
    const result = await services.publishListing(input, context);
    expect(result).toEqual({ listingId: "lst_test", version: 3 });
    expect(await services.publishListing(input, context)).toEqual(result);
    expect(authority.readNativeReadiness).toHaveBeenCalledTimes(1);
    expect(await services.loadListingState("lst_test")).toMatchObject({
      status: "active",
      nativeVisibility: "enabled",
      nativeFeeState: "enrolled",
      productMeasureSnapshot: currentMeasure,
    });
  });
  it("resolves an absent creation-time measure and commits enrollment, publication and retry result together", async () => {
    const { services, eventStore, context, enable, authority } = await nativeFixture();
    const append = vi.spyOn(eventStore, "appendToStreams");
    const result = await services.setNativeListingVisibility(enable, context);
    expect(result).toEqual({ listingId: "lst_test", version: 3 });
    expect(await services.setNativeListingVisibility(enable, context)).toEqual(result);
    const commits = append.mock.calls.filter(([appends]) =>
      appends.some((entry) =>
        entry.events.some((event) => event.eventType === "marketplace.listing-request.completed"),
      ),
    );
    expect(commits).toHaveLength(1);
    expect(authority.readNativeReadiness).toHaveBeenCalledTimes(1);
    expect(await services.loadListingState("lst_test")).toMatchObject({
      status: "active",
      nativeVisibility: "enabled",
      nativePublicationRevision: 3,
      productMeasureSnapshot: currentMeasure,
      nativeFeeState: "enrolled",
      feeLocks: [{ unitCount: 2 }],
    });
    expect(commits[0]![0].map((entry) => entry.streamId)).toEqual(
      expect.arrayContaining([
        "marketplace.seller-listing-availability-acc_seller",
        "marketplace.inventory-listing-capacity-inv_test",
        "marketplace.listing-lst_test",
      ]),
    );
  });

  it.each([
    "synthetic-inventory",
    "synthetic-catalog",
    "synthetic-evidence-policy",
    "synthetic-seller-trust",
    "marketplace.seller-listing-availability-acc_seller",
    "marketplace.inventory-listing-capacity-inv_test",
    "synthetic-terms",
  ])("rolls back the entire enable when %s changes before append", async (streamId) => {
    const { services, eventStore, context, enable, participants } = await nativeFixture();
    const append = eventStore.appendToStreams!;
    let changed = false;
    vi.spyOn(eventStore, "appendToStreams").mockImplementation(async (appends) => {
      if (
        !changed &&
        appends.some((entry) =>
          entry.events.some((event) => event.eventType === "marketplace.listing-request.completed"),
        )
      ) {
        changed = true;
        const purpose = (
          {
            "synthetic-inventory": "stock-allocation",
            "synthetic-catalog": "product-measures",
            "synthetic-evidence-policy": "native-readiness",
            "synthetic-seller-trust": "manage-listing",
            "synthetic-terms": "native-fee",
          } as const
        )[streamId as "synthetic-inventory"];
        if (purpose) await participants.change(purpose, context);
        else {
          const participant = appends.find((entry) => entry.streamId === streamId)!;
          await eventStore.appendToStream({
            streamId,
            expectedVersion: participant.expectedVersion,
            context,
            events: [{ eventType: "synthetic.authority-changed", payload: {} }],
          });
        }
      }
      return append(appends);
    });
    await expect(services.setNativeListingVisibility(enable, context)).rejects.toThrow();
    expect(await services.loadListingState("lst_test")).toMatchObject({
      nativeVisibility: "disabled",
      feeLocks: [],
      nativePublicationRevision: null,
      productMeasureSnapshot: null,
    });
    expect(
      (await eventStore.readAll()).filter((event) => event.eventType === "marketplace.listing-request.completed"),
    ).toEqual([]);
  });

  it("rejects stale confirmation without creating a fee lock or persisting the refreshed measure", async () => {
    const { services, context, enable } = await nativeFixture();
    await expect(
      services.setNativeListingVisibility({ ...enable, feeQuoteFingerprint: "stale" }, context),
    ).rejects.toThrow("Fee quote is stale");
    expect(await services.loadListingState("lst_test")).toMatchObject({
      nativeVisibility: "disabled",
      feeLocks: [],
      productMeasureSnapshot: null,
    });
  });

  it("uses folded seller availability even when the seller projection is absent", async () => {
    const { services, context, enable, resolveListingTerms } = await nativeFixture();
    await services.disableSellerListingAvailability(
      { accountId: "acc_seller", reasonCategory: "travel", availableAgainOn: null },
      context,
    );
    await expect(services.setNativeListingVisibility(enable, context)).rejects.toThrow("availability is disabled");
    expect(resolveListingTerms).not.toHaveBeenCalled();
  });

  it("fails closed without current readiness and Inventory adapters", async () => {
    const { services, context, enable, authority } = await nativeFixture();
    Object.defineProperty(authority, "readNativeReadiness", { value: undefined });
    await expect(services.setNativeListingVisibility(enable, context)).rejects.toThrow(
      "readiness authority is unavailable",
    );
    const inventoryFixture = await nativeFixture();
    Object.defineProperty(inventoryFixture.authority, "readInventory", { value: undefined });
    await expect(
      inventoryFixture.services.setNativeListingVisibility(inventoryFixture.enable, inventoryFixture.context),
    ).rejects.toThrow("Inventory authority is unavailable");
    expect(await inventoryFixture.services.loadListingState("lst_test")).toMatchObject({
      nativeVisibility: "disabled",
      feeLocks: [],
    });
  });

  it("fences every other Listing used in the Inventory capacity calculation", async () => {
    const { services, context, enable, eventStore, input } = await nativeFixture();
    await services.createListing({ ...input, listingIdOverride: "lst_other" as never, quantityCap: 1 }, context);
    const append = eventStore.appendToStreams!;
    let raced = false;
    vi.spyOn(eventStore, "appendToStreams").mockImplementation(async (appends) => {
      if (
        raced ||
        !appends.some((entry) =>
          entry.events.some((event) => event.eventType === "marketplace.listing-request.completed"),
        )
      )
        return append(appends);
      raced = true;
      expect(appends).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ streamId: "marketplace.listing-lst_other", expectedVersion: 1, events: [] }),
        ]),
      );
      await services.withdrawListing({ accountId: input.accountId, listingId: "lst_other" }, context);
      return append(appends);
    });
    await expect(services.setNativeListingVisibility(enable, context)).rejects.toThrow();
    expect(await services.loadListingState("lst_test")).toMatchObject({
      nativeVisibility: "disabled",
      feeLocks: [],
      nativePublicationRevision: null,
    });
  });

  it("does not clear a pause or withdrawal during explicit native enable", async () => {
    const { services, context, enable, resolveListingTerms } = await nativeFixture();
    await services.setNativeListingVisibility(enable, context);
    await services.setNativeListingVisibility(
      { ...enable, idempotencyKey: "disable-before-pause", nativeVisibility: "disabled", expectedListingVersion: 3 },
      context,
    );
    await services.pauseListing(
      { accountId: enable.accountId, listingId: enable.listingId, reason: "seller" },
      context,
    );
    resolveListingTerms.mockClear();
    await expect(
      services.setNativeListingVisibility(
        { ...enable, expectedListingVersion: 5, idempotencyKey: "paused-enable" },
        context,
      ),
    ).rejects.toThrow("pause or withdrawal");
    await services.withdrawListing({ accountId: enable.accountId, listingId: enable.listingId }, context);
    await expect(
      services.setNativeListingVisibility(
        { ...enable, expectedListingVersion: 6, idempotencyKey: "withdrawn-enable" },
        context,
      ),
    ).rejects.toThrow("pause or withdrawal");
    expect(resolveListingTerms).not.toHaveBeenCalled();
    expect(await services.loadListingState("lst_test")).toMatchObject({
      nativeVisibility: "disabled",
      feeLocks: [{ unitCount: 2 }],
      status: "withdrawn",
    });
  });

  it("rejects current Inventory identity drift and shortages rather than using the supply projection", async () => {
    const { services, context, enable, authority, participants } = await nativeFixture();
    vi.mocked(authority.readInventory!).mockImplementation(async (_input, operation) => [
      {
        value: {
          accountId: "acc_seller",
          inventoryItemId: "inv_test",
          catalogItemId: "cat_test",
          productId: "different-product",
          availableQuantity: 100,
        },
        reservations: await participants.reserve("stock-allocation", operation),
      },
    ]);
    await expect(services.setNativeListingVisibility(enable, context)).rejects.toThrow("product identity");
    vi.mocked(authority.readInventory!).mockImplementation(async (_input, operation) => [
      {
        value: {
          accountId: "acc_seller",
          inventoryItemId: "inv_test",
          catalogItemId: "cat_test",
          productId: "cat_test::",
          availableQuantity: 1,
        },
        reservations: await participants.reserve("stock-allocation", operation),
      },
    ]);
    await expect(
      services.setNativeListingVisibility({ ...enable, idempotencyKey: "short-stock" }, context),
    ).rejects.toThrow("sellable inventory");
    expect(await services.loadListingState("lst_test")).toMatchObject({ nativeVisibility: "disabled", feeLocks: [] });
  });

  it("preserves original formulas on reenable and confirms only uncovered restock units", async () => {
    const { services, context, enable, resolveListingTerms } = await nativeFixture();
    await services.setNativeListingVisibility(enable, context);
    const original = (await services.loadListingState("lst_test")).feeLocks;
    await services.setNativeListingVisibility(
      { ...enable, idempotencyKey: "synthetic-disable", nativeVisibility: "disabled", expectedListingVersion: 3 },
      context,
    );
    await services.updateListingQuantityCap(
      { accountId: "acc_seller", listingId: "lst_test", quantityCap: 3 },
      context,
    );
    resolveListingTerms.mockClear();
    await expect(
      services.setNativeListingVisibility(
        {
          ...enable,
          expectedListingVersion: 5,
          idempotencyKey: "synthetic-restock-enable",
          feeQuoteFingerprint: undefined,
        },
        context,
      ),
    ).rejects.toThrow("Fee quote is stale");
    await services.setNativeListingVisibility(
      { ...enable, expectedListingVersion: 5, idempotencyKey: "synthetic-restock-enable-confirmed" },
      context,
    );
    expect((await services.loadListingState("lst_test")).feeLocks).toEqual([
      ...original,
      expect.objectContaining({ unitCount: 1 }),
    ]);
    await services.setNativeListingVisibility(
      { ...enable, idempotencyKey: "synthetic-disable-again", nativeVisibility: "disabled", expectedListingVersion: 7 },
      context,
    );
    resolveListingTerms.mockClear();
    await services.setNativeListingVisibility(
      { ...enable, idempotencyKey: "synthetic-reenable", expectedListingVersion: 8, feeQuoteFingerprint: undefined },
      context,
    );
    expect(resolveListingTerms).not.toHaveBeenCalled();
  });
});

describe("channel-only creation runtime", () => {
  it("rejects stale projected availability using current Inventory and creates no Listing", async () => {
    const { services, authority, participants, eventStore, input, context } = fixture();
    vi.spyOn(authority, "readInventory").mockImplementation(async (_input, operation) => [
      {
        value: {
          accountId: input.accountId,
          inventoryItemId: input.inventoryItemId,
          catalogItemId: "cat_test",
          productId: "cat_test::",
          availableQuantity: 1,
        },
        reservations: await participants.reserve("stock-allocation", operation),
      },
    ]);
    await expect(services.createListing(input, context)).rejects.toThrow("current owned Inventory availability");
    expect(await eventStore.readStream({ streamId: "marketplace.listing-lst_test" })).toEqual([]);
  });
  it("rejects creation-time native enrollment when the fee source wins the terminal fence", async () => {
    const { services, authority, participants, eventStore, input, context } = fixture();
    vi.spyOn(authority, "verifyNativeFeeQuote").mockImplementation(async (_input, operation) => {
      const reservations = await participants.reserve("native-fee", operation);
      await participants.change("native-fee", context, false);
      return { value: true, reservations };
    });
    await expect(services.createListing({ ...input, publicationScope: "native" }, context)).rejects.toThrow();
    expect(await eventStore.readStream({ streamId: "marketplace.listing-lst_test" })).toEqual([]);
    expect(
      (await eventStore.readAll()).filter(
        (event) => event.eventType === "marketplace.listing-authority-operation.committed",
      ),
    ).toEqual([]);
  });
  it("returns typed absent native fees without native terms, evidence or shipping measure readiness", async () => {
    const { services, resolveListingTerms, eventStore, input, context } = fixture();
    expect(await services.createListing(input, context)).toEqual({
      listingId: "lst_test",
      version: 1,
      nativeFeeState: "not-enrolled",
      feeQuoteFingerprint: null,
    });
    expect(resolveListingTerms).not.toHaveBeenCalled();
    expect(await services.listSellerListingFeeHistory({ accountId: input.accountId, listingId: "lst_test" })).toEqual(
      [],
    );
    expect(await services.loadListingState("lst_test")).toMatchObject({
      status: "draft",
      nativeVisibility: "disabled",
      nativePublicationRevision: null,
      nativeFeeState: "not-enrolled",
      feeLocks: [],
      evidenceRequirements: null,
      productMeasureSnapshot: null,
      priceCurrencyCode: "CAD",
    });
    await services.createListing(input, context);
    expect((await eventStore.readStream({ streamId: "marketplace.listing-lst_test" })).length).toBe(1);
    await expect(services.createListing({ ...input, priceCurrencyCode: "USD" }, context)).rejects.toThrow(
      "request changed",
    );
  });
  it("rejects missing capability with an aborted operation and no Listing events", async () => {
    const { services, eventStore, input, context } = fixture(false);
    await expect(services.createListing(input, context)).rejects.toThrow("capability");
    expect((await eventStore.readAll()).map((event) => event.eventType)).toEqual([
      "marketplace.listing-authority-operation.opened",
      "marketplace.listing-authority-operation.aborted",
    ]);
    expect(await eventStore.readStream({ streamId: "marketplace.listing-lst_test" })).toHaveLength(0);
  });
  it("includes first native enrollment and immutable tranche formulas in fee history", async () => {
    const { services, eventStore, input, context } = fixture();
    await services.createListing(input, context);
    const lock = {
      unitCount: 2,
      terms: {
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: null,
        shippingAllowancePercentageBps: 500,
        termsScheduleId: "terms_synthetic",
        termsAgreementId: null,
        termsResolvedAt: "2026-09-27T12:00:00.000Z",
      },
      marketplaceSalesFeeUnitAmount: "0.50",
      sellerNetUnitAmount: "9.50",
      feeQuoteFingerprint: "quote_synthetic",
    };
    await eventStore.appendToStream({
      streamId: "marketplace.listing-lst_test",
      expectedVersion: 1,
      context,
      events: [
        {
          eventType: "marketplace.listing.native-visibility-changed",
          payload: {
            nativeVisibility: "enabled",
            nativeFeeState: "enrolled",
            feeLocks: [lock],
            evidenceRequirements: null,
          },
        },
        { eventType: "marketplace.listing.published", payload: {} },
      ],
    });
    expect(await services.listSellerListingFeeHistory({ accountId: input.accountId, listingId: "lst_test" })).toEqual([
      expect.objectContaining({
        event_type: "marketplace.listing.native-visibility-changed",
        stream_version: 2,
        marketplace_sales_fee_unit_amount: "0.50",
        seller_net_unit_amount: "9.50",
        terms_schedule_id: "terms_synthetic",
        fee_quote_fingerprint: "quote_synthetic",
        fee_locks: [lock],
      }),
    ]);
  });
  it("binds creation retries to purchase limits, evidence, scope and actor", async () => {
    const { services, eventStore, input, context } = fixture();
    await services.createListing(input, context);
    for (const changed of [
      { ...input, purchaseLimits: { maxUnitsPerOrder: 1 } },
      {
        ...input,
        listingPhotoUploads: [{ body: new Uint8Array([1]), contentType: "image/png", originalFilename: "changed.png" }],
      },
    ]) {
      await expect(services.createListing(changed, context)).rejects.toThrow("request changed");
    }
    await expect(services.createListing({ ...input, publicationScope: "native" }, context)).rejects.toThrow();
    await expect(
      services.createListing(input, {
        ...context,
        audit: { ...context.audit, performedByUserId: "usr_other" as never },
      }),
    ).rejects.toThrow("request changed");
    expect(await eventStore.readStream({ streamId: "marketplace.listing-lst_test" })).toHaveLength(1);
  });

  it("returns the original creation result after later owner mutations", async () => {
    const { services, input, context } = fixture();
    const original = await services.createListing(input, context);
    await services.updateListingPrice(
      { accountId: input.accountId, listingId: "lst_test", priceAmount: "12.00", priceCurrencyCode: "USD" },
      context,
    );
    expect(await services.createListing(input, context)).toEqual(original);
  });

  it("commits one identical concurrent creation and rejects a competing changed request", async () => {
    const { services, eventStore, input, context } = fixture();
    const outcomes = await Promise.allSettled([
      services.createListing(input, context),
      services.createListing(input, context),
      services.createListing({ ...input, purchaseLimits: { maxUnitsPerOrder: 1 } }, context),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await eventStore.readStream({ streamId: "marketplace.listing-lst_test" })).toHaveLength(1);
  });
  it("rejects an excessive channel-only stock cap without enrolling fees", async () => {
    const { services, resolveListingTerms, eventStore, input, context } = fixture();
    await expect(services.createListing({ ...input, quantityCap: 3 }, context)).rejects.toThrow(
      "Inventory availability",
    );
    expect((await eventStore.readAll()).map((event) => event.eventType)).toEqual([
      "marketplace.listing-authority-operation.opened",
      "marketplace.listing-authority-operation.aborted",
    ]);
    expect(resolveListingTerms).not.toHaveBeenCalled();
  });
});
