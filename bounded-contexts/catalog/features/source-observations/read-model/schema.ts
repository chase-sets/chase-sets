import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import { durableJobSchemaMigrations, durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";
import { durableJobWorkUnitSchemaSql } from "@chase-sets/platform-runtime/durable-job-work-units";
import {
  sourceObservationExpansionIdExpression,
  sourceObservationIntegrationScopeSummarySelectSql,
  sourceObservationIntegrationScopeSummaryTable,
  sourceObservationProductLineIdExpression,
  sourceObservationSeriesIdExpression,
} from "./integration-scope-summary";

const catalogSourceObservationIntegrationScopeSummaryBackfillSql = `INSERT INTO ${sourceObservationIntegrationScopeSummaryTable} (
  provider_key,
  language_code,
  product_line_id,
  product_line_name,
  series_id,
  series_name,
  expansion_id,
  expansion_name,
  total_observations,
  observed_observations,
  changed_observations,
  promoted_observations,
  rejected_observations,
  first_observed_at,
  latest_observed_at,
  latest_source_updated_at,
  updated_at
)
SELECT
  ${sourceObservationIntegrationScopeSummarySelectSql()},
  COUNT(*)::integer AS total_observations,
  (COUNT(*) FILTER (WHERE status = 'observed'))::integer AS observed_observations,
  (COUNT(*) FILTER (WHERE status = 'changed'))::integer AS changed_observations,
  (COUNT(*) FILTER (WHERE status = 'promoted'))::integer AS promoted_observations,
  (COUNT(*) FILTER (WHERE status = 'rejected'))::integer AS rejected_observations,
  MIN(observed_at) AS first_observed_at,
  MAX(observed_at) AS latest_observed_at,
  MAX(source_updated_at) AS latest_source_updated_at,
  now() AS updated_at
FROM catalog_source_observations
GROUP BY
  provider_key,
  language_code,
  coalesce(${sourceObservationProductLineIdExpression()}, ''),
  ${sourceObservationSeriesIdExpression()},
  ${sourceObservationExpansionIdExpression()}
ON CONFLICT (provider_key, language_code, product_line_id, series_id, expansion_id) DO UPDATE SET
  product_line_name = EXCLUDED.product_line_name,
  series_name = EXCLUDED.series_name,
  expansion_name = EXCLUDED.expansion_name,
  total_observations = EXCLUDED.total_observations,
  observed_observations = EXCLUDED.observed_observations,
  changed_observations = EXCLUDED.changed_observations,
  promoted_observations = EXCLUDED.promoted_observations,
  rejected_observations = EXCLUDED.rejected_observations,
  first_observed_at = EXCLUDED.first_observed_at,
  latest_observed_at = EXCLUDED.latest_observed_at,
  latest_source_updated_at = EXCLUDED.latest_source_updated_at,
  updated_at = EXCLUDED.updated_at;`;

const catalogSourceObservationRequiredSourceProfileColumnsSql = `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'catalog_source_observations_source_profile_required'
      AND conrelid = 'catalog_source_observations'::regclass
  ) THEN
    ALTER TABLE catalog_source_observations
      ADD CONSTRAINT catalog_source_observations_source_profile_required
      CHECK (
        source_profile_key IS NOT NULL
        AND source_profile_version IS NOT NULL
        AND source_mapping_fingerprint IS NOT NULL
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE catalog_source_observations
  VALIDATE CONSTRAINT catalog_source_observations_source_profile_required;

ALTER TABLE catalog_source_observations
  ALTER COLUMN source_profile_key DROP DEFAULT,
  ALTER COLUMN source_profile_key SET NOT NULL,
  ALTER COLUMN source_profile_version DROP DEFAULT,
  ALTER COLUMN source_profile_version SET NOT NULL,
  ALTER COLUMN source_mapping_fingerprint DROP DEFAULT,
  ALTER COLUMN source_mapping_fingerprint SET NOT NULL;`;

const catalogProviderIntegrationProfileVersionsActiveIndexReshapeSql = `ALTER TABLE catalog_provider_integration_profile_versions
  DROP COLUMN IF EXISTS compatibility_mode,
  ADD COLUMN IF NOT EXISTS ingestion_unit_key text NULL,
  ADD COLUMN IF NOT EXISTS migration_evidence_json jsonb NULL,
  ADD COLUMN IF NOT EXISTS authoring_audit_json jsonb NULL;

DROP INDEX IF EXISTS catalog_provider_integration_profile_versions_active_idx;`;

const catalogProviderIntegrationProfileVersionsActiveIndexSql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS catalog_provider_integration_profile_versions_active_idx
  ON catalog_provider_integration_profile_versions (provider_key, ingestion_unit_key)
  WHERE active = true AND lifecycle = 'active';`;

const catalogProviderOptionQueryCacheProfileBackfillSql = `UPDATE catalog_provider_option_query_cache
  SET profile_key = COALESCE(profile_key, ''),
      ingestion_unit_key = COALESCE(ingestion_unit_key, '')
  WHERE profile_key IS NULL OR ingestion_unit_key IS NULL;`;

const catalogProviderOptionQueryCacheRequiredProfileColumnsSql = `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'catalog_provider_option_query_cache_profile_required'
      AND conrelid = 'catalog_provider_option_query_cache'::regclass
  ) THEN
    ALTER TABLE catalog_provider_option_query_cache
      ADD CONSTRAINT catalog_provider_option_query_cache_profile_required
      CHECK (profile_key IS NOT NULL AND ingestion_unit_key IS NOT NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE catalog_provider_option_query_cache
  VALIDATE CONSTRAINT catalog_provider_option_query_cache_profile_required;

ALTER TABLE catalog_provider_option_query_cache
  ALTER COLUMN profile_key SET DEFAULT '',
  ALTER COLUMN profile_key SET NOT NULL,
  ALTER COLUMN ingestion_unit_key SET DEFAULT '',
  ALTER COLUMN ingestion_unit_key SET NOT NULL;`;

const catalogProviderOptionQueryCacheLookupIndexReshapeSql =
  "DROP INDEX IF EXISTS catalog_provider_option_query_cache_lookup_idx;";

const catalogProviderOptionQueryCacheLookupIndexSql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_provider_option_query_cache_lookup_idx
  ON catalog_provider_option_query_cache (
    provider_key,
    profile_key,
    profile_version,
    ingestion_unit_key,
    query_kind,
    language_code,
    parent_value
  );`;

const catalogMergeCandidateScopeIdentityV2WipeSql = `DELETE FROM catalog_merge_candidate_observations;
DELETE FROM catalog_merge_candidates;
DELETE FROM event_store_streams
  WHERE stream_id LIKE 'catalog.merge-candidate-%' ESCAPE '\\';`;

const catalogMergeCandidateScopeIdentityV2RequiredSql = `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'catalog_merge_candidates_scope_record_required'
      AND conrelid = 'catalog_merge_candidates'::regclass
  ) THEN
    ALTER TABLE catalog_merge_candidates
      ADD CONSTRAINT catalog_merge_candidates_scope_record_required
      CHECK (scope_record_id IS NOT NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE catalog_merge_candidates
  VALIDATE CONSTRAINT catalog_merge_candidates_scope_record_required;

ALTER TABLE catalog_merge_candidates
  ALTER COLUMN scope_record_id SET NOT NULL;`;

const catalogMergeCandidateScopeIdentityV2ForeignKeySql = `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'catalog_merge_candidates_scope_record_fk'
      AND conrelid = 'catalog_merge_candidates'::regclass
  ) THEN
    ALTER TABLE catalog_merge_candidates
      ADD CONSTRAINT catalog_merge_candidates_scope_record_fk
      FOREIGN KEY (scope_record_id)
      REFERENCES catalog_scope_records (scope_record_id)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE catalog_merge_candidates
  VALIDATE CONSTRAINT catalog_merge_candidates_scope_record_fk;`;

const catalogMergeCandidateScopeIdentityV2IndexSql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_merge_candidates_scope_record_idx
  ON catalog_merge_candidates (scope_record_id, status, updated_at DESC);`;

export const catalogSourceObservationSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_source_observations (
  observation_id text PRIMARY KEY,
  sync_run_id text NULL,
  provider_key text NOT NULL,
  external_key text NOT NULL,
  source_url text NOT NULL,
  language_code text NOT NULL,
  source_record_hash text NOT NULL,
  source_updated_at timestamptz NULL,
  observed_at timestamptz NOT NULL,
  source_profile_key text NOT NULL,
  source_profile_version text NOT NULL,
  source_mapping_fingerprint text NOT NULL,
  normalized jsonb NOT NULL,
  source_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'observed',
  status_reason text NULL,
  promoted_catalog_item_id text NULL,
  promoted_reference_record_id text NULL,
  promoted_at timestamptz NULL,
  promotion_profile_key text NULL,
  promotion_profile_version text NULL,
  promotion_plan_fingerprint text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_key, language_code, external_key)
);

ALTER TABLE catalog_source_observations
  ADD COLUMN IF NOT EXISTS sync_run_id text NULL,
  ADD COLUMN IF NOT EXISTS source_profile_key text,
  ADD COLUMN IF NOT EXISTS source_profile_version text,
  ADD COLUMN IF NOT EXISTS source_mapping_fingerprint text,
  ADD COLUMN IF NOT EXISTS promoted_reference_record_id text NULL,
  ADD COLUMN IF NOT EXISTS promotion_profile_key text NULL,
  ADD COLUMN IF NOT EXISTS promotion_profile_version text NULL,
  ADD COLUMN IF NOT EXISTS promotion_plan_fingerprint text NULL;

CREATE INDEX IF NOT EXISTS catalog_source_observations_provider_idx
  ON catalog_source_observations (provider_key, language_code);
CREATE INDEX IF NOT EXISTS catalog_source_observations_status_idx
  ON catalog_source_observations (status);
CREATE INDEX IF NOT EXISTS catalog_source_observations_observed_at_idx
  ON catalog_source_observations (observed_at DESC, observation_id ASC);
CREATE INDEX IF NOT EXISTS catalog_source_observations_name_idx
  ON catalog_source_observations USING gin (
    to_tsvector(
      'simple',
      coalesce(normalized->>'name', '') || ' ' || coalesce(normalized->>'expansionName', normalized->>'setName', '') || ' ' || external_key
    )
  );

CREATE TABLE IF NOT EXISTS ${sourceObservationIntegrationScopeSummaryTable} (
  provider_key text NOT NULL,
  language_code text NOT NULL,
  product_line_id text NOT NULL,
  product_line_name text NOT NULL DEFAULT '',
  series_id text NOT NULL,
  series_name text NOT NULL DEFAULT '',
  expansion_id text NOT NULL,
  expansion_name text NOT NULL DEFAULT '',
  total_observations integer NOT NULL DEFAULT 0,
  observed_observations integer NOT NULL DEFAULT 0,
  changed_observations integer NOT NULL DEFAULT 0,
  promoted_observations integer NOT NULL DEFAULT 0,
  rejected_observations integer NOT NULL DEFAULT 0,
  first_observed_at timestamptz NOT NULL,
  latest_observed_at timestamptz NOT NULL,
  latest_source_updated_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, language_code, product_line_id, series_id, expansion_id)
);

CREATE TABLE IF NOT EXISTS catalog_merge_candidates (
  candidate_id text PRIMARY KEY,
  scope_record_id text NOT NULL,
  identity_fingerprint text NOT NULL,
  sync_run_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL,
  status_reason text NULL,
  identity_json jsonb NOT NULL,
  matched_catalog_item_id text NULL,
  matched_product_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposed_catalog_item_facts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_external_catalog_item_references_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposed_external_product_references_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_provenance_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  promotion_intent text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  stale_at timestamptz NULL,
  CONSTRAINT catalog_merge_candidates_status_check
    CHECK (status IN ('ready', 'has-conflicts', 'stale', 'deferred', 'rejected', 'promoted')),
  CONSTRAINT catalog_merge_candidates_promotion_intent_check
    CHECK (promotion_intent IN ('create-catalog-item', 'update-catalog-item', 'link-existing-catalog-item')),
  CONSTRAINT catalog_merge_candidates_scope_record_fk
    FOREIGN KEY (scope_record_id)
    REFERENCES catalog_scope_records (scope_record_id)
);

ALTER TABLE catalog_merge_candidates
  ADD COLUMN IF NOT EXISTS scope_record_id text NULL,
  ADD COLUMN IF NOT EXISTS identity_fingerprint text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sync_run_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS status_reason text NULL,
  ADD COLUMN IF NOT EXISTS identity_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS matched_catalog_item_id text NULL,
  ADD COLUMN IF NOT EXISTS matched_product_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS proposed_catalog_item_facts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS proposed_external_catalog_item_references_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS proposed_external_product_references_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS conflicts_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS field_provenance_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS promotion_intent text NOT NULL DEFAULT 'create-catalog-item',
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS stale_at timestamptz NULL;

ALTER TABLE catalog_merge_candidates
  ALTER COLUMN identity_fingerprint DROP DEFAULT,
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN identity_json DROP DEFAULT,
  ALTER COLUMN promotion_intent DROP DEFAULT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'catalog_merge_candidates_status_check'
  ) THEN
    ALTER TABLE catalog_merge_candidates
      ADD CONSTRAINT catalog_merge_candidates_status_check
      CHECK (status IN ('ready', 'has-conflicts', 'stale', 'deferred', 'rejected', 'promoted')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'catalog_merge_candidates_promotion_intent_check'
  ) THEN
    ALTER TABLE catalog_merge_candidates
      ADD CONSTRAINT catalog_merge_candidates_promotion_intent_check
      CHECK (promotion_intent IN ('create-catalog-item', 'update-catalog-item', 'link-existing-catalog-item')) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS catalog_merge_candidate_observations (
  candidate_id text NOT NULL,
  observation_id text NOT NULL,
  sync_run_id text NULL,
  provider_key text NOT NULL,
  external_key text NOT NULL,
  source_record_hash text NOT NULL,
  source_profile_key text NOT NULL,
  source_profile_version text NOT NULL,
  source_mapping_fingerprint text NOT NULL,
  observed_at timestamptz NOT NULL,
  added_at timestamptz NOT NULL,
  PRIMARY KEY (candidate_id, observation_id),
  CONSTRAINT catalog_merge_candidate_observations_candidate_fk
    FOREIGN KEY (candidate_id)
    REFERENCES catalog_merge_candidates (candidate_id)
    ON DELETE CASCADE
);

ALTER TABLE catalog_merge_candidate_observations
  ADD COLUMN IF NOT EXISTS sync_run_id text NULL,
  ADD COLUMN IF NOT EXISTS provider_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS external_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_record_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_profile_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_profile_version text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_mapping_fingerprint text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS observed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS added_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE catalog_merge_candidate_observations
  ALTER COLUMN provider_key DROP DEFAULT,
  ALTER COLUMN external_key DROP DEFAULT,
  ALTER COLUMN source_record_hash DROP DEFAULT,
  ALTER COLUMN source_profile_key DROP DEFAULT,
  ALTER COLUMN source_profile_version DROP DEFAULT,
  ALTER COLUMN source_mapping_fingerprint DROP DEFAULT,
  ALTER COLUMN observed_at DROP DEFAULT,
  ALTER COLUMN added_at DROP DEFAULT;

CREATE INDEX IF NOT EXISTS catalog_merge_candidates_sync_run_ids_idx
  ON catalog_merge_candidates USING gin (sync_run_ids_json);
CREATE INDEX IF NOT EXISTS catalog_merge_candidate_observations_observation_idx
  ON catalog_merge_candidate_observations (observation_id);

CREATE TABLE IF NOT EXISTS catalog_provider_integration_profile_versions (
  provider_key text NOT NULL,
  profile_key text NOT NULL,
  profile_version text NOT NULL,
  ingestion_unit_key text NOT NULL,
  lifecycle text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  profile_json jsonb NOT NULL,
  source_contract_json jsonb NOT NULL,
  fixture_contract_json jsonb NOT NULL,
  retirement_plan_json jsonb NULL,
  executable_mapping_contract_json jsonb NULL,
  migration_evidence_json jsonb NULL,
  authoring_audit_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz NULL,
  deprecated_at timestamptz NULL,
  retired_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, profile_key, profile_version),
  CONSTRAINT catalog_provider_profile_lifecycle_check
    CHECK (lifecycle IN ('draft', 'test', 'active', 'deprecated', 'retired'))
);

ALTER TABLE catalog_provider_integration_profile_versions
  ADD COLUMN IF NOT EXISTS ingestion_unit_key text NULL,
  ADD COLUMN IF NOT EXISTS migration_evidence_json jsonb NULL,
  ADD COLUMN IF NOT EXISTS authoring_audit_json jsonb NULL;

CREATE INDEX IF NOT EXISTS catalog_provider_integration_profile_versions_provider_idx
  ON catalog_provider_integration_profile_versions (provider_key, profile_version DESC);

CREATE TABLE IF NOT EXISTS catalog_provider_profile_version_sections (
  provider_key text NOT NULL,
  profile_key text NOT NULL,
  profile_version text NOT NULL,
  section_key text NOT NULL,
  ingestion_unit_key text NOT NULL,
  editable boolean NOT NULL,
  validation_status text NOT NULL,
  section_fingerprint text NOT NULL,
  section_json jsonb NOT NULL,
  last_edited_at timestamptz NULL,
  last_edited_by_user_id text NULL,
  last_edited_for_account_id text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, profile_key, profile_version, section_key),
  CONSTRAINT catalog_provider_profile_sections_validation_status_check
    CHECK (validation_status IN ('valid', 'invalid')),
  CONSTRAINT catalog_provider_profile_sections_version_fk
    FOREIGN KEY (provider_key, profile_key, profile_version)
    REFERENCES catalog_provider_integration_profile_versions (provider_key, profile_key, profile_version)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS catalog_provider_profile_version_sections_provider_idx
  ON catalog_provider_profile_version_sections (provider_key, profile_version, section_key);

CREATE INDEX IF NOT EXISTS catalog_provider_profile_version_sections_ingestion_unit_idx
  ON catalog_provider_profile_version_sections (ingestion_unit_key, validation_status);

CREATE TABLE IF NOT EXISTS catalog_provider_profile_version_section_diagnostics (
  provider_key text NOT NULL,
  profile_key text NOT NULL,
  profile_version text NOT NULL,
  section_key text NOT NULL,
  diagnostic_index integer NOT NULL,
  path text NOT NULL,
  severity text NOT NULL,
  code text NOT NULL,
  diagnostic_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, profile_key, profile_version, section_key, diagnostic_index),
  CONSTRAINT catalog_provider_profile_section_diagnostics_severity_check
    CHECK (severity IN ('error', 'warning')),
  CONSTRAINT catalog_provider_profile_section_diagnostics_section_fk
    FOREIGN KEY (provider_key, profile_key, profile_version, section_key)
    REFERENCES catalog_provider_profile_version_sections (provider_key, profile_key, profile_version, section_key)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS catalog_provider_profile_version_section_diagnostics_lookup_idx
  ON catalog_provider_profile_version_section_diagnostics (
    provider_key,
    profile_version,
    section_key,
    severity
  );

CREATE TABLE IF NOT EXISTS catalog_tcgplayer_automation_domain_rate_limits (
  domain_key text PRIMARY KEY,
  request_delay_ms integer NOT NULL,
  learned_min_delay_ms integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_provider_option_query_cache (
  cache_key text PRIMARY KEY,
  provider_key text NOT NULL,
  profile_key text NOT NULL DEFAULT '',
  profile_version text NOT NULL,
  ingestion_unit_key text NOT NULL DEFAULT '',
  query_kind text NOT NULL,
  language_code text NOT NULL,
  parent_value text NOT NULL,
  items_json jsonb NOT NULL,
  item_count integer NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  stale_until timestamptz NOT NULL,
  diagnostic_code text NULL,
  diagnostic_text text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE catalog_provider_option_query_cache
  ADD COLUMN IF NOT EXISTS profile_key text DEFAULT '',
  ADD COLUMN IF NOT EXISTS ingestion_unit_key text DEFAULT '';

ALTER TABLE catalog_provider_option_query_cache
  ALTER COLUMN profile_key SET DEFAULT '',
  ALTER COLUMN ingestion_unit_key SET DEFAULT '';

CREATE INDEX IF NOT EXISTS catalog_provider_option_query_cache_stale_until_idx
  ON catalog_provider_option_query_cache (stale_until);

${durableJobSchemaSql({
  jobsTable: "catalog_source_observation_bulk_review_jobs",
  eventsTable: "catalog_source_observation_bulk_review_job_events",
  notifyChannel: "catalog_source_observation_durable_job_events",
  includeBootReshapes: false,
})}

${durableJobWorkUnitSchemaSql({
  jobsTable: "catalog_source_observation_bulk_review_jobs",
  workUnitsTable: "catalog_source_observation_bulk_review_work_units",
})}

${durableJobSchemaSql({
  jobsTable: "catalog_source_observation_integration_durable_jobs",
  eventsTable: "catalog_source_observation_integration_job_events",
  notifyChannel: "catalog_source_observation_durable_job_events",
  includeBootReshapes: false,
})}

${durableJobWorkUnitSchemaSql({
  jobsTable: "catalog_source_observation_integration_durable_jobs",
  workUnitsTable: "catalog_source_observation_integration_work_units",
})}
`;

export const catalogSourceObservationSchemaMigrations: readonly BcSchemaMigration[] = [
  ...durableJobSchemaMigrations({
    jobsTable: "catalog_source_observation_bulk_review_jobs",
  }),
  ...durableJobSchemaMigrations({
    jobsTable: "catalog_source_observation_integration_durable_jobs",
  }),
  {
    migrationId: "20260703_catalog_source_observation_required_source_profile_columns",
    description: "Enforce required Source Observation source-profile columns outside boot schema.",
    statements: ["SET LOCAL lock_timeout = '5s';", catalogSourceObservationRequiredSourceProfileColumnsSql],
  },
  {
    migrationId: "20260703_catalog_source_observation_integration_scope_summaries",
    description: "Backfill source-observation integration scope summaries and create landing-query indexes.",
    statements: [
      catalogSourceObservationIntegrationScopeSummaryBackfillSql,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_source_observation_integration_scope_summaries_lookup_idx
  ON ${sourceObservationIntegrationScopeSummaryTable} (
    provider_key,
    language_code,
    product_line_id,
    series_id,
    expansion_id,
    latest_observed_at DESC
  );`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_source_observation_integration_scope_summaries_latest_idx
  ON ${sourceObservationIntegrationScopeSummaryTable} (latest_observed_at DESC, provider_key, language_code);`,
    ],
  },
  {
    migrationId: "20260703_catalog_provider_profile_active_index_scope",
    description: "Reshape active provider-profile index to include ingestion-unit scope.",
    statements: [
      "SET LOCAL lock_timeout = '5s';",
      catalogProviderIntegrationProfileVersionsActiveIndexReshapeSql,
      catalogProviderIntegrationProfileVersionsActiveIndexSql,
    ],
  },
  {
    migrationId: "20260703_catalog_provider_option_query_cache_profile_lookup",
    description: "Backfill option-query cache profile scope and reshape lookup index.",
    statements: [
      "SET LOCAL lock_timeout = '5s';",
      catalogProviderOptionQueryCacheProfileBackfillSql,
      catalogProviderOptionQueryCacheRequiredProfileColumnsSql,
      catalogProviderOptionQueryCacheLookupIndexReshapeSql,
      catalogProviderOptionQueryCacheLookupIndexSql,
    ],
  },
  {
    migrationId: "20260713_catalog_source_observation_compatibility_indexes",
    description: "Create indexes for compatibility columns outside repeatable boot schema.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_source_observations_sync_run_idx
  ON catalog_source_observations (sync_run_id, observed_at DESC)
  WHERE sync_run_id IS NOT NULL;`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_source_observations_source_profile_idx
  ON catalog_source_observations (provider_key, source_profile_version);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_source_observations_promotion_profile_idx
  ON catalog_source_observations (provider_key, promotion_profile_version)
  WHERE promotion_profile_version IS NOT NULL;`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_merge_candidates_status_idx
  ON catalog_merge_candidates (status, updated_at DESC);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_merge_candidates_updated_idx
  ON catalog_merge_candidates (updated_at DESC, candidate_id ASC);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_merge_candidates_identity_fingerprint_idx
  ON catalog_merge_candidates (identity_fingerprint);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_merge_candidates_matched_catalog_item_idx
  ON catalog_merge_candidates (matched_catalog_item_id)
  WHERE matched_catalog_item_id IS NOT NULL;`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_merge_candidate_observations_sync_run_idx
  ON catalog_merge_candidate_observations (sync_run_id, candidate_id)
  WHERE sync_run_id IS NOT NULL;`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_merge_candidate_observations_provider_idx
  ON catalog_merge_candidate_observations (provider_key, source_profile_version);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS catalog_provider_integration_profile_versions_unit_idx
  ON catalog_provider_integration_profile_versions (provider_key, ingestion_unit_key, profile_version DESC);`,
    ],
  },
  {
    migrationId: "20260713_catalog_merge_candidate_scope_identity_v2",
    description:
      "Wipe pre-launch Merge Candidate v1 streams and projections, then enforce canonical scope-record identity.",
    statements: [
      "SET LOCAL lock_timeout = '5s';",
      "ALTER TABLE catalog_merge_candidates ADD COLUMN IF NOT EXISTS scope_record_id text NULL;",
      catalogMergeCandidateScopeIdentityV2WipeSql,
      catalogMergeCandidateScopeIdentityV2RequiredSql,
      catalogMergeCandidateScopeIdentityV2ForeignKeySql,
      catalogMergeCandidateScopeIdentityV2IndexSql,
    ],
  },
];
