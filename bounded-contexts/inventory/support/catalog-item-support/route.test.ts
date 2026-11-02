import { describe, expect, it, vi } from "vitest";
import { inventoryCatalogItemRoutes } from "./route";
import type { InventoryCatalogItemServices } from "../../features/inventory-items/integrations/catalog/runtime";
import type { InventoryCatalogItemSnapshot } from "../../features/inventory-items/integrations/catalog/queries";

const catalogItem: InventoryCatalogItemSnapshot = {
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
    getExternalProductReference: vi.fn(async () => null),
    getExternalCatalogItemReference: vi.fn(async () => null),
    getCatalogItemByGtin: vi.fn(async () => null),
    projectors: [],
    ...overrides,
  } as InventoryCatalogItemServices;
}

describe("inventory catalog item routes", () => {
  it("preserves direct canonical item lookup", async () => {
    const getCatalogItem = vi.fn<InventoryCatalogItemServices["getCatalogItem"]>(async () => catalogItem);
    const app = inventoryCatalogItemRoutes(services({ getCatalogItem }));

    const response = await app.request("/cat_air");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getCatalogItem).toHaveBeenCalledWith("cat_air");
    expect(body).toMatchObject({ catalog_item_id: "cat_air" });
  });

  it.each([
    [
      "graded schema",
      {
        canonicalDimensionOrder: [
          { dimensionId: "dim_form", dimensionName: "Form" },
          { dimensionId: "dim_card_form", dimensionName: "Card Form" },
        ],
        dimensions: [
          {
            dimensionId: "dim_form",
            dimensionName: "Form",
            required: true,
            appliesWhen: [],
            allowedOptions: [
              { optionId: "opt_raw", code: "raw", label: "Raw" },
              { optionId: "opt_graded", code: "graded", label: "Graded" },
              { optionId: "opt_slab", code: "slab", label: "Graded (Slab)" },
            ],
          },
          {
            dimensionId: "dim_card_form",
            dimensionName: "Card Form",
            required: false,
            appliesWhen: [],
            allowedOptions: [{ optionId: "opt_card_graded", code: "graded", label: "Graded" }],
          },
        ],
      },
      [{ dimensionId: "dim_form", optionId: "opt_graded" }],
    ],
    ["null schema", null, []],
  ])("returns graded_selections for a %s without another read", async (_name, productSchema, gradedSelections) => {
    const item: InventoryCatalogItemSnapshot = { ...catalogItem, product_schema: productSchema };
    const catalog = services({ getCatalogItem: vi.fn(async () => item) });
    const response = await inventoryCatalogItemRoutes(catalog).request("/cat_air");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...item, graded_selections: gradedSelections });
    expect(catalog.getCatalogItem).toHaveBeenCalledTimes(1);
    expect(catalog.getExternalProductReference).not.toHaveBeenCalled();
    expect(catalog.getExternalCatalogItemReference).not.toHaveBeenCalled();
    expect(catalog.getCatalogItemByGtin).not.toHaveBeenCalled();
  });
});
