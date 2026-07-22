import {
  evaluatePublicPolicyPublicationReadiness,
  type PublicPolicyArtifact,
  type PublicPolicyPublicationReadiness,
} from "./policy-artifact";

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

export type TermsOfServicePolicyArtifact = PublicPolicyArtifact<"terms-of-service", TermsOfServiceSubjectId>;

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
    launchRequired: true,
  },
  title: "Terms of service",
  description:
    "This versioned artifact defines the subjects the operative Chase Sets terms must cover. It is not effective until qualified counsel approves the final language, launch scope, and external approval reference.",
  sections: [
    {
      id: "wallet-nature-custody-interest",
      title: "Wallet nature, custody, and interest",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State that the Wallet is a marketplace ledger rather than a bank deposit, and define the reviewed custody and interest posture.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [],
        assumptions: [],
      },
    },
    {
      id: "cash-equivalent-and-marketplace-credit",
      title: "Cash-equivalent balance and Marketplace Credit",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Distinguish cash-equivalent Wallet funds, which are spendable and payoutable under normal readiness rules, from any future non-withdrawable Marketplace Credit.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [],
        assumptions: [],
      },
    },
    {
      id: "adjustment-authority",
      title: "Wallet Adjustment authority",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Authorize evidence-backed credits and debits for transaction, refund, fee, dispute, fraud, support, legal, goodwill, and operational-error reasons.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [],
        assumptions: [],
      },
    },
    {
      id: "provisional-credits-and-reversals",
      title: "Provisional credits, corrections, and linked reversals",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe provisional credits, duplicate or error correction, immutable posted adjustments, and new linked opposite-direction reversals.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [],
        assumptions: [],
      },
    },
    {
      id: "setoff",
      title: "Setoff",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Define lawful setoff against available balance, future proceeds, refunds, or payouts, including required limits and notice.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [],
        assumptions: [],
      },
    },
    {
      id: "negative-balances-and-restrictions",
      title: "Negative balances and capability restrictions",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe negative-balance creation and recovery, how later funds offset an amount owed, and when marketplace or payout capabilities may be restricted.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [],
        assumptions: [],
      },
    },
    {
      id: "history-notice-and-disputes",
      title: "Itemized history, notice, and disputes",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Explain itemized Wallet history and notices, the support dispute method, response expectations, and review timing.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [],
        assumptions: [],
      },
    },
    {
      id: "suspension-closure-and-holds",
      title: "Suspension, closure, dormant balances, and legal holds",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Define the treatment of Wallet funds during account suspension or closure, dormancy, legal holds, and lawful release of remaining funds.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [],
        assumptions: [],
      },
    },
    {
      id: "effective-date-notice-and-acceptance",
      title: "Effective date, change notice, and acceptance",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Define the effective date, material-change notice, version acceptance, and any counsel-approved continued-use semantics.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [],
        assumptions: [],
      },
    },
    {
      id: "evidence-and-fair-use",
      title: "Evidence-backed and fair use",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Constrain Wallet Adjustments to fair, supportable uses and state that arbitrary forfeiture is not permitted.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [],
        assumptions: [],
      },
    },
  ],
};

export function evaluateTermsOfServicePublicationReadiness(
  artifact: TermsOfServicePolicyArtifact,
): PublicPolicyPublicationReadiness {
  return evaluatePublicPolicyPublicationReadiness(artifact, requiredTermsOfServiceSubjectIds);
}
