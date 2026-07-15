import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const catalogProviderScopeObservationTableSql = `CREATE TABLE IF NOT EXISTS catalog_provider_scope_observations (
  provider_key text NOT NULL,
  unit_key text NOT NULL,
  scope_kind text NOT NULL,
  source_query_kind text NOT NULL,
  language_code text NOT NULL,
  external_id text NOT NULL,
  label text NOT NULL,
  parents jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_url text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observation_hash text NOT NULL,
  scan_id text NOT NULL,
  scanned_at timestamptz NOT NULL,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, unit_key, scope_kind, language_code, external_id),
  CONSTRAINT catalog_provider_scope_observations_scope_kind_check
    CHECK (scope_kind IN ('language', 'product-line', 'series', 'expansion', 'set'))
);`;

// The v2 ledgered migration rebuilds this re-fetchable cache, but additive boot
// SQL runs first. These fast-default columns let the v2 indexes compile against
// the deployed v1 table so bootstrap can reach that migration.
const catalogProviderScopeObservationCompatibilitySql = `ALTER TABLE catalog_provider_scope_observations
  ADD COLUMN IF NOT EXISTS unit_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS scope_kind text NOT NULL DEFAULT 'set',
  ADD COLUMN IF NOT EXISTS observation_hash text NOT NULL DEFAULT '';`;

const catalogProviderScopeObservationIndexesSql = `CREATE INDEX IF NOT EXISTS catalog_provider_scope_observations_scan_idx
  ON catalog_provider_scope_observations (scan_id);

CREATE INDEX IF NOT EXISTS catalog_provider_scope_observations_lookup_idx
  ON catalog_provider_scope_observations (provider_key, unit_key, scope_kind, language_code);

CREATE INDEX IF NOT EXISTS catalog_provider_scope_observations_hash_idx
  ON catalog_provider_scope_observations (observation_hash);`;

const catalogProviderScopeObservationSchemaSql = [
  catalogProviderScopeObservationTableSql,
  catalogProviderScopeObservationCompatibilitySql,
  catalogProviderScopeObservationIndexesSql,
].join("\n\n");

const catalogScopeRecordProposalSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_scope_record_proposals (
  proposal_id text PRIMARY KEY,
  scope_record_id text NOT NULL UNIQUE,
  product_domain text NOT NULL,
  scope_kind text NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  official_set_code text NULL,
  release_date date NULL,
  language_editions jsonb NOT NULL DEFAULT '[]'::jsonb,
  parent_external_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_status text NOT NULL DEFAULT 'proposed',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_proposed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_scope_record_proposals_product_domain_check
    CHECK (product_domain IN ('pokemon', 'magic', 'yugioh', 'one-piece', 'lorcana')),
  CONSTRAINT catalog_scope_record_proposals_scope_kind_check
    CHECK (scope_kind IN ('product-line', 'series', 'expansion', 'set')),
  CONSTRAINT catalog_scope_record_proposals_review_status_check
    CHECK (review_status IN ('proposed', 'accepted', 'rejected'))
);

CREATE INDEX IF NOT EXISTS catalog_scope_record_proposals_review_idx
  ON catalog_scope_record_proposals (review_status, product_domain, scope_kind, first_proposed_at DESC);

CREATE INDEX IF NOT EXISTS catalog_scope_record_proposals_match_idx
  ON catalog_scope_record_proposals (product_domain, scope_kind, normalized_name, official_set_code);`;

const catalogProviderRefreshScheduleSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_provider_refresh_schedule (
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
  ON catalog_provider_refresh_schedule (schedule_enabled, paused, next_run_at);`;

// Provider Scope Observations are re-fetchable provider evidence. Scope Record
// proposals and mapping review history are durable review facts and are never
// cleared by observation-cache reshapes.
export const catalogProviderScopeDiscoverySchemaSql = [
  catalogProviderScopeObservationSchemaSql,
  catalogScopeRecordProposalSchemaSql,
  catalogProviderRefreshScheduleSchemaSql,
].join("\n\n");

export const catalogProviderScopeDiscoverySchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260714_catalog_provider_scope_observation_identity_v2",
    description:
      "Rebuild re-fetchable provider option evidence with provider-unit, scope-kind, parent, language, and hash identity.",
    statements: [
      "SET LOCAL lock_timeout = '5s';",
      "DROP TABLE IF EXISTS catalog_provider_scope_observations;",
      catalogProviderScopeObservationTableSql,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_provider_scope_observations_scan_idx
  ON catalog_provider_scope_observations (scan_id);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_provider_scope_observations_lookup_idx
  ON catalog_provider_scope_observations (provider_key, unit_key, scope_kind, language_code);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_provider_scope_observations_hash_idx
  ON catalog_provider_scope_observations (observation_hash);`,
    ],
  },
];
