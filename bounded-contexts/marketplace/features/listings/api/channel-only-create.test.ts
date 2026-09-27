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
  it("rejects an excessive channel-only stock cap without enrolling fees", async () => {
    const { services, resolveListingTerms, eventStore, input, context } = fixture();
    await expect(services.createListing({ ...input, quantityCap: 3 }, context)).rejects.toThrow(
      "Inventory availability",
    );
    expect(await eventStore.readAll()).toHaveLength(0);
    expect(resolveListingTerms).not.toHaveBeenCalled();
  });
});
