import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const pricingRoundAdmissionSchemaSql = `
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
CREATE UNIQUE INDEX IF NOT EXISTS pricing_repricing_round_active_product_idx
  ON pricing_repricing_round_admissions (catalog_catalog_item_id, product_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS pricing_authority_recovery_cursors (
  writer text PRIMARY KEY,
  after_position bigint NOT NULL DEFAULT 0
);
`;

export const pricingRoundAdmissionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260928_pricing_durable_product_round_admission",
    description: "Retain Product round admission and original checkpoints until terminal or recorded recovery closure.",
    statements: [pricingRoundAdmissionSchemaSql],
  },
];
