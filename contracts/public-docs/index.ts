export type PublicHelpArticlePolicyCitation = Readonly<{
  slug: string;
  locale: string;
  title: string;
  href: string;
  citedPolicies: readonly string[];
}>;

export {
  publicPolicyHrefsByKey,
  publicPolicyKeys,
  publicPolicyPublicationStatuses,
  type PublicPolicyHref,
  type PublicPolicyKey,
  type PublicPolicyPublicationRecord,
  type PublicPolicyPublicationStatus,
  type PublicPolicyVersion,
  type PublicTermsOfServicePublicationMetadata,
} from "./policy-corpus";

export { publicHelpArticlePolicyCitations } from "./generated/help-article-policy-citations";
export { publicPolicyPublicationRecords } from "./generated/index";
export { publicTermsOfServicePublicationMetadata } from "./generated/terms-of-service-publication";
