import { publicTermsOfServicePublicationMetadata } from "@chase-sets/public-docs";
import {
  decodeActiveConsentVersionPolicyValue,
  identityActiveConsentVersionPolicies,
  type ActiveConsentVersionPolicyValue,
} from "./active-consent-version-policy";

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
export type TermsOfServicePolicyValue = ActiveConsentVersionPolicyValue;

export const IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE: TermsOfServicePolicyValue = {
  version: publicTermsOfServicePublicationMetadata.version,
};

export const decodeTermsOfServicePolicyValue = decodeActiveConsentVersionPolicyValue;

export const identityTermsOfServicePolicy = identityActiveConsentVersionPolicies["terms-of-service"];
