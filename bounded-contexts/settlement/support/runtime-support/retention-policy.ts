import type { BcRetentionExemption, BcRetentionSweep, BcSchemaMigration } from "@chase-sets/bounded-context-module";

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;

export const settlementRetentionSweeps: readonly BcRetentionSweep[] = [
  ageSweep("money-movement-webhook-events", "settlement_money_movement_webhook_events", "received_at"),
  ageSweep("provider-idempotency-keys", "settlement_provider_idempotency_keys", "created_at"),
  // Client payout-request idempotency reservations are only useful for the retry
  // window of a submit; a redelivery 90 days later is not a real double-submit.
  // Prune on the same horizon as provider idempotency keys.
  ageSweep("payout-request-idempotency", "settlement_payout_request_idempotency", "created_at"),
  {
    // Prune only long-released buyer-spend holds. Active holds are
    // live money reservations and must never be swept, so the predicate is
    // gated on the terminal 'released' status, not merely age.
    name: "wallet-spend-holds",
    tableName: "settlement_wallet_spend_holds",
    predicateSql: `candidate.status = 'released' AND candidate.released_at < now() - interval '90 days'`,
    orderBySql: `candidate.released_at ASC`,
    intervalMs: SIX_HOURS_MS,
    batchLimit: 500,
  },
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
    tableName: "settlement_liability_reconciliation_runs",
    owner: "settlement",
    reason:
      "Ledger-vs-provider liability reconciliation history is solvency audit evidence and requires archive policy.",
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
  {
    migrationId: "20260715_settlement_wallet_spend_holds_retention_index",
    description: "Add the released-hold ordering index used by the buyer-spend hold retention sweep.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_wallet_spend_holds_retention_idx
  ON settlement_wallet_spend_holds (released_at)
  WHERE status = 'released'`,
    ],
  },
  {
    migrationId: "20260716_settlement_payout_request_idempotency_retention_index",
    description: "Add the created-at ordering index used by the payout-request idempotency retention sweep.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS settlement_payout_request_idempotency_retention_idx
  ON settlement_payout_request_idempotency (created_at)`,
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
