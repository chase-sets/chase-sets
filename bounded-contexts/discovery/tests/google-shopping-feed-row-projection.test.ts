import { afterEach, describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  drainDueGoogleShoppingIncrementalSyncRequests,
  isGoogleShoppingListingLandingPageCrawlable,
  refreshGoogleShoppingFeedRowForListing,
} from "../support/google-shopping-support/feed-row-projection";

describe("google shopping feed row projection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("materializes a changed listing row and queues a debounced incremental price sync", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_INDEXING", "true");
    const db = projectionDb(listingFacts({ price_amount: "51.25" }));

    const row = await refreshGoogleShoppingFeedRowForListing(db, "lst_1", {
      reason: "price",
      requestedAt: "2026-06-03T10:00:00.000Z",
      debounceMs: 5_000,
    });

    expect(row?.payload).toMatchObject({
      offerId: "cs-listing-lst_1",
      priceAmount: "51.25",
      availability: "in stock",
      link: "https://marketplace.chasesets.com/listings/charizard-lst_1",
    });
    expect(db.queries[1]?.sql).toContain("INSERT INTO discovery_google_shopping_feed_rows");
    expect(JSON.parse(String(db.queries[1]?.values[8]))).toMatchObject({ priceAmount: "51.25" });
    expect(db.queries[2]?.sql).toContain("discovery_google_shopping_incremental_sync_requests");
    expect(JSON.parse(String(db.queries[2]?.values[1]))).toEqual(["price"]);
    expect(db.queries[2]?.values[3]).toBe(5_000);
  });

  it("excludes rows from live Merchant eligibility when marketplace indexing is disabled", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_INDEXING", "false");
    const db = projectionDb(listingFacts());

    const row = await refreshGoogleShoppingFeedRowForListing(db, "lst_1", {
      reason: "eligibility",
      requestedAt: "2026-06-03T10:00:00.000Z",
      debounceMs: 0,
    });

    expect(row?.payload).toBeNull();
    expect(row?.eligibility).toEqual({
      status: "excluded",
      reasons: ["not-crawlable"],
    });
    expect(JSON.parse(String(db.queries[1]?.values[11]))).toEqual(["not-crawlable"]);
  });

  it("persists noindex rows without a Merchant payload or payload hash", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_INDEXING", "false");
    const db = projectionDb(listingFacts());

    await refreshGoogleShoppingFeedRowForListing(db, "lst_1", {
      reason: "eligibility",
      requestedAt: "2026-06-03T10:00:00.000Z",
      debounceMs: 0,
    });

    expect(JSON.parse(String(db.queries[1]?.values[8]))).toEqual({});
    expect(db.queries[1]?.values[9]).toBeNull();
    expect(db.queries[1]?.values[10]).toBe("excluded");
    expect(db.queries[1]?.values[17]).toBe("live");
  });

  it("marks withdrawn listings as tombstones while retaining explainable exclusion state", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_INDEXING", "true");
    const db = projectionDb(listingFacts({ status: "withdrawn" }));

    const row = await refreshGoogleShoppingFeedRowForListing(db, "lst_1", {
      reason: "visibility",
      requestedAt: "2026-06-03T10:00:00.000Z",
      debounceMs: 0,
    });

    expect(row?.payload).toBeNull();
    expect(row?.eligibility.reasons).toEqual(expect.arrayContaining(["listing-not-active", "not-crawlable"]));
    expect(db.queries[1]?.values[17]).toBe("withdrawn");
    expect(JSON.parse(String(db.queries[2]?.values[1]))).toEqual(["visibility"]);
  });

  it("uses encoded Marketplace canonical URLs in the persisted Merchant payload", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_INDEXING", "true");
    const db = projectionDb(listingFacts({ listing_slug: "charizard holo/lst 1" }));

    const row = await refreshGoogleShoppingFeedRowForListing(db, "lst_1", {
      reason: "canonical",
      requestedAt: "2026-06-03T10:00:00.000Z",
      debounceMs: 0,
    });

    expect(row?.payload?.link).toBe("https://marketplace.chasesets.com/listings/charizard%20holo%2Flst%201");
    expect(JSON.parse(String(db.queries[1]?.values[8]))).toMatchObject({
      link: "https://marketplace.chasesets.com/listings/charizard%20holo%2Flst%201",
    });
  });

  it("requires active listings, stable slugs, and indexing before treating landing pages as crawlable", () => {
    expect(
      isGoogleShoppingListingLandingPageCrawlable({
        listingStatus: "active",
        listingSlug: "charizard-lst_1",
        indexingEnabled: true,
      }),
    ).toBe(true);
    expect(
      isGoogleShoppingListingLandingPageCrawlable({
        listingStatus: "active",
        listingSlug: "charizard-lst_1",
        indexingEnabled: false,
      }),
    ).toBe(false);
    expect(
      isGoogleShoppingListingLandingPageCrawlable({
        listingStatus: "paused",
        listingSlug: "charizard-lst_1",
        indexingEnabled: true,
      }),
    ).toBe(false);
    expect(
      isGoogleShoppingListingLandingPageCrawlable({
        listingStatus: "active",
        listingSlug: "",
        indexingEnabled: true,
      }),
    ).toBe(false);
  });

  it("records image exclusion reasons and queues affected listing image sync", async () => {
    vi.stubEnv("CHASE_SETS_MARKETPLACE_INDEXING", "true");
    const db = projectionDb(
      listingFacts({
        product_asset_sets: [
          {
            variants: [
              {
                role: "catalog-detail",
                publicUrl: "https://assets.chasesets.com/catalog/tiny.webp",
                width: 64,
                height: 64,
              },
            ],
          },
        ],
      }),
    );

    const row = await refreshGoogleShoppingFeedRowForListing(db, "lst_1", {
      reason: "image",
      requestedAt: "2026-06-03T10:00:00.000Z",
      debounceMs: 0,
    });

    expect(row?.imageEligibility).toMatchObject({
      status: "excluded",
      reasons: ["image-too-small"],
    });
    expect(row?.eligibility.reasons).toContain("image-too-small");
    expect(JSON.parse(String(db.queries[2]?.values[1]))).toEqual(["image"]);
  });

  it("drains due incremental sync requests in stable order and ignores unknown reasons", async () => {
    const db = incrementalRequestDb();

    const requests = await drainDueGoogleShoppingIncrementalSyncRequests(db, {
      limit: 2,
      now: "2026-06-03T10:00:00.000Z",
    });

    expect(db.queries[0]?.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(db.queries[0]?.values).toEqual([2, "2026-06-03T10:00:00.000Z"]);
    expect(requests).toEqual([
      {
        listingId: "lst_1",
        reasons: ["price", "seller-availability"],
      },
      {
        listingId: "lst_2",
        reasons: ["catalog", "image"],
      },
    ]);
  });
});

