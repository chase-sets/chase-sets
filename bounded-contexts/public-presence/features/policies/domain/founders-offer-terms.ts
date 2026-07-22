import type { PublicPolicyArtifact } from "./policy-artifact";

export const requiredFoundersOfferTermsSubjectIds = ["founders-offer-terms-scope"] as const;

export type FoundersOfferTermsSubjectId = (typeof requiredFoundersOfferTermsSubjectIds)[number];

/**
 * Registry stub only: the existing /founders route and its copy stay
 * untouched until the founders document slice migrates that page onto this
 * artifact. Nothing here is operative or consent-activatable while counsel
 * review is pending.
 */
export const foundersOfferTermsPolicyArtifact: PublicPolicyArtifact<
  "founders-offer-terms",
  FoundersOfferTermsSubjectId
> = {
  metadata: {
    policyKey: "founders-offer-terms",
    version: "v1",
    locale: "en",
    href: "/founders",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: true,
  },
  title: "Founders offer terms",
  description:
    "This versioned artifact registers the Chase Sets founders offer terms in the public policy corpus. Its subject taxonomy and operative language are not yet drafted, and nothing in it takes effect before qualified counsel approves the final language, launch scope, and external approval reference.",
  sections: [
    {
      id: "founders-offer-terms-scope",
      title: "Founders offer terms scope",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Reserve the scope of the operative Chase Sets founders offer terms, covering the founders offer cap, window, and fee-lock commitments already described on the public founders page. Counsel-approved language is required before any of it takes effect.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [
          "Subject taxonomy and draft language are owned by issue #5692 (founders offer terms document slice, which migrates the existing /founders page).",
        ],
        assumptions: [],
      },
    },
  ],
};
