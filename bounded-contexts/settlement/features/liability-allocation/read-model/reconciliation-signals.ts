import { moneyToCents, sumMoneyAmounts } from "@chase-sets/primitives/money";

/**
 * Platform-covered resolution reconciliation signals (ADR 0022, Wave 3 go-live evidence).
 *
 * Production-facing reconciliation observability for platform-funded and split support
 * resolutions. Following this platform's reconciliation conventions (see
 * platform-operations insights-dashboards `reconciliation-policy.ts`): pure, no-I/O
 * evaluators over a snapshot the read-model queries produce, each returning a documented
 * `ok | alarm` status rather than throwing, plus a daily reconciliation that ties refund
 * totals to seller-funded and platform-funded postings by currency and names the
 * explainable in-flight items.
 *
 * These evaluators do not hold a competing balance — financial truth stays in the wallet
 * ledger and the ProtectionCoverage aggregate. They read the durable reconciliation record
 * (`settlement_refund_liability_allocations`) and the reservation ledger to make every
 * listed inconsistency countable rather than silent, so an operator or alert can act on it.
 */

/** The reconciliation inconsistencies a launch-ready platform-coverage rollout must detect. */
export const platformCoverageReconciliationSignals = [
  {
    id: "coverage-request-results",
    title: "Coverage requests by result and reason",
    detects: "Reservation approve/reject volume, broken out by rejection reason code.",
    severity: "info",
  },
  {
    id: "outstanding-reservations",
    title: "Outstanding and expired reservations",
    detects: "Reservations still holding funds, and reservations that expired without settling.",
    severity: "warning",
  },
  {
    id: "refund-completed-allocation-unsettled",
    title: "Provider refund completed but allocation not settled",
    detects: "A completed refund whose authorized allocation never reconciled (stuck in-flight).",
    severity: "critical",
  },
  {
    id: "seller-debit-inconsistent",
    title: "Seller debit inconsistent with allocation",
    detects: "Posted seller debit disagreeing with the authorized seller-funded portion.",
    severity: "critical",
  },
  {
    id: "protection-consumption-inconsistent",
    title: "Protection consumption inconsistent with refund",
    detects: "Reserve consumed for an amount that disagrees with the platform-funded portion.",
    severity: "critical",
  },
  {
    id: "case-complete-with-pending-effect",
    title: "Support case complete with a pending effect",
    detects: "A remedy reported complete while a required financial or physical effect is unreconciled.",
    severity: "critical",
  },
  {
    id: "reservations-older-than-threshold",
    title: "Reservations older than the policy threshold",
    detects: "Held reserves aging past the policy deadline without settling or releasing.",
    severity: "warning",
  },
  {
    id: "quarantined-and-rejected-counts",
    title: "Quarantined and rejected event counts",
    detects: "Fail-closed quarantines and coverage rejections awaiting operator repair.",
    severity: "warning",
  },
  {
    id: "reconciliation-latency",
    title: "Return-trigger-to-refund and refund-to-reconciliation latency",
    detects: "Time from refund trigger to released refund, and from refund to durable reconciliation.",
    severity: "warning",
  },
] as const;

export type PlatformCoverageReconciliationSignalId = (typeof platformCoverageReconciliationSignals)[number]["id"];

/**
 * Documented alarm thresholds. Kept deliberately explicit so each bound is auditable and
 * unit-tested; tighten as the coverage rollout accumulates production latency history.
 */
export const PLATFORM_COVERAGE_SIGNAL_THRESHOLDS = Object.freeze({
  /** A completed refund whose allocation is still `authorized` past this many hours is stuck in-flight. */
  maxRefundToReconciliationHours: 24,
  /** Return-trigger-to-refund latency budget before the release path is considered stalled. */
  maxReturnTriggerToRefundHours: 72,
  /** A reservation still `reserved` past its policy deadline plus this grace is aging and must surface. */
  reservationAgeGraceHours: 0,
  /** Any quarantined row is actionable; more than this many open is an escalation, not routine. */
  maxOpenQuarantines: 0,
});

export type ReconciliationSignalStatus = "ok" | "alarm";

export type ReconciliationSignalEvaluation = Readonly<{
  id: PlatformCoverageReconciliationSignalId;
  status: ReconciliationSignalStatus;
  /** The measured value that produced the status (a count, an amount, or an age in hours). */
  observed: string;
  detail: string;
}>;

