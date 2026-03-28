export const identitySessionSchemaSql = `
CREATE TABLE IF NOT EXISTS identity_sessions (
  session_id text PRIMARY KEY,
  user_id text NOT NULL,
  account_id text NOT NULL,
  available_account_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  authentication_method text NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_session_lookup (
  token_hash text PRIMARY KEY,
  session_id text NOT NULL,
  user_id text NOT NULL,
  account_id text NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;
