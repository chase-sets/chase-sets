export const resolutionAccountSchemaSql = `
CREATE TABLE IF NOT EXISTS commercial_terms_account_pages (
  account_id text PRIMARY KEY,
  name text NOT NULL,
  display_name text NOT NULL,
  account_type text NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS commercial_terms_account_pages_type_idx
  ON commercial_terms_account_pages (account_type, updated_at DESC);
`;
