import { describe, expect, it } from "vitest";
import { catalogScopeSyncBatchSchemaSql } from "./schema";
import { catalogCountHistorySchemaSql, catalogCountHistorySchemaMigrations } from "./count-schema";

describe("Scope Sync Batch schema", () => {
  it("persists restart-safe batches and bounded scope work units", () => {
    expect(catalogScopeSyncBatchSchemaSql).toContain("CREATE TABLE IF NOT EXISTS catalog_scope_sync_batches");
    expect(catalogScopeSyncBatchSchemaSql).toContain("CREATE TABLE IF NOT EXISTS catalog_scope_sync_batch_units");
    expect(catalogScopeSyncBatchSchemaSql).toContain("claimed_until timestamptz NULL");
    expect(catalogScopeSyncBatchSchemaSql).toContain("plan_fingerprint text NOT NULL");
    expect(catalogScopeSyncBatchSchemaSql).not.toMatch(/DROP TABLE|TRUNCATE|ALTER COLUMN .* SET NOT NULL/);
  });
  it("creates count claim/result indexes during new-table boot, not a populated-table migration", () => {
    expect(catalogCountHistorySchemaSql).toContain("CREATE TABLE IF NOT EXISTS catalog_scope_sync_count_history");
    expect(catalogCountHistorySchemaSql).toContain("catalog_count_history_quote_claim_idx");
    expect(catalogCountHistorySchemaSql).toContain("catalog_count_history_result_idx");
    expect(catalogCountHistorySchemaMigrations.flatMap((migration) => migration.statements).join("\n")).not.toMatch(
      /CREATE (?:UNIQUE )?INDEX|DROP|TRUNCATE/,
    );
  });
});
