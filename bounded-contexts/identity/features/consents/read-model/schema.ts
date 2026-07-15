export const identityConsentSchemaSql = `CREATE TABLE IF NOT EXISTS identity_consents (
  consent_id text PRIMARY KEY,
  subject_type text NOT NULL,
  user_id text NULL,
  account_id text NULL,
  policy_key text NOT NULL,
  policy_version text NOT NULL,
  status text NOT NULL DEFAULT 'recorded',
  recorded_at timestamptz NOT NULL,
  withdrawn_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE identity_consents
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'recorded',
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz NULL;

CREATE UNLOGGED TABLE IF NOT EXISTS identity_consent_current_states (
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  user_id text NULL,
  account_id text NULL,
  policy_key text NOT NULL,
  consent_id text NOT NULL,
  policy_version text NOT NULL,
  status text NOT NULL,
  recorded_at timestamptz NOT NULL,
  withdrawn_at timestamptz NULL,
  last_event_global_position bigint NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (subject_type, subject_id, policy_key)
);`;
