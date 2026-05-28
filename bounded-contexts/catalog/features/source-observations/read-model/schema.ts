export const catalogSourceObservationSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_source_observations (
  observation_id text PRIMARY KEY,
  provider_key text NOT NULL,
  external_key text NOT NULL,
  source_url text NOT NULL,
  language_code text NOT NULL,
  source_record_hash text NOT NULL,
  source_updated_at timestamptz NULL,
  observed_at timestamptz NOT NULL,
  normalized jsonb NOT NULL,
  source_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'observed',
  status_reason text NULL,
  promoted_catalog_item_id text NULL,
  promoted_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_key, language_code, external_key)
);

CREATE INDEX IF NOT EXISTS catalog_source_observations_provider_idx
  ON catalog_source_observations (provider_key, language_code);
CREATE INDEX IF NOT EXISTS catalog_source_observations_status_idx
  ON catalog_source_observations (status);
CREATE INDEX IF NOT EXISTS catalog_source_observations_name_idx
  ON catalog_source_observations USING gin (
    to_tsvector(
      'simple',
      coalesce(normalized->>'name', '') || ' ' || coalesce(normalized->>'expansionName', normalized->>'setName', '') || ' ' || external_key
    )
  );

CREATE TABLE IF NOT EXISTS catalog_source_observation_bulk_jobs (
  job_id text PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('promote', 'reject', 'reapply')),
  selection_mode text NOT NULL CHECK (selection_mode IN ('ids', 'filter')),
  observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NULL,
  event_context jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  progress jsonb NOT NULL,
  result jsonb NULL,
  error_message text NULL,
  claim_owner_id text NULL,
  claim_expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_source_observation_bulk_jobs_status_idx
  ON catalog_source_observation_bulk_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS catalog_source_observation_bulk_jobs_claim_idx
  ON catalog_source_observation_bulk_jobs (claim_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS catalog_source_observation_integration_jobs (
  job_id text PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('import', 'reapply')),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_context jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  progress jsonb NOT NULL,
  result jsonb NULL,
  error_message text NULL,
  claim_owner_id text NULL,
  claim_expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_source_observation_integration_jobs_status_idx
  ON catalog_source_observation_integration_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS catalog_source_observation_integration_jobs_claim_idx
  ON catalog_source_observation_integration_jobs (claim_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS catalog_source_observation_job_events (
  job_kind text NOT NULL CHECK (job_kind IN ('bulk-review', 'integration')),
  job_id text NOT NULL,
  sequence bigint NOT NULL,
  event_name text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_kind, job_id, sequence)
);

CREATE INDEX IF NOT EXISTS catalog_source_observation_job_events_lookup_idx
  ON catalog_source_observation_job_events (job_kind, job_id, sequence);`;
