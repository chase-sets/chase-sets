import {
  assertCoverageRejectionReasonCode,
  assertRefundTrigger,
  assertReturnDirective,
  classifyLiabilityFundingKind,
  isLiabilityFundingKind,
  normalizeBuyerRemedy,
  normalizeLiabilityAllocation,
  normalizeLiabilityAllocationForRemedy,
  normalizePlatformCoverageCurrencyCode,
  type BuyerRemedyKind,
  type CoverageRejectionReasonCode,
  type LiabilityAllocation,
  type LiabilityFundingKind,
  type RefundTrigger,
  type ReturnDirective,
} from "../primitives/platform-coverage";
import { moneyToCents, normalizeMoneyAmount } from "../primitives/money";

/**
 * Versioned cross-context fact contracts for platform-covered support resolutions
 * (epic #5210, ADR 0022). Every payload here is a fact — a thing that happened in
 * its owning context — never a remote command. The stable identifiers, allocation,
 * and closed vocabularies let Support, Settlement, Payments, and Fulfillment agree on
 * the same remedy without inferring liability from a refund's existence or its text.
 *
 * Runtime validation lives beside the types: each `normalize*` returns a canonical,
 * fully-validated payload or throws. Amounts are wire-shaped decimal strings and are
 * re-canonicalized through the money primitive on every decode, so replayed events are
 * validated identically to freshly published ones.
 */

/** Canonical fact type names. `.v1` is the wire version; additive fields evolve within v1. */
export const platformCoverageFactTypes = {
  remedyAuthorized: "support.support-request.remedy-authorized.v1",
  platformCoverageRequested: "support.support-request.platform-coverage-requested.v1",
  refundReleased: "support.support-request.refund-released.v1",
  remedyCompleted: "support.support-request.remedy-completed.v1",
  protectionCoverageReserved: "settlement.protection-coverage.reserved.v1",
  protectionCoverageRejected: "settlement.protection-coverage.rejected.v1",
  protectionCoverageSettled: "settlement.protection-coverage.settled.v1",
} as const;

export type PlatformCoverageFactType = (typeof platformCoverageFactTypes)[keyof typeof platformCoverageFactTypes];

// -------------------------------------------------------------------------------------------------
// Wire shapes. Amounts are decimal strings on the wire; validators canonicalize them.
// -------------------------------------------------------------------------------------------------

export type BuyerRemedyFactV1 = Readonly<{
  kind: BuyerRemedyKind;
  amount: string;
  currencyCode: string;
}>;

export type LiabilityAllocationFactV1 = Readonly<{
  sellerFundedAmount: string;
  platformFundedAmount: string;
  currencyCode: string;
  fundingKind: LiabilityFundingKind;
}>;

/**
 * Fields shared by every platform-coverage fact.
 *
 * - `remedyId` is the cross-context correlation anchor; the same remedy id threads
 *   Support, Settlement, Payments, and Fulfillment.
 * - `causationId` is the id of the fact/command that caused this one (`null` for an
 *   originating authorization), giving explicit lineage for out-of-order delivery.
 * - `idempotencyKey` makes duplicate delivery harmless: a consumer that has already
 *   applied a key is a no-op on redelivery.
 * - `policyVersion` pins the coverage/remedy policy in force, so replay is deterministic.
 * - The acting operator (actor) is carried by the transport envelope's audit block, not
 *   duplicated here.
 */
export type PlatformCoverageFactEnvelopeV1 = Readonly<{
  factSchemaVersion: 1;
  supportRequestId: string;
  remedyId: string;
  idempotencyKey: string;
  causationId: string | null;
  policyVersion: string;
  occurredAt: string;
}>;

