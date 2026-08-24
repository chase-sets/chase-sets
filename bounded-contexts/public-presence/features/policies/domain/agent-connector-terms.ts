import type { PublicPolicyArtifact } from "./policy-artifact";

export const requiredAgentConnectorTermsSubjectIds = [
  "scope-and-definitions",
  "account-attribution-and-principal-liability",
  "authentication-and-authorized-surfaces",
  "permitted-purposes-and-rate-limits",
  "market-data-use",
  "agent-transactions",
  "suspension-and-revocation",
  "disclaimers-and-liability",
  "changes-and-versioning",
] as const;

export type AgentConnectorTermsSubjectId = (typeof requiredAgentConnectorTermsSubjectIds)[number];

const agentResponsibilityClaimId = "authorized-agent-principal-responsibility-and-liability-boundary" as const;
const agentAccessAndAccountSanctionClaimId = "agent-access-and-agent-caused-account-sanction-boundary" as const;

/**
 * Original pre-counsel draft. Product behavior is limited to the cited current
 * sources; every legal allocation and restriction remains an explicit counsel
 * question, and the artifact cannot take effect while its counsel gate is shut.
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
    "These draft terms describe the current Chase Sets connector surfaces and collect the legal questions qualified counsel must resolve before the artifact can be approved, published, effective, or consent-activatable.",
  sections: [
    {
      id: "scope-and-definitions",
      title: "Scope and connector definitions",
      draftText:
        "These Agent Connector Terms address automated access through the documented Chase Sets connector surfaces. The native `/mcp` bridge is a separate first-party and operator automation surface where Chase Sets controls the agent host and binds requests to a platform session or operator principal. External agent commerce uses the distinct `/.well-known/ucp` discovery profile and `/ucp/mcp` transport. The Developer Portal documents and links these surfaces; it is not an executable connector and does not imply that every API, tool, or resource is available.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Define the connector surfaces without transferring native MCP authority to external UCP or treating documentation as executable behavior.",
        decisionRefs: [5696, 7223],
        productTruthRefs: [
          "docs/architecture/ucp-agent-commerce.md:5-21,59-63",
          "docs/api/agent-connectors.md:3-10",
          "infrastructure/platform-runtime/mcp-contracts.ts:100-117,137-147",
        ],
        openQuestions: [
          "How should qualified counsel define the parties, covered automation, and document precedence without implying that every API, tool, or resource is available?",
        ],
        assumptions: [
          {
            assertion:
              "The Developer Portal is a documentation and discovery route family, not an executable connector surface.",
            evidenceRef: "bounded-contexts/public-presence/GLOSSARY.md:27-38",
          },
        ],
        canonicalClaims: [],
      },
      claimDisclosures: [],
    },
    {
      id: "account-attribution-and-principal-liability",
      title: "Account attribution and principal questions",
      draftText:
        "Connector activity presented with an authorized credential is evaluated in, and attributable to, the authenticated actor and Account context resolved for that credential. Each call is checked against granted OAuth scopes and permissions, including an Account-scoped actor where the tool requires one. The authorization flow binds the grant to the Account selected by the human authorizing the connector.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State the shipped Account and permission attribution boundary while leaving the extent of principal responsibility and liability unresolved.",
        decisionRefs: [6817, 7223],
        productTruthRefs: [
          "infrastructure/platform-runtime/mcp-contracts.ts:156-190,239-261",
          "bounded-contexts/public-presence/features/developer-portal/domain/articles/agent-authentication.en.md:22-24,50-60,75-77",
          "bounded-contexts/identity/GLOSSARY.md:168-218",
        ],
        openQuestions: [
          "To what extent, if any, should an Account holder be responsible or liable for actions taken by an authorized agent? Qualified counsel must settle the allocation before publication.",
        ],
        assumptions: [],
        canonicalClaims: [{ claimId: agentResponsibilityClaimId, productTruthRefs: [] }],
      },
      claimDisclosures: [{ claimId: agentResponsibilityClaimId }],
    },
    {
      id: "authentication-and-authorized-surfaces",
      title: "Authentication and authorized surfaces",
      draftText:
        "Connector clients use only the documented authentication and authorization surfaces for the connector they call. External UCP clients discover OAuth endpoints from the well-known metadata, use Authorization Code with PKCE, and request the scopes needed for their workflow; the runtime refuses tool calls that exceed the granted permission boundary. Developer Portal documentation does not expand those authorized surfaces or the capabilities currently available.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe only documented authentication and authorization surfaces, without guaranteeing access beyond implemented scopes and capabilities.",
        decisionRefs: [7223],
        productTruthRefs: [
          "docs/api/agent-connectors.md:18",
          "bounded-contexts/public-presence/features/developer-portal/domain/articles/agent-authentication.en.md:24-60",
          "infrastructure/platform-runtime/mcp-contracts.ts:156-190",
        ],
        openQuestions: [
          "What credential-protection duties and consequences for attempting unauthorized access should qualified counsel state, and how should those terms avoid guaranteeing a broader surface than the implementation provides?",
        ],
        assumptions: [],
        canonicalClaims: [],
      },
      claimDisclosures: [],
    },
    {
      id: "permitted-purposes-and-rate-limits",
      title: "Permitted purposes and rate limits",
      draftText:
        "Connector requests are subject to the current per-surface Rate-Limit Policy and shipped agent guardrails. The policy can apply named-surface request-volume overrides, and the agent-grant guardrail can refuse writes that arrive too quickly. Numeric limits remain live policy and runtime values rather than fixed promises in these terms.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the current policy and rate-limit guardrail kinds without copying mutable numeric defaults or claiming universal technical prevention.",
        decisionRefs: [7223],
        productTruthRefs: [
          "bounded-contexts/platform-operations/features/rate-limit-policy/domain/rate-limit-policy.ts:5-22,143-171",
          "infrastructure/platform-runtime/agent-guardrails.ts:180-204",
        ],
        openQuestions: [
          "Which connector purposes should be permitted, and what restrictions and remedies should qualified counsel state for scraping, rate-limit bypass, or other attempts to evade documented access controls?",
          "No shipped source cited here proves a detector or universal prevention mechanism; should the final terms describe obligations without making that technical claim?",
        ],
        assumptions: [],
        canonicalClaims: [],
      },
      claimDisclosures: [],
    },
    {
      id: "market-data-use",
      title: "Connector and market data use",
      draftText:
        "Connector responses expose the catalog and marketplace data returned by tools advertised as available on the current surface. Public discovery tools provide documented read-only marketplace discovery, while the native MCP surface lists only callable capabilities. These product boundaries do not establish terms for downstream retention, redistribution, model training, competitive use, or other reuse.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Bound the current data proposition to returned documented tool data and leave downstream-use restrictions to counsel.",
        decisionRefs: [7223],
        productTruthRefs: [
          "infrastructure/platform-runtime/mcp-contracts.ts:100-117,137-147",
          "docs/architecture/ucp-agent-commerce.md:29-31,35-46,61-63",
          "bounded-contexts/public-presence/features/developer-portal/domain/articles/agent-authentication.en.md:58-73",
        ],
        openQuestions: [
          "What restrictions, if any, should qualified counsel place on retention, redistribution, model training, competitive use, or other downstream handling of connector and market data?",
          "No cited implementation proves technical prevention of those downstream uses; the final terms must not assert such prevention without new product-truth evidence.",
        ],
        assumptions: [],
        canonicalClaims: [],
      },
      claimDisclosures: [],
    },
    {
      id: "agent-transactions",
      title: "Agent-assisted transactions",
      draftText:
        "Agent-assisted transactions use the guardrails implemented for the invoked surface. Native tools can require an authenticated actor, permissions, Account scope, exact confirmation, and write idempotency; agent-grant spend checks can apply rail, human-presence, per-order, daily, and monthly boundaries from the resolved mandate. UCP checkout remains a trusted UI handoff unless mandate verification and provider-backed payment conditions are configured, and the shipped checkout and payment path applies only when those gates pass.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State the exact current confirmation, idempotency, mandate, spend, and handoff guardrails without promising end-to-end completion.",
        decisionRefs: [7223],
        productTruthRefs: [
          "docs/architecture/ucp-agent-commerce.md:17-21,48-75,83-89",
          "infrastructure/platform-runtime/mcp-contracts.ts:156-236",
          "infrastructure/platform-runtime/agent-guardrails.ts:207-318",
        ],
        openQuestions: [
          "What legal effect and attribution should an agent-assisted transaction have, and how should mistakes be allocated among the Account holder, agent provider, counterparties, and Chase Sets?",
          "How should qualified counsel describe transaction limitations without promising end-to-end, error-free, or universally headless completion beyond the executed runtime?",
        ],
        assumptions: [],
        canonicalClaims: [],
      },
      claimDisclosures: [],
    },
    {
      id: "suspension-and-revocation",
      title: "Authorization revocation and access questions",
      draftText:
        "The Account consent-management surface lists and revokes Linked Platform Authorizations, and a linked Account can revoke platform consent. Separately, current runtime guardrails refuse operations only when their shipped authorization, confirmation, rate-limit, mandate, or spend checks return a refusal. Those product behaviors do not establish a contractual ground, notice, process, consequence, or Account sanction based on agent conduct.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Separate shipped consent revocation and runtime refusal checks from the unresolved authority to suspend agent access or sanction an Account because of agent conduct.",
        decisionRefs: [6817, 7223],
        productTruthRefs: [
          "docs/architecture/ucp-agent-commerce.md:11-15,83-87",
          "infrastructure/platform-runtime/mcp-contracts.ts:156-236",
          "infrastructure/platform-runtime/agent-guardrails.ts:180-318",
        ],
        openQuestions: [
          "On what grounds, through what process and notice, and with what consequences may agent access be suspended or revoked, and may the underlying Account separately be restricted, suspended, or closed because of agent conduct? Qualified counsel must settle that boundary.",
        ],
        assumptions: [],
        canonicalClaims: [{ claimId: agentAccessAndAccountSanctionClaimId, productTruthRefs: [] }],
      },
      claimDisclosures: [{ claimId: agentAccessAndAccountSanctionClaimId }],
    },
    {
      id: "disclaimers-and-liability",
      title: "Disclaimers and liability questions",
      draftText:
        "The connector surfaces are components of the bounded Chase Sets services described by the applicable public policies and Developer Portal documentation. Any warranties, disclaimers, exclusions, remedy limits, or liability cap for connector use require qualified counsel review; this draft states no numeric cap and does not label a legal allocation as current product behavior.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Cross-reference the bounded service while leaving every warranty, disclaimer, exclusion, remedy, and liability allocation to qualified counsel.",
        decisionRefs: [5696, 7223],
        productTruthRefs: [
          "docs/architecture/ucp-agent-commerce.md:1-15",
          "bounded-contexts/public-presence/GLOSSARY.md:27-38,40-55",
        ],
        openQuestions: [
          "What warranties, disclaimers, exclusions, remedy limits, and liability cap are enforceable for connector use, and how should they interact with the other applicable public policies?",
        ],
        assumptions: [],
        canonicalClaims: [],
      },
      claimDisclosures: [],
    },
    {
      id: "changes-and-versioning",
      title: "Changes and versioning",
      draftText:
        "This artifact is version `v1` and remains `counsel-review-required`, with no effective date or counsel approval reference. The canonical policy machinery therefore keeps it non-activatable. Any notice, acceptance, transition, survival, or re-acceptance rule for a later version requires qualified counsel review and is not claimed as current wiring.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Record the current v1 counsel-gated artifact state without inventing notice, acceptance, or re-acceptance wiring.",
        decisionRefs: [5696, 7223],
        productTruthRefs: [
          "bounded-contexts/public-presence/features/policies/domain/agent-connector-terms.ts:30-40",
          "bounded-contexts/public-presence/features/policies/domain/policy-artifact.ts:369-429",
        ],
        openQuestions: [
          "What notice, acceptance, transition, survival, and re-acceptance terms should apply to later versions, and what product wiring would be required before those terms could describe current behavior?",
        ],
        assumptions: [],
        canonicalClaims: [],
      },
      claimDisclosures: [],
    },
  ],
};
