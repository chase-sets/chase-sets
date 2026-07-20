import { describe, expect, it } from "vitest";
import { catalogSourceObservationSchemaMigrations, catalogSourceObservationSchemaSql } from "./schema";

describe("catalogSourceObservationSchemaSql", () => {
  it("creates replay-only payload assembly storage without boot-time data reshapes", () => {
    expect(catalogSourceObservationSchemaSql).toContain(
      "CREATE UNLOGGED TABLE IF NOT EXISTS catalog_source_observation_payload_assemblies",
    );
    expect(catalogSourceObservationSchemaSql).toContain("encoded_chunks jsonb NOT NULL DEFAULT '[]'::jsonb");
  });

  it("creates source-observation integration scope summary storage without boot-time backfill/index rebuilds", () => {
    expect(catalogSourceObservationSchemaSql).toContain(
      "CREATE TABLE IF NOT EXISTS catalog_source_observation_integration_scope_summaries",
    );
    expect(catalogSourceObservationSchemaSql).toContain(
      "PRIMARY KEY (provider_key, language_code, product_line_id, series_id, expansion_id)",
    );
    expect(catalogSourceObservationSchemaSql).not.toContain(
      "INSERT INTO catalog_source_observation_integration_scope_summaries",
    );
    expect(catalogSourceObservationSchemaSql).not.toContain(
      "CREATE INDEX IF NOT EXISTS catalog_source_observation_integration_scope_summaries_lookup_idx",
    );
  });

  it("backfills and indexes source-observation integration scope summaries through ledgered migrations", () => {
    expect(catalogSourceObservationSchemaMigrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          migrationId: "20260703_catalog_source_observation_required_source_profile_columns",
          statements: [
            "SET LOCAL lock_timeout = '5s';",
            expect.stringContaining("ALTER COLUMN source_profile_key SET NOT NULL"),
          ],
        }),
        expect.objectContaining({
          migrationId: "20260703_catalog_source_observation_integration_scope_summaries",
          statements: [
            expect.stringContaining("INSERT INTO catalog_source_observation_integration_scope_summaries"),
            expect.stringContaining(
              "CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_source_observation_integration_scope_summaries_lookup_idx",
            ),
            expect.stringContaining(
              "CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_source_observation_integration_scope_summaries_latest_idx",
            ),
          ],
        }),
      ]),
    );
  });

  it("ledgers provider-profile and option-query-cache reshapes", () => {
    expect(catalogSourceObservationSchemaSql).not.toContain("DROP COLUMN IF EXISTS compatibility_mode");
    expect(catalogSourceObservationSchemaSql).not.toContain(
      "DROP INDEX IF EXISTS catalog_provider_integration_profile_versions_active_idx",
    );
    expect(catalogSourceObservationSchemaSql).not.toContain("UPDATE catalog_provider_option_query_cache");
    expect(catalogSourceObservationSchemaSql).not.toContain("ALTER COLUMN ingestion_unit_key SET NOT NULL");
    expect(catalogSourceObservationSchemaSql).not.toContain(
      "DROP INDEX IF EXISTS catalog_provider_option_query_cache_lookup_idx",
    );

    expect(catalogSourceObservationSchemaMigrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          migrationId: "20260703_catalog_provider_profile_active_index_scope",
          statements: [
            "SET LOCAL lock_timeout = '5s';",
            expect.stringContaining("DROP COLUMN IF EXISTS compatibility_mode"),
            expect.stringContaining(
              "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS catalog_provider_integration_profile_versions_active_idx",
            ),
          ],
        }),
        expect.objectContaining({
          migrationId: "20260703_catalog_provider_option_query_cache_profile_lookup",
          statements: [
            "SET LOCAL lock_timeout = '5s';",
            expect.stringContaining("UPDATE catalog_provider_option_query_cache"),
            expect.stringContaining("ALTER COLUMN ingestion_unit_key SET NOT NULL"),
            expect.stringContaining("DROP INDEX IF EXISTS catalog_provider_option_query_cache_lookup_idx"),
            expect.stringContaining(
              "CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_provider_option_query_cache_lookup_idx",
            ),
          ],
        }),
      ]),
    );
  });

  it("second boot after migrations has no source-observation index reshapes or update backfills", () => {
    const queryLog: string[] = [];
    const appliedMigrations = new Set(
      catalogSourceObservationSchemaMigrations.map((migration) => migration.migrationId),
    );
    const runBoot = () => {
      queryLog.push(catalogSourceObservationSchemaSql);
      for (const migration of catalogSourceObservationSchemaMigrations) {
        if (appliedMigrations.has(migration.migrationId)) {
          continue;
        }
        queryLog.push(...migration.statements);
        appliedMigrations.add(migration.migrationId);
      }
    };

    runBoot();

    expect(queryLog.join("\n")).not.toMatch(/\bDROP\s+INDEX\b/i);
    expect(queryLog.join("\n")).not.toMatch(/\bUPDATE\s+catalog_/i);
    expect(queryLog.join("\n")).not.toMatch(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i);
  });

  it("persists Catalog Merge Candidates with review, provenance, and promotion-planning shape", () => {
    expect(catalogSourceObservationSchemaSql).toContain("CREATE TABLE IF NOT EXISTS catalog_merge_candidates");
    expect(catalogSourceObservationSchemaSql).toContain("scope_record_id text NOT NULL");
    expect(catalogSourceObservationSchemaSql).toContain("REFERENCES catalog_scope_records (scope_record_id)");
    expect(catalogSourceObservationSchemaSql).toContain("identity_fingerprint text NOT NULL");
    expect(catalogSourceObservationSchemaSql).toContain("sync_run_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb");
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

  it("wipes v1 candidate identity through a pinned migration and rebuilds only from preserved inputs", () => {
    const migration = catalogSourceObservationSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20260713_catalog_merge_candidate_scope_identity_v2",
    );

    expect(migration).toEqual(
      expect.objectContaining({
        statements: [
          "SET LOCAL lock_timeout = '5s';",
          expect.stringContaining("ADD COLUMN IF NOT EXISTS scope_record_id text NULL"),
          expect.stringMatching(
            /DELETE FROM catalog_merge_candidate_observations;[\s\S]*DELETE FROM catalog_merge_candidates;[\s\S]*DELETE FROM event_store_streams/,
          ),
          expect.stringContaining("ALTER COLUMN scope_record_id SET NOT NULL"),
          expect.stringContaining("REFERENCES catalog_scope_records (scope_record_id)"),
          expect.stringContaining("CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_merge_candidates_scope_record_idx"),
        ],
      }),
    );
    expect(migration?.statements.join("\n")).not.toContain("catalog_source_observations");
    expect(migration?.statements.join("\n")).not.toContain("DELETE FROM catalog_provider_scope_mappings");
  });

  it("persists candidate membership without destructive Source Observation ownership", () => {
    expect(catalogSourceObservationSchemaSql).toContain(
      "CREATE TABLE IF NOT EXISTS catalog_merge_candidate_observations",
    );
    expect(catalogSourceObservationSchemaSql).toContain("PRIMARY KEY (candidate_id, observation_id)");
    expect(catalogSourceObservationSchemaSql).toContain(
      "CREATE INDEX IF NOT EXISTS catalog_merge_candidate_observations_observation_idx",
    );
    expect(catalogSourceObservationSchemaSql).toContain("sync_run_id text NULL");
    const compatibilityIndexes = catalogSourceObservationSchemaMigrations.find(
      (migration) => migration.migrationId === "20260713_catalog_source_observation_compatibility_indexes",
    );
    expect(compatibilityIndexes?.statements.join("\n")).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_merge_candidate_observations_sync_run_idx",
    );
    expect(compatibilityIndexes?.statements.join("\n")).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_source_observations_sync_run_idx",
    );
    expect(catalogSourceObservationSchemaSql).toContain(
      "CREATE INDEX IF NOT EXISTS catalog_source_observations_observed_at_idx",
    );
    expect(catalogSourceObservationSchemaSql).toContain(
      "ON catalog_source_observations (observed_at DESC, observation_id ASC)",
    );
    expect(catalogSourceObservationSchemaSql).toContain(
      "REFERENCES catalog_merge_candidates (candidate_id)\n    ON DELETE CASCADE",
    );
    expect(catalogSourceObservationSchemaSql).not.toContain("REFERENCES catalog_source_observations");
  });

  it("evolves Catalog Merge Candidate columns in boot SQL and indexes compatibility columns through the ledger", () => {
    const candidateAlterPosition = catalogSourceObservationSchemaSql.indexOf("ALTER TABLE catalog_merge_candidates");
    const candidateIndexPosition = catalogSourceObservationSchemaSql.indexOf(
      "CREATE INDEX IF NOT EXISTS catalog_merge_candidates_sync_run_ids_idx",
    );
    const observationAlterPosition = catalogSourceObservationSchemaSql.indexOf(
      "ALTER TABLE catalog_merge_candidate_observations",
    );

    expect(candidateAlterPosition).toBeGreaterThan(0);
    expect(candidateIndexPosition).toBeGreaterThan(candidateAlterPosition);
    expect(observationAlterPosition).toBeGreaterThan(0);
    expect(catalogSourceObservationSchemaSql).toContain(
      "ADD COLUMN IF NOT EXISTS sync_run_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb",
    );
    expect(catalogSourceObservationSchemaSql).toContain("ADD COLUMN IF NOT EXISTS scope_record_id text NULL");
    expect(catalogSourceObservationSchemaSql).toContain(
      "ADD COLUMN IF NOT EXISTS matched_product_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb",
    );
    expect(catalogSourceObservationSchemaSql).toContain(
      "ADD COLUMN IF NOT EXISTS proposed_external_product_references_json jsonb NOT NULL DEFAULT '[]'::jsonb",
    );
    expect(catalogSourceObservationSchemaSql).toContain("ADD COLUMN IF NOT EXISTS promotion_intent text NOT NULL");
    expect(catalogSourceObservationSchemaSql).toContain("ALTER COLUMN identity_fingerprint DROP DEFAULT");
    expect(catalogSourceObservationSchemaSql).toContain("catalog_merge_candidates_promotion_intent_check");
    expect(catalogSourceObservationSchemaSql).toContain("ADD COLUMN IF NOT EXISTS sync_run_id text NULL");
    expect(catalogSourceObservationSchemaSql).toContain("ADD COLUMN IF NOT EXISTS provider_key text NOT NULL");
    expect(catalogSourceObservationSchemaSql).toContain(
      "ADD COLUMN IF NOT EXISTS source_profile_version text NOT NULL",
    );
    const compatibilityIndexes = catalogSourceObservationSchemaMigrations.find(
      (migration) => migration.migrationId === "20260713_catalog_source_observation_compatibility_indexes",
    );
    expect(compatibilityIndexes?.statements.join("\n")).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_merge_candidates_updated_idx",
    );
    expect(compatibilityIndexes?.statements.join("\n")).toContain(
      "ON catalog_merge_candidates (updated_at DESC, candidate_id ASC)",
    );
  });

  it("adds provider option query cache profile columns in boot SQL and ledgers lookup indexing", () => {
    const alterPosition = catalogSourceObservationSchemaSql.indexOf("ALTER TABLE catalog_provider_option_query_cache");

    expect(alterPosition).toBeGreaterThan(0);
    expect(catalogSourceObservationSchemaSql).not.toContain(
      "CREATE INDEX IF NOT EXISTS catalog_provider_option_query_cache_lookup_idx",
    );
    expect(catalogSourceObservationSchemaSql).toContain("ADD COLUMN IF NOT EXISTS profile_key text DEFAULT ''");
    expect(catalogSourceObservationSchemaSql).toContain("ADD COLUMN IF NOT EXISTS ingestion_unit_key text DEFAULT ''");
    expect(catalogSourceObservationSchemaSql).not.toContain("ALTER COLUMN profile_key SET NOT NULL");
    expect(catalogSourceObservationSchemaSql).not.toContain("ALTER COLUMN ingestion_unit_key SET NOT NULL");
    expect(catalogSourceObservationSchemaSql).not.toContain(
      "DROP INDEX IF EXISTS catalog_provider_option_query_cache_lookup_idx",
    );
  });
});
