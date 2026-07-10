import type { BcRetentionSweep, BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const checkoutRetentionSweeps: readonly BcRetentionSweep[] = [
  {
    name: "terminal-session-pages",
    tableName: "checkout_session_pages",
    predicateSql: `(candidate.cancelled_at IS NOT NULL OR jsonb_array_length(candidate.order_ids) > 0)
      AND candidate.updated_at < now() - interval '30 days'`,
    orderBySql: "candidate.updated_at ASC",
    intervalMs: 24 * 60 * 60 * 1_000,
    batchLimit: 250,
  },
];

export const checkoutRetentionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_checkout_session_retention_index",
    description: "Add the terminal checkout-session ordering index used by bounded retention sweeps.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS checkout_session_pages_retention_idx
  ON checkout_session_pages (updated_at)
  WHERE cancelled_at IS NOT NULL OR order_ids <> '[]'::jsonb`,
    ],
  },
];
