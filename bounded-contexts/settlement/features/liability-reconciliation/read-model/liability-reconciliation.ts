import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { addMoney, compareMoney, subtractMoney } from "../../../support/runtime-support/common";

/**
 * Ledger-vs-provider liability reconciliation.
 *
 * The platform holds sellers' funds on the provider (Stripe) platform balance
 * until they are paid out. The money we owe is the sum of every wallet's
 * balance (available + pending) plus the demand of payouts already debited from
 * wallets but not yet completed at the provider (`requested`/`in-transit`).
 * That total is the platform's obligation; the provider's available balance
 * must be able to cover it.
 *
 * A slow leak (a double transfer, a missed reversal) drains the provider
 * balance below the obligation without any single event looking wrong — it is
 * invisible until cash-out. This job compares the two figures on a schedule and
 * alarms when the provider balance falls short of the obligation by more than a
 * tolerance band. A *surplus* (provider balance above the obligation) is not
 * alarmed: platform float above liabilities is expected and not a shortfall
 * risk. The tolerance band absorbs benign settlement-timing skew (a transfer
 * that has left the provider balance while its payout still counts as in-flight
 * demand, or vice versa).
 *
 * This is a detective control only: it never moves money and never mutates the
 * ledger. The aggregate remains the enforcement point; this surfaces drift for
 * an operator to investigate.
 */

export const SETTLEMENT_LIABILITY_RECONCILIATION_STATUSES = ["ok", "shortfall-alarm"] as const;
export type SettlementLiabilityReconciliationStatus = (typeof SETTLEMENT_LIABILITY_RECONCILIATION_STATUSES)[number];

/**
 * Default tolerance band, in currency units, for benign settlement-timing skew.
 * Conservative by design: a genuine leak accumulates well past this, while
 * sub-band drift is noise. Operators tune it via the runtime/worker config.
 */
export const DEFAULT_LIABILITY_RECONCILIATION_TOLERANCE_AMOUNT = "1.00";

export type LiabilityReconciliationSnapshot = Readonly<{
  currencyCode: string;
  /** Σ (available + pending) across all wallets in this currency — funds owed to sellers. */
  walletLiabilityAmount: string;
  /** Σ amount of payouts debited from wallets but not yet completed at the provider. */
  inFlightPayoutDemandAmount: string;
  /** The provider platform available balance for this currency. */
  providerAvailableAmount: string;
}>;

export type LiabilityReconciliationResult = Readonly<{
  currencyCode: string;
  walletLiabilityAmount: string;
  inFlightPayoutDemandAmount: string;
  providerAvailableAmount: string;
  /** walletLiability + inFlightDemand — the total the provider balance must cover. */
  expectedObligationAmount: string;
  /** providerAvailable − expectedObligation (signed; negative means a shortfall). */
  driftAmount: string;
  toleranceAmount: string;
  status: SettlementLiabilityReconciliationStatus;
}>;

/**
 * Pure evaluation of one reconciliation snapshot. No I/O — safe to unit test and
 * to call repeatedly. A shortfall is flagged only when the obligation exceeds
 * the provider balance by strictly more than the tolerance band.
 */
export function evaluateLiabilityReconciliation(
  snapshot: LiabilityReconciliationSnapshot,
  toleranceAmount: string = DEFAULT_LIABILITY_RECONCILIATION_TOLERANCE_AMOUNT,
): LiabilityReconciliationResult {
  const expectedObligationAmount = addMoney(snapshot.walletLiabilityAmount, snapshot.inFlightPayoutDemandAmount);
  const driftAmount = subtractMoney(snapshot.providerAvailableAmount, expectedObligationAmount);
  // Shortfall when obligation > providerAvailable + tolerance.
  const providerCoverageWithTolerance = addMoney(snapshot.providerAvailableAmount, toleranceAmount);
  const status: SettlementLiabilityReconciliationStatus =
    compareMoney(expectedObligationAmount, providerCoverageWithTolerance) > 0 ? "shortfall-alarm" : "ok";

  return {
    currencyCode: snapshot.currencyCode,
    walletLiabilityAmount: snapshot.walletLiabilityAmount,
    inFlightPayoutDemandAmount: snapshot.inFlightPayoutDemandAmount,
    providerAvailableAmount: snapshot.providerAvailableAmount,
    expectedObligationAmount,
    driftAmount,
    toleranceAmount,
    status,
  };
}

export const settlementLiabilityReconciliationSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_liability_reconciliation_runs (
  reconciliation_run_id text PRIMARY KEY,
  currency_code text NOT NULL,
  wallet_liability_amount numeric(18, 2) NOT NULL,
  in_flight_payout_demand_amount numeric(18, 2) NOT NULL,
  provider_available_amount numeric(18, 2) NOT NULL,
  expected_obligation_amount numeric(18, 2) NOT NULL,
  drift_amount numeric(18, 2) NOT NULL,
  tolerance_amount numeric(18, 2) NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_liability_reconciliation_runs_completed_idx
  ON settlement_liability_reconciliation_runs (completed_at DESC);

CREATE INDEX IF NOT EXISTS settlement_liability_reconciliation_runs_status_idx
  ON settlement_liability_reconciliation_runs (status, completed_at DESC);
`;

/**
 * Gather the current liability snapshot from the durable read model. Pure
 * SELECTs (no locks, no mutation), safe to run alongside concurrent posting.
 */
export async function queryLiabilitySnapshot(
  db: PgQueryable,
  currencyCode: string,
): Promise<Readonly<{ walletLiabilityAmount: string; inFlightPayoutDemandAmount: string }>> {
  const result = await db.query<{
    wallet_liability_amount: string;
    in_flight_payout_demand_amount: string;
  }>(
    `SELECT
       COALESCE((
         SELECT SUM(available_balance_amount + pending_balance_amount)
         FROM settlement_wallet_pages
         WHERE currency_code = $1
       ), 0)::numeric(18, 2)::text AS wallet_liability_amount,
       COALESCE((
         SELECT SUM(amount)
         FROM settlement_payout_pages
         WHERE currency_code = $1
           AND status IN ('requested', 'in-transit')
       ), 0)::numeric(18, 2)::text AS in_flight_payout_demand_amount`,
    [currencyCode],
  );
  const row = result.rows[0];
  return {
    walletLiabilityAmount: row?.wallet_liability_amount ?? "0.00",
    inFlightPayoutDemandAmount: row?.in_flight_payout_demand_amount ?? "0.00",
  };
}

export async function recordLiabilityReconciliationRun(
  db: PgQueryable,
  entry: Readonly<{
    reconciliationRunId: string;
    result: LiabilityReconciliationResult;
    startedAt: string;
    completedAt: string;
  }>,
): Promise<void> {
  const { result } = entry;
  await db.query(
    `INSERT INTO settlement_liability_reconciliation_runs (
       reconciliation_run_id,
       currency_code,
       wallet_liability_amount,
       in_flight_payout_demand_amount,
       provider_available_amount,
       expected_obligation_amount,
       drift_amount,
       tolerance_amount,
       status,
       started_at,
       completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (reconciliation_run_id) DO NOTHING`,
    [
      entry.reconciliationRunId,
      result.currencyCode,
      result.walletLiabilityAmount,
      result.inFlightPayoutDemandAmount,
      result.providerAvailableAmount,
      result.expectedObligationAmount,
      result.driftAmount,
      result.toleranceAmount,
      result.status,
      entry.startedAt,
      entry.completedAt,
    ],
  );
}

export type SettlementLiabilityReconciliationRunRow = Readonly<{
  reconciliation_run_id: string;
  currency_code: string;
  wallet_liability_amount: string;
  in_flight_payout_demand_amount: string;
  provider_available_amount: string;
  expected_obligation_amount: string;
  drift_amount: string;
  tolerance_amount: string;
  status: SettlementLiabilityReconciliationStatus;
  started_at: string;
  completed_at: string;
}>;

export async function listLiabilityReconciliationRuns(
  db: PgQueryable,
  params: Readonly<{ limit?: number }> = {},
): Promise<readonly SettlementLiabilityReconciliationRunRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 25, 200));
  const result = await db.query<SettlementLiabilityReconciliationRunRow>(
    `SELECT
       reconciliation_run_id,
       currency_code,
       wallet_liability_amount::text AS wallet_liability_amount,
       in_flight_payout_demand_amount::text AS in_flight_payout_demand_amount,
       provider_available_amount::text AS provider_available_amount,
       expected_obligation_amount::text AS expected_obligation_amount,
       drift_amount::text AS drift_amount,
       tolerance_amount::text AS tolerance_amount,
       status,
       started_at,
       completed_at
     FROM settlement_liability_reconciliation_runs
     ORDER BY completed_at DESC, reconciliation_run_id DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}
