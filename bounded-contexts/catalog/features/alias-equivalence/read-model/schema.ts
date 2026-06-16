// Catalog Alias persistence (#1905).
//
// Three queryable tables:
//   - catalog_source_observation_alias_candidates: typed alias candidates
//     produced by Source Observations, not buried in normalized JSON.
//   - catalog_item_aliases: accepted aliases for Catalog Items.
//   - catalog_reference_record_aliases: accepted aliases for Reference Records
//     (set-equivalent / series-equivalent), aligned with reference-data naming.
//
// Uniqueness is by alias hash (a deterministic function of target + normalized
// alias text + language + alias type + provider + source category). The hash
// encodes the dedupe key, so a single UNIQUE(alias_hash) enforces the ADR
// cardinality rules: one alias text → many targets and one target → many
// aliases, deduped per source. Revocation flips review_status; it never deletes,
// preserving provenance and audit history.
export const catalogAliasEquivalenceSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_source_observation_alias_candidates (
  alias_hash text PRIMARY KEY,
  target_kind text NOT NULL,
  target_id text NULL,
  target_key text NOT NULL,
  alias_text text NOT NULL,
  normalized_alias_text text NOT NULL,
  alias_language_code text NOT NULL,
  source_language_code text NULL,
  alias_type text NOT NULL,
  confidence text NOT NULL,
  review_status text NOT NULL DEFAULT 'pending',
  provider_key text NOT NULL,
  observation_id text NULL,
  source_category text NOT NULL,
  source_profile_key text NOT NULL,
  source_profile_version text NOT NULL,
  mapping_fingerprint text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_alias_candidate_target_kind_check
    CHECK (target_kind IN ('catalog-item', 'reference-record')),
  CONSTRAINT catalog_alias_candidate_review_status_check
    CHECK (review_status IN ('pending', 'accepted', 'auto-accepted', 'rejected', 'revoked'))
);

CREATE INDEX IF NOT EXISTS catalog_source_observation_alias_candidates_target_idx
  ON catalog_source_observation_alias_candidates (target_kind, target_id, target_key);
CREATE INDEX IF NOT EXISTS catalog_source_observation_alias_candidates_text_idx
  ON catalog_source_observation_alias_candidates (normalized_alias_text, alias_language_code);
CREATE INDEX IF NOT EXISTS catalog_source_observation_alias_candidates_review_idx
  ON catalog_source_observation_alias_candidates (review_status, alias_type);
CREATE INDEX IF NOT EXISTS catalog_source_observation_alias_candidates_observation_idx
  ON catalog_source_observation_alias_candidates (observation_id)
  WHERE observation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_source_observation_alias_candidates_provider_profile_idx
  ON catalog_source_observation_alias_candidates (provider_key, source_profile_version);

CREATE TABLE IF NOT EXISTS catalog_item_aliases (
  alias_hash text PRIMARY KEY,
  catalog_item_id text NOT NULL,
  target_field text NOT NULL,
  alias_text text NOT NULL,
  normalized_alias_text text NOT NULL,
  alias_language_code text NOT NULL,
  source_language_code text NULL,
  alias_type text NOT NULL,
  confidence text NOT NULL,
  review_status text NOT NULL,
  provider_key text NOT NULL,
  observation_id text NULL,
  source_category text NOT NULL,
  source_profile_key text NOT NULL,
  source_profile_version text NOT NULL,
  mapping_fingerprint text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_actor text NULL,
  last_reason text NULL,
  policy_version text NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_item_aliases_review_status_check
    CHECK (review_status IN ('pending', 'accepted', 'auto-accepted', 'rejected', 'revoked'))
);

CREATE INDEX IF NOT EXISTS catalog_item_aliases_catalog_item_idx
  ON catalog_item_aliases (catalog_item_id, review_status);
CREATE INDEX IF NOT EXISTS catalog_item_aliases_text_idx
  ON catalog_item_aliases (normalized_alias_text, alias_language_code);
CREATE INDEX IF NOT EXISTS catalog_item_aliases_published_idx
  ON catalog_item_aliases (catalog_item_id, alias_type)
  WHERE review_status IN ('accepted', 'auto-accepted');
CREATE INDEX IF NOT EXISTS catalog_item_aliases_provider_profile_idx
  ON catalog_item_aliases (provider_key, source_profile_version);

CREATE TABLE IF NOT EXISTS catalog_reference_record_aliases (
  alias_hash text PRIMARY KEY,
  reference_record_id text NULL,
  type_key text NOT NULL,
  alias_text text NOT NULL,
  normalized_alias_text text NOT NULL,
  alias_language_code text NOT NULL,
  source_language_code text NULL,
  alias_type text NOT NULL,
  confidence text NOT NULL,
  review_status text NOT NULL,
  provider_key text NOT NULL,
  observation_id text NULL,
  source_category text NOT NULL,
  source_profile_key text NOT NULL,
  source_profile_version text NOT NULL,
  mapping_fingerprint text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_actor text NULL,
  last_reason text NULL,
  policy_version text NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_reference_record_aliases_type_check
    CHECK (alias_type IN ('set-equivalent', 'series-equivalent')),
  CONSTRAINT catalog_reference_record_aliases_review_status_check
    CHECK (review_status IN ('pending', 'accepted', 'auto-accepted', 'rejected', 'revoked'))
);

CREATE INDEX IF NOT EXISTS catalog_reference_record_aliases_record_idx
  ON catalog_reference_record_aliases (reference_record_id, review_status)
  WHERE reference_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_reference_record_aliases_type_key_idx
  ON catalog_reference_record_aliases (type_key, review_status);
CREATE INDEX IF NOT EXISTS catalog_reference_record_aliases_text_idx
  ON catalog_reference_record_aliases (normalized_alias_text, alias_language_code);
CREATE INDEX IF NOT EXISTS catalog_reference_record_aliases_published_idx
  ON catalog_reference_record_aliases (reference_record_id, alias_type)
  WHERE review_status IN ('accepted', 'auto-accepted');`;
