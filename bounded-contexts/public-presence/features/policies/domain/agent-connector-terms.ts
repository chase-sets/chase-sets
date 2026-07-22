import type { PublicPolicyArtifact } from "./policy-artifact";

export const requiredAgentConnectorTermsSubjectIds = ["agent-connector-terms-scope"] as const;

export type AgentConnectorTermsSubjectId = (typeof requiredAgentConnectorTermsSubjectIds)[number];

/**
 * Registry stub only: nothing here is operative or consent-activatable while
 * counsel review is pending.
 */
export const agentConnectorTermsPolicyArtifact: PublicPolicyArtifact<
  "agent-connector-terms",
  AgentConnectorTermsSubjectId
> = {
  metadata: {
    policyKey: "agent-connector-terms",
    version: "v1",
    locale: "en",
    href: "/agent-terms",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: true,
  },
  title: "Agent connector terms",
  description:
    "This versioned artifact registers the Chase Sets agent connector terms in the public policy corpus. Its subject taxonomy and operative language are not yet drafted, and nothing in it takes effect before qualified counsel approves the final language, launch scope, and external approval reference.",
  sections: [
    {
      id: "agent-connector-terms-scope",
      title: "Agent connector terms scope",
      draftText: "",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Reserve the scope of the operative Chase Sets agent connector terms, covering authorized machine access to the marketplace through the published connector surface. Counsel-approved language is required before any of it takes effect.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [
          "Subject taxonomy and draft language are owned by issue #5690 (agent connector terms document slice).",
        ],
        assumptions: [],
      },
    },
  ],
};
