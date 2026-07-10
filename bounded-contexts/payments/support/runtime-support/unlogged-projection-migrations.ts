import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const paymentsUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_payments_unlogged_projections",
    description: "Store replayable Payments projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE payments_payment_orders DROP CONSTRAINT IF EXISTS payments_payment_orders_payment_id_fkey;",
      "ALTER TABLE payments_account_risk_sources SET UNLOGGED;",
      "ALTER TABLE payments_fulfillment_dispute_evidence_sources SET UNLOGGED;",
      "ALTER TABLE payments_order_inputs SET UNLOGGED;",
      "ALTER TABLE payments_payment_orders SET UNLOGGED;",
      "ALTER TABLE payments_payment_pages SET UNLOGGED;",
      "ALTER TABLE payments_refund_pages SET UNLOGGED;",
      "ALTER TABLE payments_payment_orders ADD CONSTRAINT payments_payment_orders_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments_payment_pages (payment_id) ON DELETE CASCADE NOT VALID;",
      "ALTER TABLE payments_payment_orders VALIDATE CONSTRAINT payments_payment_orders_payment_id_fkey;",
    ],
  },
];
