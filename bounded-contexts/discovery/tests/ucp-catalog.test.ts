import { describe, expect, it, vi } from "vitest";
import { createDiscoveryUcpHandlers } from "../support/ucp-support/catalog";
import type { DiscoveryItemsServices } from "../support/item-support/runtime";

function buildItems(overrides: Partial<DiscoveryItemsServices> = {}): DiscoveryItemsServices {
  return {
    market: {} as DiscoveryItemsServices["market"],
    search: {
      suggestItems: vi.fn(async () => []),
      searchItems: vi.fn(async () => ({
        items: [
          {
            catalog_item_id: "cat_1",
            slug: "charizard-cat_1",
            language_code: "en",
            title_i18n: {},
            title: "Charizard",
            subtitle_i18n: {},
            subtitle: "Base Set",
            display_badges: [],
            description_i18n: {},
            description: "A fiery card.",
            blueprint_id: "blueprint_card",
            blueprint_name: "Card",
            status: "active",
            category_names: ["Pokemon"],
            category_slugs: ["pokemon"],
            tags: ["fire"],
            image_urls: ["https://images.example/charizard.jpg"],
            product_asset_sets: [],
            image_fallback: null,
            market_summary: {
              lowest_price_amount: "12.34",
              active_listing_count: 2,
              total_visible_quantity: 3,
            },
            updated_at: "2026-05-16T00:00:00.000Z",
          },
        ],
        facets: [],
        category_counts: [],
        total: 1,
        nextCursor: null,
        retrievalMode: "lexical" as const,
        lexicalCount: 0,
      })),
      previewBulkAdd: vi.fn(async () => ({
        totalMatches: null,
        eligibleCount: 0,
        skippedCount: 0,
        overLimit: false,
        limit: 25,
        lines: [],
        skippedItems: [],
      })),
      rebuildSearchIndex: vi.fn(),
      projectors: [],
    },
    detail: {
      getItemDetail: vi.fn(async () => null),
      getSellerOverlay: vi.fn(async () => ({
        accountOfferMatches: [],
        sellerInventoryItems: [],
        hasListingStockLocation: false,
        selectedSellerListing: null,
      })),
      findSimilarItems: vi.fn(async () => ({ items: [], count: 0, mode: "none" as const })),
      projectors: [],
    },
    projectors: [],
    ...overrides,
  };
}

describe("Discovery UCP catalog handlers", () => {
  it("maps discovery search rows to UCP product envelopes", async () => {
    const items = buildItems();
    const handlers = createDiscoveryUcpHandlers(items);

    const result = await handlers.restHandlers.search_catalog({
      request: new Request("https://marketplace.example/ucp/v1/catalog/search", {
        method: "POST",
        body: JSON.stringify({ query: "charizard", filters: { category: "Pokemon" } }),
      }),
      params: {},
    } as never);

    expect(items.search.searchItems).toHaveBeenCalledWith(
      expect.objectContaining({
        search: "charizard",
        category: "Pokemon",
        includeTotal: true,
      }),
    );
    expect(result).toMatchObject({
      ucp: { status: "ok" },
      products: [
        {
          id: "cat_1",
          title: "Charizard",
          url: "https://marketplace.example/items/charizard-cat_1",
          image_urls: ["https://images.example/charizard.jpg"],
          price: { currency: "USD", amount: "1234" },
          availability: {
            status: "available",
            quantity: 3,
          },
          extensions: {
            chase_sets: {
              catalog_item_id: "cat_1",
              blueprint_id: "blueprint_card",
              primary_image_url: "https://images.example/charizard.jpg",
              price_display: "$12.34",
              availability_display: "3 available",
              marketplace: {
                active_listing_count: 2,
                total_visible_quantity: 3,
              },
              actions: {
                view_product: {
                  url: "https://marketplace.example/items/charizard-cat_1",
                },
                create_checkout: {
                  tool: "create_checkout",
                },
              },
            },
          },
        },
      ],
      result_presentation: {
        component: "marketplace-results",
      },
    });
  });

  it("returns a UCP not-found message when get_product cannot resolve an item", async () => {
    const handlers = createDiscoveryUcpHandlers(buildItems());

    const result = await handlers.restHandlers.get_product({
      request: new Request("https://marketplace.example/ucp/v1/catalog/product", {
        method: "POST",
        body: JSON.stringify({ id: "missing" }),
      }),
      params: {},
    } as never);

    expect(result).toMatchObject({
      ucp: { status: "error" },
      messages: [{ code: "product_not_found" }],
    });
  });
});
