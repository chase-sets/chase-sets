import { describe, expect, it } from "vitest";
import { catalogSourceObservationSchemaSql } from "./schema";

describe("catalogSourceObservationSchemaSql", () => {
  it("evolves provider option query cache profile columns before lookup indexing", () => {
    const alterPosition = catalogSourceObservationSchemaSql.indexOf("ALTER TABLE catalog_provider_option_query_cache");
    const indexPosition = catalogSourceObservationSchemaSql.indexOf(
      "CREATE INDEX IF NOT EXISTS catalog_provider_option_query_cache_lookup_idx",
    );

    expect(alterPosition).toBeGreaterThan(0);
    expect(indexPosition).toBeGreaterThan(alterPosition);
    expect(catalogSourceObservationSchemaSql).toContain("ADD COLUMN IF NOT EXISTS profile_key text DEFAULT ''");
    expect(catalogSourceObservationSchemaSql).toContain("ADD COLUMN IF NOT EXISTS ingestion_unit_key text DEFAULT ''");
    expect(catalogSourceObservationSchemaSql).toContain("ALTER COLUMN profile_key SET NOT NULL");
    expect(catalogSourceObservationSchemaSql).toContain("ALTER COLUMN ingestion_unit_key SET NOT NULL");
    expect(
      catalogSourceObservationSchemaSql.indexOf("DROP INDEX IF EXISTS catalog_provider_option_query_cache_lookup_idx"),
    ).toBeGreaterThan(alterPosition);
  });
});
