import type { BcRetentionExemption, BcRetentionSweep, BcSchemaMigration } from "@chase-sets/bounded-context-module";

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;

export const paymentsRetentionSweeps: readonly BcRetentionSweep[] = [
  ageSweep("provider-webhook-events", "payments_provider_webhook_events", "received_at", 90),
  ageSweep("provider-idempotency-keys", "payments_provider_idempotency_keys", "created_at", 90),
  {
    name: "terminal-payment-creation-reservations",
    tableName: "payments_payment_creation_reservations",
    predicateSql: `candidate.status IN ('failed', 'released')
      AND candidate.updated_at < now() - interval '90 days'`,
    orderBySql: "candidate.updated_at ASC",
    intervalMs: SIX_HOURS_MS,
    batchLimit: 500,
  },
];

export const paymentsRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "payments_saved_checkout_instrument_audit",
    owner: "payments",
    reason: "Consent/security audit history requires archive policy before destructive retention.",
  },
  {
    tableName: "payments_reconciliation_runs",
    owner: "payments",
    reason: "Money reconciliation evidence requires an accounting archive policy before deletion.",
  },
  {
    tableName: "payments_provider_operations",
    owner: "payments",
    reason: "Provider operation history is money-movement audit evidence, not disposable maintenance data.",
  },
  {
    tableName: "payments_payment_pages",
    owner: "payments",
    reason: "Payment pages are money-relevant records explicitly excluded by issue #3625.",
  },
];

export const paymentsRetentionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_payments_retention_indexes",
    description: "Add ordering indexes used by bounded Payments retention sweeps.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_provider_idempotency_keys_retention_idx
  ON payments_provider_idempotency_keys (created_at)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS payments_payment_creation_reservations_retention_idx
  ON payments_payment_creation_reservations (updated_at)
  WHERE status IN ('failed', 'released')`,
    ],
  },
];

function ageSweep(name: string, tableName: string, timestampColumn: string, days: number): BcRetentionSweep {
  return {
    name,
    tableName,
    predicateSql: `candidate.${timestampColumn} < now() - interval '${days} days'`,
    orderBySql: `candidate.${timestampColumn} ASC`,
    intervalMs: SIX_HOURS_MS,
    batchLimit: 500,
  };
}
