/**
 * The closed public policy corpus vocabulary. Public Presence owns
 * publication; every launch legal document is registered here with a literal
 * key and a literal canonical route, so consumers discriminate on
 * `policyKey` instead of matching strings. This module is deliberately free
 * of generated imports so the corpus compiler can load it directly.
 */
export const publicPolicyKeys = [
  "terms-of-service",
  "privacy-policy",
  "seller-agreement",
  "payments-terms",
  "agent-connector-terms",
  "authenticity-service-terms",
  "founders-offer-terms",
] as const;

export type PublicPolicyKey = (typeof publicPolicyKeys)[number];

export const publicPolicyHrefsByKey = {
  "terms-of-service": "/terms",
  "privacy-policy": "/privacy",
  "seller-agreement": "/seller-agreement",
  "payments-terms": "/payments-terms",
  "agent-connector-terms": "/agent-terms",
  "authenticity-service-terms": "/authenticity-terms",
  "founders-offer-terms": "/founders",
} as const satisfies Record<PublicPolicyKey, `/${string}`>;

export type PublicPolicyHref = (typeof publicPolicyHrefsByKey)[PublicPolicyKey];

export const publicPolicyPublicationStatuses = ["counsel-review-required", "published"] as const;

export type PublicPolicyPublicationStatus = (typeof publicPolicyPublicationStatuses)[number];

export type PublicPolicyVersion = `v${number}`;

/**
 * Generated per-document publication record. Distributes over the policy
 * keys so each member carries its literal key and canonical href — a
 * discriminated union, never a stringly-typed record. `consentActivatable`
 * encodes the publication-to-activation invariant: it is compiled true only
 * for a published, readiness-valid artifact, so consent surfaces can never
 * gate on a placeholder stub.
 */
export type PublicPolicyPublicationRecord<Key extends PublicPolicyKey = PublicPolicyKey> = Key extends PublicPolicyKey
  ? Readonly<{
      policyKey: Key;
      version: PublicPolicyVersion;
      locale: string;
      href: (typeof publicPolicyHrefsByKey)[Key];
      publicationStatus: PublicPolicyPublicationStatus;
      effectiveAt: string | null;
      counselApprovalReference: string | null;
      rolloutJurisdictionsOrProductLimits: readonly string[];
      launchRequired: boolean;
      consentActivatable: boolean;
    }>
  : never;

/**
 * Frozen pre-corpus shape of the Terms of Service metadata export. Identity's
 * consent policy consumes the named export of this shape; it must keep
 * compiling with the exact historical field set.
 */
export type PublicTermsOfServicePublicationMetadata = Readonly<
  Omit<PublicPolicyPublicationRecord<"terms-of-service">, "launchRequired" | "consentActivatable">
>;
