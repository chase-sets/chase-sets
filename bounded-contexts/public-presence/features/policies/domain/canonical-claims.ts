export type CanonicalClaimStatus = "settled" | "unresolved";

/**
 * The closed set of shared sensitive money/custody/processor and
 * authorized-agent-boundary claims that more than one Public Policy Artifact,
 * or more than one section of the same artifact, may need to reference. A
 * claim earns an id here when the same governed proposition surfaces in more
 * than one place and must carry one status everywhere. Adding an id here is
 * the one place a claim's settled/unresolved status is decided; no artifact
 * section may assert a different status for the same id.
 */
export const canonicalClaimIds = [
  "payment-charge-timing-and-capture",
  "payment-chargeback-recovery-mechanism",
  "payout-release-hold-mechanism",
  "wallet-no-interest",
  "wallet-deposit-and-fdic-posture",
  "authorized-agent-principal-responsibility-and-liability-boundary",
  "agent-access-and-agent-caused-account-sanction-boundary",
] as const;

export type CanonicalClaimId = (typeof canonicalClaimIds)[number];

export type CanonicalClaimDefinition = Readonly<{
  status: CanonicalClaimStatus;
  description: string;
  /**
   * The one provenance identity for this shared claim. Every artifact section
   * that references the claim must cite this exact ordered set, so a sibling
   * document cannot silently substitute adjacent but weaker evidence for the
   * same material claim. Unresolved claims always own an empty set.
   */
  productTruthRefs: readonly string[];
  /**
   * Only enforced when status is "settled": a section citing this claim must
   * cite at least one product-truth evidence reference whose exact cited
   * source lines contain one of these keywords (case-insensitive), so a
   * citation pointing at unrelated code fails
   * structurally instead of only on human review.
   */
  requiredEvidenceKeywords: readonly string[];
  /**
   * Required when status is "unresolved": the single canonical, generated
   * public disclosure sentence a section renders through a structural
   * `claimDisclosures` entry instead of hand-authored free-form prose. The
   * same registry entry that marks a claim unresolved also controls what the
   * public page says about it, so a section can never render the claim as
   * settled fact while a disclosure segment is in play.
   */
  unresolvedPublicDisclosure?: string;
  /**
   * Narrow, per-claim defense in depth: case-insensitive substrings that
   * would assert this claim as settled fact. Forbidden anywhere in any
   * section's public draft text corpus-wide while the claim remains
   * unresolved, independent of whether that section declares the claim in
   * its own `canonicalClaims` manifest.
   */
  forbiddenAssertionPhrases?: readonly string[];
}>;

