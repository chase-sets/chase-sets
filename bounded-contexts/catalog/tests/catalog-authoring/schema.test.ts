import { describe, expect, it } from "vitest";
import { catalogCatalogItemSchemaSql } from "../../features/catalog-items/read-model/schema";

describe("catalog item schema migrations", () => {
  it("adds compatibility columns before creating indexes that depend on them", () => {
    const addLanguageColumnIndex = catalogCatalogItemSchemaSql.indexOf(
      "ALTER TABLE catalog_admin_catalog_item_list_pages",
    );
    const languageIndexIndex = catalogCatalogItemSchemaSql.indexOf(
      "catalog_admin_catalog_item_list_pages_language_idx",
    );

    expect(addLanguageColumnIndex).toBeGreaterThanOrEqual(0);
    expect(languageIndexIndex).toBeGreaterThanOrEqual(0);
    expect(addLanguageColumnIndex).toBeLessThan(languageIndexIndex);
  });
});
