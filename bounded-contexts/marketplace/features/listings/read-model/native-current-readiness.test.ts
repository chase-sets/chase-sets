import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { NativeListingEligibilityV1 } from "@chase-sets/event-core/public-event-payloads";
import { createMarketplaceListingCurrentReadiness } from "./native-current-readiness";

const at = "2026-09-27T12:00:00.000Z";
const later = "2026-09-27T12:01:00.000Z";
const listing: NativeListingEligibilityV1 = {
  schemaVersion: 1,
  listingId: "listing-synthetic",
  accountId: "account-synthetic",
  priceAmount: "10.00",
  priceCurrencyCode: "USD",
  targetPriceRevision: 1,
  listingRevision: 2,
  visibilityRevision: 1,
  nativePublicationRevision: 2,
  eligible: false,
  blockingReason: null,
  sourceEventId: "event-synthetic",
  sourceGlobalPosition: "2",
  projectionGeneration: "1",
  generatedAt: at,
};
function fixture(selectedOptions: { dimensionId: string; optionId: string }[] = []) {
  const { eventStore } = createInMemoryEventStore();
  const rows = [
    {
      listing_id: listing.listingId,
      listing_revision: 2,
      catalog_catalog_item_id: "catalog-synthetic",
      product_id: "catalog-synthetic::",
      selected_options: selectedOptions.map(({ dimensionId, optionId }) => ({ optionId, dimensionId })),
      graded_card: null,
      evidence: [],
    },
  ];
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("FROM marketplace_listing_pages")
      ? rows
      : sql.includes("COUNT(*)")
        ? [{ review_count: "0" }]
        : [],
  }));
  const product = {
    catalogItemId: "catalog-synthetic",
    productId: "catalog-synthetic::",
    selectedOptions,
    blueprintId: "blueprint-synthetic",
    categoryIds: [],
    productMeasureRevision: 1,
    productMeasureSnapshot: {
      catalogItemId: "catalog-synthetic",
      productId: "catalog-synthetic::",
      selectedOptions: selectedOptions.map(({ dimensionId, optionId }) => ({ optionId, dimensionId })),
      measureVersion: "synthetic",
      unitLengthInches: 3,
      unitWidthInches: 2,
      unitHeightInches: 1,
      unitWeightOunces: 1,
      physicalFlags: [],
      stackBehavior: "non-stackable" as const,
      source: "profile" as const,
      confidence: "measured" as const,
    },
  };
  const seller = vi.fn(async (_accountId: string) => ({
    generatedAt: at,
    validBefore: later,
    value: {
      accountId: listing.accountId,
      active: true,
      badgeKeys: [] as string[],
    },
  }));
  const products = vi.fn(async () => ({ generatedAt: at, validBefore: later, value: [product] }));
  const read = createMarketplaceListingCurrentReadiness(
    { eventStore, db: { query } as unknown as PgQueryable, now: () => new Date(at) },
    { seller, products },
  );
  return { read, rows, seller, products, product, query, eventStore };
}
describe("Marketplace-owned current native readiness", () => {
  it("compares Product selections structurally across JSON storage key order", async () => {
    const f = fixture([{ dimensionId: "dim_synthetic", optionId: "opt_synthetic" }]);
    expect((await f.read({ accountId: listing.accountId, listings: [listing] }))[0]?.ready).toBe(true);
  });

  it("applies Marketplace evidence policy and authoritative seller availability", async () => {
    const f = fixture();
    expect(
      (await f.read({ accountId: listing.accountId, listings: [{ ...listing, priceAmount: "1000.00" }] }))[0]?.ready,
    ).toBe(false);
    await f.eventStore.appendToStream({
      streamId: `marketplace.seller-listing-availability-${listing.accountId}`,
      expectedVersion: 0,
      context: {
        tenantId: "tnt_synthetic",
        audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
      },
      events: [
        {
          eventType: "marketplace.seller-listing-availability.disabled",
          payload: {
            accountId: listing.accountId,
            reasonCategory: null,
            availableAgainOn: null,
            availableAgainAt: null,
            disabledAt: at,
          },
        },
      ],
    });
    expect((await f.read({ accountId: listing.accountId, listings: [listing] }))[0]?.ready).toBe(false);
  });
  it("evaluates current owner inputs with one Listing query and one batch per foreign owner", async () => {
    const f = fixture();
    const result = await f.read({ accountId: listing.accountId, listings: [listing, listing] });
    expect(result).toEqual(
      Array.from({ length: 2 }, () => ({
        listingId: listing.listingId,
        listingRevision: 2,
        generatedAt: at,
        validBefore: later,
        ready: true,
      })),
    );
    expect(f.products).toHaveBeenCalledExactlyOnceWith([
      { catalogItemId: "catalog-synthetic", productId: "catalog-synthetic::", selectedOptions: [] },
    ]);
    expect(f.seller).toHaveBeenCalledExactlyOnceWith(listing.accountId);
    expect(f.query.mock.calls.filter(([sql]) => sql.includes("FROM marketplace_listing_pages"))).toHaveLength(1);
  });
  it("rejects stale source revisions and missing Catalog members", async () => {
    const f = fixture();
    f.rows[0]!.listing_revision = 1;
    await expect(f.read({ accountId: listing.accountId, listings: [listing] })).rejects.toThrow("source changed");
    f.rows[0]!.listing_revision = 2;
    f.products.mockResolvedValue({ generatedAt: at, validBefore: later, value: [] });
    await expect(f.read({ accountId: listing.accountId, listings: [listing] })).rejects.toThrow("Catalog membership");
  });
  it("does not promote suspended or foreign seller facts", async () => {
    const f = fixture();
    f.seller.mockResolvedValue({
      generatedAt: at,
      validBefore: later,
      value: { accountId: listing.accountId, active: false, badgeKeys: [] },
    });
    expect((await f.read({ accountId: listing.accountId, listings: [listing] }))[0]?.ready).toBe(false);
    f.seller.mockResolvedValue({
      generatedAt: at,
      validBefore: later,
      value: { accountId: "foreign-synthetic", active: true, badgeKeys: [] },
    });
    await expect(f.read({ accountId: listing.accountId, listings: [listing] })).rejects.toThrow("different owner");
  });
  it("rejects stale owner reads rather than reusing projected seller facts", async () => {
    const f = fixture();
    f.products.mockResolvedValue({ generatedAt: "2026-09-27T11:59:59.000Z", validBefore: later, value: [f.product] });
    await expect(f.read({ accountId: listing.accountId, listings: [listing] })).rejects.toThrow("stale");
  });
});
