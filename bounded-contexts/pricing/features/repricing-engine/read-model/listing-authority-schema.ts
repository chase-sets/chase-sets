import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

// Retained owner mutation/admission receipts, not replayable projections or TTL caches.
export const pricingListingAuthoritySchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_authority_sql_mutations (
  mutation_id text PRIMARY KEY,
  command jsonb NOT NULL,
  result jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS pricing_evaluation_budget_admissions (
  evaluation_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  budget_day date NOT NULL,
  binding text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'released'))
);
CREATE INDEX IF NOT EXISTS pricing_evaluation_budget_account_day_idx
  ON pricing_evaluation_budget_admissions (seller_account_id, budget_day);
`;

export const pricingListingAuthoritySchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260928_pricing_listing_authority_receipts",
    description: "Retain Pricing SQL mutation and daily budget admission identities.",
    statements: [pricingListingAuthoritySchemaSql],
  },
];
