import { describe, expect, it, vi } from "vitest";
import { inventoryCatalogItemRoutes } from "./route";
import type { InventoryCatalogItemServices } from "../../features/inventory-items/integrations/catalog/runtime";

const catalogItem = {
  catalog_item_id: "cat_air",
  language_code: "en",
  title: "Air Balloon",
  subtitle: "Trainer Item",
  blueprint_id: "bp_1",
  status: "active",
  product_schema: null,
  updated_at: "2026-06-23T00:00:00.000Z",
};

function services(overrides: Partial<InventoryCatalogItemServices> = {}): InventoryCatalogItemServices {
  return {
    getCatalogItem: vi.fn(async () => catalogItem),
    searchCatalogItems: vi.fn(async () => ({ items: [catalogItem], total: 1 })),
    getExternalProductReference: vi.fn(async () => null),
    getExternalCatalogItemReference: vi.fn(async () => null),
    getCatalogItemByGtin: vi.fn(async () => null),
    projectors: [],
    ...overrides,
  } as InventoryCatalogItemServices;
}

describe("inventory catalog item routes", () => {
  it("returns searchable catalog items for picker requests", async () => {
    const searchCatalogItems = vi.fn<InventoryCatalogItemServices["searchCatalogItems"]>(async () => ({
      items: [catalogItem],
      total: 1,
    }));
    const app = inventoryCatalogItemRoutes(services({ searchCatalogItems }));

    const response = await app.request("/?search=Air&limit=7");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(searchCatalogItems).toHaveBeenCalledWith({ search: "Air", status: undefined, limit: 7 });
    expect(body).toMatchObject({
      count: 1,
      total: 1,
      items: [expect.objectContaining({ title: "Air Balloon" })],
    });
  });

  it("preserves direct canonical item lookup", async () => {
    const getCatalogItem = vi.fn<InventoryCatalogItemServices["getCatalogItem"]>(async () => catalogItem);
    const app = inventoryCatalogItemRoutes(services({ getCatalogItem }));

    const response = await app.request("/cat_air");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getCatalogItem).toHaveBeenCalledWith("cat_air");
    expect(body).toMatchObject({ catalog_item_id: "cat_air" });
  });
});
