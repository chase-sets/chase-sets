import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

/**
 * Read model for the Wallet Adjustment lifecycle (ADR 0020). Owned by the
 * settlement wallet projection alongside the wallet balance pages -- it is a
 * same-context self-projection of the `settlement.wallet-adjustment.*` stream,
 * so it needs no cross-context wake registration. Every column is derived from
 * an immutable lifecycle event; posted adjustments and their linked reversals
 * are never edited, only advanced forward through their status.
 */
export const settlementWalletAdjustmentSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_wallet_adjustment_pages (
  adjustment_id text PRIMARY KEY,
  status text NOT NULL
    CHECK (status IN ('requested', 'approved', 'rejected', 'posted', 'reversed')),
  target_account_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  reason_code text NOT NULL,
  explanation text NULL,
  evidence_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  reversal_of_adjustment_id text NULL,
  reversed_by_adjustment_id text NULL,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL,
  self_benefiting boolean NOT NULL DEFAULT FALSE,
  approved_by text NULL,
  approved_at timestamptz NULL,
  elevation_required boolean NOT NULL DEFAULT FALSE,
  elevation_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  elevation_approved_by text NULL,
  creates_or_increases_negative_balance boolean NOT NULL DEFAULT FALSE,
  reversal_after_funds_settled boolean NOT NULL DEFAULT FALSE,
  high_value_credit_threshold_amount numeric(12, 2) NULL,
  high_value_debit_threshold_amount numeric(12, 2) NULL,
  recent_auth_max_age_minutes integer NULL,
  rejected_by text NULL,
  rejected_at timestamptz NULL,
  rejection_reason text NULL,
  posted_ledger_entry_id text NULL,
  posted_at timestamptz NULL,
  available_balance_before numeric(12, 2) NULL,
  available_balance_after numeric(12, 2) NULL,
  reversed_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_wallet_adjustment_pages_account_idx
  ON settlement_wallet_adjustment_pages (target_account_id, requested_at DESC, adjustment_id DESC);

CREATE INDEX IF NOT EXISTS settlement_wallet_adjustment_pages_incomplete_idx
  ON settlement_wallet_adjustment_pages (status, requested_at)
  WHERE status IN ('requested', 'approved');

CREATE INDEX IF NOT EXISTS settlement_wallet_adjustment_pages_ledger_entry_idx
  ON settlement_wallet_adjustment_pages (posted_ledger_entry_id)
  WHERE posted_ledger_entry_id IS NOT NULL;
`;

export const settlementWalletAdjustmentSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260713_settlement_wallet_adjustment_pages",
    description: "Create the Wallet Adjustment lifecycle read model and its lookup indexes (additive, replay-safe).",
    statements: ["SET lock_timeout = '5s';", settlementWalletAdjustmentSchemaSql],
  },
];
