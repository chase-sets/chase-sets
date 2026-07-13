import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildPublicListingProductJsonLd,
  sellerUnbuyableMessage,
  serializePublicListingProductJsonLd,
} from "../routes/public-listing";
import type { DiscoveryPublicListing } from "../support/client-support/contracts";
import { getDiscoveryPublicListingBySlug } from "../support/market-support/queries";

describe("public listing Product JSON-LD", () => {
  it("builds Product and Offer JSON-LD from an eligible Google Shopping feed payload", () => {
    const jsonLd = buildPublicListingProductJsonLd({
      listing: publicListing(),
      canonicalUrl: "https://marketplace.chasesets.com/listings/charizard-lst_1",
    });

    expect(jsonLd).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Charizard Base Set Near Mint",
      image: "https://assets.chasesets.com/catalog/charizard.webp",
      sku: "cs-listing-lst_1",
      offers: {
        "@type": "Offer",
        url: "https://marketplace.chasesets.com/listings/charizard-lst_1",
        price: "42.00",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
        itemCondition: "https://schema.org/UsedCondition",
        seller: {
          "@type": "Organization",
          name: "Card Vault",
        },
      },
    });
    expect(serializePublicListingProductJsonLd(jsonLd!)).toContain('"@type":"Product"');
  });

  it("keeps schema.org availability and condition aligned with the Merchant payload", () => {
    const jsonLd = buildPublicListingProductJsonLd({
      listing: publicListing({
        google_shopping_structured_data_payload: {
          ...publicListing().google_shopping_structured_data_payload!,
          availability: "out of stock",
          condition: "new",
        },
      }),
      canonicalUrl: "https://marketplace.chasesets.com/listings/charizard-lst_1",
    });

    expect(jsonLd?.offers).toMatchObject({
      availability: "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition",
    });
  });

  it("does not emit offer markup for inactive public listings even with an eligible feed payload", () => {
    expect(
      buildPublicListingProductJsonLd({
        listing: publicListing({ status: "paused" }),
        canonicalUrl: "https://marketplace.chasesets.com/listings/charizard-lst_1",
      }),
    ).toBeNull();
  });

  it("does not emit offer markup for unavailable or non-production listing pages", () => {
    expect(
      buildPublicListingProductJsonLd({
        listing: publicListing({ seller_listing_availability_status: "unavailable" }),
        canonicalUrl: "https://marketplace.chasesets.com/listings/charizard-lst_1",
      }),
    ).toBeNull();

    expect(
      buildPublicListingProductJsonLd({
        listing: publicListing(),
        canonicalUrl: "https://marketplace.staging.chasesets.com/listings/charizard-lst_1",
      }),
    ).toBeNull();

    expect(
      buildPublicListingProductJsonLd({
        listing: publicListing({
          google_shopping_structured_data_payload: {
            ...publicListing().google_shopping_structured_data_payload!,
            link: "https://marketplace.chasesets.com/listings/other-listing",
          },
        }),
        canonicalUrl: "https://marketplace.chasesets.com/listings/charizard-lst_1",
      }),
    ).toBeNull();
  });

  it("loads only eligible live Google Shopping payloads for public listings", async () => {
    const db = queryDb({
      ...publicListing(),
      google_shopping_structured_data_payload: publicListing().google_shopping_structured_data_payload,
    });

    const listing = await getDiscoveryPublicListingBySlug(db, "charizard-lst_1");

    expect(db.queries[0]?.sql).toContain("LEFT JOIN discovery_google_shopping_feed_rows AS google_feed");
    expect(db.queries[0]?.sql).toContain("google_feed.eligibility_status = 'eligible'");
    expect(db.queries[0]?.sql).toContain("google_feed.tombstone_status = 'live'");
    expect(listing?.google_shopping_structured_data_payload).toMatchObject({
      offerId: "cs-listing-lst_1",
      priceAmount: "42.00",
    });
  });

  it("relaxes the direct listing lookup so away/at-capacity listings render instead of 'not found' (m127 #4883)", async () => {
    const db = queryDb({ ...publicListing() });

    await getDiscoveryPublicListingBySlug(db, "charizard-lst_1");

    const sql = db.queries[0]?.sql ?? "";
    expect(sql).not.toContain("seller_listing_availability_status = 'available'");
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("product_measure_snapshot IS NOT NULL");
    expect(sql).toContain("visible_quantity > 0");
  });
});

