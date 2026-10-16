import { describe, expect, it, vi } from "vitest";
import { createDiscoveryItemMcpHandlers } from "./mcp";
import type { DiscoveryItemsServices } from "./runtime";

function searchRow(overrides: Record<string, unknown> = {}) {
  return {
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
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function detailRow(overrides: Record<string, unknown> = {}) {
  return {
    ...searchRow(),
    category_names: undefined,
    category_slugs: undefined,
    categories: [{ categoryId: "cat_pokemon", slug: "pokemon", name: "Pokemon" }],
    field_values: [],
    blueprint: null,
    product_schema: null,
    market_listings: [
      {
        listing_id: "lst_1",
        listing_slug: "charizard-near-mint-lst_1",
        product_slug: "charizard-near-mint",
        account_id: "acc_seller",
        inventory_item_id: "inv_1",
        catalog_catalog_item_id: "cat_1",
        product_id: "cat_1::condition:near-mint",
        item_title: "Charizard",
        item_subtitle: "Base Set",
        selected_options: [{ dimensionId: "condition", optionId: "near-mint" }],
        product_summary: "Condition: Near Mint",
        graded_card: null,
        storage_location_name: "A",
        ship_from_code: "AUS",
        price_amount: "12.34",
        price_currency_code: "EUR",
        listing_stream_version: 2,
        shipping_allowance_percentage_bps: 0,
        quantity_cap: 3,
        max_units_per_order: null,
        max_units_per_day: null,
        max_units_per_customer_account: null,
        status: "active",
        seller_slug: "seller",
        seller_display_name: "Seller",
        seller_average_rating: "4.9",
        seller_review_count: 12,
        seller_badges: [],
        seller_at_capacity: false,
        visible_quantity: 3,
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
      },
    ],
    offer_demand_matches: [],
    contents: [],
    included_in: [],
    ...overrides,
  };
}

function services(overrides: Partial<DiscoveryItemsServices> = {}): DiscoveryItemsServices {
  return {
    market: {} as DiscoveryItemsServices["market"],
    search: {
      suggestItems: vi.fn(async () => []),
      searchItems: vi.fn(async () => ({
        items: [searchRow()],
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
      previewBulkAdd: vi.fn(),
      rebuildSearchIndex: vi.fn(),
      projectors: [],
    },
    detail: {
      getItemDetail: vi.fn(async () => detailRow()),
      getSellerOverlay: vi.fn(),
      findSimilarItems: vi.fn(async () => ({ items: [], count: 0, mode: "none" as const })),
      projectors: [],
    },
    projectors: [],
    ...overrides,
  };
}

function toolInput(args: Record<string, unknown>) {
  return {
    actor: null,
    tool: null as never,
    arguments: args,
    request: new Request("https://marketplace.example/mcp"),
    protocol: null as never,
  };
}

describe("Discovery item MCP handlers", () => {
  it("returns corrected rows through search-market and feed without retrieval metadata", async () => {
    const fakeServices = services();
    const original = await fakeServices.search.searchItems();
    vi.mocked(fakeServices.search.searchItems).mockResolvedValue({
      ...original,
      retrievalMode: "corrected",
      lexicalCount: 0,
      nextCursor: null,
    });
    const handlers = createDiscoveryItemMcpHandlers(fakeServices);
    const result = await handlers.toolHandlers["discovery.search-market"]?.(toolInput({ query: "chraizard" }));
    expect(result).toMatchObject({ items: [{ catalog_item_id: "cat_1" }], count: 1, nextCursor: null });
    expect(result).not.toHaveProperty("retrievalMode");
    expect(result).not.toHaveProperty("lexicalCount");
    const feed = await handlers.toolHandlers["discovery.get-chatgpt-product-feed"]?.(toolInput({ query: "chraizard" }));
    expect(feed).toMatchObject({ products: [{ id: "cat_1" }], count: 1, nextCursor: null });
    expect(feed).not.toHaveProperty("retrievalMode");
    expect(feed).not.toHaveProperty("lexicalCount");
  });
  it("returns interpreted final rows through search-market and feed without interpretation metadata", async () => {
    const fakeServices = services();
    const original = await fakeServices.search.searchItems();
    vi.mocked(fakeServices.search.searchItems).mockResolvedValue({
      ...original,
      nextCursor: null,
      interpretation: {
        remainingQuery: "charizard",
        applied: [{ param: "dimension.dim_seed_grade", optionId: "chc_seed_grade_gem_mint_10", label: "Gem Mint 10" }],
      },
    });
    const handlers = createDiscoveryItemMcpHandlers(fakeServices);
    const result = await handlers.toolHandlers["discovery.search-market"]?.(toolInput({ query: "charizard psa 10" }));
    expect(result).toMatchObject({ items: [{ catalog_item_id: "cat_1" }], count: 1, nextCursor: null });
    const feed = await handlers.toolHandlers["discovery.get-chatgpt-product-feed"]?.(
      toolInput({ query: "charizard psa 10" }),
    );
    expect(feed).toMatchObject({ products: [{ id: "cat_1" }], count: 1, nextCursor: null });
    expect(JSON.stringify([result, feed])).not.toMatch(/interpretation|remainingQuery|Gem Mint|retrievalMode/);
  });
  it("searches only active public discovery rows for anonymous callers", async () => {
    const fakeServices = services();
    const handlers = createDiscoveryItemMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["discovery.search-market"]?.(
      toolInput({ query: "charizard", category: "pokemon", status: "draft", limit: 5 }),
    );

    expect(result).toMatchObject({ total: 1, count: 1 });
    expect(fakeServices.search.searchItems).toHaveBeenCalledWith(
      expect.objectContaining({
        search: "charizard",
        category: "pokemon",
        limit: 5,
        status: "active",
        includeTotal: true,
      }),
    );
  });

  it("forwards an opaque cursor and returns a restarted fresh page in the unchanged search envelope", async () => {
    const fakeServices = services();
    const fresh = await createDiscoveryItemMcpHandlers(fakeServices).toolHandlers["discovery.search-market"]?.(
      toolInput({ query: "charizard" }),
    );
    vi.mocked(fakeServices.search.searchItems).mockResolvedValueOnce({
      items: [searchRow()],
      facets: [],
      category_counts: [],
      total: 1,
      nextCursor: "cursor_v2",
      retrievalMode: "lexical",
      lexicalCount: 1,
      cursorState: "restarted",
      queryHash: "",
      resultSetKey: "",
    });

    const restarted = await createDiscoveryItemMcpHandlers(fakeServices).toolHandlers["discovery.search-market"]?.(
      toolInput({ query: "charizard", cursor: "legacy-cursor" }),
    );

    expect(fakeServices.search.searchItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "charizard", cursor: "legacy-cursor", includeTotal: true }),
    );
    expect(Object.keys(restarted as object).sort()).toEqual(Object.keys(fresh as object).sort());
    expect(restarted).toMatchObject({ total: 1, count: 1, nextCursor: "cursor_v2" });
  });

  it("reads active item detail and resource payloads without an actor", async () => {
    const fakeServices = services();
    const handlers = createDiscoveryItemMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["discovery.get-item-detail"]?.(toolInput({ itemSlug: "charizard-cat_1" })),
    ).resolves.toMatchObject({ catalog_item_id: "cat_1", status: "active" });
    await expect(
      handlers.resourceHandlers["chase-sets://discovery/items/{itemSlug}"]?.({
        actor: null,
        resource: null as never,
        uri: "chase-sets://discovery/items/charizard-cat_1",
        request: new Request("https://marketplace.example/mcp"),
        protocol: null as never,
      }),
    ).resolves.toMatchObject({ catalog_item_id: "cat_1", status: "active" });
  });

  it("fails closed for draft item detail reads", async () => {
    const handlers = createDiscoveryItemMcpHandlers(
      services({
        detail: {
          getItemDetail: vi.fn(async () => detailRow({ status: "draft" })),
          getSellerOverlay: vi.fn(),
          findSimilarItems: vi.fn(async () => ({ items: [], count: 0, mode: "none" as const })),
          projectors: [],
        },
      }),
    );

    await expect(
      handlers.toolHandlers["discovery.get-item-detail"]?.(toolInput({ itemSlug: "draft-charizard" })),
    ).rejects.toThrow("Item not found.");
  });

  it("returns ChatGPT product feed rows from public item details only", async () => {
    const fakeServices = services({
      detail: {
        getItemDetail: vi
          .fn()
          .mockResolvedValueOnce(detailRow())
          .mockResolvedValueOnce(detailRow({ catalog_item_id: "cat_draft", status: "draft" })),
        getSellerOverlay: vi.fn(),
        findSimilarItems: vi.fn(async () => ({ items: [], count: 0, mode: "none" as const })),
        projectors: [],
      },
      search: {
        suggestItems: vi.fn(async () => []),
        searchItems: vi.fn(async () => ({
          items: [searchRow(), searchRow({ catalog_item_id: "cat_draft", slug: "draft-card" })],
          facets: [],
          category_counts: [],
          total: 2,
          nextCursor: "cursor_1",
          retrievalMode: "lexical" as const,
          lexicalCount: 1,
          cursorState: "fresh" as const,
          queryHash: "",
          resultSetKey: "",
        })),
        previewBulkAdd: vi.fn(),
        rebuildSearchIndex: vi.fn(),
        projectors: [],
      },
    });
    const handlers = createDiscoveryItemMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["discovery.get-chatgpt-product-feed"]?.(toolInput({ query: "char" }));

    expect(result).toMatchObject({
      feedFormat: "chatgpt-product-feed/v1",
      count: 1,
      total: 2,
      nextCursor: "cursor_1",
      products: [
        {
          id: "cat_1",
          title: "Charizard",
          url: "https://marketplace.example/items/charizard-cat_1",
          price: { currency: "EUR", amount: "12.34", display: "€12.34" },
          availability: { status: "in_stock", quantity: 3 },
          variants: [
            {
              listing_id: "lst_1",
              url: "https://marketplace.example/listings/charizard-near-mint-lst_1",
            },
          ],
        },
      ],
    });
  });
});
