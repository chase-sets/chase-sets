import {
  allocateMoneyByLargestRemainder,
  centsToMoneyAmount,
  moneyToCents,
  normalizeMoneyAmount,
} from "@chase-sets/primitives/money";
import {
  classifyLiabilityFundingKind,
  normalizePlatformCoverageCurrencyCode,
  type LiabilityFundingKind,
} from "@chase-sets/primitives/platform-coverage";

/**
 * Liability allocation — the Settlement-owned decision that turns a completed
 * refund plus its authorized `LiabilityAllocation` (ADR 0022) into exact seller
 * and platform postings. Settlement owns financial truth (ADR 0013/0020, reaffirmed
 * by ADR 0022): it never infers who paid from the mere existence of a refund, never
 * charges the seller for a platform-covered remedy, and never consumes more than the
 * reserved protection amount.
 *
 * This module is pure — no I/O — so the money invariants are decided and tested in
 * isolation from the projection that persists them. The projection feeds it the
 * authorized allocation (projected from the Payments refund-causation facts),
 * the completed refund amount/currency (from `payments.payment-refunded`), and the
 * reservation state (from the ProtectionCoverage read model), and applies the
 * postings the decision returns.
 *
 * Invariants encoded here:
 * - A refund with no authorized allocation is seller-funded by the documented
 *   compatibility default — the legacy shape and a genuinely seller-funded remedy are
 *   indistinguishable at the fact boundary, and both preserve current seller-debit
 *   behavior.
 * - Allocation components are non-negative (guaranteed by the shared normalizer) and
 *   must sum exactly to the completed refund; a refund larger or smaller than the
 *   authorized remedy is quarantined, never silently re-split onto the seller.
 * - A positive platform-funded portion requires an approved coverage id AND a matching
 *   reserved coverage; the platform portion consumed equals the reserved amount.
 * - Currency and monetary precision match the authorized remedy.
 * - Every non-quarantined decision is fully reconstructable from its inputs, so replay
 *   and projection rebuild are deterministic.
 */

/**
 * The authorized allocation for a single refund, projected from the Payments
 * refund-causation facts. `null` seller/platform values are never allowed — the
 * upstream normalizer canonicalizes them — so this shape carries canonical money.
 */
export type AuthorizedRefundAllocation = Readonly<{
  refundId: string;
  remedyId: string;
  coverageId: string | null;
  sellerFundedAmount: string;
  platformFundedAmount: string;
  currencyCode: string;
  fundingKind: LiabilityFundingKind;
}>;

/** The ProtectionCoverage reservation state a settle draws against, from the coverage read model. */
export type CoverageReservationState = Readonly<{
  reservedAmount: string;
  status: "reserved" | "settled" | "released" | "expired";
  refundId: string | null;
  policyVersion: string;
  currencyCode: string;
  supportRequestId: string;
  remedyId: string;
}>;

export const refundLiabilityQuarantineReasons = [
  "currency-mismatch",
  "amount-mismatch",
  "coverage-missing",
  "coverage-not-reserved",
  "coverage-already-settled",
  "reservation-mismatch",
  "no-seller-exposure",
] as const;

export type RefundLiabilityQuarantineReason = (typeof refundLiabilityQuarantineReasons)[number];

export type RefundLiabilityDecision =
  | Readonly<{
      outcome: "seller-funded-default";
      /** The whole completed refund is debited to the seller, distributed by the existing proration. */
      sellerDebitAmount: string;
    }>
  | Readonly<{
      outcome: "allocated";
      fundingKind: LiabilityFundingKind;
      /** Exact seller-funded portion, distributed across seller payouts to sum to this amount. */
      sellerDebitAmount: string;
      /** Exact platform-funded portion consumed from the reserved coverage; "0.00" for seller-funded. */
      platformSettleAmount: string;
      coverageId: string | null;
      /**
       * True when the coverage was already settled against this same refund; the seller
       * debit remains idempotent and the coverage settle is a no-op. Distinguishes a safe
       * replay from a genuine double-consumption attempt.
       */
      alreadySettled: boolean;
    }>
  | Readonly<{
      outcome: "quarantined";
      reasonCode: RefundLiabilityQuarantineReason;
      detail: string;
    }>;

export type DecideRefundLiabilityInput = Readonly<{
  allocation: AuthorizedRefundAllocation | null;
  completedRefundAmount: string;
  completedCurrencyCode: string;
  /** The reserved coverage for a platform-funded allocation, or `null` when none is recorded. */
  reservation: CoverageReservationState | null;
}>;

function quarantine(reasonCode: RefundLiabilityQuarantineReason, detail: string): RefundLiabilityDecision {
  return { outcome: "quarantined", reasonCode, detail };
}

/**
 * Decides the seller and platform postings for a completed refund. Fails closed:
 * any inconsistency between the completed refund and the authorized allocation, or
 * with the protection reservation, is quarantined for operator review rather than
 * charged to the seller.
 */
