/**
 * The GMV Reconciliation Run: one row per tape-vs-ledger drift check
 * owned by platform-operations even though both source numbers it
 * compares (pricing's Platform Daily Rollup GMV, settlement's ledger 'sale'
 * credit total) live in other contexts -- this table only ever stores the
 * comparison RESULT, never raw trade or ledger rows, so it is genuinely
 * platform-operations' own data, not a mirror of another context's tables.
 *
 * Retention: forever, like the source data it audits (an ops audit trail
 * shouldn't silently disappear) -- exempt from age-based retention sweeps by
 * omission, matching the Trades Tape / rollup convention.
 */
export const platformOperationsOpsDashboardSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_operations_gmv_reconciliation_runs (
  reconciliation_run_id text PRIMARY KEY,
  year_month text NOT NULL,
  tape_gmv_amount numeric(14, 2) NOT NULL,
  ledger_sale_amount numeric(14, 2) NOT NULL,
  delta_amount numeric(14, 2) NOT NULL,
  delta_ratio numeric(8, 4) NULL,
  status text NOT NULL CHECK (status IN ('ok', 'drift-alarm')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_operations_gmv_reconciliation_runs_month_idx
  ON platform_operations_gmv_reconciliation_runs (year_month DESC, completed_at DESC);
`;
