import { describe, expect, it } from "vitest";
import { catalogSourceObservationSchemaSql } from "./schema";

describe("catalogSourceObservationSchemaSql", () => {
  it("persists Catalog Merge Candidates with review, provenance, and promotion-planning shape", () => {
    expect(catalogSourceObservationSchemaSql).toContain("CREATE TABLE IF NOT EXISTS catalog_merge_candidates");
    expect(catalogSourceObservationSchemaSql).toContain("identity_fingerprint text NOT NULL");
    expect(catalogSourceObservationSchemaSql).toContain("matched_catalog_item_id text NULL");
    expect(catalogSourceObservationSchemaSql).toContain("matched_product_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(catalogSourceObservationSchemaSql).toContain(
      "proposed_catalog_item_facts_json jsonb NOT NULL DEFAULT '{}'::jsonb",
    );
    expect(catalogSourceObservationSchemaSql).toContain(
      "proposed_external_catalog_item_references_json jsonb NOT NULL DEFAULT '[]'::jsonb",
    );
    expect(catalogSourceObservationSchemaSql).toContain(
      "proposed_external_product_references_json jsonb NOT NULL DEFAULT '[]'::jsonb",
    );
    expect(catalogSourceObservationSchemaSql).toContain("conflicts_json jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(catalogSourceObservationSchemaSql).toContain("warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(catalogSourceObservationSchemaSql).toContain("field_provenance_json jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(catalogSourceObservationSchemaSql).toContain(
      "CHECK (promotion_intent IN ('create-catalog-item', 'update-catalog-item', 'link-existing-catalog-item'))",
    );
  });

  it("persists candidate membership without destructive Source Observation ownership", () => {
    expect(catalogSourceObservationSchemaSql).toContain(
      "CREATE TABLE IF NOT EXISTS catalog_merge_candidate_observations",
    );
    expect(catalogSourceObservationSchemaSql).toContain("PRIMARY KEY (candidate_id, observation_id)");
    expect(catalogSourceObservationSchemaSql).toContain(
      "CREATE INDEX IF NOT EXISTS catalog_merge_candidate_observations_observation_idx",
    );
    expect(catalogSourceObservationSchemaSql).toContain(
      "REFERENCES catalog_merge_candidates (candidate_id)\n    ON DELETE CASCADE",
    );
    expect(catalogSourceObservationSchemaSql).not.toContain("REFERENCES catalog_source_observations");
  });

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
