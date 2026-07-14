import { addMoneyAmounts, moneyToCents, normalizeMoneyAmount, type MoneyAmount } from "./money";

/**
 * Platform-covered resolution value objects and closed vocabularies.
 *
 * These are the cross-context primitives for the "platform-covered support
 * resolution" capability (epic #5210): the four orthogonal decisions an operator
 * makes independently — buyer remedy, liability allocation, return disposition,
 * and refund trigger — plus the money invariants that bind them. Support (Platform
 * Operations), Settlement, Payments, and Fulfillment all construct or read these
 * value objects; none of them may infer liability from the existence of a refund.
 *
 * Ratified by ADR 0022. Financial truth remains Settlement-owned; these are shared
 * vocabulary, not an accounting authority.
 */

/** Lowercases and validates a three-letter ISO currency code. Currency is always explicit. */
export function normalizePlatformCoverageCurrencyCode(input: string): string {
  const currencyCode = input.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currencyCode)) {
    throw new Error("Platform-coverage currency must be a three-letter code.");
  }
  return currencyCode;
}

// -------------------------------------------------------------------------------------------------
// Return disposition — where the physical goods go. Orthogonal to who pays and to refund timing.
// -------------------------------------------------------------------------------------------------

export const returnDirectives = ["return-to-seller", "return-to-platform", "no-return"] as const;

export type ReturnDirective = (typeof returnDirectives)[number];

export function isReturnDirective(value: string): value is ReturnDirective {
  return (returnDirectives as readonly string[]).includes(value);
}

export function assertReturnDirective(value: string): ReturnDirective {
  if (!isReturnDirective(value)) {
    throw new Error(`Unknown return directive: ${value}`);
  }
  return value;
}

// -------------------------------------------------------------------------------------------------
// Refund trigger — when the refund is released. Orthogonal to the return destination.
// -------------------------------------------------------------------------------------------------

export const refundTriggers = [
  "immediate",
  "carrier-accepted",
  "delivered",
  "facility-intake",
  "operator-release",
] as const;

export type RefundTrigger = (typeof refundTriggers)[number];

export function isRefundTrigger(value: string): value is RefundTrigger {
  return (refundTriggers as readonly string[]).includes(value);
}

export function assertRefundTrigger(value: string): RefundTrigger {
  if (!isRefundTrigger(value)) {
    throw new Error(`Unknown refund trigger: ${value}`);
  }
  return value;
}

// -------------------------------------------------------------------------------------------------
// Buyer remedy — what the buyer receives. `replacement` and other future remedies are reserved but
// out of scope for this contract; a replacement remedy will carry its own non-monetary shape.
// -------------------------------------------------------------------------------------------------

export const buyerRemedyKinds = ["full-refund", "partial-refund"] as const;

export type BuyerRemedyKind = (typeof buyerRemedyKinds)[number];

export function isBuyerRemedyKind(value: string): value is BuyerRemedyKind {
  return (buyerRemedyKinds as readonly string[]).includes(value);
}

export type BuyerRemedyInput = Readonly<{
  kind: BuyerRemedyKind;
  amount: string;
  currencyCode: string;
}>;

export type BuyerRemedy = Readonly<{
  kind: BuyerRemedyKind;
  amount: MoneyAmount;
  currencyCode: string;
}>;

/**
 * Normalizes and validates a buyer remedy. The authorized remedy is always a
 * positive monetary amount in an explicit currency; a zero remedy is degenerate
 * and rejected so downstream allocation arithmetic cannot silently balance to zero.
 */
export function normalizeBuyerRemedy(input: BuyerRemedyInput): BuyerRemedy {
  if (!isBuyerRemedyKind(input.kind)) {
    throw new Error(`Unknown buyer remedy kind: ${input.kind}`);
  }
  const currencyCode = normalizePlatformCoverageCurrencyCode(input.currencyCode);
  const amount = normalizeMoneyAmount(input.amount);
  if (moneyToCents(amount) <= 0n) {
    throw new Error("Buyer remedy amount must be a positive monetary amount.");
  }
  return { kind: input.kind, amount, currencyCode } satisfies BuyerRemedy;
}

// -------------------------------------------------------------------------------------------------
// Liability allocation — who funds the remedy. A closed funding taxonomy lets consumers distinguish
// seller-funded, platform-funded, and split allocations without parsing free-form metadata.
// -------------------------------------------------------------------------------------------------