/**
 * The snapshot the read-model queries produce for a reconciliation window. Amounts are
 * canonical decimal strings; counts are non-negative integers; ages are whole hours.
 */
export type PlatformCoverageReconciliationSnapshot = Readonly<{
  coverageRequests: Readonly<{ reserved: number; rejected: number }>;
  outstandingReservations: number;
  expiredReservations: number;
  /** Completed refunds whose allocation row is still `authorized` (not yet reconciled). */
  refundsCompletedAwaitingReconciliation: number;
  /** Oldest such refund's age in hours; 0 when none. */
  oldestUnreconciledRefundAgeHours: number;
  /** Reconciled rows whose posted seller debit disagrees with the authorized seller portion. */
  sellerDebitMismatches: number;
  /** Settled coverages whose consumed amount disagrees with the platform-funded portion. */
  protectionConsumptionMismatches: number;
  /** Remedies marked complete while a required effect is still pending. */
  casesCompleteWithPendingEffect: number;
  /** Reservations still `reserved` past their policy deadline. */
  reservationsPastPolicyDeadline: number;
  quarantinedAllocations: number;
  coverageRejections: number;
  /** Worst observed return-trigger-to-refund latency in hours; 0 when none. */
  maxReturnTriggerToRefundHours: number;
}>;

function evaluation(
  id: PlatformCoverageReconciliationSignalId,
  status: ReconciliationSignalStatus,
  observed: string,
  detail: string,
): ReconciliationSignalEvaluation {
  return { id, status, observed, detail };
}

/**
 * Evaluates every reconciliation signal against the snapshot. Pure and total: it always
 * returns one evaluation per registered signal, so a dashboard can render the full board
 * and an alert can fire on any `alarm`. A signal is `alarm` only when the invariant it
 * guards is actually violated; volume-only signals (`info` severity) never alarm.
 */
export function evaluatePlatformCoverageReconciliationSignals(
  snapshot: PlatformCoverageReconciliationSnapshot,
): readonly ReconciliationSignalEvaluation[] {
  const thresholds = PLATFORM_COVERAGE_SIGNAL_THRESHOLDS;
  return [
    evaluation(
      "coverage-request-results",
      "ok",
      `${snapshot.coverageRequests.reserved} reserved / ${snapshot.coverageRequests.rejected} rejected`,
      "Coverage request volume is informational and never alarms on its own.",
    ),
    evaluation(
      "outstanding-reservations",
      snapshot.expiredReservations > 0 ? "alarm" : "ok",
      `${snapshot.outstandingReservations} outstanding / ${snapshot.expiredReservations} expired`,
      "An expired reservation means a remedy stalled without settling or releasing.",
    ),
    evaluation(
      "refund-completed-allocation-unsettled",
      snapshot.refundsCompletedAwaitingReconciliation > 0 &&
        snapshot.oldestUnreconciledRefundAgeHours > thresholds.maxRefundToReconciliationHours
        ? "alarm"
        : "ok",
      `${snapshot.refundsCompletedAwaitingReconciliation} awaiting, oldest ${snapshot.oldestUnreconciledRefundAgeHours}h`,
      "A completed refund whose allocation never reconciled is money moved without a posting.",
    ),
    evaluation(
      "seller-debit-inconsistent",
      snapshot.sellerDebitMismatches > 0 ? "alarm" : "ok",
      `${snapshot.sellerDebitMismatches} mismatched`,
      "A seller debit must equal the authorized seller-funded portion, never the whole refund.",
    ),
    evaluation(
      "protection-consumption-inconsistent",
      snapshot.protectionConsumptionMismatches > 0 ? "alarm" : "ok",
      `${snapshot.protectionConsumptionMismatches} mismatched`,
      "The reserve consumed must equal the platform-funded portion, exactly once.",
    ),
    evaluation(
      "case-complete-with-pending-effect",
      snapshot.casesCompleteWithPendingEffect > 0 ? "alarm" : "ok",
      `${snapshot.casesCompleteWithPendingEffect} cases`,
      "No case may be represented as complete while a required effect is pending.",
    ),
    evaluation(
      "reservations-older-than-threshold",
      snapshot.reservationsPastPolicyDeadline > 0 ? "alarm" : "ok",
      `${snapshot.reservationsPastPolicyDeadline} past deadline`,
      "A reservation held past its policy deadline must expire or be operator-resolved.",
    ),
    evaluation(
      "quarantined-and-rejected-counts",
      snapshot.quarantinedAllocations > thresholds.maxOpenQuarantines ? "alarm" : "ok",
      `${snapshot.quarantinedAllocations} quarantined / ${snapshot.coverageRejections} rejected`,
      "Every quarantined row is a fail-closed refund awaiting operator repair.",
    ),
    evaluation(
      "reconciliation-latency",
      snapshot.maxReturnTriggerToRefundHours > thresholds.maxReturnTriggerToRefundHours ? "alarm" : "ok",
      `${snapshot.maxReturnTriggerToRefundHours}h worst trigger-to-refund`,
      "A stalled return-trigger-to-refund path leaves a buyer un-refunded past the budget.",
    ),
  ];
}

