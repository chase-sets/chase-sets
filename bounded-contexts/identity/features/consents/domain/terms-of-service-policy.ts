import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  publicPolicyPublicationRecords,
  publicTermsOfServicePublicationMetadata,
  type PublicPolicyKey,
} from "@chase-sets/public-docs";
import { IdentityDomainError } from "../../../support/runtime-support/common";
import { TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN } from "./terms-of-service";

/**
 * The active-required-version registry for the consent policy keys Identity
 * can carry Consents for, built on the shared platform-policy machinery (see
 * `infrastructure/platform-policy`). Identity is the acceptance owner and is
 * the only consumer that needs to resolve these values directly; Settlement
 * reads Terms acceptance only through the `TermsAcceptanceResolver` host port
 * (see `../read-model/terms-acceptance.ts` and
 * `bounded-contexts/settlement/features/wallets/api/balance-credit-resolver.ts`)
 * so no context queries another context's storage directly.
 *
 * Public Presence remains the publication owner of the actual document text;
 * these policies only carry the version token an operator activates once a
 * counsel-approved artifact is published. Until then, each `defaultValue`
 * below is a pre-publication placeholder -- it lets the consent-versioning
 * machinery be exercised end-to-end without asserting that any real document
 * has gone live.
 *
 * A PLACEHOLDER DEFAULT IS NOT AN ACTIVE VERSION. Nothing in requirement
 * derivation reads `defaultValue`, and nothing reads the cached document
 * projection: whether a key is activated, and at which version, comes only
 * from that key's Consent Activation Authority (see `./consent-bundle.ts`).
 * Declaring a key here therefore widens the set of *allowed* consent policies
 * and never activates one.
 */
export type ConsentPolicyVersionValue = Readonly<{
  /** The currently-required consent version. Must match `TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN`. */
  version: string;
}>;

/** Frozen alias: the Terms of Service policy value shape predates the generalized registry. */
export type TermsOfServicePolicyValue = ConsentPolicyVersionValue;

/**
 * The closed set of consent policy keys Identity recognizes. Each is a
 * published Public Presence policy key -- the `satisfies` below is the
 * compile-time proof, so a key that Public Presence does not publish cannot be
 * declared consent-capable here.
 *
 * This is the *allowed member* vocabulary. Membership of a Consent Bundle and
 * derivation of a requirement are separate contracts; see `./consent-bundle.ts`.
 */
export const IDENTITY_CONSENT_POLICY_KEYS = [
  "terms-of-service",
  "privacy-policy",
  "seller-agreement",
  "payments-terms",
] as const satisfies readonly PublicPolicyKey[];

export type IdentityConsentPolicyKey = (typeof IDENTITY_CONSENT_POLICY_KEYS)[number];

export function isIdentityConsentPolicyKey(policyKey: string): policyKey is IdentityConsentPolicyKey {
  return (IDENTITY_CONSENT_POLICY_KEYS as readonly string[]).includes(policyKey);
}

/**
 * Closed-shape decode for a consent active-version policy value. Key presence
 * is not value validity: a non-object, an array, an unknown member, or a
 * version token that does not match the canonical pattern all reject rather
 * than being coerced into a usable value.
 */
export function decodeConsentPolicyVersionValue(raw: JsonValue): ConsentPolicyVersionValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new IdentityDomainError("Consent active-version policy value must be an object.");
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "version") {
      throw new IdentityDomainError(`Consent active-version policy value carries unexpected field '${key}'.`);
    }
  }

  const version = typeof record.version === "string" ? record.version.trim() : "";
  if (!TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN.test(version)) {
    throw new IdentityDomainError(
      `Consent active-version policy version must match ${TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN}.`,
    );
  }

  return { version };
}

/** Frozen alias for the Terms of Service decode entry point. */
export const decodeTermsOfServicePolicyValue = decodeConsentPolicyVersionValue;

export const IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE: ConsentPolicyVersionValue = {
  version: publicTermsOfServicePublicationMetadata.version,
};

const CONSENT_POLICY_SCHEMA_SUMMARY = "{ version: string matching /^v[1-9][0-9]*$/ }";

function placeholderValueFor(policyKey: IdentityConsentPolicyKey): ConsentPolicyVersionValue {
  return { version: publicPolicyPublicationRecords[policyKey].version };
}

/**
 * The Terms of Service active-version policy. Its key is load-bearing history
 * -- operator-created platform-policy documents already reference it -- so it
 * is spelled out literally here and must never be renamed or regenerated from
 * a template.
 */
export const identityTermsOfServicePolicy: PolicyDefinition<ConsentPolicyVersionValue> = definePolicy({
  policyKey: "identity.terms-of-service-active-version",
  contextName: "identity",
  schemaSummary: CONSENT_POLICY_SCHEMA_SUMMARY,
  defaultValue: IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE,
  decodeValue: decodeConsentPolicyVersionValue,
});

export const identityPrivacyPolicyActiveVersionPolicy: PolicyDefinition<ConsentPolicyVersionValue> = definePolicy({
  policyKey: "identity.privacy-policy-active-version",
  contextName: "identity",
  schemaSummary: CONSENT_POLICY_SCHEMA_SUMMARY,
  defaultValue: placeholderValueFor("privacy-policy"),
  decodeValue: decodeConsentPolicyVersionValue,
});

export const identitySellerAgreementActiveVersionPolicy: PolicyDefinition<ConsentPolicyVersionValue> = definePolicy({
  policyKey: "identity.seller-agreement-active-version",
  contextName: "identity",
  schemaSummary: CONSENT_POLICY_SCHEMA_SUMMARY,
  defaultValue: placeholderValueFor("seller-agreement"),
  decodeValue: decodeConsentPolicyVersionValue,
});

export const identityPaymentsTermsActiveVersionPolicy: PolicyDefinition<ConsentPolicyVersionValue> = definePolicy({
  policyKey: "identity.payments-terms-active-version",
  contextName: "identity",
  schemaSummary: CONSENT_POLICY_SCHEMA_SUMMARY,
  defaultValue: placeholderValueFor("payments-terms"),
  decodeValue: decodeConsentPolicyVersionValue,
});

/**
 * The closed consent-policy-key to active-version-policy mapping. `satisfies`
 * over the full key union makes an unmapped consent policy key a compile
 * error, so this registry cannot silently fall behind
 * `IDENTITY_CONSENT_POLICY_KEYS`.
 */
export const identityConsentActiveVersionPolicies = {
  "terms-of-service": identityTermsOfServicePolicy,
  "privacy-policy": identityPrivacyPolicyActiveVersionPolicy,
  "seller-agreement": identitySellerAgreementActiveVersionPolicy,
  "payments-terms": identityPaymentsTermsActiveVersionPolicy,
} as const satisfies Readonly<Record<IdentityConsentPolicyKey, PolicyDefinition<ConsentPolicyVersionValue>>>;

/** Resolves the active-version policy for a consent policy key. Unknown keys reject. */
export function identityConsentActiveVersionPolicyFor(policyKey: string): PolicyDefinition<ConsentPolicyVersionValue> {
  if (!isIdentityConsentPolicyKey(policyKey)) {
    throw new IdentityDomainError(`Consent policy key '${policyKey}' is not a recognized Identity consent policy.`);
  }
  return identityConsentActiveVersionPolicies[policyKey];
}
