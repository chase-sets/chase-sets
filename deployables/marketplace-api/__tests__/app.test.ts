import { describe, expect, it } from "vitest";
import type { DiscoveryServices } from "@chase-sets/discovery";
import { buildMarketplaceApp } from "../src/app";

const services: DiscoveryServices = {
  items: {
    search: {
      searchItems: async () => ({ items: [], total: 0 }),
      rebuildSearchIndex: async () => {},
      projectors: [],
    },
    detail: {
      getItemDetail: async () => null,
      projectors: [],
    },
    projectors: [],
  },
  categories: {
    listCategories: async () => [],
    projectors: [],
  },
  projectors: [],
};

describe("marketplace api host app", () => {
  it("mounts health and the discovery API under /api/marketplace", async () => {
    const app = buildMarketplaceApp(services);

    const healthResponse = await app.fetch(new Request("http://marketplace.test/health"));
    expect(healthResponse.status).toBe(200);

    const legacyResponse = await app.fetch(new Request("http://marketplace.test/api/items"));
    expect(legacyResponse.status).toBe(404);

    const discoveryResponse = await app.fetch(new Request("http://marketplace.test/api/marketplace/items"));
    expect(discoveryResponse.status).toBe(200);
  });
});