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
              lowest_price_currency_code: "EUR",
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
        cursorState: "fresh" as const,
        queryHash: "",
        resultSetKey: "",
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
  it("keeps corrected rows mode-free in REST and MCP search_catalog", async () => {
    const items = buildItems();
    const original = await items.search.searchItems();
    vi.mocked(items.search.searchItems).mockResolvedValue({
      ...original,
      retrievalMode: "corrected",
      lexicalCount: 0,
      nextCursor: null,
    });
    const handlers = createDiscoveryUcpHandlers(items);
    const result = await handlers.restHandlers.search_catalog({
      request: new Request("https://marketplace.example/ucp/v1/catalog/search", {
        method: "POST",
        body: JSON.stringify({ query: "chraizard" }),
      }),
      params: {},
    } as never);
    expect(result).toMatchObject({ products: [{ id: "cat_1" }], count: 1, total: 1, next_cursor: null });
    expect(JSON.stringify(result)).not.toMatch(/retrievalMode|lexicalCount|corrected/);
    const mcp = await handlers.mcpToolHandlers.search_catalog({
      request: new Request("https://marketplace.example/mcp", {
        method: "POST",
        body: JSON.stringify({ query: "chraizard" }),
      }),
      params: {},
    } as never);
    expect(mcp).toEqual(result);
  });
  it("returns interpreted final rows without interpretation metadata in REST and MCP search_catalog", async () => {
    const items = buildItems();
    const original = await items.search.searchItems();
    vi.mocked(items.search.searchItems).mockResolvedValue({
      ...original,
      nextCursor: null,
      interpretation: {
        remainingQuery: "charizard",
        applied: [{ param: "dimension.dim_seed_grade", optionId: "chc_seed_grade_gem_mint_10", label: "Gem Mint 10" }],
      },
    });
    const handlers = createDiscoveryUcpHandlers(items);
    const input = (url: string) =>
      ({
        request: new Request(url, { method: "POST", body: JSON.stringify({ query: "charizard psa 10" }) }),
        params: {},
      }) as never;
    const rest = await handlers.restHandlers.search_catalog(input("https://marketplace.example/ucp/v1/catalog/search"));
    expect(rest).toMatchObject({ products: [{ id: "cat_1" }], count: 1, next_cursor: null });
    expect(JSON.stringify(rest)).not.toMatch(/interpretation|remainingQuery|Gem Mint|retrievalMode/);
    expect(await handlers.mcpToolHandlers.search_catalog(input("https://marketplace.example/mcp"))).toEqual(rest);
  });
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
          price: { currency: "EUR", amount: "1234" },
          availability: {
            status: "available",
            quantity: 3,
          },
          extensions: {
            chase_sets: {
              catalog_item_id: "cat_1",
              blueprint_id: "blueprint_card",
              primary_image_url: "https://images.example/charizard.jpg",
              price_display: "€12.34",
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

  it("forwards opaque cursors and keeps the search envelope unchanged when a cursor restarts", async () => {
    const items = buildItems();
    const handlers = createDiscoveryUcpHandlers(items);
    const search = (body: Record<string, unknown>) =>
      handlers.restHandlers.search_catalog({
        request: new Request("https://marketplace.example/ucp/v1/catalog/search", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        params: {},
      } as never);
    const fresh = await search({ query: "charizard" });
    const restartedPage = await vi.mocked(items.search.searchItems).getMockImplementation()?.();
    if (!restartedPage) throw new Error("Expected the default search fixture.");
    vi.mocked(items.search.searchItems).mockResolvedValueOnce({
      ...restartedPage,
      nextCursor: "cursor_v2",
      cursorState: "restarted",
    });

    const restarted = await search({ query: "charizard", cursor: "legacy-cursor" });

    expect(items.search.searchItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "charizard", cursor: "legacy-cursor", includeTotal: true }),
    );
    expect(Object.keys(restarted).sort()).toEqual(Object.keys(fresh).sort());
    expect(restarted).toMatchObject({ ucp: { status: "ok" }, count: 1, total: 1, next_cursor: "cursor_v2" });
    expect(JSON.stringify(restarted)).not.toContain("restart");
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
