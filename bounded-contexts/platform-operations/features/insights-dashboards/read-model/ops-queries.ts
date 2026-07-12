import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import { computeGmvReconciliation, type GmvReconciliationStatus } from "./reconciliation-policy";

export type GmvReconciliationRun = Readonly<{
  reconciliationRunId: string;
  yearMonth: string;
  tapeGmvAmount: string;
  ledgerSaleAmount: string;
  deltaAmount: string;
  deltaRatio: string | null;
  status: GmvReconciliationStatus;
  startedAt: string;
  completedAt: string;
}>;

/**
 * Runs the tape-vs-ledger GMV reconciliation drift check for one calendar
 * month and records the result. The two source amounts are passed
 * in rather than fetched here -- this function's job is the comparison and
 * the durable record, not cross-context orchestration (the caller, e.g. the
 * platform-worker scheduled job, already has both contexts' services in
 * scope and fetches them directly; see deployables/platform-worker's
 * `platform-operations.gmv-reconciliation` job).
 */
export async function runGmvReconciliation(
  db: PgQueryable,
  params: Readonly<{ yearMonth: string; tapeGmvAmount: string; ledgerSaleAmount: string; now?: string }>,
): Promise<GmvReconciliationRun> {
  const startedAt = params.now ?? new Date().toISOString();
  const computation = computeGmvReconciliation({
    tapeGmvAmount: params.tapeGmvAmount,
    ledgerSaleAmount: params.ledgerSaleAmount,
  });
  const completedAt = new Date().toISOString();
  const reconciliationRunId = createId("gmvrec");

  await db.query(
    `INSERT INTO platform_operations_gmv_reconciliation_runs (
       reconciliation_run_id, year_month, tape_gmv_amount, ledger_sale_amount,
       delta_amount, delta_ratio, status, started_at, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      reconciliationRunId,
      params.yearMonth,
      computation.tapeGmvAmount,
      computation.ledgerSaleAmount,
      computation.deltaAmount,
      computation.deltaRatio,
      computation.status,
      startedAt,
      completedAt,
    ],
  );

  return {
    reconciliationRunId,
    yearMonth: params.yearMonth,
    ...computation,
    startedAt,
    completedAt,
  };
}

export async function listGmvReconciliationRuns(
  db: PgQueryable,
  params: Readonly<{ limit?: number }> = {},
): Promise<readonly GmvReconciliationRun[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 24, 100));
  const result = await db.query<{
    reconciliation_run_id: string;
    year_month: string;
    tape_gmv_amount: string;
    ledger_sale_amount: string;
    delta_amount: string;
    delta_ratio: string | null;
    status: GmvReconciliationStatus;
    started_at: Date;
    completed_at: Date;
  }>(
    `SELECT reconciliation_run_id, year_month, tape_gmv_amount, ledger_sale_amount,
            delta_amount, delta_ratio, status, started_at, completed_at
     FROM platform_operations_gmv_reconciliation_runs
     ORDER BY year_month DESC, completed_at DESC
     LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    reconciliationRunId: row.reconciliation_run_id,
    yearMonth: row.year_month,
    tapeGmvAmount: row.tape_gmv_amount,
    ledgerSaleAmount: row.ledger_sale_amount,
    deltaAmount: row.delta_amount,
    deltaRatio: row.delta_ratio,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: new Date(row.completed_at).toISOString(),
  }));
}
