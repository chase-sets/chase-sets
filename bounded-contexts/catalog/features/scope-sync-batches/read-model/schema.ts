export const catalogScopeSyncBatchSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_scope_sync_batches (
  batch_id text PRIMARY KEY,
  selection jsonb NOT NULL,
  budget jsonb NOT NULL,
  plan_fingerprint text NOT NULL,
  preview jsonb NOT NULL,
  status text NOT NULL,
  event_context jsonb NOT NULL,
  fast_no_op boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  CONSTRAINT catalog_scope_sync_batches_status_check
    CHECK (status IN ('queued', 'running', 'cancelled', 'completed', 'partial', 'failed'))
);

CREATE INDEX IF NOT EXISTS catalog_scope_sync_batches_context_status_idx
  ON catalog_scope_sync_batches ((event_context->'audit'->>'forAccountId'), status, updated_at DESC);

CREATE INDEX IF NOT EXISTS catalog_scope_sync_batches_settled_fingerprint_lookup_idx
  ON catalog_scope_sync_batches (
    (event_context->'audit'->>'forAccountId'),
    (event_context->'audit'->>'performedByUserId'),
    plan_fingerprint
  )
  WHERE status = 'completed';

CREATE TABLE IF NOT EXISTS catalog_scope_sync_batch_units (
  batch_id text NOT NULL REFERENCES catalog_scope_sync_batches (batch_id) ON DELETE CASCADE,
  scope_record_id text NOT NULL,
  ordinal integer NOT NULL,
  plan jsonb NOT NULL,
  provider_keys text[] NOT NULL DEFAULT '{}'::text[],
  state text NOT NULL DEFAULT 'queued',
  sync_run_id text NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  error_message text NULL,
  claim_owner_id text NULL,
  claimed_until timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  PRIMARY KEY (batch_id, scope_record_id),
  CONSTRAINT catalog_scope_sync_batch_units_state_check
    CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS catalog_scope_sync_batch_units_claim_idx
  ON catalog_scope_sync_batch_units (state, claimed_until, batch_id, ordinal)
  WHERE state IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS catalog_scope_sync_batch_units_provider_idx
  ON catalog_scope_sync_batch_units USING gin (provider_keys);`;
