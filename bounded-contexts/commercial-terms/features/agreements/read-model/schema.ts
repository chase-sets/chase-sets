export const agreementSchemaSql = `
CREATE TABLE IF NOT EXISTS commercial_terms_agreement_pages (
  agreement_id text PRIMARY KEY,
  account_id text NOT NULL,
  label text NOT NULL,
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

CREATE INDEX IF NOT EXISTS commercial_terms_agreement_pages_account_idx
  ON commercial_terms_agreement_pages (account_id, effective_from DESC, updated_at DESC);
`;
