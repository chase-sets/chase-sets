import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const pricingRoundAdmissionTablesSql = `
CREATE TABLE IF NOT EXISTS pricing_repricing_round_admissions (
  round_id text PRIMARY KEY,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  executor_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'completed')),
  checkpoints jsonb NOT NULL DEFAULT '{}',
  closure_reason text,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE TABLE IF NOT EXISTS pricing_authority_recovery_cursors (
  writer text PRIMARY KEY,
  after_position bigint NOT NULL DEFAULT 0
);
`;

// Fresh boot builds the index on the new empty table. The ledger uses a separate
// concurrent statement so upgrading a populated admission ledger does not block writers.
export const pricingRoundAdmissionSchemaSql = `${pricingRoundAdmissionTablesSql}
CREATE UNIQUE INDEX IF NOT EXISTS pricing_repricing_round_active_product_idx
  ON pricing_repricing_round_admissions (catalog_catalog_item_id, product_id) WHERE status = 'active';
`;

export const pricingRoundAdmissionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260928_pricing_durable_product_round_admission",
    description: "Retain Product round admission and original checkpoints until terminal or recorded recovery closure.",
    statements: [
      pricingRoundAdmissionTablesSql,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pricing_repricing_round_active_product_idx
       ON pricing_repricing_round_admissions (catalog_catalog_item_id, product_id) WHERE status = 'active'`,
    ],
  },
];
