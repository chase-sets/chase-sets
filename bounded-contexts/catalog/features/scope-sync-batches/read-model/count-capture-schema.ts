export const countCaptureSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_scope_sync_count_capture_history (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL,
  owner_hash text NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS catalog_count_capture_run_idx ON catalog_scope_sync_count_capture_history (run_id,position DESC);
CREATE INDEX IF NOT EXISTS catalog_count_capture_owner_idx ON catalog_scope_sync_count_capture_history (owner_hash,position DESC);
CREATE INDEX IF NOT EXISTS catalog_count_capture_dispatch_idx ON catalog_scope_sync_count_capture_history ((payload->'authority'->>'dispatchId'));`;

export const countCaptureSchemaMigrations = [
  {
    migrationId: "catalog-count-capture-history-v1",
    description: "Retain staging count capture phases and possible sends without import capabilities.",
    statements: [countCaptureSchemaSql],
  },
];
