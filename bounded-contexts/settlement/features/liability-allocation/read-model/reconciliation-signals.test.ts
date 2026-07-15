import { describe, expect, it } from "vitest";
import {
  PLATFORM_COVERAGE_SIGNAL_THRESHOLDS,
  computeDailyReconciliationByCurrency,
  evaluatePlatformCoverageReconciliationSignals,
  platformCoverageReconciliationSignals,
  type PlatformCoverageReconciliationSignalId,
  type PlatformCoverageReconciliationSnapshot,
  type RefundReconciliationRow,
} from "./reconciliation-signals";

function healthySnapshot(
  overrides: Partial<PlatformCoverageReconciliationSnapshot> = {},
): PlatformCoverageReconciliationSnapshot {
  return {
    coverageRequests: { reserved: 12, rejected: 1 },
    outstandingReservations: 3,
    expiredReservations: 0,
    refundsCompletedAwaitingReconciliation: 1,
    oldestUnreconciledRefundAgeHours: 2,
    sellerDebitMismatches: 0,
    protectionConsumptionMismatches: 0,
    casesCompleteWithPendingEffect: 0,
    reservationsPastPolicyDeadline: 0,
    quarantinedAllocations: 0,
    coverageRejections: 1,
    maxReturnTriggerToRefundHours: 6,
    ...overrides,
  };
}

function statusFor(
  evaluations: readonly { id: PlatformCoverageReconciliationSignalId; status: string }[],
  id: PlatformCoverageReconciliationSignalId,
): string {
  return evaluations.find((evaluation) => evaluation.id === id)!.status;
}

describe("platform-coverage reconciliation signals", () => {
  it("pins the signal registry so every listed inconsistency stays covered", () => {
    expect(platformCoverageReconciliationSignals.map((signal) => signal.id)).toEqual([
      "coverage-request-results",
      "outstanding-reservations",
      "refund-completed-allocation-unsettled",
      "seller-debit-inconsistent",
      "protection-consumption-inconsistent",
      "case-complete-with-pending-effect",
      "reservations-older-than-threshold",
      "quarantined-and-rejected-counts",
      "reconciliation-latency",
    ]);
  });

  it("evaluates one status per registered signal and stays green on a healthy window", () => {
    const evaluations = evaluatePlatformCoverageReconciliationSignals(healthySnapshot());
    expect(evaluations.map((evaluation) => evaluation.id)).toEqual(
      platformCoverageReconciliationSignals.map((signal) => signal.id),
    );
    expect(evaluations.every((evaluation) => evaluation.status === "ok")).toBe(true);
  });

  it("alarms a completed refund whose allocation is unreconciled past the budget", () => {
    const withinBudget = evaluatePlatformCoverageReconciliationSignals(
      healthySnapshot({
        refundsCompletedAwaitingReconciliation: 1,
        oldestUnreconciledRefundAgeHours: PLATFORM_COVERAGE_SIGNAL_THRESHOLDS.maxRefundToReconciliationHours,
      }),
    );
    expect(statusFor(withinBudget, "refund-completed-allocation-unsettled")).toBe("ok");

    const overBudget = evaluatePlatformCoverageReconciliationSignals(
      healthySnapshot({
        refundsCompletedAwaitingReconciliation: 1,
        oldestUnreconciledRefundAgeHours: PLATFORM_COVERAGE_SIGNAL_THRESHOLDS.maxRefundToReconciliationHours + 1,
      }),
    );
    expect(statusFor(overBudget, "refund-completed-allocation-unsettled")).toBe("alarm");
  });

  it("alarms every fail-closed inconsistency", () => {
    const evaluations = evaluatePlatformCoverageReconciliationSignals(
      healthySnapshot({
        expiredReservations: 1,
        sellerDebitMismatches: 1,
        protectionConsumptionMismatches: 1,
        casesCompleteWithPendingEffect: 1,
        reservationsPastPolicyDeadline: 1,
        quarantinedAllocations: 1,
        maxReturnTriggerToRefundHours: PLATFORM_COVERAGE_SIGNAL_THRESHOLDS.maxReturnTriggerToRefundHours + 1,
      }),
    );
    expect(statusFor(evaluations, "outstanding-reservations")).toBe("alarm");
    expect(statusFor(evaluations, "seller-debit-inconsistent")).toBe("alarm");
    expect(statusFor(evaluations, "protection-consumption-inconsistent")).toBe("alarm");
    expect(statusFor(evaluations, "case-complete-with-pending-effect")).toBe("alarm");
    expect(statusFor(evaluations, "reservations-older-than-threshold")).toBe("alarm");
    expect(statusFor(evaluations, "quarantined-and-rejected-counts")).toBe("alarm");
    expect(statusFor(evaluations, "reconciliation-latency")).toBe("alarm");
  });

  it("never alarms the informational coverage-request-results signal", () => {
    const evaluations = evaluatePlatformCoverageReconciliationSignals(
      healthySnapshot({ coverageRequests: { reserved: 0, rejected: 999 } }),
    );
    expect(statusFor(evaluations, "coverage-request-results")).toBe("ok");
  });
});

