export type PublicHelpArticlePolicyCitation = Readonly<{
  slug: string;
  locale: string;
  title: string;
  href: string;
  citedPolicies: readonly string[];
}>;

export type PublicTermsOfServicePublicationMetadata = Readonly<{
  policyKey: "terms-of-service";
  version: `v${number}`;
  locale: string;
  href: "/terms";
  publicationStatus: "counsel-review-required" | "published";
  effectiveAt: string | null;
  counselApprovalReference: string | null;
  rolloutJurisdictionsOrProductLimits: readonly string[];
}>;

export { publicHelpArticlePolicyCitations } from "./generated/help-article-policy-citations";
export { publicTermsOfServicePublicationMetadata } from "./generated/terms-of-service-publication";
