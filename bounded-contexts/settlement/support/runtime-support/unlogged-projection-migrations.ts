import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const settlementUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_settlement_unlogged_projections",
    description: "Store replayable Settlement projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE settlement_ledger_entry_pages DROP CONSTRAINT IF EXISTS settlement_ledger_entry_pages_account_id_fkey;",
      "ALTER TABLE settlement_account_address_risk_sources SET UNLOGGED;",
      "ALTER TABLE settlement_account_instrument_risk_sources SET UNLOGGED;",
      "ALTER TABLE settlement_account_review_sources SET UNLOGGED;",
      "ALTER TABLE settlement_account_risk_sources SET UNLOGGED;",
      "ALTER TABLE settlement_account_velocity_sources SET UNLOGGED;",
      "ALTER TABLE settlement_ledger_entry_pages SET UNLOGGED;",
      "ALTER TABLE settlement_order_fulfillment_sources SET UNLOGGED;",
      "ALTER TABLE settlement_order_trust_signal_sources SET UNLOGGED;",
      "ALTER TABLE settlement_payment_sources SET UNLOGGED;",
      "ALTER TABLE settlement_payout_pages SET UNLOGGED;",
      "ALTER TABLE settlement_payout_readiness_pages SET UNLOGGED;",
      "ALTER TABLE settlement_refund_sources SET UNLOGGED;",
      "ALTER TABLE settlement_support_holds SET UNLOGGED;",
      "ALTER TABLE settlement_wallet_pages SET UNLOGGED;",
      "ALTER TABLE settlement_ledger_entry_pages ADD CONSTRAINT settlement_ledger_entry_pages_account_id_fkey FOREIGN KEY (account_id) REFERENCES settlement_wallet_pages (account_id) ON DELETE CASCADE NOT VALID;",
      "ALTER TABLE settlement_ledger_entry_pages VALIDATE CONSTRAINT settlement_ledger_entry_pages_account_id_fkey;",
    ],
  },
];
