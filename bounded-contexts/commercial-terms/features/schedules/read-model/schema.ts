export const scheduleSchemaSql = `
CREATE TABLE IF NOT EXISTS commercial_terms_schedule_pages (
  schedule_id text PRIMARY KEY,
  label text NOT NULL,
  account_type text NOT NULL,
  marketplace_fee_percentage_bps integer NOT NULL,
  marketplace_fee_fixed_amount numeric(12,2) NOT NULL,
  payment_fee_percentage_bps integer NOT NULL,
  payment_fee_fixed_amount numeric(12,2) NOT NULL,
  status text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS commercial_terms_schedule_pages_account_type_idx
  ON commercial_terms_schedule_pages (account_type, effective_from DESC, updated_at DESC);
`;
