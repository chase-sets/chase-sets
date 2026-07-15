/**
 * Read-model schema for the Settlement liability-allocation slice (ADR 0022).
 *
 * One table, `settlement_refund_liability_allocations`, is the durable reconciliation
 * record for every refund whose liability Settlement allocates. It is written from a
 * single projection so a refund's authorized allocation, its completed reconciliation,
 * and any quarantine are one converging row:
 *
 * - `authorized` — the Payments refund-causation fact recorded who funds the refund
 *   (seller/platform/split) before completion; the allocation is known, postings pending.
 * - `reconciled` — the completed refund's seller portion is posted to the seller ledger
 *   and (for platform-funded refunds) the reserved coverage is consumed; postings durable.
 * - `quarantined` — a fail-closed state for a refund whose allocation is missing,
 *   mismatched, over-limit, wrong-currency, or over-reservation. No seller debit and no
 *   coverage consumption happen for a quarantined row; it is the operator repair queue.
 *
 * Amounts are `numeric(12,2)` and non-negative, consistent with the money primitive.
 * Financial postings themselves remain in the wallet ledger and the ProtectionCoverage
 * aggregate; this table records their reconciliation, never a competing balance.
 */
export const settlementRefundLiabilityAllocationSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_refund_liability_allocations (
  refund_id text PRIMARY KEY,
  payment_id text NULL,
  remedy_id text NOT NULL,
  coverage_id text NULL,
  currency_code text NOT NULL,
  seller_funded_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (seller_funded_amount >= 0),
  platform_funded_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (platform_funded_amount >= 0),
  funding_kind text NOT NULL CHECK (funding_kind IN ('seller-funded', 'platform-funded', 'split')),
  completed_refund_amount numeric(12,2) NULL CHECK (completed_refund_amount IS NULL OR completed_refund_amount >= 0),
  seller_posted_amount numeric(12,2) NULL CHECK (seller_posted_amount IS NULL OR seller_posted_amount >= 0),
  platform_settled_amount numeric(12,2) NULL CHECK (platform_settled_amount IS NULL OR platform_settled_amount >= 0),
  reconciliation_status text NOT NULL CHECK (reconciliation_status IN ('authorized', 'reconciled', 'quarantined')),
  quarantine_reason text NULL,
  quarantine_detail text NULL,
  authorized_at timestamptz NULL,
  reconciled_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settlement_refund_liability_allocations_status_idx
  ON settlement_refund_liability_allocations (reconciliation_status, updated_at DESC, refund_id DESC);

CREATE INDEX IF NOT EXISTS settlement_refund_liability_allocations_remedy_idx
  ON settlement_refund_liability_allocations (remedy_id);

CREATE INDEX IF NOT EXISTS settlement_refund_liability_allocations_coverage_idx
  ON settlement_refund_liability_allocations (coverage_id)
  WHERE coverage_id IS NOT NULL;
`;
