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
import { expectUcpCapture, ucpSchemaValidator } from "@chase-sets/platform-runtime/ucp-schema-test-support";
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

type DetailListing = Readonly<{
  listing_id: string;
  listing_slug: string;
  price_amount: string;
  price_currency_code: string;
}>;

function detailFor(
  id: string,
  listings: readonly DetailListing[] = [
    { listing_id: `${id}_listing`, listing_slug: `${id}-listing`, price_amount: "10.00", price_currency_code: "USD" },
  ],
) {
  return {
    catalog_item_id: id,
    slug: `${id}-slug`,
    title: `Product ${id}`,
    description: `Description ${id}`,
    market_listings: listings,
  } as unknown as DiscoveryItemDetailRow;
}

describe("Discovery UCP catalog handlers", () => {
  it("keeps corrected rows mode-free in REST and MCP search_catalog", async () => {
    const items = buildItems({
      detail: { ...buildItems().detail, getItemDetail: vi.fn(async () => detailFor("cat_1")) },
    });
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
    expect(result).toMatchObject({
      products: [expect.objectContaining({ id: "cat_1" })],
      pagination: { has_next_page: false },
    });
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
    const items = buildItems({
      detail: { ...buildItems().detail, getItemDetail: vi.fn(async () => detailFor("cat_1")) },
    });
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
    expect(rest).toMatchObject({
      products: [expect.objectContaining({ id: "cat_1" })],
      pagination: { has_next_page: false },
    });
    expect(JSON.stringify(rest)).not.toMatch(/interpretation|remainingQuery|Gem Mint|retrievalMode/);
    expect(await handlers.mcpToolHandlers.search_catalog(input("https://marketplace.example/mcp"))).toEqual(rest);
  });
  it("drops search rows whose detail cannot be hydrated", async () => {
    const items = buildItems();
    const handlers = createDiscoveryUcpHandlers(items);

    const result = await handlers.restHandlers.search_catalog({
      request: new Request("https://marketplace.example/ucp/v1/catalog/search", {
        method: "POST",
        body: JSON.stringify({ query: "charizard", filters: { categories: ["Pokemon"] } }),
      }),
      params: {},
    } as never);

    expect(items.search.searchItems).toHaveBeenCalledWith(
      expect.objectContaining({
        search: "charizard",
        categories: ["Pokemon"],
        limit: 20,
        includeTotal: true,
      }),
    );
    expect(result).toMatchObject({
      ucp: { status: "success" },
      products: [],
      pagination: { has_next_page: false },
    });
    expectUcpCapture(result, { operation: "search_catalog", kind: "resource" });
    expect(result.pagination).not.toHaveProperty("total_count");
  });

  it.each([
    ["search_catalog", { query: "pikachu", limit: 3 }, "searchItems"],
    ["lookup_catalog", { ids: ["cat_1"] }, "getItemDetail"],
    ["get_product", { id: "cat_1" }, "getItemDetail"],
  ] as const)("rejects flat MCP args for %s", async (operation, arguments_, spyName) => {
    const items = buildItems({
      detail: { ...buildItems().detail, getItemDetail: vi.fn(async () => detailFor("cat_1")) },
    });
    const handlers = createDiscoveryUcpHandlers(items);
    const result = await handlers.mcpToolHandlers[operation]({
      actor: null,
      context: null,
      arguments: arguments_,
      params: {},
      request: new Request("https://marketplace.example/ucp/mcp", {
        method: "POST",
        body: JSON.stringify(arguments_),
      }),
    });
    expectUcpCapture(result, { operation, kind: "error" });
    expect(result).toMatchObject({ messages: [{ code: "invalid_request", severity: "recoverable" }] });
    const spy = spyName === "searchItems" ? items.search.searchItems : items.detail.getItemDetail;
    expect(spy).not.toHaveBeenCalled();
  });

  const catalogMatrix = [
    ...(["M1", "M2", "ineligible-only"] as const).flatMap((productSet) =>
      (["USD", "EUR", "absent", "JPY"] as const).flatMap((currency) =>
        (["none", "USD min 500 / max 1500 minor"] as const).flatMap((bound) =>
          (["search_catalog", "lookup_catalog", "get_product"] as const).map((tool) => ({
            name: `${productSet} ${currency} ${bound} ${tool}`,
            productSet,
            currency,
            bound,
            tool,
          })),
        ),
      ),
    ),
  ] as const;

  it.each(catalogMatrix)("UCP 2026-08-25 catalog currency matrix $name", async (cell) => {
    const listing = (id: string, amount: string, code: string) => ({
      listing_id: `${id}-${code.toLowerCase()}`,
      listing_slug: `${id}-${code.toLowerCase()}`,
      price_amount: amount,
      price_currency_code: code,
    });
    const definitions = {
      M1: [listing("M1", "10.00", "USD"), listing("M1", "9.00", "EUR")],
      M2: [listing("M2", "20.00", "USD"), listing("M2", "18.00", "EUR")],
      "ineligible-only": [listing("ineligible", "1000.50", "JPY")],
    } as const;
    const ids = cell.productSet === "ineligible-only" ? ["ineligible"] : [cell.productSet];
    const details = new Map(ids.map((id) => [id, detailFor(id, definitions[cell.productSet])]));
    const searchTemplate = (await buildItems().search.searchItems()).items[0];
    const rows = ids.map((id) => ({
      ...searchTemplate,
      catalog_item_id: id,
      slug: `${id}-slug`,
      title: `Product ${id}`,
    }));
    const searchItems = vi.fn(async () => ({
      ...(await buildItems().search.searchItems()),
      items: rows,
      total: rows.length,
      nextCursor: null,
    }));
    const items = buildItems({
      search: { ...buildItems().search, searchItems },
      detail: { ...buildItems().detail, getItemDetail: vi.fn(async (id: string) => details.get(id) ?? null) },
    });
    const handlers = createDiscoveryUcpHandlers(items);
    const context = cell.currency === "absent" ? {} : { currency: cell.currency };
    const filters = cell.bound === "none" || cell.currency !== "USD" ? {} : { price: { min: 500, max: 1500 } };
    const catalog =
      cell.tool === "search_catalog"
        ? { query: "cards", context, filters }
        : cell.tool === "lookup_catalog"
          ? { ids, context, filters }
          : { id: ids[0], context, filters };
    const rest = await handlers.restHandlers[cell.tool]({
      actor: null,
      context: null,
      arguments: {},
      params: {},
      request: new Request("https://marketplace.example/ucp/v1/catalog", {
        method: "POST",
        body: JSON.stringify(catalog),
      }),
    });
    const mcp = await handlers.mcpToolHandlers[cell.tool]({
      actor: null,
      context: null,
      arguments: { catalog },
      params: {},
      request: new Request("https://marketplace.example/ucp/mcp", { method: "POST" }),
    });
    expect(mcp).toEqual(rest);
    const failed = rest.ucp.status === "error";
    const kind = failed ? "error" : "resource";
    expectUcpCapture(rest, { operation: cell.tool, kind });
    if (failed && cell.tool === "get_product") {
      expect(rest).toMatchObject({ messages: [{ code: "product_not_found", severity: "unrecoverable" }] });
    } else {
      const products = (
        cell.tool === "get_product" ? (rest.product ? [rest.product] : []) : (rest.products ?? [])
      ) as Array<Record<string, unknown>>;
      const expectedProductCount =
        (cell.productSet === "ineligible-only" && cell.currency !== "JPY") ||
        (cell.productSet === "M2" &&
          cell.currency === "USD" &&
          cell.bound !== "none" &&
          cell.tool === "lookup_catalog") ||
        (cell.productSet === "ineligible-only" && cell.currency === "JPY")
          ? 0
          : 1;
      expect(products).toHaveLength(expectedProductCount);
      if (cell.tool === "search_catalog") expect(rest.pagination).not.toHaveProperty("cursor");
      if (cell.tool === "search_catalog") {
        if (expectedProductCount === 1) expect(rest.pagination).toHaveProperty("total_count");
        else expect(rest.pagination).not.toHaveProperty("total_count");
        expect(searchItems).toHaveBeenCalledWith(
          expect.objectContaining({
            limit: 20,
            includeTotal: true,
            ...(cell.currency === "absent" ? {} : { priceCurrency: cell.currency }),
            ...(cell.bound === "USD min 500 / max 1500 minor" && cell.currency === "USD"
              ? { priceMin: "5.00", priceMax: "15.00" }
              : {}),
          }),
        );
      }
      if (products.length > 0) {
        const variants = (products[0]?.variants ?? []) as Array<Record<string, unknown>>;
        expect(variants).toHaveLength(1);
        const selectedCurrency =
          cell.productSet === "ineligible-only"
            ? "jpy"
            : cell.currency === "USD" || cell.currency === "EUR"
              ? cell.currency.toLowerCase()
              : "eur";
        expect(variants[0]?.id).toBe(`${cell.productSet}-${selectedCurrency}`);
      }
    }
  });

  it("applies the twenty-row default and cursor before hydration", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      catalog_item_id: `cat_${index}`,
      slug: `slug_${index}`,
      title: `Product ${index}`,
    })) as never[];
    const items = buildItems({
      search: {
        ...buildItems().search,
        searchItems: vi
          .fn()
          .mockResolvedValueOnce({ items: rows, total: 50, nextCursor: "cursor_page_2" })
          .mockResolvedValueOnce({ items: rows.slice(0, 1), total: 21, nextCursor: null }),
      },
      detail: {
        ...buildItems().detail,
        getItemDetail: vi.fn(async (id: string) => detailFor(id)),
      },
    });
    const handlers = createDiscoveryUcpHandlers(items);
    const call = (body: Record<string, unknown>) =>
      handlers.restHandlers.search_catalog({
        request: new Request("https://marketplace.example/ucp/v1/catalog/search", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        params: {},
      } as never);
    const first = await call({ query: "cards", pagination: { limit: 25 } });
    expect(items.search.searchItems).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 20 }));
    expect(first.products).toHaveLength(20);
    expect(first.pagination).toMatchObject({ has_next_page: true, cursor: "cursor_page_2", total_count: 50 });
    const second = await call({ query: "cards", pagination: { cursor: "cursor_page_2" } });
    expect(items.search.searchItems).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 20, cursor: "cursor_page_2" }),
    );
    expect(second.products).toHaveLength(1);
  });

  it("indexes warnings against emitted products after dropped rows", async () => {
    const items = buildItems({
      search: {
        ...buildItems().search,
        searchItems: vi.fn(async () => ({
          items: [
            { catalog_item_id: "drop", slug: "drop", title: "Drop" },
            { catalog_item_id: "keep", slug: "keep", title: "Keep" },
          ],
          total: 2,
          nextCursor: null,
        })) as never,
      },
      detail: {
        ...buildItems().detail,
        getItemDetail: vi.fn(async (id: string) =>
          id === "drop"
            ? null
            : detailFor(id, [
                { listing_id: "usd", listing_slug: "usd", price_amount: "10.00", price_currency_code: "USD" },
                { listing_id: "eur", listing_slug: "eur", price_amount: "9.00", price_currency_code: "EUR" },
              ]),
        ),
      },
    });
    const result = await createDiscoveryUcpHandlers(items).restHandlers.search_catalog({
      request: new Request("https://marketplace.example/ucp/v1/catalog/search", {
        method: "POST",
        body: JSON.stringify({ query: "cards", context: { currency: "USD" } }),
      }),
      params: {},
    } as never);
    expect(result.products).toHaveLength(1);
    expect(result.messages).toEqual([
      expect.objectContaining({ code: "listings_omitted_currency", path: "$.products[0]" }),
    ]);
    const lookup = await createDiscoveryUcpHandlers(items).restHandlers.lookup_catalog({
      request: new Request("https://marketplace.example/ucp/v1/catalog/lookup", {
        method: "POST",
        body: JSON.stringify({ ids: ["drop", "keep"], context: { currency: "USD" } }),
      }),
      params: {},
    } as never);
    expect(lookup.messages).toEqual([
      expect.objectContaining({ code: "listings_omitted_currency", path: "$.products[0]" }),
    ]);
  });

  it("unwraps catalog arguments for MCP search, lookup, and get_product", async () => {
    const items = buildItems({
      detail: {
        ...buildItems().detail,
        getItemDetail: vi.fn(async (id: string) => detailFor(id)),
      },
    });
    const handlers = createDiscoveryUcpHandlers(items);
    const input = (argumentsValue: Record<string, unknown>) =>
      ({
        request: new Request("https://marketplace.example/ucp/mcp", { method: "POST", body: "{}" }),
        arguments: argumentsValue,
        params: {},
      }) as never;
    const restRequest = (body: Record<string, unknown>) =>
      ({
        request: new Request("https://marketplace.example/ucp/v1/catalog", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        arguments: {},
        params: {},
      }) as never;
    const searchMcp = await handlers.mcpToolHandlers.search_catalog(input({ catalog: { query: "cards" } }));
    const searchRest = await handlers.restHandlers.search_catalog(restRequest({ query: "cards" }));
    expect(searchMcp).toEqual(searchRest);
    const lookupMcp = await handlers.mcpToolHandlers.lookup_catalog(input({ catalog: { ids: ["cat_1"] } }));
    const lookupRest = await handlers.restHandlers.lookup_catalog(restRequest({ ids: ["cat_1"] }));
    expect(lookupMcp).toEqual(lookupRest);
    const productMcp = await handlers.mcpToolHandlers.get_product(input({ catalog: { id: "cat_1" } }));
    const productRest = await handlers.restHandlers.get_product(restRequest({ id: "cat_1" }));
    expect(productMcp).toEqual(productRest);
    expect(items.detail.getItemDetail).toHaveBeenCalledWith("cat_1");
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

    const restarted = await search({ query: "charizard", pagination: { cursor: "legacy-cursor" } });

    expect(items.search.searchItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "charizard", cursor: "legacy-cursor", includeTotal: true }),
    );
    expect(Object.keys(restarted).sort()).toEqual(Object.keys(fresh).sort());
    expect(restarted).toMatchObject({
      ucp: { status: "success" },
      pagination: { cursor: "cursor_v2", has_next_page: true },
    });
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
  it("UCP 2026-08-25 Product resource validates on all three tools", () => {
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
          price_amount: "10.00",
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
    const request = new Request("https://marketplace.example/ucp/v1/catalog");
    const usd10 = source.market_listings[0]!;
    const usd12 = { ...usd10, listing_id: "lst_usd_12", listing_slug: "charizard-usd-12", price_amount: "12.00" };
    const eur9 = {
      ...usd10,
      listing_id: "lst_eur",
      listing_slug: "charizard-eur",
      price_amount: "9.00",
      price_currency_code: "EUR",
    };
    const products = [
      { name: "M1", source: { ...source, market_listings: [usd10, eur9] }, minors: [1000], omitted: true },
      { name: "M2", source: { ...source, market_listings: [usd10, usd12, eur9] }, minors: [1000, 1200], omitted: true },
      { name: "single-currency", source, minors: [1000], omitted: false },
    ];
    for (const row of products) {
      const presentment = selectPresentment(row.source.market_listings, "USD");
      expect(presentment, row.name).not.toBeNull();
      if (!presentment) throw new Error(`Missing ${row.name} presentment`);
      const inputs = lookupInputs([
        { requestedId: "requested-catalog-alias", productId: source.catalog_item_id },
        { requestedId: "requested-listing-alias", productId: source.catalog_item_id },
        { requestedId: "requested-catalog-alias", productId: source.catalog_item_id },
      ])[0]!.inputs;
      for (const mode of ["search", "lookup", "get_product"] as const) {
        const product = catalogUcpProduct({ source: row.source, presentment, request, mode, inputs });
        const schema =
          mode === "search"
            ? "catalog_search.json#/$defs/search_response"
            : `catalog_lookup.json#/$defs/${mode === "lookup" ? "lookup_response" : "get_product_response"}`;
        const validate = ucpSchemaValidator(`https://ucp.dev/2026-08-25/schemas/shopping/${schema}`);
        const envelope = {
          ucp: { version: "2026-08-25", status: "success" },
          ...(mode === "get_product" ? { product } : { products: [product] }),
        };
        expect(validate(envelope), `${row.name}/${mode}: ${JSON.stringify(validate.errors)}`).toBe(true);
        expect(product.id).toBe(source.catalog_item_id);
        expect(product.url).toBe("https://marketplace.example/items/charizard-cat-1");
        expect(new URL(product.url).origin).toBe("https://marketplace.example");
        expect(product.price_range).toEqual({
          min: { currency: "USD", amount: presentment.priceRange.min },
          max: { currency: "USD", amount: presentment.priceRange.max },
        });
        expect(product.extensions.chase_sets.omitted_listings).toBe(row.omitted);
        const listings = mode === "lookup" ? presentment.listings.slice(0, 1) : presentment.listings;
        expect(product.variants.map((variant) => variant.id)).toEqual(listings.map((listing) => listing.listing_id));
        expect(product.variants.map((variant) => variant.price)).toEqual(
          (mode === "lookup" ? row.minors.slice(0, 1) : row.minors).map((amount) => ({ currency: "USD", amount })),
        );
        for (const [index, variant] of product.variants.entries()) {
          expect(variant.url).toBe(`https://marketplace.example/listings/${listings[index]!.listing_slug}`);
          expect(new URL(variant.url).origin).toBe("https://marketplace.example");
          if (mode === "lookup") expect(variant.inputs).toEqual(inputs);
          else expect(variant).not.toHaveProperty("inputs");
        }
        console.info(
          "AC3_ENVELOPE",
          JSON.stringify({
            product: row.name,
            mode,
            valid: true,
            variant_ids: product.variants.map((variant) => variant.id),
          }),
        );
      }
      for (const inputs of [undefined, []])
        expect(() => catalogUcpProduct({ source: row.source, presentment, request, mode: "lookup", inputs })).toThrow(
          "UCP lookup Product requires request inputs",
        );
    }
  });
});
