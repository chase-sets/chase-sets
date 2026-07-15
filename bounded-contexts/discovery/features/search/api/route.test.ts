import { describe, expect, it, vi } from "vitest";
import type { DiscoveryItemSearchServices } from "./runtime";
import { discoveryItemSearchRoutes } from "./route";
import { DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS } from "../domain/normalization";

function createServices(): DiscoveryItemSearchServices {
  return {
    suggestItems: vi.fn(async () => []),
    searchItems: vi.fn(async () => ({
      items: [],
      facets: [],
      total: 0,
      nextCursor: null,
      retrievalMode: "lexical" as const,
      lexicalCount: 0,
    })),
    previewBulkAdd: vi.fn(async () => ({
      totalMatches: 0,
      eligibleCount: 0,
      skippedCount: 0,
      overLimit: false,
      limit: 250,
      lines: [],
      skippedItems: [],
    })),
    rebuildSearchIndex: vi.fn(async () => undefined),
    publishSearchOutcome: vi.fn(async () => undefined),
    projectors: [],
  };
}

describe("discovery item search routes", () => {
  it("returns bounded active-item prefix suggestions", async () => {
    const services = createServices();
    vi.mocked(services.suggestItems).mockResolvedValue([
      {
        catalogItemId: "cat_1",
        title: "Charizard ex",
        slug: "charizard-ex-cat-1",
        category: "Pokemon TCG",
      },
    ]);
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request("/suggest?q=char&limit=1000");

    expect(response.status).toBe(200);
    expect(services.suggestItems).toHaveBeenCalledWith("char", 1000);
    expect(await response.json()).toEqual({
      items: [
        {
          catalogItemId: "cat_1",
          title: "Charizard ex",
          slug: "charizard-ex-cat-1",
          category: "Pokemon TCG",
        },
      ],
      count: 1,
    });
  });

  it("returns an empty suggestion list for an empty query", async () => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request("/suggest?q=");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], count: 0 });
  });

  it("caps suggestion query length by Unicode code point", async () => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);
    const query = "検索".repeat(100);

    const response = await app.request(`/suggest?q=${encodeURIComponent(query)}`);

    expect(response.status).toBe(200);
    const boundedQuery = vi.mocked(services.suggestItems).mock.calls[0]?.[0] ?? "";
    expect([...boundedQuery]).toHaveLength(80);
  });

  it.each([
    { path: "/?status=draft&search=leak", serviceName: "searchItems" as const },
    { path: "/?status=archived&search=leak", serviceName: "searchItems" as const },
    { path: "/bulk-cart-preview?status=draft&search=leak", serviceName: "previewBulkAdd" as const },
  ])("forces public $path searches to active catalog items", async ({ path, serviceName }) => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request(path);

    expect(response.status).toBe(200);
    expect(services[serviceName]).toHaveBeenCalledWith(expect.objectContaining({ search: "leak", status: "active" }));
  });

  it("parses price range, in-stock, and price-sort query state", async () => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request("/?priceMin=10.25&priceMax=50&inStock=true&sort=price_asc");

    expect(response.status).toBe(200);
    expect(services.searchItems).toHaveBeenCalledWith(
      expect.objectContaining({
        priceMin: "10.25",
        priceMax: "50",
        inStock: true,
        sort: "price_asc",
      }),
    );
  });

  it("ignores malformed price and in-stock query values", async () => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request("/?priceMin=-1&priceMax=12.345&inStock=yes");

    expect(response.status).toBe(200);
    expect(services.searchItems).toHaveBeenCalledWith(
      expect.objectContaining({ priceMin: undefined, priceMax: undefined, inStock: false }),
    );
  });

  it.each([
    {
      label: "10 KB Latin text",
      search: "a".repeat(10_000),
      expected: "a".repeat(DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS),
    },
    {
      label: "5 KB CJK text",
      search: "検索".repeat(2_500),
      expected: "検索".repeat(DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS / 2),
    },
    {
      label: "tsquery metacharacters",
      search: `Charizard' & :* "quoted"`,
      expected: `Charizard' & :* "quoted"`,
    },
  ])("bounds and preserves well-formed $label search input", async ({ search, expected }) => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request(`/?search=${encodeURIComponent(search)}`);

    expect(response.status).toBe(200);
    expect(services.searchItems).toHaveBeenCalledWith(expect.objectContaining({ search: expected }));
    expect([...expected]).toHaveLength(Math.min([...search].length, DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS));
  });
});
