/**
 * GMV reconciliation drift-alarm policy, following this platform's general
 * ledger-reconciliation conventions (run records, counters, a status field
 * rather than a hard failure).
 *
 * Settlement's ledger 'sale' credits are posted NET of the marketplace sales
 * fee (see settlement's `getLedgerSaleCreditTotalForMonth` doc comment), so
 * the ledger total for a month is expected to sit BELOW pricing's gross
 * Platform Daily Rollup GMV for the same month -- by roughly the platform's
 * take rate, plus a little settlement-timing lag near the month boundary.
 * Exact equality is never the expected outcome, and this check does not
 * attempt to reconcile to a precise take rate (marketplace sales fee data is
 * not yet available as a per-order or monthly-aggregate figure anywhere in
 * the codebase -- see the PR description's "take-rate realized" deviation).
 * This is a coarse SANITY/DRIFT signal, not a penny-accurate fee
 * reconciliation: it catches gross data-integrity problems (a broken join, a
 * stalled rollup job, a double-counted month) without pretending to know the
 * exact expected fee percentage.
 *
 * The band below is deliberately wide for that reason. Tighten it once the
 * platform policy-consolidation work exposes a real platform take-rate value
 * this check can reconcile against precisely.
 */
export const GMV_RECONCILIATION_DRIFT_BAND = Object.freeze({
  /**
   * Ledger total should never exceed gross tape GMV (it is a net-of-fee
   * subset of it) -- any positive overage means the two sides are counting
   * different populations, not just a fee gap.
   */
  maxLedgerOverGmvRatio: 0,
  /**
   * Ledger total should not fall short of gross tape GMV by more than this
   * fraction. Typical marketplace take rates are far under this; a gap this
   * large signals an undercounting or timing problem worth an operator
   * looking at, not a plausible fee rate.
   */
  maxUndershootRatio: 0.4,
});

export type GmvReconciliationStatus = "ok" | "drift-alarm";

export type GmvReconciliationComputation = Readonly<{
  tapeGmvAmount: string;
  ledgerSaleAmount: string;
  deltaAmount: string;
  /** (tapeGmv - ledgerSale) / tapeGmv. Null when tapeGmv is zero (nothing to divide by; treated as `ok` when the ledger is also zero). */
  deltaRatio: string | null;
  status: GmvReconciliationStatus;
}>;

/** Pure drift computation -- no I/O, easy to unit-test against the documented band above. */
export function computeGmvReconciliation(
  params: Readonly<{ tapeGmvAmount: string; ledgerSaleAmount: string }>,
): GmvReconciliationComputation {
  const tapeGmv = Number(params.tapeGmvAmount);
  const ledgerSale = Number(params.ledgerSaleAmount);
  const deltaAmount = tapeGmv - ledgerSale;

  if (tapeGmv === 0) {
    return {
      tapeGmvAmount: params.tapeGmvAmount,
      ledgerSaleAmount: params.ledgerSaleAmount,
      deltaAmount: deltaAmount.toFixed(2),
      deltaRatio: null,
      status: ledgerSale === 0 ? "ok" : "drift-alarm",
    };
  }

  const deltaRatio = deltaAmount / tapeGmv;
  const status: GmvReconciliationStatus =
    deltaRatio < -GMV_RECONCILIATION_DRIFT_BAND.maxLedgerOverGmvRatio ||
    deltaRatio > GMV_RECONCILIATION_DRIFT_BAND.maxUndershootRatio
      ? "drift-alarm"
      : "ok";

  return {
    tapeGmvAmount: params.tapeGmvAmount,
    ledgerSaleAmount: params.ledgerSaleAmount,
    deltaAmount: deltaAmount.toFixed(2),
    deltaRatio: deltaRatio.toFixed(4),
    status,
  };
}
