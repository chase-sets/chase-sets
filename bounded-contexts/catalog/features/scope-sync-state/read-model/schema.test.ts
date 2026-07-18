import { describe, expect, it } from "vitest";
import { catalogScopeSyncStateSchemaMigrations, catalogScopeSyncStateSchemaSql } from "./schema";

describe("catalogScopeSyncStateSchemaSql", () => {
  it("defines the durable per-scope-per-provider-unit sync state table", () => {
    expect(catalogScopeSyncStateSchemaSql).toContain("CREATE TABLE IF NOT EXISTS catalog_scope_sync_state");
    expect(catalogScopeSyncStateSchemaSql).toContain("PRIMARY KEY (scope_key, provider_key, unit_key)");
    expect(catalogScopeSyncStateSchemaSql).toContain(
      "CHECK (state IN ('never-synced', 'pending', 'running', 'settled', 'failed', 'stale'))",
    );
    expect(catalogScopeSyncStateSchemaSql).toContain("child_execution_scope jsonb NOT NULL");
    expect(catalogScopeSyncStateSchemaSql).toContain("last_sync_run_id text NULL");
    expect(catalogScopeSyncStateSchemaSql).toContain("last_job_id text NULL");
    expect(catalogScopeSyncStateSchemaSql).toContain("observed_count integer NULL");
    expect(catalogScopeSyncStateSchemaSql).toContain("changed_count integer NULL");
  });

  it("converges existing sync state tables on Scope Record linkage", () => {
    const migration = catalogScopeSyncStateSchemaMigrations.find(
      (entry) => entry.migrationId === "20260718_catalog_scope_sync_state_scope_record_id",
    );

    expect(migration?.statements).toEqual([
      "ALTER TABLE catalog_scope_sync_state ADD COLUMN IF NOT EXISTS scope_record_id text NULL",
    ]);
  });
});
