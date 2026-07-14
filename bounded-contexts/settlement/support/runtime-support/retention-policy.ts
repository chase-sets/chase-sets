import type { BcRetentionExemption, BcRetentionSweep, BcSchemaMigration } from "@chase-sets/bounded-context-module";

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;

export const settlementRetentionSweeps: readonly BcRetentionSweep[] = [
  ageSweep("money-movement-webhook-events", "settlement_money_movement_webhook_events", "received_at"),
  ageSweep("provider-idempotency-keys", "settlement_provider_idempotency_keys", "created_at"),
];

export const settlementRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "settlement_provider_operations",
    owner: "settlement",
    reason: "Payout provider operation history is accounting evidence and requires archive policy.",
  },
  {
    tableName: "settlement_reconciliation_runs",
    owner: "settlement",
    reason: "Payout reconciliation history is accounting evidence and requires archive policy.",
  },
  {
    tableName: "settlement_protection_coverage",
    owner: "settlement",
    reason:
      "Protection-coverage reservation lifecycle is accounting evidence for reserve reconciliation and requires archive policy.",
  },
  {
    tableName: "settlement_protection_coverage_rejections",
    owner: "settlement",
    reason:
      "Refused protection-coverage reservations are an audit trail (why coverage was denied) and require archive policy.",
  },
];

export const settlementRetentionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_settlement_idempotency_retention_index",
    description: "Add the provider idempotency ordering index used by bounded retention sweeps.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_provider_idempotency_keys_retention_idx
  ON settlement_provider_idempotency_keys (created_at)`,
    ],
  },
];

function ageSweep(name: string, tableName: string, timestampColumn: string): BcRetentionSweep {
  return {
    name,
    tableName,
    predicateSql: `candidate.${timestampColumn} < now() - interval '90 days'`,
    orderBySql: `candidate.${timestampColumn} ASC`,
    intervalMs: SIX_HOURS_MS,
    batchLimit: 500,
  };
}