export type SupportRequestRemedyAuthorizedV1Payload = PlatformCoverageFactEnvelopeV1 &
  Readonly<{
    /** Present iff the platform-funded component is positive (coverage belongs to exactly one remedy). */
    coverageId: string | null;
    remedy: BuyerRemedyFactV1;
    allocation: LiabilityAllocationFactV1;
    returnDirective: ReturnDirective;
    refundTrigger: RefundTrigger;
    /** Structured operator reason for the authorization (audit); not a funding signal. */
    reasonCode: string;
  }>;

export type SupportRequestPlatformCoverageRequestedV1Payload = PlatformCoverageFactEnvelopeV1 &
  Readonly<{
    coverageId: string;
    requestedAmount: string;
    currencyCode: string;
    reasonCode: string;
  }>;

export type ProtectionCoverageReservedV1Payload = PlatformCoverageFactEnvelopeV1 &
  Readonly<{
    coverageId: string;
    reservedAmount: string;
    currencyCode: string;
  }>;

export type ProtectionCoverageRejectedV1Payload = PlatformCoverageFactEnvelopeV1 &
  Readonly<{
    coverageId: string;
    requestedAmount: string;
    currencyCode: string;
    reasonCode: CoverageRejectionReasonCode;
  }>;

export type SupportRequestRefundReleasedV1Payload = PlatformCoverageFactEnvelopeV1 &
  Readonly<{
    coverageId: string | null;
    refundAmount: string;
    currencyCode: string;
    allocation: LiabilityAllocationFactV1;
    refundTrigger: RefundTrigger;
  }>;

export type ProtectionCoverageSettledV1Payload = PlatformCoverageFactEnvelopeV1 &
  Readonly<{
    coverageId: string;
    /** The correlated Payments refund whose platform portion this reservation consumes. */
    refundId: string;
    allocation: LiabilityAllocationFactV1;
    currencyCode: string;
  }>;

export type SupportRequestRemedyCompletedV1Payload = PlatformCoverageFactEnvelopeV1 &
  Readonly<{
    coverageId: string | null;
    refundId: string | null;
    allocation: LiabilityAllocationFactV1;
    returnDirective: ReturnDirective;
    completedAt: string;
  }>;

// -------------------------------------------------------------------------------------------------
// Validation helpers.
// -------------------------------------------------------------------------------------------------

function assertNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Platform-coverage fact requires ${field}.`);
  }
  return trimmed;
}

function assertIsoTimestamp(value: string, field: string): string {
  const trimmed = assertNonEmpty(value, field);
  if (Number.isNaN(Date.parse(trimmed))) {
    throw new Error(`Platform-coverage fact ${field} must be an ISO timestamp.`);
  }
  return trimmed;
}

type EnvelopeInput = Readonly<{
  factSchemaVersion: number;
  supportRequestId: string;
  remedyId: string;
  idempotencyKey: string;
  causationId?: string | null;
  policyVersion: string;
  occurredAt: string;
}>;

function normalizeEnvelope(input: EnvelopeInput): PlatformCoverageFactEnvelopeV1 {
  if (input.factSchemaVersion !== 1) {
    throw new Error(`Unsupported platform-coverage fact schema version: ${input.factSchemaVersion}`);
  }
  return {
    factSchemaVersion: 1,
    supportRequestId: assertNonEmpty(input.supportRequestId, "a support request id"),
    remedyId: assertNonEmpty(input.remedyId, "a remedy id"),
    idempotencyKey: assertNonEmpty(input.idempotencyKey, "an idempotency key"),
    causationId: input.causationId == null ? null : assertNonEmpty(input.causationId, "a causation id"),
    policyVersion: assertNonEmpty(input.policyVersion, "a policy version"),
    occurredAt: assertIsoTimestamp(input.occurredAt, "occurredAt"),
  };
}

function normalizeAllocationFact(
  allocation: LiabilityAllocationFactV1,
  source: LiabilityAllocation,
): LiabilityAllocationFactV1 {
  if (isLiabilityFundingKind(allocation.fundingKind) && allocation.fundingKind !== source.fundingKind) {
    throw new Error(
      `Liability allocation fundingKind '${allocation.fundingKind}' disagrees with its components ('${source.fundingKind}').`,
    );
  }
  return {
    sellerFundedAmount: source.sellerFundedAmount,
    platformFundedAmount: source.platformFundedAmount,
    currencyCode: source.currencyCode,
    fundingKind: source.fundingKind,
  };
}

/**
 * Enforces that platform funding and a coverage id are inseparable: a positive
 * platform-funded amount requires a coverage id, and a coverage id must not appear on
 * a purely seller-funded allocation. This is the "a coverage id belongs to exactly one
 * remedy, and platform coverage is not free-form" invariant at the fact boundary.
 */
function reconcileCoverageId(fundingKind: LiabilityFundingKind, coverageId: string | null): string | null {
  const hasPlatformFunding = fundingKind !== "seller-funded";
  if (hasPlatformFunding) {
    if (coverageId == null) {
      throw new Error("A platform-funded remedy fact requires a coverageId.");
    }
    return assertNonEmpty(coverageId, "a coverage id");
  }
  if (coverageId != null && coverageId.trim().length > 0) {
    throw new Error("A seller-funded remedy fact must not carry a coverageId.");
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// Per-fact normalizers.
// -------------------------------------------------------------------------------------------------

export function normalizeSupportRequestRemedyAuthorizedV1(
  input: EnvelopeInput &
    Readonly<{
      coverageId?: string | null;
      remedy: BuyerRemedyFactV1;
      allocation: LiabilityAllocationFactV1;
      returnDirective: string;
      refundTrigger: string;
      reasonCode: string;
    }>,
): SupportRequestRemedyAuthorizedV1Payload {
  const envelope = normalizeEnvelope(input);
  const remedy = normalizeBuyerRemedy(input.remedy);
  const allocation = normalizeLiabilityAllocationForRemedy(remedy, input.allocation);
  return {
    ...envelope,
    coverageId: reconcileCoverageId(allocation.fundingKind, input.coverageId ?? null),
    remedy: { kind: remedy.kind, amount: remedy.amount, currencyCode: remedy.currencyCode },
    allocation: normalizeAllocationFact(input.allocation, allocation),
    returnDirective: assertReturnDirective(input.returnDirective),
    refundTrigger: assertRefundTrigger(input.refundTrigger),
    reasonCode: assertNonEmpty(input.reasonCode, "a reason code"),
  };
}

export function normalizeSupportRequestPlatformCoverageRequestedV1(
  input: EnvelopeInput &
    Readonly<{ coverageId: string; requestedAmount: string; currencyCode: string; reasonCode: string }>,
): SupportRequestPlatformCoverageRequestedV1Payload {
  const envelope = normalizeEnvelope(input);
  const currencyCode = normalizePlatformCoverageCurrencyCode(input.currencyCode);
  const requestedAmount = normalizeMoneyAmount(input.requestedAmount);
  if (moneyToCents(requestedAmount) <= 0n) {
    throw new Error("A platform-coverage reservation request must be for a positive amount.");
  }
  return {
    ...envelope,
    coverageId: assertNonEmpty(input.coverageId, "a coverage id"),
    requestedAmount,
    currencyCode,
    reasonCode: assertNonEmpty(input.reasonCode, "a reason code"),
  };
}

export function normalizeProtectionCoverageReservedV1(
  input: EnvelopeInput & Readonly<{ coverageId: string; reservedAmount: string; currencyCode: string }>,
): ProtectionCoverageReservedV1Payload {
  const envelope = normalizeEnvelope(input);
  const currencyCode = normalizePlatformCoverageCurrencyCode(input.currencyCode);
  const reservedAmount = normalizeMoneyAmount(input.reservedAmount);
  if (moneyToCents(reservedAmount) <= 0n) {
    throw new Error("A reserved coverage amount must be positive.");
  }
  return {
    ...envelope,
    coverageId: assertNonEmpty(input.coverageId, "a coverage id"),
    reservedAmount,
    currencyCode,
  };
}

export function normalizeProtectionCoverageRejectedV1(
  input: EnvelopeInput &
    Readonly<{ coverageId: string; requestedAmount: string; currencyCode: string; reasonCode: string }>,
): ProtectionCoverageRejectedV1Payload {
  const envelope = normalizeEnvelope(input);
  const currencyCode = normalizePlatformCoverageCurrencyCode(input.currencyCode);
  const requestedAmount = normalizeMoneyAmount(input.requestedAmount);
  return {
    ...envelope,
    coverageId: assertNonEmpty(input.coverageId, "a coverage id"),
    requestedAmount,
    currencyCode,
    reasonCode: assertCoverageRejectionReasonCode(input.reasonCode),
  };
}

export function normalizeSupportRequestRefundReleasedV1(
  input: EnvelopeInput &
    Readonly<{
      coverageId?: string | null;
      refundAmount: string;
      currencyCode: string;
      allocation: LiabilityAllocationFactV1;
      refundTrigger: string;
    }>,
): SupportRequestRefundReleasedV1Payload {
  const envelope = normalizeEnvelope(input);
  const currencyCode = normalizePlatformCoverageCurrencyCode(input.currencyCode);
  const refundAmount = normalizeMoneyAmount(input.refundAmount);
  const allocation = normalizeLiabilityAllocation({ ...input.allocation, currencyCode });
  const componentCents = moneyToCents(allocation.sellerFundedAmount) + moneyToCents(allocation.platformFundedAmount);
  if (componentCents !== moneyToCents(refundAmount)) {
    throw new Error("Refund-released allocation components must sum exactly to the released refund amount.");
  }
  return {
    ...envelope,
    coverageId: reconcileCoverageId(allocation.fundingKind, input.coverageId ?? null),
    refundAmount,
    currencyCode,
    allocation: normalizeAllocationFact(input.allocation, allocation),
    refundTrigger: assertRefundTrigger(input.refundTrigger),
  };
}

export function normalizeProtectionCoverageSettledV1(
  input: EnvelopeInput &
    Readonly<{ coverageId: string; refundId: string; allocation: LiabilityAllocationFactV1; currencyCode: string }>,
): ProtectionCoverageSettledV1Payload {
  const envelope = normalizeEnvelope(input);
  const currencyCode = normalizePlatformCoverageCurrencyCode(input.currencyCode);
  const allocation = normalizeLiabilityAllocation({ ...input.allocation, currencyCode });
  if (moneyToCents(allocation.platformFundedAmount) <= 0n) {
    throw new Error("A settled protection-coverage fact must consume a positive platform-funded amount.");
  }
  return {
    ...envelope,
    coverageId: assertNonEmpty(input.coverageId, "a coverage id"),
    refundId: assertNonEmpty(input.refundId, "a refund id"),
    allocation: normalizeAllocationFact(input.allocation, allocation),
    currencyCode,
  };
}

export function normalizeSupportRequestRemedyCompletedV1(
  input: EnvelopeInput &
    Readonly<{
      coverageId?: string | null;
      refundId?: string | null;
      allocation: LiabilityAllocationFactV1;
      returnDirective: string;
      completedAt: string;
    }>,
): SupportRequestRemedyCompletedV1Payload {
  const envelope = normalizeEnvelope(input);
  const allocation = normalizeLiabilityAllocation(input.allocation);
  return {
    ...envelope,
    coverageId: reconcileCoverageId(allocation.fundingKind, input.coverageId ?? null),
    refundId: input.refundId == null ? null : assertNonEmpty(input.refundId, "a refund id"),
    allocation: normalizeAllocationFact(input.allocation, allocation),
    returnDirective: assertReturnDirective(input.returnDirective),
    completedAt: assertIsoTimestamp(input.completedAt, "completedAt"),
  };
}

// Re-export the funding classifier so Settlement/Support can label allocations identically.
export { classifyLiabilityFundingKind };
