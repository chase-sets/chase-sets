import { describe, expect, it } from "vitest";
import { catalogProviderScopeMappingSchemaSql } from "./schema";

describe("catalogProviderScopeMappingSchemaSql", () => {
  it("persists provider coordinates with accepted-query indexes", () => {
    expect(catalogProviderScopeMappingSchemaSql).toContain(
      "CREATE TABLE IF NOT EXISTS catalog_provider_scope_mappings",
    );
    expect(catalogProviderScopeMappingSchemaSql).toContain("UNIQUE (scope_record_id, provider_key, unit_key)");
    expect(catalogProviderScopeMappingSchemaSql).toContain("product_line_id text NULL");
    expect(catalogProviderScopeMappingSchemaSql).toContain("series_id text NULL");
    expect(catalogProviderScopeMappingSchemaSql).toContain("set_id text NULL");
    expect(catalogProviderScopeMappingSchemaSql).toContain("set_name text NULL");
    expect(catalogProviderScopeMappingSchemaSql).toContain("language_coordinates jsonb NOT NULL");
    expect(catalogProviderScopeMappingSchemaSql).toContain("review_status IN ('accepted', 'auto-accepted')");
  });
});
