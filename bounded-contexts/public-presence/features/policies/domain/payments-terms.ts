import type { PublicPolicyArtifact } from "./policy-artifact";

export const requiredPaymentsTermsSubjectIds = ["payments-terms-scope"] as const;

export type PaymentsTermsSubjectId = (typeof requiredPaymentsTermsSubjectIds)[number];

/**
 * Registry stub only: nothing here is operative or consent-activatable while
 * counsel review is pending.
 */
export const paymentsTermsPolicyArtifact: PublicPolicyArtifact<"payments-terms", PaymentsTermsSubjectId> = {
  metadata: {
    policyKey: "payments-terms",
    version: "v1",
    locale: "en",
    href: "/payments-terms",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: true,
  },
  title: "Payments terms",
  description:
    "This versioned artifact registers the Chase Sets payments terms in the public policy corpus. Its subject taxonomy and operative language are not yet drafted, and nothing in it takes effect before qualified counsel approves the final language, launch scope, and external approval reference.",
  sections: [
    {
      id: "payments-terms-scope",
      title: "Payments terms scope",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Reserve the scope of the operative Chase Sets payments terms, covering payment processing, payouts, and the marketplace's payment-provider relationship. Counsel-approved language is required before any of it takes effect.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [
          "Subject taxonomy and draft language are owned by issue #5688 (payments terms document slice).",
        ],
        assumptions: [],
      },
    },
  ],
};
