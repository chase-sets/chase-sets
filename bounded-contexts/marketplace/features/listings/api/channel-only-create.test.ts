import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createMarketplaceListingRuntime } from "./runtime";
import type { ListingTargetAuthority } from "./target-contracts";

function fixture(capability = true) {
  const { eventStore } = createInMemoryEventStore();
  const resolveListingTerms = vi.fn(async () => {
    throw new Error("Native fees must not be requested.");
  });
  const guards = [{ streamId: "synthetic-capability", expectedVersion: 0 }];
  const authority: ListingTargetAuthority = {
    authorizeManage: async () => ({ value: capability, guards }),
    resolveConnection: async () => ({ value: null, guards: [] }),
    resolveAllocation: async () => ({ value: null, guards: [] }),
    verifyDecision: async () => ({ value: false, guards: [] }),
    authorizeResume: async () => ({ value: false, guards: [] }),
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
              selected_options: [],
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
              available_quantity: 2,
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
  const context = {
    tenantId: "tnt_test" as never,
    audit: { forAccountId: "acc_seller" as never, performedByUserId: "usr_test" as never },
  };
  return { services, resolveListingTerms, eventStore, input, context };
}

describe("channel-only creation runtime", () => {
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
  it("rejects missing capability without any owner events", async () => {
    const { services, eventStore, input, context } = fixture(false);
    await expect(services.createListing(input, context)).rejects.toThrow("capability");
    expect(await eventStore.readAll()).toHaveLength(0);
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
    expect(await eventStore.readAll()).toHaveLength(0);
    expect(resolveListingTerms).not.toHaveBeenCalled();
  });
});
