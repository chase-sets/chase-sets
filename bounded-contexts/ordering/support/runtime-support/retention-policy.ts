import type { BcRetentionSweep, BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const orderingRetentionSweeps: readonly BcRetentionSweep[] = [
  {
    name: "released-listing-purchase-limit-claims",
    tableName: "ordering_listing_purchase_limit_claims",
    predicateSql: "candidate.status = 'released' AND candidate.released_at < now() - interval '30 days'",
    orderBySql: "candidate.released_at ASC",
    intervalMs: 6 * 60 * 60 * 1_000,
    batchLimit: 500,
  },
  {
    name: "released-seller-open-order-claims",
    tableName: "ordering_seller_open_order_claims",
    predicateSql: "candidate.status = 'released' AND candidate.released_at < now() - interval '30 days'",
    orderBySql: "candidate.released_at ASC",
    intervalMs: 6 * 60 * 60 * 1_000,
    batchLimit: 500,
  },
];

export const orderingRetentionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_ordering_purchase_claim_retention_index",
    description: "Add the released purchase-limit claim ordering index used by bounded retention sweeps.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ordering_listing_purchase_limit_claims_retention_idx
  ON ordering_listing_purchase_limit_claims (released_at)
  WHERE status = 'released'`,
    ],
  },
  {
    migrationId: "20260713_ordering_seller_open_order_claim_retention_index",
    description: "Add the released seller Open Order claim ordering index used by bounded retention sweeps.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ordering_seller_open_order_claims_retention_idx
  ON ordering_seller_open_order_claims (released_at)
  WHERE status = 'released'`,
    ],
  },
];
