export const catalogProviderScopeMappingSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_provider_scope_mappings (
  mapping_id text PRIMARY KEY,
  scope_record_id text NOT NULL,
  provider_key text NOT NULL,
  unit_key text NOT NULL,
  product_line_id text NULL,
  series_id text NULL,
  set_id text NULL,
  set_name text NULL,
  language_coordinates jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence text NOT NULL,
  review_status text NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_actor text NULL,
  last_reason text NULL,
  policy_version text NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_record_id, provider_key, unit_key),
  CONSTRAINT catalog_provider_scope_mappings_review_status_check
    CHECK (review_status IN ('proposed', 'accepted', 'auto-accepted', 'rejected', 'revoked')),
  CONSTRAINT catalog_provider_scope_mappings_confidence_check
    CHECK (confidence IN ('exact', 'high', 'candidate', 'generated', 'manual'))
);

CREATE INDEX IF NOT EXISTS catalog_provider_scope_mappings_scope_idx
  ON catalog_provider_scope_mappings (scope_record_id, review_status);

CREATE INDEX IF NOT EXISTS catalog_provider_scope_mappings_provider_unit_idx
  ON catalog_provider_scope_mappings (provider_key, unit_key, review_status);

CREATE INDEX IF NOT EXISTS catalog_provider_scope_mappings_accepted_scope_idx
  ON catalog_provider_scope_mappings (scope_record_id, provider_key, unit_key)
  WHERE review_status IN ('accepted', 'auto-accepted');

CREATE INDEX IF NOT EXISTS catalog_provider_scope_mappings_accepted_provider_unit_idx
  ON catalog_provider_scope_mappings (provider_key, unit_key, scope_record_id)
  WHERE review_status IN ('accepted', 'auto-accepted');

CREATE INDEX IF NOT EXISTS catalog_provider_scope_mappings_provider_set_idx
  ON catalog_provider_scope_mappings (provider_key, set_id)
  WHERE set_id IS NOT NULL;`;
