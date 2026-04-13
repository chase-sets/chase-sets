export const identityApiKeySchemaSql = `
CREATE TABLE IF NOT EXISTS identity_api_keys (
  api_key_id text PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL,
  key_prefix text NOT NULL,
  status text NOT NULL,
  last_used_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_api_key_lookup (
  key_prefix text PRIMARY KEY,
  api_key_id text NOT NULL,
  user_id text NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;
