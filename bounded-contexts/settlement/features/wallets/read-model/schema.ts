import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const settlementWalletSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_wallet_pages (
  account_id text PRIMARY KEY,
  currency_code text NOT NULL,
  pending_balance_amount numeric(12, 2) NOT NULL,
  available_balance_amount numeric(12, 2) NOT NULL,
  total_credited_amount numeric(12, 2) NOT NULL,
  total_debited_amount numeric(12, 2) NOT NULL,
  negative_balance_status text NOT NULL DEFAULT 'in-good-standing'
    CHECK (negative_balance_status IN ('in-good-standing', 'negative', 'collections')),
  negative_balance_started_at timestamptz NULL,
  collections_escalated_at timestamptz NULL,
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

CREATE TABLE IF NOT EXISTS settlement_wallet_spend_holds (
  hold_id text PRIMARY KEY,
  account_id text NOT NULL,
  payment_id text NULL,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released')),
  placed_at timestamptz NOT NULL,
  expires_at timestamptz NULL,
  released_at timestamptz NULL,
  release_reason text NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_wallet_spend_holds_active_account_idx
  ON settlement_wallet_spend_holds (account_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS settlement_wallet_spend_holds_active_expiry_idx
  ON settlement_wallet_spend_holds (expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;
`;

const settlementWalletSpendHoldsTableSql = `CREATE TABLE IF NOT EXISTS settlement_wallet_spend_holds (
  hold_id text PRIMARY KEY,
  account_id text NOT NULL,
  payment_id text NULL,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released')),
  placed_at timestamptz NOT NULL,
  expires_at timestamptz NULL,
  released_at timestamptz NULL,
  release_reason text NULL,
  updated_at timestamptz NOT NULL
);`;

const settlementWalletSpendHoldsActiveAccountIndexSql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_wallet_spend_holds_active_account_idx
  ON settlement_wallet_spend_holds (account_id)
  WHERE status = 'active';`;

const settlementWalletSpendHoldsActiveExpiryIndexSql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_wallet_spend_holds_active_expiry_idx
  ON settlement_wallet_spend_holds (expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;`;

const settlementWalletNegativeBalanceColumnsSql = `ALTER TABLE settlement_wallet_pages
  ADD COLUMN IF NOT EXISTS negative_balance_status text NOT NULL DEFAULT 'in-good-standing'
    CHECK (negative_balance_status IN ('in-good-standing', 'negative', 'collections')),
  ADD COLUMN IF NOT EXISTS negative_balance_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS collections_escalated_at timestamptz NULL;`;

const settlementWalletNegativeBalanceIndexSql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_wallet_pages_negative_balance_idx
  ON settlement_wallet_pages (negative_balance_status, negative_balance_started_at)
  WHERE negative_balance_status <> 'in-good-standing';`;

export const settlementWalletSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260707_settlement_wallet_negative_balance_columns",
    description: "Backfill settlement wallet negative-balance columns and create the lookup index.",
    statements: [
      "SET lock_timeout = '5s';",
      settlementWalletNegativeBalanceColumnsSql,
      settlementWalletNegativeBalanceIndexSql,
    ],
  },
  {
    migrationId: "20260715_settlement_wallet_spend_holds",
    description: "Create the buyer-spend hold read model backing the balance-credit reservation (issue #3568).",
    statements: [
      "SET lock_timeout = '5s';",
      settlementWalletSpendHoldsTableSql,
      settlementWalletSpendHoldsActiveAccountIndexSql,
      settlementWalletSpendHoldsActiveExpiryIndexSql,
    ],
  },
];
