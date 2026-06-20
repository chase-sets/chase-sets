import { durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";
import { durableJobWorkUnitSchemaSql } from "@chase-sets/platform-runtime/durable-job-work-units";

export const catalogSourceObservationSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_source_observations (
  observation_id text PRIMARY KEY,
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
  ADD COLUMN IF NOT EXISTS source_profile_key text,
  ADD COLUMN IF NOT EXISTS source_profile_version text,
  ADD COLUMN IF NOT EXISTS source_mapping_fingerprint text,
  ADD COLUMN IF NOT EXISTS promoted_reference_record_id text NULL,
  ADD COLUMN IF NOT EXISTS promotion_profile_key text NULL,
  ADD COLUMN IF NOT EXISTS promotion_profile_version text NULL,
  ADD COLUMN IF NOT EXISTS promotion_plan_fingerprint text NULL;

ALTER TABLE catalog_source_observations
  ALTER COLUMN source_profile_key DROP DEFAULT,
  ALTER COLUMN source_profile_key SET NOT NULL,
  ALTER COLUMN source_profile_version DROP DEFAULT,
  ALTER COLUMN source_profile_version SET NOT NULL,
  ALTER COLUMN source_mapping_fingerprint DROP DEFAULT,
  ALTER COLUMN source_mapping_fingerprint SET NOT NULL;

CREATE INDEX IF NOT EXISTS catalog_source_observations_provider_idx
  ON catalog_source_observations (provider_key, language_code);
CREATE INDEX IF NOT EXISTS catalog_source_observations_status_idx
  ON catalog_source_observations (status);
CREATE INDEX IF NOT EXISTS catalog_source_observations_source_profile_idx
  ON catalog_source_observations (provider_key, source_profile_version);
CREATE INDEX IF NOT EXISTS catalog_source_observations_promotion_profile_idx
  ON catalog_source_observations (provider_key, promotion_profile_version)
  WHERE promotion_profile_version IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_source_observations_name_idx
  ON catalog_source_observations USING gin (
    to_tsvector(
      'simple',
      coalesce(normalized->>'name', '') || ' ' || coalesce(normalized->>'expansionName', normalized->>'setName', '') || ' ' || external_key
    )
  );

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
  DROP COLUMN IF EXISTS compatibility_mode,
  ADD COLUMN IF NOT EXISTS ingestion_unit_key text NULL,
  ADD COLUMN IF NOT EXISTS migration_evidence_json jsonb NULL,
  ADD COLUMN IF NOT EXISTS authoring_audit_json jsonb NULL;

DROP INDEX IF EXISTS catalog_provider_integration_profile_versions_active_idx;

CREATE UNIQUE INDEX IF NOT EXISTS catalog_provider_integration_profile_versions_active_idx
  ON catalog_provider_integration_profile_versions (provider_key, ingestion_unit_key)
  WHERE active = true AND lifecycle = 'active';

CREATE INDEX IF NOT EXISTS catalog_provider_integration_profile_versions_provider_idx
  ON catalog_provider_integration_profile_versions (provider_key, profile_version DESC);

CREATE INDEX IF NOT EXISTS catalog_provider_integration_profile_versions_unit_idx
  ON catalog_provider_integration_profile_versions (provider_key, ingestion_unit_key, profile_version DESC);

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

UPDATE catalog_provider_option_query_cache
  SET profile_key = COALESCE(profile_key, ''),
      ingestion_unit_key = COALESCE(ingestion_unit_key, '')
  WHERE profile_key IS NULL OR ingestion_unit_key IS NULL;

ALTER TABLE catalog_provider_option_query_cache
  ALTER COLUMN profile_key SET DEFAULT '',
  ALTER COLUMN profile_key SET NOT NULL,
  ALTER COLUMN ingestion_unit_key SET DEFAULT '',
  ALTER COLUMN ingestion_unit_key SET NOT NULL;

DROP INDEX IF EXISTS catalog_provider_option_query_cache_lookup_idx;

CREATE INDEX IF NOT EXISTS catalog_provider_option_query_cache_lookup_idx
  ON catalog_provider_option_query_cache (
    provider_key,
    profile_key,
    profile_version,
    ingestion_unit_key,
    query_kind,
    language_code,
    parent_value
  );

CREATE INDEX IF NOT EXISTS catalog_provider_option_query_cache_stale_until_idx
  ON catalog_provider_option_query_cache (stale_until);

${durableJobSchemaSql({
  jobsTable: "catalog_source_observation_bulk_review_jobs",
  eventsTable: "catalog_source_observation_bulk_review_job_events",
  notifyChannel: "catalog_source_observation_durable_job_events",
})}

${durableJobWorkUnitSchemaSql({
  jobsTable: "catalog_source_observation_bulk_review_jobs",
  workUnitsTable: "catalog_source_observation_bulk_review_work_units",
})}

${durableJobSchemaSql({
  jobsTable: "catalog_source_observation_integration_durable_jobs",
  eventsTable: "catalog_source_observation_integration_job_events",
  notifyChannel: "catalog_source_observation_durable_job_events",
})}

${durableJobWorkUnitSchemaSql({
  jobsTable: "catalog_source_observation_integration_durable_jobs",
  workUnitsTable: "catalog_source_observation_integration_work_units",
})}
`;
