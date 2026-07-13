import { describe, expect, it } from "vitest";
import { catalogCatalogItemSchemaSql } from "../../features/catalog-items/read-model/schema";
import { catalogAuthoringSchemaMigrations, catalogAuthoringSchemaSql } from "../../support/authoring-support/schema";

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

describe("catalog authoring schema composition", () => {
  it("includes alias-equivalence persistence tables", () => {
    expect(catalogAuthoringSchemaSql).toContain("catalog_source_observation_alias_candidates");
    expect(catalogAuthoringSchemaSql).toContain("catalog_item_aliases");
    expect(catalogAuthoringSchemaSql).toContain("catalog_reference_record_aliases");
    expect(catalogAuthoringSchemaSql).toContain("catalog_provider_scope_mappings");
  });

  it("includes source-observation scope-summary concurrent index migrations", () => {
    expect(catalogAuthoringSchemaMigrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          migrationId: "20260703_catalog_source_observation_integration_scope_summaries",
        }),
      ]),
    );
  });

  it("includes the canonical-scope Merge Candidate wipe-and-rebuild migration", () => {
    expect(catalogAuthoringSchemaMigrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          migrationId: "20260713_catalog_merge_candidate_scope_identity_v2",
        }),
      ]),
    );
  });
});
