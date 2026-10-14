export const countCaptureTableSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_scope_sync_count_capture_history (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL,
  owner_hash text NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);`;

// The new table's indexes are installed by boot before any capture writes; no populated-table index migration is needed.
export const countCaptureSchemaSql = `${countCaptureTableSchemaSql}
CREATE INDEX IF NOT EXISTS catalog_count_capture_run_idx
  ON catalog_scope_sync_count_capture_history (run_id, position DESC);
CREATE INDEX IF NOT EXISTS catalog_count_capture_owner_idx
  ON catalog_scope_sync_count_capture_history (owner_hash, position DESC);`;

export const countCaptureSchemaMigrations = [
  {
    migrationId: "catalog-scope-sync-count-capture-history-v1",
    description: "Retain append-only staging count-capture runs and their possible-send debits.",
    statements: [countCaptureTableSchemaSql],
  },
];
