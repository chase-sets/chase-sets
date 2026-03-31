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

  it("hides empty categories from the marketplace category list", async () => {
    const app = buildMarketplaceApp({
      ...services,
      categories: {
        ...services.categories,
        listCategories: async () => [
          {
            category_id: "cat_empty",
            key: "empty",
            name: "Empty",
            description: "No items yet",
            status: "active",
            parent_category_id: null,
            parent_category: null,
            display_order: 0,
            item_count: 0,
            updated_at: "2026-03-31T00:00:00.000Z",
          },
          {
            category_id: "cat_pokemon",
            key: "pokemon",
            name: "Pokemon",
            description: "Pokemon cards",
            status: "active",
            parent_category_id: null,
            parent_category: null,
            display_order: 1,
            item_count: 3,
            updated_at: "2026-03-31T00:00:00.000Z",
          },
        ],
      },
    });

    const response = await app.fetch(new Request("http://marketplace.test/api/marketplace/categories"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          category_id: "cat_pokemon",
          key: "pokemon",
          name: "Pokemon",
          description: "Pokemon cards",
          status: "active",
          parent_category_id: null,
          parent_category: null,
          display_order: 1,
          item_count: 3,
          updated_at: "2026-03-31T00:00:00.000Z",
        },
      ],
      total: 1,
      count: 1,
    });
  });
});