// -------------------------------------------------------------------------------------------------
// Daily reconciliation by currency.
// -------------------------------------------------------------------------------------------------

/**
 * A reconciliation row as `settlement_refund_liability_allocations` stores it. `reconciled`
 * rows carry posted seller and settled platform amounts; `authorized` rows are in-flight
 * (allocation known, postings pending); `quarantined` rows are fail-closed repairs.
 */
export type RefundReconciliationRow = Readonly<{
  refundId: string;
  currencyCode: string;
  reconciliationStatus: "authorized" | "reconciled" | "quarantined";
  completedRefundAmount: string | null;
  sellerPostedAmount: string | null;
  platformSettledAmount: string | null;
  authorizedRefundAmount: string;
}>;

export type CurrencyReconciliation = Readonly<{
  currencyCode: string;
  /** Sum of completed refunds across reconciled rows. */
  reconciledRefundTotal: string;
  sellerPostedTotal: string;
  platformSettledTotal: string;
  /** Authorized but not-yet-reconciled refunds — the explainable in-flight balance. */
  inFlightTotal: string;
  /** Fail-closed rows awaiting repair. */
  quarantinedTotal: string;
  /** True when reconciledRefundTotal equals sellerPostedTotal + platformSettledTotal to the cent. */
  balanced: boolean;
  /** reconciledRefundTotal − (sellerPostedTotal + platformSettledTotal); "0.00" when balanced. */
  drift: string;
}>;

/**
 * Ties refund totals to seller-funded and platform-funded postings for each currency, and
 * separates the explainable in-flight (authorized) and quarantined balances so a daily
 * report balances by currency instead of pretending everything settled. Pure over the rows.
 */
export function computeDailyReconciliationByCurrency(
  rows: readonly RefundReconciliationRow[],
): readonly CurrencyReconciliation[] {
  const byCurrency = new Map<string, RefundReconciliationRow[]>();
  for (const row of rows) {
    const bucket = byCurrency.get(row.currencyCode) ?? [];
    bucket.push(row);
    byCurrency.set(row.currencyCode, bucket);
  }

  const currencies = [...byCurrency.keys()].sort((left, right) => left.localeCompare(right));
  return currencies.map((currencyCode) => {
    const bucket = byCurrency.get(currencyCode) ?? [];
    const reconciled = bucket.filter((row) => row.reconciliationStatus === "reconciled");
    const reconciledRefundTotal = sumMoneyAmounts(reconciled.map((row) => row.completedRefundAmount ?? "0.00"));
    const sellerPostedTotal = sumMoneyAmounts(reconciled.map((row) => row.sellerPostedAmount ?? "0.00"));
    const platformSettledTotal = sumMoneyAmounts(reconciled.map((row) => row.platformSettledAmount ?? "0.00"));
    const inFlightTotal = sumMoneyAmounts(
      bucket.filter((row) => row.reconciliationStatus === "authorized").map((row) => row.authorizedRefundAmount),
    );
    const quarantinedTotal = sumMoneyAmounts(
      bucket.filter((row) => row.reconciliationStatus === "quarantined").map((row) => row.authorizedRefundAmount),
    );
    const driftCents =
      moneyToCents(reconciledRefundTotal) - (moneyToCents(sellerPostedTotal) + moneyToCents(platformSettledTotal));
    const drift = (Number(driftCents) / 100).toFixed(2);
    return {
      currencyCode,
      reconciledRefundTotal,
      sellerPostedTotal,
      platformSettledTotal,
      inFlightTotal,
      quarantinedTotal,
      balanced: driftCents === 0n,
      drift,
    };
  });
}
