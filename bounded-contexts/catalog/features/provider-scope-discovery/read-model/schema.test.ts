import { describe, expect, it } from "vitest";
import { catalogProviderScopeDiscoverySchemaMigrations, catalogProviderScopeDiscoverySchemaSql } from "./schema";

describe("Provider Scope Discovery schema", () => {
  it("persists provider-unit scope observations with hash-deduped natural identity", () => {
    expect(catalogProviderScopeDiscoverySchemaSql).toContain("unit_key text NOT NULL");
    expect(catalogProviderScopeDiscoverySchemaSql).toContain("scope_kind text NOT NULL");
    expect(catalogProviderScopeDiscoverySchemaSql).toContain("parents jsonb NOT NULL");
    expect(catalogProviderScopeDiscoverySchemaSql).toContain("observation_hash text NOT NULL");
    expect(catalogProviderScopeDiscoverySchemaSql).toContain(
      "PRIMARY KEY (provider_key, unit_key, scope_kind, language_code, external_id)",
    );
  });

  it("keeps canonical scope proposals reviewable without changing mapping review history", () => {
    expect(catalogProviderScopeDiscoverySchemaSql).toContain(
      "CREATE TABLE IF NOT EXISTS catalog_scope_record_proposals",
    );
    expect(catalogProviderScopeDiscoverySchemaSql).toContain(
      "CHECK (review_status IN ('proposed', 'accepted', 'rejected'))",
    );

    const migration = catalogProviderScopeDiscoverySchemaMigrations.find(
      (candidate) => candidate.migrationId === "20260714_catalog_provider_scope_observation_identity_v2",
    );
    const migrationSql = migration?.statements.join("\n") ?? "";
    expect(migrationSql).toContain("DROP TABLE IF EXISTS catalog_provider_scope_observations");
    expect(migrationSql.match(/CREATE INDEX CONCURRENTLY/g)).toHaveLength(3);
    expect(migrationSql).not.toMatch(/CREATE INDEX(?! CONCURRENTLY)/);
    expect(migrationSql).not.toContain("catalog_provider_scope_mappings");
    expect(migrationSql).not.toContain("catalog_scope_records");
  });
});
