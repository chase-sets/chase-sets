export const identityAccountSchemaSql = `CREATE TABLE IF NOT EXISTS identity_accounts (
  account_id text PRIMARY KEY,
  name text NOT NULL,
  display_name text NOT NULL,
  account_type text NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;
