import { describe, expect, it } from "vitest";
import { catalogScopeSyncBatchSchemaSql } from "./schema";

describe("Scope Sync Batch schema", () => {
  it("persists restart-safe batches and bounded scope work units", () => {
    expect(catalogScopeSyncBatchSchemaSql).toContain("CREATE TABLE IF NOT EXISTS catalog_scope_sync_batches");
    expect(catalogScopeSyncBatchSchemaSql).toContain("CREATE TABLE IF NOT EXISTS catalog_scope_sync_batch_units");
    expect(catalogScopeSyncBatchSchemaSql).toContain("claimed_until timestamptz NULL");
    expect(catalogScopeSyncBatchSchemaSql).toContain("plan_fingerprint text NOT NULL");
    expect(catalogScopeSyncBatchSchemaSql).not.toMatch(/DROP TABLE|TRUNCATE|ALTER COLUMN .* SET NOT NULL/);
  });
});
