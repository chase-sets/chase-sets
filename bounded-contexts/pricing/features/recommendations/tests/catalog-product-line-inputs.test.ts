import { describe, expect, it, vi } from "vitest";
import { readCatalogItemProductLineInputs } from "../read-model/catalog-product-line-inputs";

describe("C-facing Catalog Product Line input adapter", () => {
  it("loads one set of item ids and maps the shared reference or explicit null", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          catalog_item_id: "direct",
          product_line_reference_id: "line",
          product_line_name: "Line",
          product_line_version: 1,
        },
        {
          catalog_item_id: "inherited",
          product_line_reference_id: "line",
          product_line_name: "Line",
          product_line_version: 2,
        },
        { catalog_item_id: "unset", product_line_reference_id: null, product_line_name: null, product_line_version: 3 },
      ],
    });
    await expect(readCatalogItemProductLineInputs({ query }, ["direct", "inherited", "unset"])).resolves.toEqual([
      { catalogItemId: "direct", productLine: { referenceId: "line", name: "Line", version: 1 } },
      { catalogItemId: "inherited", productLine: { referenceId: "line", name: "Line", version: 2 } },
      { catalogItemId: "unset", productLine: null },
    ]);
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/catalog_item_id = ANY\(\$1::text\[\]\)/), [
      ["direct", "inherited", "unset"],
    ]);
  });

  it("does not query for an empty portfolio", async () => {
    const query = vi.fn();
    await expect(readCatalogItemProductLineInputs({ query }, [])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
