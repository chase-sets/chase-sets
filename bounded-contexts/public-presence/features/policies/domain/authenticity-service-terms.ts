import type { PublicPolicyArtifact } from "./policy-artifact";

export const requiredAuthenticityServiceTermsSubjectIds = ["authenticity-service-terms-scope"] as const;

export type AuthenticityServiceTermsSubjectId = (typeof requiredAuthenticityServiceTermsSubjectIds)[number];

/**
 * Registry stub only: nothing here is operative or consent-activatable while
 * counsel review is pending. Deliberately not launch-required — this document
 * rides in the counsel review packet only and becomes launch-required when
 * the authenticity service ships an opt-in surface.
 */
export const authenticityServiceTermsPolicyArtifact: PublicPolicyArtifact<
  "authenticity-service-terms",
  AuthenticityServiceTermsSubjectId
> = {
  metadata: {
    policyKey: "authenticity-service-terms",
    version: "v1",
    locale: "en",
    href: "/authenticity-terms",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: false,
  },
  title: "Authenticity service terms",
  description:
    "This versioned artifact registers the Chase Sets authenticity service terms in the public policy corpus. Its subject taxonomy and operative language are not yet drafted, and nothing in it takes effect before qualified counsel approves the final language, launch scope, and external approval reference.",
  sections: [
    {
      id: "authenticity-service-terms-scope",
      title: "Authenticity service terms scope",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Reserve the scope of the operative Chase Sets authenticity service terms, covering the optional authentication service for eligible items. Counsel-approved language is required before any of it takes effect.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [
          "Subject taxonomy and draft language are owned by issue #5691 (authenticity service terms document slice, packet-only until the service ships).",
        ],
        assumptions: [],
      },
    },
  ],
};
