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
  display_reference text NOT NULL DEFAULT '',
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

/**
 * `display_reference` is added to already-deployed tables idempotently
 * outside the base `CREATE TABLE` (matching the payout display-reference
 * precedent), and its uniqueness is enforced by a `CONCURRENTLY` index in its
 * own migration statement since that index type cannot run inside a
 * transaction. Rows written before this migration ran keep the empty-string
 * default and are excluded from the uniqueness check via the partial index.
 */
const settlementWalletAdjustmentDisplayReferenceColumnSql = `
ALTER TABLE settlement_wallet_adjustment_pages
  ADD COLUMN IF NOT EXISTS display_reference text NOT NULL DEFAULT '';
`;

const settlementWalletAdjustmentDisplayReferenceUniqueIndexSql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS settlement_wallet_adjustment_pages_display_reference_key
  ON settlement_wallet_adjustment_pages (display_reference)
  WHERE display_reference <> '';`;

export const settlementWalletAdjustmentSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260713_settlement_wallet_adjustment_pages",
    description: "Create the Wallet Adjustment lifecycle read model and its lookup indexes (additive, replay-safe).",
    statements: ["SET lock_timeout = '5s';", settlementWalletAdjustmentSchemaSql],
  },
  {
    migrationId: "20260714_settlement_wallet_adjustment_display_reference_column",
    description:
      "Add the support-safe/account-facing Wallet Adjustment display reference column outside boot-time schema SQL " +
      "(additive, replay-safe).",
    statements: ["SET lock_timeout = '5s';", settlementWalletAdjustmentDisplayReferenceColumnSql],
  },
  {
    migrationId: "20260714_settlement_wallet_adjustment_display_reference_idx",
    description:
      "Add the Wallet Adjustment display reference unique index outside boot-time schema SQL. Rows written before " +
      "this migration ran keep the empty-string default and are excluded from the uniqueness check; the " +
      "projector always populates a real reference for every adjustment it creates.",
    statements: ["SET lock_timeout = '5s';", settlementWalletAdjustmentDisplayReferenceUniqueIndexSql],
  },
];
