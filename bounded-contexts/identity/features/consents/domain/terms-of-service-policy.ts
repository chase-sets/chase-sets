import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { publicPolicyPublicationRecords, publicTermsOfServicePublicationMetadata } from "@chase-sets/public-docs";
import { IdentityDomainError } from "../../../support/runtime-support/common";
import { TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN } from "./terms-of-service";

/**
 * The active-required-version registry for the canonical Terms of Service
 * consent key, built on the shared platform-policy machinery (see
 * `infrastructure/platform-policy`). Identity is the acceptance owner and is
 * the only consumer that needs to resolve this value directly; Settlement
 * reads it only through the `TermsAcceptanceResolver` host port (see
 * `../read-model/terms-acceptance.ts` and
 * `bounded-contexts/settlement/features/wallets/api/balance-credit-resolver.ts`)
 * so no context queries another context's storage directly.
 *
 * Public Presence remains the publication owner of the actual terms text;
 * this policy only carries the version token an operator activates once a
 * counsel-approved artifact is published. Until then, `defaultValue` below
 * is a pre-publication placeholder -- it lets the acceptance gate and the
 * consent-versioning machinery be exercised end-to-end without asserting
 * that any real terms have gone live. Revising this policy (creating an
 * "active" platform-policy document with a later `effectiveFrom`) is what
 * actually activates a newly published version; the generic policy console
 * admin surface both contexts already share covers that operator action, so
 * no bespoke admin route is required here.
 */
export type TermsOfServicePolicyValue = Readonly<{
  /** The currently-required consent version. Must match `TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN`. */
  version: string;
}>;

export const IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE: TermsOfServicePolicyValue = {
  version: publicTermsOfServicePublicationMetadata.version,
};

export function decodeTermsOfServicePolicyValue(raw: JsonValue): TermsOfServicePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new IdentityDomainError("Terms of Service policy value must be an object.");
  }

  const record = raw as Record<string, unknown>;
  const version = typeof record.version === "string" ? record.version.trim() : "";
  if (!TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN.test(version)) {
    throw new IdentityDomainError(
      `Terms of Service policy version must match ${TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN}.`,
    );
  }

  return { version };
}

export const identityTermsOfServicePolicy: PolicyDefinition<TermsOfServicePolicyValue> = definePolicy({
  policyKey: "identity.terms-of-service-active-version",
  contextName: "identity",
  schemaSummary: "{ version: string matching /^v[1-9][0-9]*$/ }",
  defaultValue: IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE,
  decodeValue: decodeTermsOfServicePolicyValue,
});

/**
 * The consent-capable policy keys Identity owns, one per document a Consent
 * Bundle may declare as a member. Every one carries the same active-version
 * value shape, so the generalization is a registry of the same `definePolicy`
 * declaration rather than a new mechanism.
 *
 * The Terms of Service key is `identity.terms-of-service-active-version`,
 * unchanged and reusing the exact definition above -- generalizing the registry
 * must not re-key the one document that already has recorded Consent history.
 *
 * As with Terms of Service, each `defaultValue` here is a PRE-PUBLICATION
 * PLACEHOLDER taken from the compiled publication record. It exists so the
 * versioning machinery is exercisable end-to-end; it asserts nothing about any
 * document having gone live. What actually makes a version required is the
 * publication-to-activation invariant in `./consent-bundle.ts`: the compiled
 * artifact must be consent-activatable AND its Consent Activation Authority
 * must report it active. A placeholder alone never produces a requirement.
 */
export const IDENTITY_CONSENT_POLICY_KEYS = [
  "terms-of-service",
  "privacy-policy",
  "seller-agreement",
  "payments-terms",
] as const;

export type IdentityConsentPolicyKey = (typeof IDENTITY_CONSENT_POLICY_KEYS)[number];

function defineConsentActiveVersionPolicy(
  policyKey: IdentityConsentPolicyKey,
): PolicyDefinition<TermsOfServicePolicyValue> {
  return definePolicy({
    policyKey: `identity.${policyKey}-active-version`,
    contextName: "identity",
    schemaSummary: "{ version: string matching /^v[1-9][0-9]*$/ }",
    defaultValue: { version: publicPolicyPublicationRecords[policyKey].version },
    decodeValue: decodeTermsOfServicePolicyValue,
  });
}

export const identityConsentActiveVersionPolicies = {
  "terms-of-service": identityTermsOfServicePolicy,
  "privacy-policy": defineConsentActiveVersionPolicy("privacy-policy"),
  "seller-agreement": defineConsentActiveVersionPolicy("seller-agreement"),
  "payments-terms": defineConsentActiveVersionPolicy("payments-terms"),
} as const satisfies Readonly<Record<IdentityConsentPolicyKey, PolicyDefinition<TermsOfServicePolicyValue>>>;

export function isIdentityConsentPolicyKey(value: string): value is IdentityConsentPolicyKey {
  return Object.prototype.hasOwnProperty.call(identityConsentActiveVersionPolicies, value);
}
