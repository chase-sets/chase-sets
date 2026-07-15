export const termsOfServicePublicationStatuses = ["counsel-review-required", "published"] as const;
export type TermsOfServicePublicationStatus = (typeof termsOfServicePublicationStatuses)[number];

export const termsOfServiceSectionReviewStatuses = ["counsel-required", "counsel-approved"] as const;
export type TermsOfServiceSectionReviewStatus = (typeof termsOfServiceSectionReviewStatuses)[number];

export const requiredTermsOfServiceSubjectIds = [
  "wallet-nature-custody-interest",
  "cash-equivalent-and-marketplace-credit",
  "adjustment-authority",
  "provisional-credits-and-reversals",
  "setoff",
  "negative-balances-and-restrictions",
  "history-notice-and-disputes",
  "suspension-closure-and-holds",
  "effective-date-notice-and-acceptance",
  "evidence-and-fair-use",
] as const;

export type TermsOfServiceSubjectId = (typeof requiredTermsOfServiceSubjectIds)[number];

export type TermsOfServicePublicationMetadata = Readonly<{
  policyKey: "terms-of-service";
  version: `v${number}`;
  locale: string;
  href: "/terms";
  publicationStatus: TermsOfServicePublicationStatus;
  effectiveAt: string | null;
  counselApprovalReference: string | null;
  rolloutJurisdictionsOrProductLimits: readonly string[];
}>;

export type TermsOfServiceSection = Readonly<{
  id: TermsOfServiceSubjectId;
  title: string;
  reviewStatus: TermsOfServiceSectionReviewStatus;
  placeholderScope: string;
}>;

export type TermsOfServicePolicyArtifact = Readonly<{
  metadata: TermsOfServicePublicationMetadata;
  title: string;
  description: string;
  sections: readonly TermsOfServiceSection[];
}>;

export const termsOfServicePolicyArtifact: TermsOfServicePolicyArtifact = {
  metadata: {
    policyKey: "terms-of-service",
    version: "v1",
    locale: "en",
    href: "/terms",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
  },
  title: "Terms of service",
  description:
    "This versioned artifact defines the subjects the operative Chase Sets terms must cover. It is not effective until qualified counsel approves the final language, launch scope, and external approval reference.",
  sections: [
    {
      id: "wallet-nature-custody-interest",
      title: "Wallet nature, custody, and interest",
      reviewStatus: "counsel-required",
      placeholderScope:
        "State that the Wallet is a marketplace ledger rather than a bank deposit, and define the reviewed custody and interest posture.",
    },
    {
      id: "cash-equivalent-and-marketplace-credit",
      title: "Cash-equivalent balance and Marketplace Credit",
      reviewStatus: "counsel-required",
      placeholderScope:
        "Distinguish cash-equivalent Wallet funds, which are spendable and payoutable under normal readiness rules, from any future non-withdrawable Marketplace Credit.",
    },
    {
      id: "adjustment-authority",
      title: "Wallet Adjustment authority",
      reviewStatus: "counsel-required",
      placeholderScope:
        "Authorize evidence-backed credits and debits for transaction, refund, fee, dispute, fraud, support, legal, goodwill, and operational-error reasons.",
    },
    {
      id: "provisional-credits-and-reversals",
      title: "Provisional credits, corrections, and linked reversals",
      reviewStatus: "counsel-required",
      placeholderScope:
        "Describe provisional credits, duplicate or error correction, immutable posted adjustments, and new linked opposite-direction reversals.",
    },
    {
      id: "setoff",
      title: "Setoff",
      reviewStatus: "counsel-required",
      placeholderScope:
        "Define lawful setoff against available balance, future proceeds, refunds, or payouts, including required limits and notice.",
    },
    {
      id: "negative-balances-and-restrictions",
      title: "Negative balances and capability restrictions",
      reviewStatus: "counsel-required",
      placeholderScope:
        "Describe negative-balance creation and recovery, how later funds offset an amount owed, and when marketplace or payout capabilities may be restricted.",
    },
    {
      id: "history-notice-and-disputes",
      title: "Itemized history, notice, and disputes",
      reviewStatus: "counsel-required",
      placeholderScope:
        "Explain itemized Wallet history and notices, the support dispute method, response expectations, and review timing.",
    },
    {
      id: "suspension-closure-and-holds",
      title: "Suspension, closure, dormant balances, and legal holds",
      reviewStatus: "counsel-required",
      placeholderScope:
        "Define the treatment of Wallet funds during account suspension or closure, dormancy, legal holds, and lawful release of remaining funds.",
    },
    {
      id: "effective-date-notice-and-acceptance",
      title: "Effective date, change notice, and acceptance",
      reviewStatus: "counsel-required",
      placeholderScope:
        "Define the effective date, material-change notice, version acceptance, and any counsel-approved continued-use semantics.",
    },
    {
      id: "evidence-and-fair-use",
      title: "Evidence-backed and fair use",
      reviewStatus: "counsel-required",
      placeholderScope:
        "Constrain Wallet Adjustments to fair, supportable uses and state that arbitrary forfeiture is not permitted.",
    },
  ],
};

export type TermsOfServicePublicationReadiness = Readonly<{
  ready: boolean;
  errors: readonly string[];
}>;

export function evaluateTermsOfServicePublicationReadiness(
  artifact: TermsOfServicePolicyArtifact,
): TermsOfServicePublicationReadiness {
  const errors: string[] = [];
  const { metadata } = artifact;

  if (metadata.publicationStatus !== "published") {
    errors.push("Terms of Service publication status must be published.");
  }
  if (!isIsoTimestamp(metadata.effectiveAt)) {
    errors.push("Terms of Service publication requires an effective ISO timestamp.");
  }
  if (!isApprovalReference(metadata.counselApprovalReference)) {
    errors.push("Terms of Service publication requires a non-placeholder counsel approval reference.");
  }
  if (metadata.rolloutJurisdictionsOrProductLimits.length === 0) {
    errors.push("Terms of Service publication requires at least one reviewed rollout jurisdiction or product limit.");
  }

  const sectionsById = new Map(artifact.sections.map((section) => [section.id, section]));
  for (const subjectId of requiredTermsOfServiceSubjectIds) {
    const section = sectionsById.get(subjectId);
    if (!section) {
      errors.push(`Terms of Service publication is missing required subject '${subjectId}'.`);
    } else if (section.reviewStatus !== "counsel-approved") {
      errors.push(`Terms of Service subject '${subjectId}' requires counsel-approved copy.`);
    }
  }

  return { ready: errors.length === 0, errors };
}

function isIsoTimestamp(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  return !Number.isNaN(new Date(value).valueOf());
}

function isApprovalReference(value: string | null): value is string {
  return value !== null && value.trim().length >= 12 && !/placeholder|pending|tbd/i.test(value);
}
