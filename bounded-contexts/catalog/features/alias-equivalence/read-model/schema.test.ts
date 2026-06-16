import { describe, expect, it } from "vitest";
import { catalogAliasEquivalenceSchemaSql } from "./schema";
import { catalogAuthoringSchemaSql } from "../../../support/authoring-support/schema";

describe("Catalog Alias schema", () => {
  it("declares the three alias tables with idempotent CREATE statements", () => {
    for (const table of [
      "catalog_source_observation_alias_candidates",
      "catalog_item_aliases",
      "catalog_reference_record_aliases",
    ]) {
      expect(catalogAliasEquivalenceSchemaSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("enforces uniqueness/dedupe via alias_hash primary keys", () => {
    const primaryKeyMatches = catalogAliasEquivalenceSchemaSql.match(/alias_hash text PRIMARY KEY/g) ?? [];
    expect(primaryKeyMatches).toHaveLength(3);
  });

  it("constrains review states to the ADR-locked set", () => {
    expect(catalogAliasEquivalenceSchemaSql).toContain(
      "review_status IN ('pending', 'accepted', 'auto-accepted', 'rejected', 'revoked')",
    );
  });

  it("restricts reference-record alias types to set/series equivalents", () => {
    expect(catalogAliasEquivalenceSchemaSql).toContain("alias_type IN ('set-equivalent', 'series-equivalent')");
  });

  it("creates index columns only after the tables that hold them", () => {
    const tableIndex = catalogAliasEquivalenceSchemaSql.indexOf("CREATE TABLE IF NOT EXISTS catalog_item_aliases");
    const indexIndex = catalogAliasEquivalenceSchemaSql.indexOf("catalog_item_aliases_published_idx");
    expect(tableIndex).toBeGreaterThanOrEqual(0);
    expect(indexIndex).toBeGreaterThan(tableIndex);
  });

  it("is composed into the catalog authoring schema", () => {
    expect(catalogAuthoringSchemaSql).toContain("catalog_source_observation_alias_candidates");
    expect(catalogAuthoringSchemaSql).toContain("catalog_item_aliases");
    expect(catalogAuthoringSchemaSql).toContain("catalog_reference_record_aliases");
  });

  it("partial publishable indexes only cover accepted and auto-accepted rows", () => {
    const publishablePartials =
      catalogAliasEquivalenceSchemaSql.match(/WHERE review_status IN \('accepted', 'auto-accepted'\)/g) ?? [];
    expect(publishablePartials.length).toBeGreaterThanOrEqual(2);
  });
});
