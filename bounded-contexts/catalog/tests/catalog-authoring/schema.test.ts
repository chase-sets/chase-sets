import { describe, expect, it } from "vitest";
import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
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

  it("clears grants and drops retired TCGplayer custody tables in one idempotent migration", () => {
    const migration: BcSchemaMigration | undefined = catalogAuthoringSchemaMigrations.find(
      ({ migrationId }) => migrationId === "20261018_catalog_remove_tcgplayer_server_custody",
    );
    expect(migration).toBeDefined();
    expect(migration?.statements).toEqual([
      "SET LOCAL lock_timeout = '5s';",
      "DROP TABLE IF EXISTS catalog_tcgplayer_operator_session_outcomes",
      "DROP TABLE IF EXISTS catalog_tcgplayer_operator_sessions",
    ]);
    expect(migration?.dataStep).toBeTypeOf("function");
  });

  it("does not create retired custody tables on a fresh database", () => {
    expect(catalogAuthoringSchemaSql).not.toContain("CREATE TABLE IF NOT EXISTS catalog_tcgplayer_operator_sessions");
    expect(catalogAuthoringSchemaSql).not.toContain(
      "CREATE TABLE IF NOT EXISTS catalog_tcgplayer_operator_session_outcomes",
    );
  });
});
