import { moneyToCents } from "@chase-sets/primitives/money";
import {
  assertRefundTrigger,
  normalizeLiabilityAllocation,
  type LiabilityFundingKind,
  type RefundTrigger,
} from "@chase-sets/primitives/platform-coverage";
import type { LiabilityAllocationFactV1 } from "@chase-sets/event-core/platform-coverage-facts";

/**
 * Refund causation carries the stable remedy and liability-allocation references
 * a refund must preserve so downstream consumers (Settlement, Support) never infer
 * who paid from the mere existence of a refund. Payments carries these references
 * through; it does not decide seller-vs-platform liability — the allocation arrives
 * as authorized input from upstream and is only validated here.
 *
 * A seller-funded refund carries no causation at all (the legacy shape), so the
 * value is optional everywhere and its absence upcasts to a seller-funded refund.
 * When present, the allocation is validated with the shared platform-coverage
 * normalizers so the fact boundary and the money aggregate agree on the same rules.
 */
export type RefundCausationInput = Readonly<{
  remedyId: string;
  coverageId?: string | null;
  allocation: LiabilityAllocationFactV1;
  reasonCode: string;
  refundTrigger: RefundTrigger | string;
  refundTriggerEvidenceRef?: string | null;
  policyVersion?: string | null;
}>;

export type RefundCausation = Readonly<{
  remedyId: string;
  /** Present iff the allocation is platform-funded; a seller-funded refund must not carry one. */
  coverageId: string | null;
  allocation: LiabilityAllocationFactV1;
  reasonCode: string;
  refundTrigger: RefundTrigger;
  /** Reference to the evidence whose arrival released the refund (the causing fact). */
  refundTriggerEvidenceRef: string | null;
  policyVersion: string | null;
}>;

function requiredText(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(message);
  }
  return trimmed;
}

/**
 * Platform funding and an approved coverage reference are inseparable: a
 * platform-funded (or split) allocation requires a coverage id, and a purely
 * seller-funded allocation must not carry one. This is the Payments-side of the
 * "coverage id belongs to exactly one remedy" invariant, and the rejection the
 * acceptance criteria require for platform-funded input lacking coverage.
 */
function reconcileCoverageReference(
  fundingKind: LiabilityFundingKind,
  coverageId: string | null | undefined,
): string | null {
  const trimmed = coverageId?.trim() ?? "";
  const platformFunded = fundingKind !== "seller-funded";
  if (platformFunded) {
    if (!trimmed) {
      throw new Error("A platform-funded refund requires an approved coverage reference.");
    }
    return trimmed;
  }
  if (trimmed) {
    throw new Error("A seller-funded refund must not carry a coverage reference.");
  }
  return null;
}

/**
 * Validates and canonicalizes refund causation against the refund it accompanies.
 * The allocation must be in the refund currency, its non-negative seller and
 * platform components must sum exactly to the refund amount, and the coverage id
 * must be present iff platform-funded. Any disagreement throws so a refund with
 * a mismatched allocation is never persisted or sent to the provider.
 */
export function normalizeRefundCausation(
  input: RefundCausationInput,
  refundAmount: string,
  refundCurrencyCode: string,
): RefundCausation {
  const remedyId = requiredText(input.remedyId, "Refund causation requires a remedy id.");
  const allocation = normalizeLiabilityAllocation({
    sellerFundedAmount: input.allocation.sellerFundedAmount,
    platformFundedAmount: input.allocation.platformFundedAmount,
    currencyCode: input.allocation.currencyCode,
  });
  if (input.allocation.fundingKind && input.allocation.fundingKind !== allocation.fundingKind) {
    throw new Error("Refund causation funding kind disagrees with its allocation components.");
  }
  if (allocation.currencyCode !== refundCurrencyCode) {
    throw new Error("Refund causation currency must match the refund currency.");
  }
  const componentCents = moneyToCents(allocation.sellerFundedAmount) + moneyToCents(allocation.platformFundedAmount);
  if (componentCents !== moneyToCents(refundAmount)) {
    throw new Error("Refund causation allocation must sum exactly to the refund amount.");
  }
  return {
    remedyId,
    coverageId: reconcileCoverageReference(allocation.fundingKind, input.coverageId),
    allocation: {
      sellerFundedAmount: allocation.sellerFundedAmount,
      platformFundedAmount: allocation.platformFundedAmount,
      currencyCode: allocation.currencyCode,
      fundingKind: allocation.fundingKind,
    },
    reasonCode: requiredText(input.reasonCode, "Refund causation requires a structured reason code."),
    refundTrigger: assertRefundTrigger(String(input.refundTrigger)),
    refundTriggerEvidenceRef: input.refundTriggerEvidenceRef?.trim() || null,
    policyVersion: input.policyVersion?.trim() || null,
  };
}

/** Structural equality for replay/idempotency guards; both operands are normalizer output with a stable shape. */
export function refundCausationsEqual(left: RefundCausation | null, right: RefundCausation | null): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * The refund idempotency key is derived from the stable remedy id, not request
 * timing, so a command delivered twice resolves to the same refund stream and the
 * provider is invoked at most once for a remedy.
 */
export function refundIdForRemedy(remedyId: string): string {
  const suffix = requiredText(remedyId, "A remedy id is required to derive a refund id.").replace(/^rmd_/, "");
  return `rfd_${suffix}`;
}
