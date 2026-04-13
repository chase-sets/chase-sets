export const orderingAccountSchemaSql = `
CREATE TABLE IF NOT EXISTS ordering_account_pages (
  account_id text PRIMARY KEY,
  display_name text NULL,
  status text NOT NULL DEFAULT 'active',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ordering_account_pages_status_idx
  ON ordering_account_pages (status, updated_at DESC, account_id ASC);
`;