describe("daily reconciliation by currency", () => {
  function reconciledRow(overrides: Partial<RefundReconciliationRow> = {}): RefundReconciliationRow {
    return {
      refundId: "rfd_1",
      currencyCode: "usd",
      reconciliationStatus: "reconciled",
      completedRefundAmount: "40.00",
      sellerPostedAmount: "0.00",
      platformSettledAmount: "40.00",
      authorizedRefundAmount: "40.00",
      ...overrides,
    };
  }

  it("balances reconciled refunds against seller and platform postings per currency", () => {
    const rows: readonly RefundReconciliationRow[] = [
      reconciledRow({ refundId: "rfd_1", sellerPostedAmount: "0.00", platformSettledAmount: "40.00" }),
      reconciledRow({
        refundId: "rfd_2",
        completedRefundAmount: "30.00",
        sellerPostedAmount: "10.00",
        platformSettledAmount: "20.00",
      }),
    ];
    const [usd] = computeDailyReconciliationByCurrency(rows);
    expect(usd).toMatchObject({
      currencyCode: "usd",
      reconciledRefundTotal: "70.00",
      sellerPostedTotal: "10.00",
      platformSettledTotal: "60.00",
      balanced: true,
      drift: "0.00",
    });
  });

  it("separates the explainable in-flight and quarantined balances from settled totals", () => {
    const rows: readonly RefundReconciliationRow[] = [
      reconciledRow({ refundId: "rfd_1" }),
      reconciledRow({
        refundId: "rfd_2",
        reconciliationStatus: "authorized",
        completedRefundAmount: null,
        sellerPostedAmount: null,
        platformSettledAmount: null,
        authorizedRefundAmount: "25.00",
      }),
      reconciledRow({
        refundId: "rfd_3",
        reconciliationStatus: "quarantined",
        completedRefundAmount: null,
        sellerPostedAmount: null,
        platformSettledAmount: null,
        authorizedRefundAmount: "15.00",
      }),
    ];
    const [usd] = computeDailyReconciliationByCurrency(rows);
    expect(usd).toMatchObject({
      reconciledRefundTotal: "40.00",
      inFlightTotal: "25.00",
      quarantinedTotal: "15.00",
      balanced: true,
    });
  });

  it("surfaces drift when postings do not sum to the reconciled refund", () => {
    const rows: readonly RefundReconciliationRow[] = [
      reconciledRow({ completedRefundAmount: "40.00", sellerPostedAmount: "5.00", platformSettledAmount: "30.00" }),
    ];
    const [usd] = computeDailyReconciliationByCurrency(rows);
    expect(usd).toMatchObject({ balanced: false, drift: "5.00" });
  });

  it("reports each currency independently, sorted", () => {
    const rows: readonly RefundReconciliationRow[] = [
      reconciledRow({ refundId: "rfd_usd", currencyCode: "usd" }),
      reconciledRow({ refundId: "rfd_eur", currencyCode: "eur", platformSettledAmount: "40.00" }),
    ];
    const result = computeDailyReconciliationByCurrency(rows);
    expect(result.map((entry) => entry.currencyCode)).toEqual(["eur", "usd"]);
  });
});
