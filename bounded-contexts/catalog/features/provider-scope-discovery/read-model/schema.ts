import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

// Provider Scope Discovery owns two plain (non-event-sourced) operational
// tables, mirroring the existing `catalog_provider_option_query_cache`
// precedent in source-observations: this is re-fetchable provider evidence,
// not an irreplaceable business fact, so it is stored as directly-written
// state rather than a projected event stream.
//
// `catalog_provider_scope_observations` is the durable snapshot of "what
// scope options (series/expansions/sets/product-lines) does this provider
// currently expose" that the future Provider Scope Mapping matcher
// reads to propose candidates. `catalog_provider_refresh_schedule` is the
// per-provider cadence/pause bookkeeping the scheduled refresh reads and
// writes each run.
export const catalogProviderScopeDiscoverySchemaSql = `CREATE TABLE IF NOT EXISTS catalog_provider_scope_observations (
  provider_key text NOT NULL,
  query_kind text NOT NULL,
  language_code text NOT NULL,
  option_external_key text NOT NULL,
  display_name text NOT NULL,
  parent_value text NULL,
  image_url text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  scan_id text NOT NULL,
  scanned_at timestamptz NOT NULL,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, query_kind, language_code, option_external_key)
);

CREATE INDEX IF NOT EXISTS catalog_provider_scope_observations_scan_idx
  ON catalog_provider_scope_observations (scan_id);

CREATE INDEX IF NOT EXISTS catalog_provider_scope_observations_lookup_idx
  ON catalog_provider_scope_observations (provider_key, query_kind, parent_value);

CREATE TABLE IF NOT EXISTS catalog_provider_refresh_schedule (
  provider_key text PRIMARY KEY,
  schedule_enabled boolean NOT NULL,
  manual_only boolean NOT NULL DEFAULT false,
  credit_aware boolean NOT NULL DEFAULT false,
  interval_ms bigint NOT NULL,
  paused boolean NOT NULL DEFAULT false,
  paused_by text NULL,
  paused_reason text NULL,
  paused_at timestamptz NULL,
  next_run_at timestamptz NULL,
  last_run_started_at timestamptz NULL,
  last_run_completed_at timestamptz NULL,
  last_run_status text NULL,
  last_run_observation_count integer NULL,
  last_run_error text NULL,
  last_run_triggered_by text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_provider_refresh_schedule_status_check
    CHECK (last_run_status IS NULL OR last_run_status IN ('succeeded', 'failed', 'skipped-no-targets'))
);

CREATE INDEX IF NOT EXISTS catalog_provider_refresh_schedule_due_idx
  ON catalog_provider_refresh_schedule (schedule_enabled, paused, next_run_at);
`;

// Both tables are new; there is nothing deployed yet to reshape, so no
// migrations are required alongside the boot schema above.
export const catalogProviderScopeDiscoverySchemaMigrations: readonly BcSchemaMigration[] = [];
