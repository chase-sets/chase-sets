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
    const statements = catalogCountHistorySchemaMigrations.flatMap((migration) => migration.statements).join("\n");
    expect(statements).not.toMatch(/CREATE (?:UNIQUE )?INDEX|DROP (?:TABLE|COLUMN|INDEX)|TRUNCATE/);
    // The only DROP is the guarded event-kind constraint replacement asserted below.
    expect(statements.match(/\bDROP\b[^;\n]*/g)).toEqual([
      "DROP CONSTRAINT IF EXISTS catalog_scope_sync_count_history_event_kind_check",
    ]);
  });
  it("widens count history event kinds through one ledgered, lock-bounded upgrade with boot parity", () => {
    const kinds = "'usage', 'quoted', 'approved', 'debit', 'result', 'allocated', 'allocation-ended'";
    const check = `CONSTRAINT catalog_scope_sync_count_history_event_kind_check CHECK (event_kind IN (${kinds}))`;
    expect(catalogCountHistorySchemaSql).toContain(check);
    const [original, upgrade, ...rest] = catalogCountHistorySchemaMigrations;
    expect(rest).toEqual([]);
    expect(original!.migrationId).toBe("catalog-scope-sync-count-history-v1");
    expect(original!.statements.join("\n")).toContain(
      "event_kind text NOT NULL CHECK (event_kind IN ('usage', 'quoted', 'approved', 'debit', 'result'))",
    );
    expect(upgrade!.migrationId).toBe("catalog-scope-sync-count-history-v2-quote-allocation");
    expect(upgrade!.statements).toEqual([
      "SET lock_timeout = '5s'",
      "ALTER TABLE catalog_scope_sync_count_history DROP CONSTRAINT IF EXISTS catalog_scope_sync_count_history_event_kind_check",
      `ALTER TABLE catalog_scope_sync_count_history ADD ${check} NOT VALID`,
      "ALTER TABLE catalog_scope_sync_count_history VALIDATE CONSTRAINT catalog_scope_sync_count_history_event_kind_check",
    ]);
  });
});
