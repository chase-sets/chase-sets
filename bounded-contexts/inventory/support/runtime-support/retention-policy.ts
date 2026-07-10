import type { BcRetentionExemption, BcRetentionSweep, BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const inventoryRetentionSweeps: readonly BcRetentionSweep[] = [
  {
    name: "completed-item-adjustment-idempotency",
    tableName: "inventory_item_adjustment_idempotency",
    predicateSql: "candidate.status = 'completed' AND candidate.completed_at < now() - interval '90 days'",
    orderBySql: "candidate.completed_at ASC",
    intervalMs: 6 * 60 * 60 * 1_000,
    batchLimit: 500,
  },
];

export const inventoryRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "inventory_holds",
    owner: "inventory",
    reason: "Hold rows are mutable event projections that may receive later release, consume, or extension events.",
  },
];

export const inventoryRetentionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_inventory_idempotency_retention_index",
    description: "Add the completed adjustment ordering index used by bounded retention sweeps.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_item_adjustment_idempotency_retention_idx
  ON inventory_item_adjustment_idempotency (completed_at)
  WHERE status = 'completed'`,
    ],
  },
];