export const liabilityFundingKinds = ["seller-funded", "platform-funded", "split"] as const;

export type LiabilityFundingKind = (typeof liabilityFundingKinds)[number];

export function isLiabilityFundingKind(value: string): value is LiabilityFundingKind {
  return (liabilityFundingKinds as readonly string[]).includes(value);
}

export type LiabilityAllocationInput = Readonly<{
  sellerFundedAmount: string;
  platformFundedAmount: string;
  currencyCode: string;
}>;

export type LiabilityAllocation = Readonly<{
  sellerFundedAmount: MoneyAmount;
  platformFundedAmount: MoneyAmount;
  currencyCode: string;
  /** Derived, closed classification. Never a source field — always computed from the components. */
  fundingKind: LiabilityFundingKind;
}>;

/**
 * Classifies a funding split from its non-negative components. Platform funding is
 * signalled only by a positive platform amount, so a both-zero split (only reachable
 * for a degenerate zero remedy, which `normalizeBuyerRemedy` forbids) classifies as
 * seller-funded — no protection reserve is consumed.
 */
export function classifyLiabilityFundingKind(
  sellerFundedCents: bigint,
  platformFundedCents: bigint,
): LiabilityFundingKind {
  if (sellerFundedCents < 0n || platformFundedCents < 0n) {
    throw new Error("Liability allocation components must be non-negative.");
  }
  if (platformFundedCents === 0n) {
    return "seller-funded";
  }
  if (sellerFundedCents === 0n) {
    return "platform-funded";
  }
  return "split";
}

/**
 * Normalizes a liability allocation on its own (non-negative components, canonical
 * money, explicit currency, derived funding kind). Does not check the sum against a
 * remedy — use {@link normalizeLiabilityAllocationForRemedy} to bind the invariant.
 */
export function normalizeLiabilityAllocation(input: LiabilityAllocationInput): LiabilityAllocation {
  const currencyCode = normalizePlatformCoverageCurrencyCode(input.currencyCode);
  const sellerFundedAmount = normalizeMoneyAmount(input.sellerFundedAmount);
  const platformFundedAmount = normalizeMoneyAmount(input.platformFundedAmount);
  const fundingKind = classifyLiabilityFundingKind(
    moneyToCents(sellerFundedAmount),
    moneyToCents(platformFundedAmount),
  );
  return { sellerFundedAmount, platformFundedAmount, currencyCode, fundingKind } satisfies LiabilityAllocation;
}

/**
 * Normalizes a liability allocation and binds it to an authorized remedy, enforcing
 * the core accounting invariant: the seller-funded and platform-funded components are
 * non-negative, share the remedy currency, and sum exactly to the authorized remedy.
 */
export function normalizeLiabilityAllocationForRemedy(
  remedy: BuyerRemedy,
  input: LiabilityAllocationInput,
): LiabilityAllocation {
  const allocation = normalizeLiabilityAllocation(input);
  if (allocation.currencyCode !== remedy.currencyCode) {
    throw new Error("Liability allocation currency must match the authorized remedy currency.");
  }
  const componentSum = addMoneyAmounts(allocation.sellerFundedAmount, allocation.platformFundedAmount);
  if (moneyToCents(componentSum) !== moneyToCents(remedy.amount)) {
    throw new Error("Liability allocation components must sum exactly to the authorized remedy amount.");
  }
  return allocation;
}

// -------------------------------------------------------------------------------------------------
// Coverage rejection — a closed, machine-readable reason taxonomy for a refused reservation.
// -------------------------------------------------------------------------------------------------

export const coverageRejectionReasonCodes = [
  "insufficient-reserve",
  "policy-limit-exceeded",
  "currency-mismatch",
  "conflicting-terms",
  "coverage-expired",
] as const;

export type CoverageRejectionReasonCode = (typeof coverageRejectionReasonCodes)[number];

export function isCoverageRejectionReasonCode(value: string): value is CoverageRejectionReasonCode {
  return (coverageRejectionReasonCodes as readonly string[]).includes(value);
}

export function assertCoverageRejectionReasonCode(value: string): CoverageRejectionReasonCode {
  if (!isCoverageRejectionReasonCode(value)) {
    throw new Error(`Unknown coverage rejection reason code: ${value}`);
  }
  return value;
}
