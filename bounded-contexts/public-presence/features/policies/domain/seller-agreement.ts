import type { PublicPolicyArtifact } from "./policy-artifact";

export const requiredSellerAgreementSubjectIds = ["seller-agreement-scope"] as const;

export type SellerAgreementSubjectId = (typeof requiredSellerAgreementSubjectIds)[number];

/**
 * Registry stub only: nothing here is operative or consent-activatable while
 * counsel review is pending.
 */
export const sellerAgreementPolicyArtifact: PublicPolicyArtifact<"seller-agreement", SellerAgreementSubjectId> = {
  metadata: {
    policyKey: "seller-agreement",
    version: "v1",
    locale: "en",
    href: "/seller-agreement",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: true,
  },
  title: "Seller agreement",
  description:
    "This versioned artifact registers the Chase Sets seller agreement in the public policy corpus. Its subject taxonomy and operative language are not yet drafted, and nothing in it takes effect before qualified counsel approves the final language, launch scope, and external approval reference.",
  sections: [
    {
      id: "seller-agreement-scope",
      title: "Seller agreement scope",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Reserve the scope of the operative Chase Sets seller agreement, covering the obligations, capabilities, and standards that apply to accounts that sell on the marketplace. Counsel-approved language is required before any of it takes effect.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [
          "Subject taxonomy and draft language are owned by issue #5687 (seller agreement document slice).",
        ],
        assumptions: [],
      },
    },
  ],
};
