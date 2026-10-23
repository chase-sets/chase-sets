import { describe, expect, it, vi } from "vitest";
import {
  boundPresentment,
  catalogUcpProduct,
  createDiscoveryUcpHandlers,
  LISTINGS_OMITTED_CONTENT,
  lookupInputs,
  minorBoundToDecimal,
  PRICE_FILTER_IGNORED_CONTENT,
  resolveUcpCurrency,
  selectPresentment,
  toUcpMinorUnits,
  type UcpCatalogListing,
} from "../support/ucp-support/catalog";
import { ucpSchemaValidator } from "@chase-sets/platform-runtime/ucp-schema-test-support";
import type { DiscoveryItemDetailRow } from "../features/item-detail/read-model/queries";
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

type Listing = UcpCatalogListing;
const listing = (id: string, amount: string, currency: string): Listing => ({
  listing_id: id,
  price_amount: amount,
  price_currency_code: currency,
});

describe("UCP currency and minor units follow decision C2 and C3", () => {
  it("resolves ISO currencies and exact minor units", () => {
    expect(resolveUcpCurrency(" usd ")).toEqual({ code: "USD", exponent: 2 });
    expect(resolveUcpCurrency("JPY")).toEqual({ code: "JPY", exponent: 0 });
    expect(resolveUcpCurrency("KWD")).toEqual({ code: "KWD", exponent: 3 });
    expect(resolveUcpCurrency("ZZZ")).toBeNull();
    expect(resolveUcpCurrency("US")).toBeNull();
    expect(resolveUcpCurrency("")).toBeNull();
    const numberFormat = vi.spyOn(Intl, "NumberFormat");
    numberFormat.mockImplementation(function () {
      return { resolvedOptions: () => ({ maximumFractionDigits: undefined }) } as Intl.NumberFormat;
    } as unknown as typeof Intl.NumberFormat);
    try {
      expect(resolveUcpCurrency("USD")).toBeNull();
    } finally {
      numberFormat.mockRestore();
    }
    expect(toUcpMinorUnits("1000.00", "JPY")).toEqual({ currency: "JPY", minor: 1000 });
    expect(toUcpMinorUnits("1000.50", "JPY")).toBeNull();
    expect(toUcpMinorUnits("1.00", "KWD")).toEqual({ currency: "KWD", minor: 1000 });
    expect(toUcpMinorUnits("12.345", "USD")).toBeNull();
    expect(toUcpMinorUnits("90071992547409.90", "USD")).toEqual({
      currency: "USD",
      minor: 9007199254740990,
    });
    expect(toUcpMinorUnits("9007199254740992", "USD")).toBeNull();
    expect(minorBoundToDecimal(1000, "USD")).toBe("10.00");
    expect(minorBoundToDecimal(5, "USD")).toBe("0.05");
    expect(minorBoundToDecimal(0, "USD")).toBe("0.00");
    expect(minorBoundToDecimal(1000, "JPY")).toBe("1000");
    expect(minorBoundToDecimal(1000, "KWD")).toBe("1.000");
    expect(minorBoundToDecimal(Number.MAX_SAFE_INTEGER, "KWD")).toBe("9007199254740.991");
  });
});

describe("UCP presentment follows decision case 4", () => {
  it("chooses request currency or deterministic fallback and omits other listings", () => {
    const mixed = [listing("usd_10", "10.00", "USD"), listing("eur_9", "9.00", "EUR")];
    expect(selectPresentment(mixed, undefined)).toEqual({
      currency: "EUR",
      listings: [mixed[1]],
      priceRange: { min: 900, max: 900 },
      omittedListings: true,
    });
    expect(selectPresentment(mixed, "JPY")).toEqual({
      currency: "EUR",
      listings: [mixed[1]],
      priceRange: { min: 900, max: 900 },
      omittedListings: true,
    });
    expect(selectPresentment(mixed, "ZZZ")).toEqual({
      currency: "EUR",
      listings: [mixed[1]],
      priceRange: { min: 900, max: 900 },
      omittedListings: true,
    });
    expect(selectPresentment(mixed, "USD")).toEqual({
      currency: "USD",
      listings: [mixed[0]],
      priceRange: { min: 1000, max: 1000 },
      omittedListings: true,
    });
    expect(selectPresentment(mixed, "EUR")).toEqual({
      currency: "EUR",
      listings: [mixed[1]],
      priceRange: { min: 900, max: 900 },
      omittedListings: true,
    });
    expect(
      selectPresentment(
        [listing("usd_10", "10.00", "USD"), listing("usd_bad", "12.345", "USD"), listing("eur_9", "9.00", "EUR")],
        "USD",
      ),
    ).toEqual({
      currency: "USD",
      listings: [listing("usd_10", "10.00", "USD")],
      priceRange: { min: 1000, max: 1000 },
      omittedListings: true,
    });
    const m2 = [listing("usd_10", "10.00", "USD"), listing("usd_12", "12.00", "USD"), listing("eur_9", "9.00", "EUR")];
    expect(selectPresentment(m2, undefined)).toEqual({
      currency: "USD",
      listings: [m2[0], m2[1]],
      priceRange: { min: 1000, max: 1200 },
      omittedListings: true,
    });
    expect(selectPresentment(m2, "EUR")).toEqual({
      currency: "EUR",
      listings: [m2[2]],
      priceRange: { min: 900, max: 900 },
      omittedListings: true,
    });
    expect(selectPresentment([listing("bad", "1000.50", "JPY")], undefined)).toBeNull();
    expect(selectPresentment([listing("bad", "10.00", "ZZZ")], undefined)).toBeNull();
    expect(selectPresentment([listing("one", "10.00", "USD")], "EUR")).toEqual({
      currency: "USD",
      listings: [listing("one", "10.00", "USD")],
      priceRange: { min: 1000, max: 1000 },
      omittedListings: false,
    });
  });
});

