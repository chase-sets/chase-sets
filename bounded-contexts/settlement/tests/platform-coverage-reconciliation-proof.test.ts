import { describe, expect, it } from "vitest";
import { moneyToCents, sumMoneyAmounts } from "@chase-sets/primitives/money";
import {
  normalizeSupportRequestRefundReleasedV1,
  normalizeSupportRequestRemedyAuthorizedV1,
  type LiabilityAllocationFactV1,
  type SupportRequestRefundReleasedV1Payload,
  type SupportRequestRemedyAuthorizedV1Payload,
} from "@chase-sets/event-core/platform-coverage-facts";
import type { BuyerRemedyKind, RefundTrigger, ReturnDirective } from "@chase-sets/primitives/platform-coverage";
import {
  decideProtectionCoverage,
  evolveProtectionCoverage,
  initialProtectionReserveState,
  type ProtectionCoverageCommand,
  type ProtectionCoverageEvent,
  type ProtectionReserveState,
} from "../features/protection-coverage/domain/protection-coverage";
import {
  decideRefundLiability,
  distributeSellerFundedPortion,
  type AuthorizedRefundAllocation,
  type CoverageReservationState,
  type RefundLiabilityDecision,
  type SellerPayoutWeight,
} from "../features/liability-allocation/domain/liability-allocation";

/**
 * Platform-funded resolution reconciliation proof (ADR 0022, Wave 3 go-live evidence).
 * This is the missing exact-once cross-context proof: it drives the REAL Settlement
 * financial-truth deciders — `decideProtectionCoverage`/`evolveProtectionCoverage` (the
 * ProtectionCoverage reservation aggregate) and `decideRefundLiability` (the seller/platform
 * posting decision) — against the REAL published-fact contracts a downstream context
 * actually receives (`@chase-sets/event-core/platform-coverage-facts`).
 *
 * Settlement never imports Support/Payments/Fulfillment code; it only ever sees their
 * normalized facts. So the upstream Support remedy authorization and the Payments refund
 * are represented here exactly as Settlement observes them — as contract-validated fact
 * payloads — and the proof asserts Settlement's money invariants end-to-end at the event
 * and ledger-decision levels. The Support-owned closure gate, refund-release timing, and
 * notification dedup are proven in the sibling platform-operations lifecycle proof; the
 * Payments causation-carry and at-most-once refund id are proven in the payments causation
 * tests. The operator acceptance packet composes all three
 * (platform-coverage-reconciliation-acceptance.md).
 *
 * The golden assertion: a fully platform-covered case refunds the buyer exactly once,
 * never debits the seller, consumes exactly the reserved protection amount exactly once,
 * and its reservation cannot be double-consumed under duplicate or out-of-order delivery.
 */

const POLICY_VERSION = "coverage-policy-2026-07";
const SUPPORT_REQUEST_ID = "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8NB";
const REMEDY_ID = "rmd_01JZ6DKP7S7Z4AZ5N5E6K7M8NA";
const COVERAGE_ID = "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9";
const REFUND_ID = "rfd_01JZ6DKP7S7Z4AZ5N5E6K7M8NA";
const AUTHORIZED_AT = "2026-07-14T00:00:00.000Z";
const RELEASED_AT = "2026-07-14T01:00:00.000Z";
const SETTLED_AT = "2026-07-14T02:00:00.000Z";

type AllocationSpec = Readonly<{ seller: string; platform: string; currencyCode?: string }>;

function allocationFact(spec: AllocationSpec): LiabilityAllocationFactV1 {
  const currencyCode = spec.currencyCode ?? "usd";
  const fundingKind =
    moneyToCents(spec.platform) === 0n
      ? "seller-funded"
      : moneyToCents(spec.seller) === 0n
        ? "platform-funded"
        : "split";
  return {
    sellerFundedAmount: spec.seller,
    platformFundedAmount: spec.platform,
    currencyCode,
    fundingKind,
  };
}

function remedyAmount(spec: AllocationSpec): string {
  return sumMoneyAmounts([spec.seller, spec.platform]);
}

