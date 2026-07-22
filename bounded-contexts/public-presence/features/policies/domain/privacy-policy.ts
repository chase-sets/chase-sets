import type { PublicPolicyArtifact } from "./policy-artifact";

export const requiredPrivacyPolicySubjectIds = ["privacy-notice-scope"] as const;

export type PrivacyPolicySubjectId = (typeof requiredPrivacyPolicySubjectIds)[number];

/**
 * Registry stub only: the existing /privacy placeholder page stays untouched
 * until the privacy document slice flips it to this artifact. Nothing here is
 * operative or consent-activatable while counsel review is pending.
 */
export const privacyPolicyArtifact: PublicPolicyArtifact<"privacy-policy", PrivacyPolicySubjectId> = {
  metadata: {
    policyKey: "privacy-policy",
    version: "v1",
    locale: "en",
    href: "/privacy",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: true,
  },
  title: "Privacy policy",
  description:
    "This versioned artifact registers the Chase Sets privacy policy in the public policy corpus. Its subject taxonomy and operative language are not yet drafted, and nothing in it takes effect before qualified counsel approves the final language, launch scope, and external approval reference.",
  sections: [
    {
      id: "privacy-notice-scope",
      title: "Privacy notice scope",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Reserve the scope of the operative Chase Sets privacy notice, covering the personal data the marketplace collects, uses, shares, and retains. Counsel-approved language is required before any of it takes effect.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [
          "Subject taxonomy and draft language are owned by issue #5689 (privacy policy document slice).",
        ],
        assumptions: [],
      },
    },
  ],
};