describe("UCP lookup bounds and inputs follow the currency-delta boundary", () => {
  it("filters only matching-currency bounds and correlates featured inputs", () => {
    const usd = selectPresentment(
      [listing("usd_10", "10.00", "USD"), listing("usd_12", "12.00", "USD"), listing("eur_9", "9.00", "EUR")],
      undefined,
    )!;
    expect(boundPresentment(usd, { currency: "USD", min: 1100 })).toMatchObject({
      listings: [usd.listings[1]],
      priceRange: { min: 1200, max: 1200 },
      ignored: false,
    });
    expect(boundPresentment(usd, { currency: "USD", min: 1300 })).toBeNull();
    const eur = selectPresentment([listing("usd_10", "10.00", "USD"), listing("eur_9", "9.00", "EUR")], "EUR")!;
    expect(boundPresentment(eur, { currency: "EUR", min: 1100 })).toBeNull();
    expect(boundPresentment(usd, { currency: "JPY", min: 1 })).toMatchObject({ ignored: true, listings: usd.listings });
    expect(boundPresentment(usd, { min: 1100 })).toMatchObject({ ignored: true, listings: usd.listings });
    expect(
      lookupInputs([
        { requestedId: "a", productId: "p" },
        { requestedId: "b", productId: "p" },
        { requestedId: "a", productId: "p" },
        { requestedId: "x", productId: null },
      ]),
    ).toEqual([
      {
        id: "p",
        inputs: [
          { id: "a", match: "featured" },
          { id: "b", match: "featured" },
        ],
      },
    ]);
    expect(PRICE_FILTER_IGNORED_CONTENT).toBe(
      "Price filter was not applied where its currency was absent or unsupported, or where a product is not priced only in that currency.",
    );
    expect(LISTINGS_OMITTED_CONTENT).toBe(
      "Some listings for this product were omitted because their price could not be presented in this product's currency.",
    );
  });
});

describe("UCP 2026-08-25 Product resource", () => {
  it("validates search, lookup and get-product shapes using listing presentment", () => {
    const source = {
      catalog_item_id: "cat_1",
      slug: "charizard-cat-1",
      title: "Charizard",
      description: "A fiery card.",
      market_listings: [
        {
          listing_id: "lst_usd",
          listing_slug: "charizard-usd",
          product_slug: "charizard-raw",
          account_id: "acc_1",
          inventory_item_id: "inv_1",
          catalog_catalog_item_id: "cat_1",
          product_id: "prod_1",
          item_title: "Charizard Raw",
          item_subtitle: null,
          selected_options: [],
          product_summary: "Raw",
          graded_card: null,
          storage_location_name: null,
          ship_from_code: "US-IL",
          price_amount: "12.34",
          price_currency_code: "USD",
          listing_stream_version: 1,
          shipping_allowance_percentage_bps: 0,
          quantity_cap: 1,
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
          visible_quantity: 1,
          created_at: "2026-10-16T00:00:00Z",
          updated_at: "2026-10-16T00:00:00Z",
        },
      ],
    } as unknown as DiscoveryItemDetailRow;
    const presentment = selectPresentment(source.market_listings, "USD")!;
    const request = new Request("https://marketplace.example/ucp/v1/catalog");
    const validateProduct = ucpSchemaValidator("https://ucp.dev/2026-08-25/schemas/shopping/types/product.json");
    for (const mode of ["search", "lookup", "get_product"] as const) {
      const product = catalogUcpProduct({
        source,
        presentment,
        request,
        mode,
        inputs: [{ id: "lst_usd", match: "featured" }],
      });
      expect(validateProduct(product), mode).toBe(true);
      expect(product).toMatchObject({
        id: "cat_1",
        url: "https://marketplace.example/items/charizard-cat-1",
        price_range: { min: { currency: "USD", amount: 1234 }, max: { amount: 1234 } },
        variants: [{ id: "lst_usd", price: { currency: "USD", amount: 1234 } }],
      });
      if (mode === "lookup") expect(product.variants).toHaveLength(1);
    }
  });
});