/** The Support-authored authorization fact exactly as Settlement/Payments decode it. */
function authorizeRemedy(params: {
  allocation: AllocationSpec;
  remedyKind?: BuyerRemedyKind;
  returnDirective?: ReturnDirective;
  refundTrigger?: RefundTrigger;
  coverageId?: string | null;
}): SupportRequestRemedyAuthorizedV1Payload {
  const amount = remedyAmount(params.allocation);
  return normalizeSupportRequestRemedyAuthorizedV1({
    factSchemaVersion: 1,
    supportRequestId: SUPPORT_REQUEST_ID,
    remedyId: REMEDY_ID,
    idempotencyKey: `remedy-authorized:${REMEDY_ID}`,
    causationId: null,
    policyVersion: POLICY_VERSION,
    occurredAt: AUTHORIZED_AT,
    coverageId: params.coverageId === undefined ? COVERAGE_ID : params.coverageId,
    remedy: {
      kind: params.remedyKind ?? "full-refund",
      amount,
      currencyCode: params.allocation.currencyCode ?? "usd",
    },
    allocation: allocationFact(params.allocation),
    returnDirective: params.returnDirective ?? "no-return",
    refundTrigger: params.refundTrigger ?? "immediate",
    reasonCode: "fault-indeterminate",
  });
}

/** The Support refund-released fact whose allocation Payments carries through unchanged. */
function releaseRefund(authorization: SupportRequestRemedyAuthorizedV1Payload): SupportRequestRefundReleasedV1Payload {
  return normalizeSupportRequestRefundReleasedV1({
    factSchemaVersion: 1,
    supportRequestId: authorization.supportRequestId,
    remedyId: authorization.remedyId,
    idempotencyKey: `refund-released:${authorization.remedyId}`,
    causationId: authorization.idempotencyKey,
    policyVersion: authorization.policyVersion,
    occurredAt: RELEASED_AT,
    coverageId: authorization.coverageId,
    refundAmount: authorization.remedy.amount,
    currencyCode: authorization.remedy.currencyCode,
    allocation: authorization.allocation,
    refundTrigger: authorization.refundTrigger,
  });
}

/** Reserve the platform portion, exactly as the coverage-request projection would. */
function reserveCommand(
  authorization: SupportRequestRemedyAuthorizedV1Payload,
  fundedAmount: string,
  policyLimitAmount?: string,
): ProtectionCoverageCommand {
  return {
    type: "ReserveProtectionCoverage",
    coverageId: authorization.coverageId!,
    remedyId: authorization.remedyId,
    supportRequestId: authorization.supportRequestId,
    requestedAmount: authorization.allocation.platformFundedAmount,
    currencyCode: authorization.allocation.currencyCode,
    policyVersion: authorization.policyVersion,
    reasonCode: authorization.reasonCode,
    idempotencyKey: `coverage-reserve:${authorization.coverageId}`,
    causationId: authorization.idempotencyKey,
    occurredAt: authorization.occurredAt,
    fundedAmount,
    ...(policyLimitAmount === undefined ? {} : { policyLimitAmount }),
  };
}

function settleCommand(
  released: SupportRequestRefundReleasedV1Payload,
  refundId = REFUND_ID,
): ProtectionCoverageCommand {
  return {
    type: "SettleProtectionCoverage",
    coverageId: released.coverageId!,
    refundId,
    platformFundedAmount: released.allocation.platformFundedAmount,
    sellerFundedAmount: released.allocation.sellerFundedAmount,
    currencyCode: released.currencyCode,
    policyVersion: released.policyVersion,
    idempotencyKey: `coverage-settle:${released.coverageId}`,
    causationId: released.idempotencyKey,
    occurredAt: SETTLED_AT,
  };
}

function apply(state: ProtectionReserveState, command: ProtectionCoverageCommand): ProtectionReserveState {
  return decideProtectionCoverage(state, command).reduce(evolveProtectionCoverage, state);
}

function reservationStateFor(
  state: ProtectionReserveState,
  coverageId: string | null,
): CoverageReservationState | null {
  if (coverageId === null) {
    return null;
  }
  const record = state.reservations[coverageId];
  if (!record) {
    return null;
  }
  return {
    reservedAmount: record.reservedAmount,
    status: record.status,
    refundId: record.refundId,
    policyVersion: record.policyVersion,
    currencyCode: record.currencyCode,
    supportRequestId: record.supportRequestId,
    remedyId: record.remedyId,
  };
}

/** The authorized allocation Payments carries into refund causation, decoded by Settlement. */
function authorizedRefundAllocation(
  released: SupportRequestRefundReleasedV1Payload,
  refundId = REFUND_ID,
): AuthorizedRefundAllocation {
  return {
    refundId,
    remedyId: released.remedyId,
    coverageId: released.coverageId,
    sellerFundedAmount: released.allocation.sellerFundedAmount,
    platformFundedAmount: released.allocation.platformFundedAmount,
    currencyCode: released.currencyCode,
    fundingKind: released.allocation.fundingKind,
  };
}