function projectionDb(facts: Record<string, unknown>): PgQueryable & {
  queries: Array<{ sql: string; values: readonly unknown[] }>;
} {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  return {
    queries,
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("FROM discovery_market_listings AS listing")) {
        return { rows: [facts], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

function incrementalRequestDb(): PgQueryable & {
  queries: Array<{ sql: string; values: readonly unknown[] }>;
} {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  return {
    queries,
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      return {
        rows: [
          { listing_id: "lst_1", reasons: JSON.stringify(["price", "seller-availability", "unknown"]) },
          { listing_id: "lst_2", reasons: ["catalog", "image"] },
        ],
        rowCount: 2,
      };
    },
  };
}

function listingFacts(overrides: Record<string, unknown> = {}) {
  return {
    listing_id: "lst_1",
    listing_slug: "charizard-lst_1",
    account_id: "acc_1",
    catalog_catalog_item_id: "cit_1",
    product_id: "prd_1",
    item_title: "Charizard",
    item_subtitle: "Base Set",
    selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    product_summary: "A Base Set Charizard card.",
    ship_from_code: "US",
    price_amount: "42.00",
    shipping_allowance_percentage_bps: 500,
    quantity_cap: 1,
    status: "active",
    seller_listing_availability_status: "available",
    seller_account_status: "active",
    catalog_title: "Charizard",
    catalog_subtitle: "Base Set",
    catalog_description: "A Base Set Charizard card.",
    catalog_status: "active",
    image_urls: [],
    product_asset_sets: [
      {
        variants: [
          {
            role: "catalog-detail",
            publicUrl: "https://assets.chasesets.com/catalog/charizard.webp",
            width: 960,
            height: 1344,
          },
        ],
      },
    ],
    image_fallback: null,
    product_schema: {
      canonicalDimensionOrder: [{ dimensionId: "condition", dimensionName: "Condition" }],
    },
    ...overrides,
  };
}