describe("public listing away/at-capacity buyer messaging (m127 #4883)", () => {
  it("returns null when the listing is fully purchasable", () => {
    expect(sellerUnbuyableMessage(publicListing())).toBeNull();
  });

  it("renders a timezone-correct back-on-date message when the seller is away with a known resume instant", () => {
    const message = sellerUnbuyableMessage(
      publicListing({
        seller_listing_availability_status: "unavailable",
        seller_available_again_at: "2026-07-20 05:00:00+00",
      }),
    );

    expect(message).toMatchObject({ title: "Seller is away" });
    expect(message?.description).toBe("This seller is away. Listings return July 20, 2026.");
  });

  it("falls back to the bare unavailable copy when the seller is away with no resume instant", () => {
    const message = sellerUnbuyableMessage(
      publicListing({
        seller_listing_availability_status: "unavailable",
        seller_available_again_at: null,
      }),
    );

    expect(message).toMatchObject({
      title: "Seller is away",
      description: "Account listings are temporarily unavailable.",
    });
  });

  it("renders at-capacity copy when the seller is not away but at capacity", () => {
    const message = sellerUnbuyableMessage(
      publicListing({
        seller_listing_availability_status: "available",
        seller_at_capacity: true,
      }),
    );

    expect(message).toMatchObject({ title: "Temporarily at capacity" });
  });

  it("prioritizes the away message over at-capacity when both apply", () => {
    const message = sellerUnbuyableMessage(
      publicListing({
        seller_listing_availability_status: "unavailable",
        seller_available_again_at: "2026-07-20 05:00:00+00",
        seller_at_capacity: true,
      }),
    );

    expect(message?.title).toBe("Seller is away");
  });
});

function publicListing(overrides: Partial<DiscoveryPublicListing> = {}): DiscoveryPublicListing {
  return {
    listing_id: "lst_1",
    listing_slug: "charizard-lst_1",
    product_slug: "charizard-prd_1",
    account_id: "acc_1",
    seller_slug: "card-vault-acc_1",
    seller_display_name: "Card Vault",
    seller_listing_availability_status: "available",
    seller_listing_availability_reason_category: null,
    seller_listing_available_again_on: null,
    seller_average_rating: "4.9",
    seller_review_count: 12,
    inventory_item_id: "inv_1",
    catalog_catalog_item_id: "cit_1",
    catalog_item_slug: "charizard-cit_1",
    product_id: "prd_1",
    item_title: "Charizard",
    item_subtitle: "Base Set",
    selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    product_summary: "Near Mint",
    storage_location_name: null,
    ship_from_code: "US",
    price_amount: "42.00",
    shipping_allowance_percentage_bps: 500,
    quantity_cap: 1,
    max_units_per_order: null,
    max_units_per_day: null,
    max_units_per_customer_account: null,
    status: "active",
    google_shopping_structured_data_payload: {
      offerId: "cs-listing-lst_1",
      title: "Charizard Base Set Near Mint",
      description: "A Base Set Charizard card.",
      link: "https://marketplace.chasesets.com/listings/charizard-lst_1",
      imageLink: "https://assets.chasesets.com/catalog/charizard.webp",
      priceAmount: "42.00",
      currencyCode: "USD",
      availability: "in stock",
      condition: "used",
      brand: "Pokemon",
      productType: "Trading Cards",
    },
    visible_quantity: 1,
    created_at: "2026-06-04T00:00:00.000Z",
    updated_at: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}

function queryDb(
  row: Record<string, unknown>,
): PgQueryable & { queries: Array<{ sql: string; values: readonly unknown[] }> } {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  return {
    queries,
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [row], rowCount: 1 };
    },
  };
}