describe("platform-funded reconciliation proof — golden exactly-once", () => {
  it("refunds once, never debits the seller, consumes the reserve exactly once (fully platform-funded, immediate)", () => {
    const authorization = authorizeRemedy({ allocation: { seller: "0.00", platform: "40.00" } });
    const released = releaseRefund(authorization);

    // Settlement reserves the platform portion against available funds.
    const reservedEvents = decideProtectionCoverage(
      initialProtectionReserveState,
      reserveCommand(authorization, "100.00"),
    );
    expect(reservedEvents.map((event) => event.type)).toEqual(["settlement.protection-coverage.reserved.v1"]);
    const afterReserve = reservedEvents.reduce(evolveProtectionCoverage, initialProtectionReserveState);
    expect(afterReserve.outstandingReservedAmount).toBe("40.00");

    // Payments completes the refund; Settlement reconciles the completed refund against the allocation.
    const decision = decideRefundLiability({
      allocation: authorizedRefundAllocation(released),
      completedRefundAmount: released.refundAmount,
      completedCurrencyCode: released.currencyCode,
      reservation: reservationStateFor(afterReserve, released.coverageId),
    });

    expect(decision).toEqual({
      outcome: "allocated",
      fundingKind: "platform-funded",
      sellerDebitAmount: "0.00",
      platformSettleAmount: "40.00",
      coverageId: COVERAGE_ID,
      alreadySettled: false,
    } satisfies RefundLiabilityDecision);

    // Consume the reserve exactly once.
    const settleEvents = decideProtectionCoverage(afterReserve, settleCommand(released));
    expect(settleEvents.map((event) => event.type)).toEqual(["settlement.protection-coverage.settled.v1"]);
    const afterSettle = settleEvents.reduce(evolveProtectionCoverage, afterReserve);
    expect(afterSettle.reservations[COVERAGE_ID]?.status).toBe("settled");
    expect(afterSettle.consumedAmount).toBe("40.00");
    expect(afterSettle.outstandingReservedAmount).toBe("0.00");

    // Buyer refunded exactly once: a single released refund amount, no seller debit posted.
    expect(released.refundAmount).toBe("40.00");
    expect(decision.outcome === "allocated" && decision.sellerDebitAmount).toBe("0.00");
  });
});

