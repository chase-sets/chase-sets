import { agentConnectorTermsPolicyArtifact, requiredAgentConnectorTermsSubjectIds } from "./agent-connector-terms";
import {
  authenticityServiceTermsPolicyArtifact,
  requiredAuthenticityServiceTermsSubjectIds,
} from "./authenticity-service-terms";
import { foundersOfferTermsPolicyArtifact, requiredFoundersOfferTermsSubjectIds } from "./founders-offer-terms";
import { paymentsTermsPolicyArtifact, requiredPaymentsTermsSubjectIds } from "./payments-terms";
import type { PublicPolicyArtifact } from "./policy-artifact";
import { privacyPolicyArtifact, requiredPrivacyPolicySubjectIds } from "./privacy-policy";
import { requiredSellerAgreementSubjectIds, sellerAgreementPolicyArtifact } from "./seller-agreement";
import { requiredTermsOfServiceSubjectIds, termsOfServicePolicyArtifact } from "./terms-of-service";

export type PublicPolicyRegistryEntry = Readonly<{
  artifact: PublicPolicyArtifact;
  requiredSubjectIds: readonly string[];
}>;

/**
 * The one enumeration of every Public Policy Artifact in the launch legal
 * corpus. The corpus compiler, the counsel review packet, and the corpus
 * routes all iterate this registry — never a filename convention — so adding
 * a document is a reviewed registry change and content edits to one document
 * cannot affect any sibling's generated module.
 */
export const publicPolicyRegistry: readonly PublicPolicyRegistryEntry[] = [
  { artifact: termsOfServicePolicyArtifact, requiredSubjectIds: requiredTermsOfServiceSubjectIds },
  { artifact: privacyPolicyArtifact, requiredSubjectIds: requiredPrivacyPolicySubjectIds },
  { artifact: sellerAgreementPolicyArtifact, requiredSubjectIds: requiredSellerAgreementSubjectIds },
  { artifact: paymentsTermsPolicyArtifact, requiredSubjectIds: requiredPaymentsTermsSubjectIds },
  { artifact: agentConnectorTermsPolicyArtifact, requiredSubjectIds: requiredAgentConnectorTermsSubjectIds },
  { artifact: authenticityServiceTermsPolicyArtifact, requiredSubjectIds: requiredAuthenticityServiceTermsSubjectIds },
  { artifact: foundersOfferTermsPolicyArtifact, requiredSubjectIds: requiredFoundersOfferTermsSubjectIds },
];
