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
});
