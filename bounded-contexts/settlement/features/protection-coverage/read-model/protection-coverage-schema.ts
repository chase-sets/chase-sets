import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

/**
 * Read-model schema for the Settlement ProtectionCoverage slice (ADR 0022).
 * Two tables projected from the Settlement-owned
 * `settlement.protection-coverage.*` facts:
 *
 * - `settlement_protection_coverage` — one row per reservation lifecycle
 *   (reserved → settled | released | expired), the operator/metrics surface for
 *   reconciliation. It never exposes internal ledger postings.
 * - `settlement_protection_coverage_rejections` — the audit trail of refused
 *   reservations with a closed machine-readable reason, so a conflicting retry
 *   or an insufficient reserve is visible and countable.
 *
 * Authoritative availability lives in the pool aggregate; these tables are a
 * convergent projection for operators and metrics. Reservation amounts are
 * `numeric(12,2)`, non-negative, consistent with the money primitive.
 */
export const settlementProtectionCoverageSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_protection_coverage (
  coverage_id text PRIMARY KEY,
  remedy_id text NOT NULL,
  support_request_id text NOT NULL,
  currency_code text NOT NULL,
  reserved_amount numeric(12,2) NOT NULL CHECK (reserved_amount >= 0),
  consumed_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (consumed_amount >= 0),
  released_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (released_amount >= 0),
  recovered_gross_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (recovered_gross_amount >= 0),
  recovery_cost_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (recovery_cost_amount >= 0),
  recovered_net_amount numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'expired')),
  refund_id text NULL,
  policy_version text NOT NULL,
  reason_code text NULL,
  reserved_at timestamptz NOT NULL,
  terminal_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settlement_protection_coverage_status_idx
  ON settlement_protection_coverage (status, reserved_at DESC, coverage_id DESC);

CREATE INDEX IF NOT EXISTS settlement_protection_coverage_remedy_idx
  ON settlement_protection_coverage (remedy_id);

CREATE TABLE IF NOT EXISTS settlement_protection_coverage_rejections (
  coverage_id text NOT NULL,
  remedy_id text NOT NULL,
  support_request_id text NOT NULL,
  requested_amount numeric(12,2) NOT NULL,
  currency_code text NOT NULL,
  reason_code text NOT NULL,
  idempotency_key text NOT NULL,
  rejected_at timestamptz NOT NULL,
  PRIMARY KEY (coverage_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS settlement_protection_coverage_rejections_reason_idx
  ON settlement_protection_coverage_rejections (reason_code, rejected_at DESC);

CREATE TABLE IF NOT EXISTS settlement_protection_coverage_recoveries (
  recovery_id text PRIMARY KEY,
  coverage_id text NOT NULL,
  remedy_id text NOT NULL,
  recovered_item_id text NOT NULL,
  return_shipment_id text NOT NULL,
  recovery_type text NOT NULL,
  gross_amount numeric(12,2) NOT NULL CHECK (gross_amount >= 0),
  cost_amount numeric(12,2) NOT NULL CHECK (cost_amount >= 0),
  net_amount numeric(12,2) NOT NULL,
  currency_code text NOT NULL,
  policy_version text NOT NULL,
  evidence_references jsonb NOT NULL,
  causation_id text NULL,
  recovered_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_protection_coverage_recoveries_coverage_idx
  ON settlement_protection_coverage_recoveries (coverage_id, recovered_at);
`;

export const settlementProtectionCoverageSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260714_settlement_protection_coverage_recovery_columns",
    description: "Add recovered-return value totals to protection coverage projections.",
    statements: [
      `
      ALTER TABLE settlement_protection_coverage
        ADD COLUMN IF NOT EXISTS recovered_gross_amount numeric(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS recovery_cost_amount numeric(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS recovered_net_amount numeric(12,2) NOT NULL DEFAULT 0;
    `,
    ],
  },
];
