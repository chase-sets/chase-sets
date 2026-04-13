export const identityConsentSchemaSql = `CREATE TABLE IF NOT EXISTS identity_consents (
  consent_id text PRIMARY KEY,
  subject_type text NOT NULL,
  user_id text NULL,
  account_id text NULL,
  policy_key text NOT NULL,
  policy_version text NOT NULL,
  recorded_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;
