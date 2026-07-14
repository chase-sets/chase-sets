import { describe, expect, it, vi } from "vitest";
import type { DiscoveryItemSearchServices } from "./runtime";
import { discoveryItemSearchRoutes } from "./route";

function createServices(): DiscoveryItemSearchServices {
  return {
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
});
