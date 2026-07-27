import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { publicPolicyPublicationRecords, type PublicPolicyKey } from "@chase-sets/public-docs";
import { IdentityDomainError } from "../../../support/runtime-support/common";
import { TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN } from "./terms-of-service";

/**
 * The active-required-version registry for every consent-capable policy key
 * Identity owns, built on the shared platform-policy machinery (see
 * `infrastructure/platform-policy`). Every document uses the same
 * `definePolicy` pattern and the same value shape; only the key differs, and a
 * key is derived from its Public Presence publication key so the two can never
 * drift into naming each other by hand.
 *
 * Identity is the acceptance owner and is the only consumer that needs to
 * resolve these values directly; Settlement reads the Terms of Service value
 * only through the `TermsAcceptanceResolver` host port (see
 * `../read-model/terms-acceptance.ts` and
 * `bounded-contexts/settlement/features/wallets/api/balance-credit-resolver.ts`)
 * so no context queries another context's storage directly.
 *
 * Public Presence remains the publication owner of the actual policy text;
 * these policies only carry the version token an operator activates once a
 * counsel-approved artifact is published. Until then, each `defaultValue` below
 * is a pre-publication placeholder -- it lets the acceptance gate and the
 * consent-versioning machinery be exercised end-to-end without asserting that
 * any real policy text has gone live. A placeholder version is deliberately NOT
 * enough to record an acceptance: what admits a Consent is the Consent
 * Activation Authority reporting that exact version active (see
 * `./consent-bundle.ts`), and what makes a bundle member REQUIRED additionally
 * needs the compiled artifact to be consent-activatable. Creating an "active"
 * platform-policy document carrying a later version is the value change; the
 * authority activation is the separate, guardable act.
 */
export type ConsentActiveVersionPolicyValue = Readonly<{
  /** The currently-required consent version. Must match `TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN`. */
  version: string;
}>;

export function decodeConsentActiveVersionPolicyValue(raw: JsonValue): ConsentActiveVersionPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new IdentityDomainError("Consent active-version policy value must be an object.");
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "version") {
      throw new IdentityDomainError(`Consent active-version policy value has unexpected field '${key}'.`);
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

/**
 * Derives the platform-policy key for a publication key. `terms-of-service`
 * resolves to `identity.terms-of-service-active-version`, the key that shipped
 * before this registry was generalized -- it is derived here rather than
 * restated so generalizing the registry could not silently move it.
 */
export function identityConsentActiveVersionPolicyKey(publicPolicyKey: PublicPolicyKey): string {
  return `identity.${publicPolicyKey}-active-version`;
}

function defineIdentityConsentActiveVersionPolicy(
  publicPolicyKey: PublicPolicyKey,
): PolicyDefinition<ConsentActiveVersionPolicyValue> {
  return definePolicy({
    policyKey: identityConsentActiveVersionPolicyKey(publicPolicyKey),
    contextName: "identity",
    schemaSummary: "{ version: string matching /^v[1-9][0-9]*$/ }",
    defaultValue: { version: publicPolicyPublicationRecords[publicPolicyKey].version },
    decodeValue: decodeConsentActiveVersionPolicyValue,
  });
}

export const IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE: ConsentActiveVersionPolicyValue = {
  version: publicPolicyPublicationRecords["terms-of-service"].version,
};

export const identityTermsOfServicePolicy = defineIdentityConsentActiveVersionPolicy("terms-of-service");
export const identityPrivacyPolicyPolicy = defineIdentityConsentActiveVersionPolicy("privacy-policy");
export const identitySellerAgreementPolicy = defineIdentityConsentActiveVersionPolicy("seller-agreement");
export const identityPaymentsTermsPolicy = defineIdentityConsentActiveVersionPolicy("payments-terms");

/**
 * The one enumeration of Identity's consent-capable active-version policies,
 * keyed by publication key. A Consent Bundle member names its policy through
 * this map, so a member can never point at a policy key nothing declares.
 */
export const identityConsentActiveVersionPolicies = {
  "terms-of-service": identityTermsOfServicePolicy,
  "privacy-policy": identityPrivacyPolicyPolicy,
  "seller-agreement": identitySellerAgreementPolicy,
  "payments-terms": identityPaymentsTermsPolicy,
} as const satisfies Partial<Record<PublicPolicyKey, PolicyDefinition<ConsentActiveVersionPolicyValue>>>;

export type IdentityConsentPolicyKey = keyof typeof identityConsentActiveVersionPolicies;
