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
      getItemDetail: vi.fn(async (id: string) => ({
        catalog_item_id: id,
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
        blueprint: null,
        status: "active",
        field_values: [],
        categories: [{ name: "Pokemon", slug: "pokemon" }],
        tags: ["fire"],
        image_urls: ["https://images.example/charizard.jpg"],
        product_asset_sets: [],
        image_fallback: null,
        product_schema: null,
        market_summary: {
          lowest_price_amount: "12.34",
          lowest_price_currency_code: "EUR",
          active_listing_count: 1,
          total_visible_quantity: 3,
        },
        market_listings: [
          {
            listing_id: "listing_1",
            listing_slug: "charizard-listing",
            product_slug: "charizard",
            account_id: "acct_1",
            inventory_item_id: "inv_1",
            catalog_catalog_item_id: id,
            product_id: "product_1",
            item_title: "Charizard",
            item_subtitle: "Base Set",
            selected_options: [],
            product_summary: "Charizard",
            graded_card: null,
            storage_location_name: null,
            ship_from_code: null,
            price_amount: "12.34",
            price_currency_code: "EUR",
            listing_stream_version: 1,
            shipping_allowance_percentage_bps: 0,
            quantity_cap: 3,
            max_units_per_order: null,
            max_units_per_day: null,
            max_units_per_customer_account: null,
            status: "active",
            seller_slug: "seller",
            seller_display_name: "Seller",
            seller_average_rating: null,
            seller_review_count: 0,
            seller_badges: [],
            seller_at_capacity: false,
            visible_quantity: 3,
            created_at: "2026-05-16T00:00:00.000Z",
            updated_at: "2026-05-16T00:00:00.000Z",
          },
        ],
        offer_demand_matches: [],
        contents: [],
        included_in: [],
        updated_at: "2026-05-16T00:00:00.000Z",
      })),
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
      ucp: { status: "success" },
      products: [
        {
          id: "cat_1",
          title: "Charizard",
          url: "https://marketplace.example/items/charizard-cat_1",
          image_urls: ["https://images.example/charizard.jpg"],
          price_range: {
            min: { currency: "EUR", amount: 1234 },
            max: { currency: "EUR", amount: 1234 },
          },
          variants: [{ id: "listing_1", price: { currency: "EUR", amount: 1234 } }],
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
    expect(restarted).toMatchObject({ ucp: { status: "success" }, count: 1, total: 1, next_cursor: "cursor_v2" });
    expect(JSON.stringify(restarted)).not.toContain("restart");
  });

  it("returns a UCP not-found message when get_product cannot resolve an item", async () => {
    const items = buildItems();
    vi.mocked(items.detail.getItemDetail).mockResolvedValueOnce(null);
    const handlers = createDiscoveryUcpHandlers(items);

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

  it("proves mixed-currency C3 presentment, C2 bypass, featured lookup, and the eight case-4 mutants", async () => {
    const items = buildItems();
    const original = await items.detail.getItemDetail("cat_1");
    if (!original) throw new Error("Expected the mixed-currency fixture.");
    const listing = (id: string, amount: string, currency: string) => ({
      ...original.market_listings[0],
      listing_id: id,
      price_amount: amount,
      price_currency_code: currency,
    });
    const mixed = {
      ...original,
      market_summary: null,
      market_listings: [
        listing("usd_10", "10.00", "USD"),
        listing("usd_12", "12.00", "USD"),
        listing("eur_9", "9.00", "EUR"),
      ],
    };
    const ineligible = {
      ...original,
      catalog_item_id: "bad",
      market_summary: null,
      market_listings: [listing("jpy_fraction", "1000.50", "JPY"), listing("unknown", "10.00", "ZZZ")],
    };
    vi.mocked(items.detail.getItemDetail).mockImplementation(async (id: string) =>
      id === "cat_1" ? mixed : id === "bad" ? ineligible : null,
    );
    const handlers = createDiscoveryUcpHandlers(items);
    const input = (operation: "search_catalog" | "lookup_catalog" | "get_product", body: Record<string, unknown>) =>
      handlers.restHandlers[operation]({
        request: new Request("https://marketplace.example/ucp/v1/catalog", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        params: {},
      } as never);

    const search = await input("search_catalog", { context: { currency: "USD" } });
    expect(search).toMatchObject({
      products: [
        {
          id: "cat_1",
          price_range: { min: { amount: 1000, currency: "USD" }, max: { amount: 1200, currency: "USD" } },
          variants: [{ id: "usd_10" }, { id: "usd_12" }],
        },
      ],
      messages: [{ code: "listings_omitted_currency", path: "$.products[0]" }],
    });
    expect(JSON.stringify(search)).not.toContain("eur_9");

    const lookup = await input("lookup_catalog", { ids: ["cat_1"], context: { currency: "USD" } });
    expect(lookup).toMatchObject({
      products: [{ variants: [{ id: "usd_10", inputs: [{ id: "cat_1", match: "featured" }] }] }],
    });
    expect((lookup as { products: Array<{ variants: unknown[] }> }).products[0].variants).toHaveLength(1);

    const euro = await input("get_product", { id: "cat_1", context: { currency: "EUR" } });
    expect(euro).toMatchObject({
      product: {
        price_range: { min: { amount: 900, currency: "EUR" }, max: { amount: 900, currency: "EUR" } },
        variants: [{ id: "eur_9" }],
      },
      messages: [{ code: "listings_omitted_currency", path: "$.product" }],
    });

    const absent = await input("get_product", { id: "cat_1" });
    expect(absent).toMatchObject({ product: { price_range: { min: { amount: 1000 }, max: { amount: 1200 } } } });
    const unsupported = await input("get_product", { id: "cat_1", context: { currency: "ZZZ" } });
    expect(unsupported).toMatchObject({ product: { variants: [{ id: "usd_10" }] } });

    const noEligible = await input("get_product", { id: "bad", context: { currency: "USD" } });
    expect(noEligible).toMatchObject({ ucp: { status: "error" }, messages: [{ code: "product_not_found" }] });

    // Named case-4 controls: raw cross-currency range, relabeling, drop/split,
    // ignored request currency, alphabetical fallback, omitted warning, ineligible
    // emission, and exact/uncorrelated lookup variants all fail above.
    expect((search as { products: unknown[] }).products).toHaveLength(1); // drop/split
    expect(JSON.stringify(search)).not.toContain('"currency":"EUR","amount":1000'); // relabel/raw range
    expect(
      (lookup as { products: Array<{ variants: Array<{ inputs?: unknown }> }> }).products[0].variants[0].inputs,
    ).toBeDefined();
  });
});