export const canonicalClaimRegistry: Readonly<Record<CanonicalClaimId, CanonicalClaimDefinition>> = {
  "payment-charge-timing-and-capture": {
    status: "settled",
    description:
      "Stripe charges/captures the buyer's selected payment method as part of completing a Marketplace " +
      "purchase, following Chase Sets' standard payment-session-create/confirm and capture path.",
    productTruthRefs: [
      "bounded-contexts/payments/features/payments/api/runtime.ts:1890-1943",
      "infrastructure/stripe-payments/index.ts:1464-1512",
    ],
    requiredEvidenceKeywords: ["createPaymentSession", "payment_intent", "RecordPaymentCapture"],
  },
  "payment-chargeback-recovery-mechanism": {
    status: "settled",
    description:
      "Chargeback/dispute recovery runs through Settlement's automated Chargeback Clawback hold/recovery/" +
      "release mechanism, distinct from the operator-directed Wallet Adjustment path.",
    productTruthRefs: ["bounded-contexts/settlement/GLOSSARY.md:127-135"],
    requiredEvidenceKeywords: ["Chargeback Clawback"],
  },
  "payout-release-hold-mechanism": {
    status: "settled",
    description:
      "Chase Sets models a Settlement-owned Payout Release Hold distinct from Stripe's own processor-level " + "holds.",
    productTruthRefs: ["bounded-contexts/settlement/GLOSSARY.md:117-125"],
    requiredEvidenceKeywords: ["Payout Release Hold"],
  },
  "wallet-no-interest": {
    status: "unresolved",
    description:
      "Whether Chase Sets pays no interest on Wallet-balance funds is not yet supported by any ratified " +
      "product-truth source; it remains an explicit open question pending qualified counsel confirmation " +
      "before publication, not a productTruthRef-backed fact.",
    productTruthRefs: [],
    requiredEvidenceKeywords: [],
    unresolvedPublicDisclosure:
      "Whether Chase Sets pays interest on Wallet balances is not yet resolved and is not addressed by this " +
      "document pending qualified counsel review.",
    forbiddenAssertionPhrases: [
      "do not earn interest",
      "does not earn interest",
      "will not earn interest",
      "no interest is paid",
    ],
  },
  "wallet-deposit-and-fdic-posture": {
    status: "unresolved",
    description:
      "Whether Wallet balances are a non-deposit, FDIC-uninsured product is not yet supported by any ratified " +
      "product-truth source; it remains an explicit open question pending qualified counsel confirmation " +
      "before publication, not a productTruthRef-backed fact.",
    productTruthRefs: [],
    requiredEvidenceKeywords: [],
    unresolvedPublicDisclosure:
      "Whether Wallet balances are treated as a bank deposit or are covered by FDIC or other deposit " +
      "insurance is not yet resolved and is not addressed by this document pending qualified counsel review.",
    forbiddenAssertionPhrases: ["insured by the fdic", "fdic insur", "not a deposit", "non-deposit", "deposit insurer"],
  },
  "authorized-agent-principal-responsibility-and-liability-boundary": {
    status: "unresolved",
    description:
      "Whether, and how far, an account holder is responsible or liable for actions an authorized software agent " +
      "takes on the Account is not yet supported by any ratified product-truth source; it remains an explicit " +
      "open question pending qualified counsel confirmation before publication, not a productTruthRef-backed fact.",
    productTruthRefs: [],
    requiredEvidenceKeywords: [],
    unresolvedPublicDisclosure:
      "The extent to which an account holder is responsible or liable for actions taken by an authorized agent " +
      "remains unresolved pending qualified counsel review.",
    forbiddenAssertionPhrases: [
      "you are fully responsible for",
      "you are solely responsible for",
      "is liable for all",
      "assumes all liability",
      "accepts full liability",
    ],
  },
  "agent-access-and-agent-caused-account-sanction-boundary": {
    status: "unresolved",
    description:
      "Whether, on what grounds, and with what process and consequences Chase Sets may suspend or revoke an " +
      "authorized software agent's access, and may separately suspend, restrict, close or otherwise sanction the " +
      "underlying Account because of that agent's conduct is not yet supported by any ratified product-truth " +
      "source; it remains an explicit open question pending qualified counsel confirmation before publication, " +
      "not a productTruthRef-backed fact.",
    productTruthRefs: [],
    requiredEvidenceKeywords: [],
    unresolvedPublicDisclosure:
      "The grounds, process, and consequences for suspending or revoking agent access, and for suspending, " +
      "restricting, or closing an Account because of agent conduct, remain unresolved pending qualified counsel " +
      "review.",
    forbiddenAssertionPhrases: [
      "may suspend or revoke at any time",
      "at chase sets' sole discretion",
      "without notice or liability",
      "immediately terminate agent access",
      "reserves the right to revoke",
    ],
  },
} as const;

export const paymentChargeTimingAndCaptureProductTruthRefs =
  canonicalClaimRegistry["payment-charge-timing-and-capture"].productTruthRefs;
export const paymentChargebackRecoveryProductTruthRefs =
  canonicalClaimRegistry["payment-chargeback-recovery-mechanism"].productTruthRefs;
export const payoutReleaseHoldProductTruthRefs =
  canonicalClaimRegistry["payout-release-hold-mechanism"].productTruthRefs;

/**
 * The single source of an unresolved claim's public disclosure text. A
 * section's `claimDisclosures` entries render through this resolver instead
 * of hand-typed prose, so the same registry entry that marks a claim
 * unresolved is the only place that can produce what the public page says
 * about it.
 */
export function resolveUnresolvedPublicDisclosureText(claimId: CanonicalClaimId): string {
  const definition = canonicalClaimRegistry[claimId];
  if (definition.status !== "unresolved" || !definition.unresolvedPublicDisclosure) {
    throw new Error(`Canonical claim '${claimId}' has no unresolved public disclosure text to render.`);
  }
  return definition.unresolvedPublicDisclosure;
}