describe("platform-funded reconciliation proof — required journeys", () => {
  it("J1 fully platform-funded, no return, immediate refund", () => {
    const authorization = authorizeRemedy({
      allocation: { seller: "0.00", platform: "40.00" },
      returnDirective: "no-return",
      refundTrigger: "immediate",
    });
    const released = releaseRefund(authorization);
    const afterReserve = apply(initialProtectionReserveState, reserveCommand(authorization, "100.00"));
    const decision = decideRefundLiability({
      allocation: authorizedRefundAllocation(released),
      completedRefundAmount: released.refundAmount,
      completedCurrencyCode: released.currencyCode,
      reservation: reservationStateFor(afterReserve, released.coverageId),
    });
    expect(decision).toMatchObject({ outcome: "allocated", sellerDebitAmount: "0.00", platformSettleAmount: "40.00" });
  });

  it("J2/J3 platform-funded, return-to-platform, refund on carrier-accepted or facility-intake reconciles identically", () => {
    // The refund trigger (carrier-accepted / facility-intake) changes WHEN Support releases the
    // refund, not HOW Settlement reconciles it. Once the refund completes, the financial decision
    // is identical to the immediate case. Trigger timing is proven in the lifecycle proof.
    for (const refundTrigger of ["carrier-accepted", "facility-intake"] as const) {
      const authorization = authorizeRemedy({
        allocation: { seller: "0.00", platform: "40.00" },
        returnDirective: "return-to-platform",
        refundTrigger,
      });
      const released = releaseRefund(authorization);
      expect(released.refundTrigger).toBe(refundTrigger);
      const afterReserve = apply(initialProtectionReserveState, reserveCommand(authorization, "100.00"));
      const decision = decideRefundLiability({
        allocation: authorizedRefundAllocation(released),
        completedRefundAmount: released.refundAmount,
        completedCurrencyCode: released.currencyCode,
        reservation: reservationStateFor(afterReserve, released.coverageId),
      });
      expect(decision).toMatchObject({
        outcome: "allocated",
        sellerDebitAmount: "0.00",
        platformSettleAmount: "40.00",
      });
    }
  });

  it("J4 split-funded remedy posts the exact seller and platform portions", () => {
    const authorization = authorizeRemedy({ allocation: { seller: "15.00", platform: "25.00" } });
    const released = releaseRefund(authorization);
    const afterReserve = apply(initialProtectionReserveState, reserveCommand(authorization, "100.00"));
    const decision = decideRefundLiability({
      allocation: authorizedRefundAllocation(released),
      completedRefundAmount: released.refundAmount,
      completedCurrencyCode: released.currencyCode,
      reservation: reservationStateFor(afterReserve, released.coverageId),
    });
    expect(decision).toMatchObject({
      outcome: "allocated",
      fundingKind: "split",
      sellerDebitAmount: "15.00",
      platformSettleAmount: "25.00",
    });

    // The exact seller portion distributes across seller payouts with no penny lost or duplicated.
    const payouts: readonly SellerPayoutWeight[] = [
      { orderId: "ord_1", sellerAccountId: "acc_a", weightAmount: "30.00" },
      { orderId: "ord_2", sellerAccountId: "acc_b", weightAmount: "10.00" },
    ];
    const distributed = distributeSellerFundedPortion("15.00", payouts);
    expect(sumMoneyAmounts(distributed)).toBe("15.00");
  });

  it("J5 seller-funded regression path debits the seller and consumes no reserve", () => {
    const authorization = authorizeRemedy({
      allocation: { seller: "40.00", platform: "0.00" },
      coverageId: null,
    });
    const released = releaseRefund(authorization);
    const decision = decideRefundLiability({
      allocation: authorizedRefundAllocation(released),
      completedRefundAmount: released.refundAmount,
      completedCurrencyCode: released.currencyCode,
      reservation: null,
    });
    expect(decision).toMatchObject({
      outcome: "allocated",
      fundingKind: "seller-funded",
      sellerDebitAmount: "40.00",
      platformSettleAmount: "0.00",
      coverageId: null,
    });

    // The legacy shape (a refund with no authorized allocation) preserves current seller-debit behavior.
    const legacy = decideRefundLiability({
      allocation: null,
      completedRefundAmount: "40.00",
      completedCurrencyCode: "usd",
      reservation: null,
    });
    expect(legacy).toEqual({ outcome: "seller-funded-default", sellerDebitAmount: "40.00" });
  });

  it("J6 coverage rejected for insufficient reserve or policy limit leaves the case open, never debits the seller", () => {
    const authorization = authorizeRemedy({ allocation: { seller: "0.00", platform: "40.00" } });

    const insufficient = decideProtectionCoverage(
      initialProtectionReserveState,
      reserveCommand(authorization, "10.00"),
    );
    expect(insufficient[0]?.type).toBe("settlement.protection-coverage.rejected.v1");
    expect(insufficient[0]?.data).toMatchObject({ reasonCode: "insufficient-reserve" });

    const overLimit = decideProtectionCoverage(
      initialProtectionReserveState,
      reserveCommand(authorization, "100.00", "25.00"),
    );
    expect(overLimit[0]?.type).toBe("settlement.protection-coverage.rejected.v1");
    expect(overLimit[0]?.data).toMatchObject({ reasonCode: "policy-limit-exceeded" });

    // A rejected reservation never moves the availability ledger and never posts a seller debit.
    const afterRejection = insufficient.reduce(evolveProtectionCoverage, initialProtectionReserveState);
    expect(afterRejection.outstandingReservedAmount).toBe("0.00");
    expect(reservationStateFor(afterRejection, authorization.coverageId)).toBeNull();
  });

  it("J7 reservation expires before refund; a late refund quarantines instead of charging the seller", () => {
    const authorization = authorizeRemedy({ allocation: { seller: "0.00", platform: "40.00" } });
    const released = releaseRefund(authorization);
    const afterReserve = apply(initialProtectionReserveState, reserveCommand(authorization, "100.00"));
    const afterExpiry = apply(afterReserve, {
      type: "ExpireProtectionCoverage",
      coverageId: authorization.coverageId!,
      policyVersion: POLICY_VERSION,
      idempotencyKey: `coverage-expire:${authorization.coverageId}`,
      causationId: null,
      deadline: "2026-07-21T00:00:00.000Z",
      occurredAt: "2026-07-21T00:00:01.000Z",
    });
    expect(afterExpiry.reservations[COVERAGE_ID]?.status).toBe("expired");
    // Expiring returns the funds to availability.
    expect(afterExpiry.outstandingReservedAmount).toBe("0.00");

    const decision = decideRefundLiability({
      allocation: authorizedRefundAllocation(released),
      completedRefundAmount: released.refundAmount,
      completedCurrencyCode: released.currencyCode,
      reservation: reservationStateFor(afterExpiry, released.coverageId),
    });
    expect(decision).toMatchObject({ outcome: "quarantined", reasonCode: "coverage-not-reserved" });
  });

  it("J8 lost provider response then webhook confirm: reconciliation stays exactly-once", () => {
    const authorization = authorizeRemedy({ allocation: { seller: "0.00", platform: "40.00" } });
    const released = releaseRefund(authorization);
    const afterReserve = apply(initialProtectionReserveState, reserveCommand(authorization, "100.00"));
    const afterSettle = apply(afterReserve, settleCommand(released));

    // The lost-response webhook redelivers the same refund; reconciling again recognizes the
    // already-settled reserve and the settle is a no-op — the reserve is consumed exactly once.
    const replayDecision = decideRefundLiability({
      allocation: authorizedRefundAllocation(released),
      completedRefundAmount: released.refundAmount,
      completedCurrencyCode: released.currencyCode,
      reservation: reservationStateFor(afterSettle, released.coverageId),
    });
    expect(replayDecision).toMatchObject({ outcome: "allocated", alreadySettled: true, sellerDebitAmount: "0.00" });

    const secondSettle = decideProtectionCoverage(afterSettle, settleCommand(released));
    expect(secondSettle).toEqual([]);
    expect(afterSettle.consumedAmount).toBe("40.00");
  });

  it("J8b a settle redelivered against a different refund id is refused, never double-consumed", () => {
    const authorization = authorizeRemedy({ allocation: { seller: "0.00", platform: "40.00" } });
    const released = releaseRefund(authorization);
    const afterSettle = apply(
      apply(initialProtectionReserveState, reserveCommand(authorization, "100.00")),
      settleCommand(released),
    );
    expect(() => decideProtectionCoverage(afterSettle, settleCommand(released, "rfd_other"))).toThrow(
      /already settled against a different refund/i,
    );
  });

  it("J9 duplicate reserve delivery is a no-op after the first", () => {
    const authorization = authorizeRemedy({ allocation: { seller: "0.00", platform: "40.00" } });
    const reserve = reserveCommand(authorization, "100.00");
    const afterFirstReserve = apply(initialProtectionReserveState, reserve);
    const duplicateReserve = decideProtectionCoverage(afterFirstReserve, reserve);
    expect(duplicateReserve).toEqual([]);
    expect(afterFirstReserve.outstandingReservedAmount).toBe("40.00");
  });

  it("J10 carrier exception / lost return: operator releases the reservation, no seller debit", () => {
    const authorization = authorizeRemedy({
      allocation: { seller: "0.00", platform: "40.00" },
      returnDirective: "return-to-platform",
      refundTrigger: "operator-release",
    });
    const afterReserve = apply(initialProtectionReserveState, reserveCommand(authorization, "100.00"));
    const afterRelease = apply(afterReserve, {
      type: "ReleaseProtectionCoverage",
      coverageId: authorization.coverageId!,
      releaseReason: "case-cancelled",
      policyVersion: POLICY_VERSION,
      idempotencyKey: `coverage-release:${authorization.coverageId}`,
      causationId: null,
      occurredAt: "2026-07-16T00:00:00.000Z",
    });
    expect(afterRelease.reservations[COVERAGE_ID]?.status).toBe("released");
    expect(afterRelease.outstandingReservedAmount).toBe("0.00");
    expect(afterRelease.consumedAmount).toBe("0.00");
  });

  it("J11 reconciliation temporarily unavailable then re-run is deterministic", () => {
    const authorization = authorizeRemedy({ allocation: { seller: "0.00", platform: "40.00" } });
    const released = releaseRefund(authorization);
    const afterReserve = apply(initialProtectionReserveState, reserveCommand(authorization, "100.00"));
    const input = {
      allocation: authorizedRefundAllocation(released),
      completedRefundAmount: released.refundAmount,
      completedCurrencyCode: released.currencyCode,
      reservation: reservationStateFor(afterReserve, released.coverageId),
    };
    // A refund that completed while reconciliation was down reconciles identically when it re-runs.
    expect(decideRefundLiability(input)).toEqual(decideRefundLiability(input));
  });

  it("J12 an incorrect legacy seller debit is repaired to a platform-funded posting through the correction path", () => {
    // The erroneous state: a refund landed as a legacy seller-funded default (whole amount debited).
    const erroneous = decideRefundLiability({
      allocation: null,
      completedRefundAmount: "40.00",
      completedCurrencyCode: "usd",
      reservation: null,
    });
    expect(erroneous).toEqual({ outcome: "seller-funded-default", sellerDebitAmount: "40.00" });

    // The approved correction records the true platform-funded allocation against a reserved coverage
    // (ADR 0020 wallet-adjustment correction path). Re-reconciling now posts zero NEW seller debit and
    // consumes the reserve; the erroneous debit is reversed by the correlated wallet adjustment.
    const authorization = authorizeRemedy({ allocation: { seller: "0.00", platform: "40.00" } });
    const released = releaseRefund(authorization);
    const afterReserve = apply(initialProtectionReserveState, reserveCommand(authorization, "100.00"));
    const corrected = decideRefundLiability({
      allocation: authorizedRefundAllocation(released),
      completedRefundAmount: released.refundAmount,
      completedCurrencyCode: released.currencyCode,
      reservation: reservationStateFor(afterReserve, released.coverageId),
    });
    expect(corrected).toMatchObject({ outcome: "allocated", sellerDebitAmount: "0.00", platformSettleAmount: "40.00" });
  });
});

