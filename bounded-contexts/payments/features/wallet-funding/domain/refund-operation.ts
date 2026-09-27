import type { PrepaidRefundIdentity, PrepaidRefundReservation } from "../api/prepaid-refund-authority";
import { matchesPrepaidRefundIdentity } from "../api/prepaid-refund-authority";
import { PaymentsDomainError } from "../../../support/runtime-support/common";

export type WalletFundingRefundStatus =
  | "intent"
  | "reserved"
  | "submitting"
  | "pending"
  | "unknown"
  | "success-awaiting-commit"
  | "committed"
  | "failure-awaiting-release"
  | "released";

export type WalletFundingRefundOperation = PrepaidRefundIdentity &
  Readonly<{
    status: WalletFundingRefundStatus;
    reservationId: string | null;
    processorRefundReference: string | null;
    providerIdempotencyKey: string;
    processorStatus: "succeeded" | "failed" | "cancelled" | "pending" | "unknown";
    outcomeEvidenceId: string | null;
    updatedAt: string;
    exception: "provider-outcome-unknown" | "refund-pending" | "authority-unavailable" | "authority-refused" | null;
  }>;

export type WalletFundingRefundObservation = Readonly<{
  refundId: string;
  processorRefundReference: string;
  amount: string;
  currencyCode: "usd";
  status: WalletFundingRefundOperation["processorStatus"];
  evidenceId: string;
  at: string;
}>;

function refuse(code: string): never {
  throw new PaymentsDomainError(code, code);
}

export function refundIntent(identity: PrepaidRefundIdentity, at: string): WalletFundingRefundOperation {
  return {
    ...identity,
    status: "intent",
    reservationId: null,
    processorRefundReference: null,
    providerIdempotencyKey: `payments:wallet-funding:${identity.fundingId}:refund:${identity.refundId}`,
    processorStatus: "unknown",
    outcomeEvidenceId: null,
    updatedAt: at,
    exception: null,
  };
}

export function reserveRefund(
  operation: WalletFundingRefundOperation,
  reservation: PrepaidRefundReservation,
  at: string,
): WalletFundingRefundOperation {
  if (!matchesPrepaidRefundIdentity(operation, reservation)) refuse("refund_identity_conflict");
  if (operation.reservationId !== null && operation.reservationId !== reservation.reservationId)
    refuse("refund_reservation_conflict");
  if (operation.status !== "intent") return operation;
  return { ...operation, reservationId: reservation.reservationId, status: "reserved", updatedAt: at, exception: null };
}

/** Only the caller that durably appends this transition may submit to the provider. */
export function claimRefundSubmission(
  operation: WalletFundingRefundOperation,
  at: string,
): WalletFundingRefundOperation {
  if (operation.status !== "reserved") return operation;
  if (!operation.reservationId) refuse("refund_reservation_required");
  return { ...operation, status: "submitting", updatedAt: at, exception: "provider-outcome-unknown" };
}

export function observeRefund(
  operation: WalletFundingRefundOperation,
  observation: WalletFundingRefundObservation,
): WalletFundingRefundOperation {
  if (
    observation.refundId !== operation.refundId ||
    observation.amount !== operation.amount ||
    observation.currencyCode !== operation.currencyCode ||
    !observation.processorRefundReference ||
    !observation.evidenceId
  )
    refuse("refund_observation_conflict");
  if (operation.processorRefundReference && operation.processorRefundReference !== observation.processorRefundReference)
    refuse("refund_provider_reference_conflict");
  if (!operation.reservationId || operation.status === "intent" || operation.status === "reserved")
    refuse("refund_submission_required");
  const success = operation.status === "committed" || operation.status === "success-awaiting-commit";
  const failure = operation.status === "released" || operation.status === "failure-awaiting-release";
  if (
    (success && (observation.status === "failed" || observation.status === "cancelled")) ||
    (failure && observation.status === "succeeded")
  )
    refuse("refund_terminal_outcome_conflict");
  // Late nonterminal observations cannot downgrade durable terminal evidence.
  if (success || failure) return operation;
  const status =
    observation.status === "succeeded"
      ? "success-awaiting-commit"
      : observation.status === "failed" || observation.status === "cancelled"
        ? "failure-awaiting-release"
        : observation.status;
  return {
    ...operation,
    status,
    processorStatus: observation.status,
    processorRefundReference: observation.processorRefundReference,
    outcomeEvidenceId: observation.evidenceId,
    updatedAt: observation.at,
    exception: status === "pending" ? "refund-pending" : status === "unknown" ? "provider-outcome-unknown" : null,
  };
}

export function settleRefundAuthority(
  operation: WalletFundingRefundOperation,
  outcome: "committed" | "released",
  at: string,
): WalletFundingRefundOperation {
  if (operation.status === outcome) return operation;
  const expected = outcome === "committed" ? "success-awaiting-commit" : "failure-awaiting-release";
  if (operation.status !== expected) refuse("refund_terminal_authority_conflict");
  return { ...operation, status: outcome, updatedAt: at, exception: null };
}
