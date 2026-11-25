export const catalogSetNameRequestSchemaSql = `
CREATE TABLE IF NOT EXISTS catalog_set_name_requests (
  job_id text NOT NULL REFERENCES catalog_source_observation_integration_durable_jobs(job_id) ON DELETE CASCADE,
  generation integer NOT NULL,
  execution_key text NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  product_line_id integer NOT NULL CHECK (product_line_id > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline timestamptz,
  attempt_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  environment text,
  grant_id text,
  closed_at timestamptz,
  answer_digest text,
  receipt jsonb,
  PRIMARY KEY (job_id, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_set_name_requests_open_execution
  ON catalog_set_name_requests (execution_key) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS catalog_set_name_requests_active
  ON catalog_set_name_requests ((true)) WHERE closed_at IS NULL AND deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_set_name_requests_fifo
  ON catalog_set_name_requests (created_at, job_id) WHERE closed_at IS NULL AND deadline IS NULL;
CREATE TABLE IF NOT EXISTS catalog_set_name_request_run_links (
  sync_run_id text PRIMARY KEY REFERENCES catalog_source_observation_integration_durable_jobs(job_id) ON DELETE CASCADE,
  child_job_id text NOT NULL REFERENCES catalog_source_observation_integration_durable_jobs(job_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS catalog_set_name_request_run_links_child
  ON catalog_set_name_request_run_links (child_job_id);
-- One parent may fan out a line refresh and a sealed child. The legacy link table
-- retains its original refresh-only key; sealed links use a distinct slot.
CREATE TABLE IF NOT EXISTS catalog_sealed_request_run_links (
  sync_run_id text PRIMARY KEY REFERENCES catalog_source_observation_integration_durable_jobs(job_id) ON DELETE CASCADE,
  child_job_id text NOT NULL REFERENCES catalog_source_observation_integration_durable_jobs(job_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS catalog_sealed_request_run_links_child
  ON catalog_sealed_request_run_links (child_job_id);
CREATE TABLE IF NOT EXISTS catalog_sealed_request_parts (
  request_id uuid NOT NULL REFERENCES catalog_set_name_requests(request_id) ON DELETE CASCADE,
  part_index integer NOT NULL CHECK (part_index BETWEEN 0 AND 499),
  digest text NOT NULL,
  byte_count integer NOT NULL,
  product_ids integer[] NOT NULL,
  post jsonb,
  PRIMARY KEY (request_id, part_index)
);
CREATE INDEX IF NOT EXISTS catalog_set_name_batch_run_dispatch
  ON catalog_source_observation_integration_durable_jobs ((payload->>'idempotencyKey'))
  WHERE job_kind = 'catalog-sync-scope';
`;
