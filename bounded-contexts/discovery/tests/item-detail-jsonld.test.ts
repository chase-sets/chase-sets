import { describe, expect, it } from "vitest";
import { buildItemDetailBreadcrumbListJsonLd, buildItemDetailProductJsonLd } from "../routes/item-detail";
import type { DiscoveryItemDetail } from "../support/client-support/contracts";

describe("item detail Product JSON-LD (AggregateOffer)", () => {
  it("builds Product JSON-LD with an AggregateOffer from real market summary data", () => {
    const jsonLd = buildItemDetailProductJsonLd({
      item: itemDetail(),
      canonicalUrl: "https://marketplace.chasesets.com/items/charizard-base-set-cat_charizard",
    });

    expect(jsonLd).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Charizard",
      description: "The iconic Base Set Charizard.",
      image: "https://assets.chasesets.com/catalog/charizard.webp",
      sku: "cat_charizard",
      category: "Trading Card Games",
      offers: {
        "@type": "AggregateOffer",
        url: "https://marketplace.chasesets.com/items/charizard-base-set-cat_charizard",
        priceCurrency: "USD",
        lowPrice: "38.00",
        offerCount: 3,
        availability: "https://schema.org/InStock",
      },
    });
  });

  it("reports OutOfStock availability when no visible quantity remains despite active listing rows", () => {
    const jsonLd = buildItemDetailProductJsonLd({
      item: itemDetail({
        market_summary: {
          lowest_price_amount: "38.00",
          active_listing_count: 1,
          total_visible_quantity: 0,
        },
      }),
      canonicalUrl: "https://marketplace.chasesets.com/items/charizard-base-set-cat_charizard",
    });

    expect(jsonLd?.offers.availability).toBe("https://schema.org/OutOfStock");
  });

  it("omits the category field when the item has no assigned categories", () => {
    const jsonLd = buildItemDetailProductJsonLd({
      item: itemDetail({ categories: [] }),
      canonicalUrl: "https://marketplace.chasesets.com/items/charizard-base-set-cat_charizard",
    });

    expect(jsonLd).not.toHaveProperty("category");
  });

  it("does not emit Product markup for a non-active item", () => {
    expect(
      buildItemDetailProductJsonLd({
        item: itemDetail({ status: "draft" }),
        canonicalUrl: "https://marketplace.chasesets.com/items/charizard-base-set-cat_charizard",
      }),
    ).toBeNull();
  });

  it("does not emit Product markup without real market supply", () => {
    expect(
      buildItemDetailProductJsonLd({
        item: itemDetail({ market_summary: null }),
        canonicalUrl: "https://marketplace.chasesets.com/items/charizard-base-set-cat_charizard",
      }),
    ).toBeNull();

    expect(
      buildItemDetailProductJsonLd({
        item: itemDetail({
          market_summary: { lowest_price_amount: null, active_listing_count: 0, total_visible_quantity: 0 },
        }),
        canonicalUrl: "https://marketplace.chasesets.com/items/charizard-base-set-cat_charizard",
      }),
    ).toBeNull();
  });

  it("does not emit Product markup without a real description or image", () => {
    expect(
      buildItemDetailProductJsonLd({
        item: itemDetail({ description: "" }),
        canonicalUrl: "https://marketplace.chasesets.com/items/charizard-base-set-cat_charizard",
      }),
    ).toBeNull();

    expect(
      buildItemDetailProductJsonLd({
        item: itemDetail({ image_urls: [] }),
        canonicalUrl: "https://marketplace.chasesets.com/items/charizard-base-set-cat_charizard",
      }),
    ).toBeNull();
  });

  it("does not emit Product markup for a missing or non-production canonical URL", () => {
    expect(buildItemDetailProductJsonLd({ item: itemDetail(), canonicalUrl: null })).toBeNull();
    expect(
      buildItemDetailProductJsonLd({
        item: itemDetail(),
        canonicalUrl: "https://marketplace.staging.chasesets.com/items/charizard-base-set-cat_charizard",
      }),
    ).toBeNull();
  });
});

describe("item detail BreadcrumbList JSON-LD", () => {
  it("mirrors Home -> Category -> Item for a categorized item", () => {
    const breadcrumbs = buildItemDetailBreadcrumbListJsonLd({
      item: itemDetail(),
      canonicalUrl: "https://marketplace.chasesets.com/items/charizard-base-set-cat_charizard",
    });

    expect(breadcrumbs).toMatchObject({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://marketplace.chasesets.com/" },
        {
          "@type": "ListItem",
          position: 2,
          name: "Trading Card Games",
          item: "https://marketplace.chasesets.com/categories/trading-card-games",
        },
        {
          "@type": "ListItem",
          position: 3,
          name: "Charizard",
          item: "https://marketplace.chasesets.com/items/charizard-base-set-cat_charizard",
        },
      ],
    });
  });

  it("falls back to Home -> Item when the item has no assigned category", () => {
    const breadcrumbs = buildItemDetailBreadcrumbListJsonLd({
      item: itemDetail({ categories: [] }),
      canonicalUrl: "https://marketplace.chasesets.com/items/charizard-base-set-cat_charizard",
    });

    expect(breadcrumbs?.itemListElement).toHaveLength(2);
    expect(breadcrumbs?.itemListElement.map((entry) => entry.name)).toEqual(["Home", "Charizard"]);
  });

  it("does not emit breadcrumb markup for a missing or non-production canonical URL", () => {
    expect(buildItemDetailBreadcrumbListJsonLd({ item: itemDetail(), canonicalUrl: null })).toBeNull();
    expect(
      buildItemDetailBreadcrumbListJsonLd({
        item: itemDetail(),
        canonicalUrl: "https://marketplace.staging.chasesets.com/items/charizard-base-set-cat_charizard",
      }),
    ).toBeNull();
  });
});

function itemDetail(overrides: Partial<DiscoveryItemDetail> = {}): DiscoveryItemDetail {
  return {
    catalog_item_id: "cat_charizard",
    slug: "charizard-base-set-cat_charizard",
    language_code: "en",
    title_i18n: {},
    title: "Charizard",
    subtitle_i18n: {},
    subtitle: "Base Set 4/102 Holo Rare",
    description_i18n: {},
    description: "The iconic Base Set Charizard.",
    blueprint_id: "bp_pokemon_card",
    blueprint: { blueprintId: "bp_pokemon_card", name: "Pokemon Card" },
    status: "active",
    field_values: [],
    categories: [{ categoryId: "cat_tcg", slug: "trading-card-games", name: "Trading Card Games" }],
    tags: [],
    image_urls: ["https://assets.chasesets.com/catalog/charizard.webp"],
    product_asset_sets: [],
    image_fallback: null,
    product_schema: null,
    market_summary: {
      lowest_price_amount: "38.00",
      active_listing_count: 3,
      total_visible_quantity: 5,
    },
    market_listings: [],
    offer_demand_matches: [],
    contents: [],
    included_in: [],
    updated_at: "2026-04-28T00:00:00.000Z",
    ...overrides,
  };
}