export function decideRefundLiability(input: DecideRefundLiabilityInput): RefundLiabilityDecision {
  const completedRefundAmount = normalizeMoneyAmount(input.completedRefundAmount);
  const completedCurrencyCode = normalizePlatformCoverageCurrencyCode(input.completedCurrencyCode);

  if (input.allocation === null) {
    // Documented compatibility default: absence of a causation-carried allocation is a
    // seller-funded refund (legacy or genuinely seller-funded). Current behavior preserved.
    return { outcome: "seller-funded-default", sellerDebitAmount: completedRefundAmount };
  }

  const allocation = input.allocation;
  const sellerFundedAmount = normalizeMoneyAmount(allocation.sellerFundedAmount);
  const platformFundedAmount = normalizeMoneyAmount(allocation.platformFundedAmount);
  const allocationCurrency = normalizePlatformCoverageCurrencyCode(allocation.currencyCode);
  const sellerCents = moneyToCents(sellerFundedAmount);
  const platformCents = moneyToCents(platformFundedAmount);
  const fundingKind = classifyLiabilityFundingKind(sellerCents, platformCents);

  if (allocationCurrency !== completedCurrencyCode) {
    return quarantine(
      "currency-mismatch",
      `Authorized allocation currency ${allocationCurrency} does not match completed refund currency ${completedCurrencyCode}.`,
    );
  }

  if (sellerCents + platformCents !== moneyToCents(completedRefundAmount)) {
    return quarantine(
      "amount-mismatch",
      `Authorized allocation (${sellerFundedAmount} + ${platformFundedAmount}) does not sum to the completed refund ${completedRefundAmount}.`,
    );
  }

  if (platformCents === 0n) {
    // Fully seller-funded authorization: debit the seller exactly, consume no reserve.
    return {
      outcome: "allocated",
      fundingKind,
      sellerDebitAmount: sellerFundedAmount,
      platformSettleAmount: "0.00",
      coverageId: null,
      alreadySettled: false,
    };
  }

  // Platform-funded or split: the platform portion must draw from an approved, reserved coverage.
  if (allocation.coverageId === null || allocation.coverageId.trim().length === 0) {
    return quarantine("coverage-missing", "A platform-funded refund requires an approved coverage id.");
  }
  if (input.reservation === null) {
    return quarantine(
      "coverage-not-reserved",
      `Coverage ${allocation.coverageId} has no protection reservation to consume.`,
    );
  }

  const reservation = input.reservation;

  if (reservation.status === "settled") {
    if (reservation.refundId === allocation.refundId) {
      // Exactly-once consumption already happened for this refund; a safe replay.
      return {
        outcome: "allocated",
        fundingKind,
        sellerDebitAmount: sellerFundedAmount,
        platformSettleAmount: platformFundedAmount,
        coverageId: allocation.coverageId,
        alreadySettled: true,
      };
    }
    return quarantine(
      "coverage-already-settled",
      `Coverage ${allocation.coverageId} is already settled against refund ${reservation.refundId ?? "unknown"}.`,
    );
  }
  if (reservation.status !== "reserved") {
    return quarantine(
      "coverage-not-reserved",
      `Coverage ${allocation.coverageId} is ${reservation.status} and cannot be consumed.`,
    );
  }

  const reservedCents = moneyToCents(normalizeMoneyAmount(reservation.reservedAmount));
  if (platformCents !== reservedCents) {
    return quarantine(
      "reservation-mismatch",
      `Platform-funded portion ${platformFundedAmount} does not equal the reserved coverage amount ${reservation.reservedAmount}.`,
    );
  }

  return {
    outcome: "allocated",
    fundingKind,
    sellerDebitAmount: sellerFundedAmount,
    platformSettleAmount: platformFundedAmount,
    coverageId: allocation.coverageId,
    alreadySettled: false,
  };
}

export type SellerPayoutWeight = Readonly<{ orderId: string; sellerAccountId: string; weightAmount: string }>;

/**
 * Distributes an exact seller-funded portion across the seller payouts by their
 * exposure weights, so the posted debits sum to exactly `sellerDebitAmount` (largest
 * remainder, no penny lost or duplicated). Unlike the legacy proration this does not
 * scale by payment total — the authorized allocation has already decided the seller's
 * share, so Settlement posts precisely that share.
 */
export function distributeSellerFundedPortion(
  sellerDebitAmount: string,
  payouts: readonly SellerPayoutWeight[],
): readonly string[] {
  const debitCents = moneyToCents(normalizeMoneyAmount(sellerDebitAmount));
  if (debitCents === 0n || payouts.length === 0) {
    return payouts.map(() => "0.00");
  }
  const weights = payouts.map((payout) => moneyToCents(normalizeMoneyAmount(payout.weightAmount)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight === 0n) {
    // No seller exposure to absorb a positive seller-funded portion; the caller quarantines.
    return payouts.map(() => "0.00");
  }
  return allocateMoneyByLargestRemainder(centsToMoneyAmount(debitCents), weights);
}