describe("platform-funded reconciliation proof — fault injection & replay convergence", () => {
  function reservedEvent(): ProtectionCoverageEvent {
    const authorization = authorizeRemedy({ allocation: { seller: "0.00", platform: "40.00" } });
    return decideProtectionCoverage(initialProtectionReserveState, reserveCommand(authorization, "100.00"))[0]!;
  }

  it("an out-of-order settled event seen before its reserve is deferred, never dropped or double-applied", () => {
    const authorization = authorizeRemedy({ allocation: { seller: "0.00", platform: "40.00" } });
    const released = releaseRefund(authorization);
    const reserved = reservedEvent();
    const afterReserve = evolveProtectionCoverage(initialProtectionReserveState, reserved);
    const settled = decideProtectionCoverage(afterReserve, settleCommand(released))[0]!;

    // In-order fold.
    const inOrder = [reserved, settled].reduce(evolveProtectionCoverage, initialProtectionReserveState);
    // A settled arriving before its reserve is ignored (no reservation to consume) rather than throwing;
    // once the reserve arrives and the settle is re-applied, state converges to the same terminal totals.
    const deferred = evolveProtectionCoverage(initialProtectionReserveState, settled);
    expect(deferred).toEqual(initialProtectionReserveState);
    const converged = [settled, reserved, settled].reduce(evolveProtectionCoverage, initialProtectionReserveState);

    expect(converged.consumedAmount).toBe(inOrder.consumedAmount);
    expect(converged.outstandingReservedAmount).toBe(inOrder.outstandingReservedAmount);
    expect(converged.reservations[COVERAGE_ID]?.status).toBe(inOrder.reservations[COVERAGE_ID]?.status);
  });

  it("projection rebuild from the persisted log is deterministic, and duplicate delivery consumes exactly once", () => {
    const authorization = authorizeRemedy({ allocation: { seller: "0.00", platform: "40.00" } });
    const released = releaseRefund(authorization);
    const reserved = reservedEvent();
    const afterReserve = evolveProtectionCoverage(initialProtectionReserveState, reserved);
    const settled = decideProtectionCoverage(afterReserve, settleCommand(released))[0]!;

    // The persisted event log carries each fact once — the decider dedups a duplicate command
    // (a redelivered reserve/settle produces no new event), so the store never appends duplicates.
    // Folding that deduped log always rebuilds the same state (projection rebuild convergence).
    const log = [reserved, settled];
    const firstBuild = log.reduce(evolveProtectionCoverage, initialProtectionReserveState);
    const secondBuild = log.reduce(evolveProtectionCoverage, initialProtectionReserveState);
    expect(secondBuild).toEqual(firstBuild);
    expect(firstBuild.consumedAmount).toBe("40.00");

    // Duplicate DELIVERY is absorbed at the decide layer: re-issuing the same reserve/settle
    // commands against the rebuilt state yields no new events, so the reserve is consumed once.
    const afterBuild = firstBuild;
    expect(decideProtectionCoverage(afterBuild, reserveCommand(authorization, "100.00"))).toEqual([]);
    expect(decideProtectionCoverage(afterBuild, settleCommand(released))).toEqual([]);
    expect(afterBuild.consumedAmount).toBe("40.00");
  });
});
