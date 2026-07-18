import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const catalogScopeSyncStateSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_scope_sync_state (
  scope_key text NOT NULL,
  provider_key text NOT NULL,
  unit_key text NOT NULL,
  product_domain text NOT NULL,
  product_form text NULL,
  language_code text NULL,
  reference_kind text NULL,
  scope_record_id text NULL,
  display_name text NOT NULL,
  role text NOT NULL,
  requirement text NOT NULL,
  child_execution_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL,
  last_sync_run_id text NULL,
  last_job_id text NULL,
  last_operator_status text NULL,
  observed_count integer NULL,
  changed_count integer NULL,
  requested_count integer NULL,
  failed_count integer NULL,
  error_message text NULL,
  last_started_at timestamptz NULL,
  last_completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_key, provider_key, unit_key),
  CONSTRAINT catalog_scope_sync_state_state_check
    CHECK (state IN ('never-synced', 'pending', 'running', 'settled', 'failed', 'stale'))
);

CREATE INDEX IF NOT EXISTS catalog_scope_sync_state_scope_idx
  ON catalog_scope_sync_state (scope_key);

CREATE INDEX IF NOT EXISTS catalog_scope_sync_state_last_job_idx
  ON catalog_scope_sync_state (last_job_id)
  WHERE last_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS catalog_scope_sync_state_last_sync_run_idx
  ON catalog_scope_sync_state (last_sync_run_id)
  WHERE last_sync_run_id IS NOT NULL;`;

export const catalogScopeSyncStateSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260718_catalog_scope_sync_state_scope_record_id",
    description: "Converge existing scope sync state rows on canonical Scope Record linkage.",
    statements: ["ALTER TABLE catalog_scope_sync_state ADD COLUMN IF NOT EXISTS scope_record_id text NULL"],
  },
];
