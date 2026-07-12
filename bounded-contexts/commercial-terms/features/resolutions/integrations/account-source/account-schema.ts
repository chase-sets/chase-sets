export const resolutionAccountSchemaSql = `
CREATE TABLE IF NOT EXISTS commercial_terms_account_pages (
  account_id text PRIMARY KEY,
  name text NOT NULL,
  display_name text NOT NULL,
  account_type text NOT NULL,
  status text NOT NULL,
  founders_window_started_at timestamptz NULL,
  founders_window_ends_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE commercial_terms_account_pages
  ADD COLUMN IF NOT EXISTS founders_window_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS founders_window_ends_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS commercial_terms_account_pages_type_idx
  ON commercial_terms_account_pages (account_type, updated_at DESC);
`;
