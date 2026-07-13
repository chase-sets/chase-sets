/**
 * Canonical Terms of Service consent policy key and version format.
 *
 * Consent facts recorded by the platform historically drifted between a
 * `"terms"` policy key with date-shaped versions and a `"terms-of-service"`
 * key with `vN` versions. Going forward every new acceptance uses the single
 * canonical key below. Historical facts recorded under a legacy key are
 * never rewritten -- they remain readable through the explicit compatibility
 * rule in `isRecognizedTermsOfServicePolicyKey`, but they never satisfy the
 * "has accepted the active version" gate, which always requires an exact
 * canonical-key, exact-current-version match (see `read-model/terms-acceptance.ts`).
 */
export const TERMS_OF_SERVICE_CONSENT_POLICY_KEY = "terms-of-service";

/**
 * Consent-key aliases recorded before the canonical key was adopted.
 * Read-only compatibility surface: consent history and audit views may
 * label facts recorded under these keys as Terms of Service history, but
 * nothing treats them as evidence of accepting the currently active version.
 */
export const TERMS_OF_SERVICE_LEGACY_CONSENT_POLICY_KEY_ALIASES: readonly string[] = ["terms"];

/** True for the canonical key only -- the key every new acceptance must use. */
export function isCanonicalTermsOfServiceConsentPolicyKey(policyKey: string): boolean {
  return policyKey === TERMS_OF_SERVICE_CONSENT_POLICY_KEY;
}

/** True for the canonical key or any recognized legacy alias -- history/audit reads only. */
export function isRecognizedTermsOfServiceConsentPolicyKey(policyKey: string): boolean {
  return (
    isCanonicalTermsOfServiceConsentPolicyKey(policyKey) ||
    TERMS_OF_SERVICE_LEGACY_CONSENT_POLICY_KEY_ALIASES.includes(policyKey)
  );
}

/**
 * Canonical version format: `vN`, N a positive integer, monotonically
 * assigned as each new published revision is registered (see
 * `terms-of-service-policy.ts`). The version string itself is opaque --
 * what ties a version to a published artifact's effective date is the
 * platform-policy document that carries it (its `effectiveFrom` field),
 * not the string's shape.
 */
export const TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN = /^v[1-9][0-9]*$/;

export function isValidTermsOfServiceConsentVersion(version: string): boolean {
  return TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN.test(version);
}
