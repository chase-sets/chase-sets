export const settlementPayoutSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_payout_pages (
  payout_id text PRIMARY KEY,
  account_id text NOT NULL,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  destination_reference text NULL,
  note text NULL,
  status text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  sent_at timestamptz NULL,
  completed_at timestamptz NULL,
  failed_at timestamptz NULL,
  failure_reason text NULL
);

CREATE INDEX IF NOT EXISTS settlement_payout_pages_account_idx
  ON settlement_payout_pages (account_id, updated_at DESC, payout_id DESC);
`;
