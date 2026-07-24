export type CanonicalClaimStatus = "settled" | "unresolved";

/**
 * The closed set of shared sensitive money/custody/processor claims that more
 * than one Public Policy Artifact may need to reference. Adding an id here is
 * the one place a claim's settled/unresolved status is decided; no artifact
 * section may assert a different status for the same id.
 */
export const canonicalClaimIds = [
  "payment-charge-timing-and-capture",
  "payment-chargeback-recovery-mechanism",
  "payout-release-hold-mechanism",
  "wallet-no-interest",
  "wallet-deposit-and-fdic-posture",
] as const;

export type CanonicalClaimId = (typeof canonicalClaimIds)[number];

export type CanonicalClaimDefinition = Readonly<{
  status: CanonicalClaimStatus;
  description: string;
  /**
   * Only enforced when status is "settled": a section citing this claim must
   * cite at least one product-truth evidence reference whose exact cited
   * source lines contain one of these keywords (case-insensitive), so a
   * citation pointing at unrelated code fails
   * structurally instead of only on human review.
   */
  requiredEvidenceKeywords: readonly string[];
}>;

export const canonicalClaimRegistry: Readonly<Record<CanonicalClaimId, CanonicalClaimDefinition>> = {
  "payment-charge-timing-and-capture": {
    status: "settled",
    description:
      "Stripe charges/captures the buyer's selected payment method as part of completing a Marketplace " +
      "purchase, following Chase Sets' standard payment-session-create/confirm and capture path.",
    requiredEvidenceKeywords: ["createPaymentSession", "payment_intent", "RecordPaymentCapture"],
  },
  "payment-chargeback-recovery-mechanism": {
    status: "settled",
    description:
      "Chargeback/dispute recovery runs through Settlement's automated Chargeback Clawback hold/recovery/" +
      "release mechanism, distinct from the operator-directed Wallet Adjustment path.",
    requiredEvidenceKeywords: ["Chargeback Clawback"],
  },
  "payout-release-hold-mechanism": {
    status: "settled",
    description:
      "Chase Sets models a Settlement-owned Payout Release Hold distinct from Stripe's own processor-level " + "holds.",
    requiredEvidenceKeywords: ["Payout Release Hold"],
  },
  "wallet-no-interest": {
    status: "unresolved",
    description:
      "Whether Chase Sets pays no interest on Wallet-balance funds is not yet supported by any ratified " +
      "product-truth source; it remains an explicit open question pending qualified counsel confirmation " +
      "before publication, not a productTruthRef-backed fact.",
    requiredEvidenceKeywords: [],
  },
  "wallet-deposit-and-fdic-posture": {
    status: "unresolved",
    description:
      "Whether Wallet balances are a non-deposit, FDIC-uninsured product is not yet supported by any ratified " +
      "product-truth source; it remains an explicit open question pending qualified counsel confirmation " +
      "before publication, not a productTruthRef-backed fact.",
    requiredEvidenceKeywords: [],
  },
} as const;
