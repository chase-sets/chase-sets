export const settlementWalletSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_wallet_pages (
  account_id text PRIMARY KEY,
  currency_code text NOT NULL,
  pending_balance_amount numeric(12, 2) NOT NULL,
  available_balance_amount numeric(12, 2) NOT NULL,
  total_credited_amount numeric(12, 2) NOT NULL,
  total_debited_amount numeric(12, 2) NOT NULL,
  opened_at timestamptz NULL,
  updated_at timestamptz NULL
);

CREATE TABLE IF NOT EXISTS settlement_ledger_entry_pages (
  ledger_entry_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES settlement_wallet_pages (account_id) ON DELETE CASCADE,
  kind text NOT NULL,
  direction text NOT NULL,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  funds_status text NOT NULL,
  order_id text NULL,
  payment_id text NULL,
  payout_id text NULL,
  description text NULL,
  posted_at timestamptz NOT NULL,
  available_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_ledger_entry_pages_account_idx
  ON settlement_ledger_entry_pages (account_id, posted_at DESC, ledger_entry_id DESC);

CREATE INDEX IF NOT EXISTS settlement_ledger_entry_pages_payout_idx
  ON settlement_ledger_entry_pages (payout_id)
  WHERE payout_id IS NOT NULL;
`;
