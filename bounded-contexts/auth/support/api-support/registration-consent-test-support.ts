import type { RegistrationConsentSubmission, SignedRegistrationConsentResolution } from "@chase-sets/identity/server";

/**
 * A stand-in for the value Identity mints. Route tests assert that this exact
 * object reaches `createPersonalIdentity`, which is what proves a path forwards
 * the resolution it was given rather than assembling one of its own.
 */
export const SERVER_MINTED_REGISTRATION_CONSENT_RESOLUTION: SignedRegistrationConsentResolution = {
  bundleKey: "registration",
  requirements: [],
  resolvedAt: "2026-07-25T00:00:00.000Z",
  signature: "server-minted-test-signature",
};

/** The submission a path with no human affirmation moment forwards. */
export const SERVER_MINTED_REGISTRATION_CONSENT_SUBMISSION: RegistrationConsentSubmission = {
  resolution: SERVER_MINTED_REGISTRATION_CONSENT_RESOLUTION,
  affirmed: false,
};

/**
 * Layer the minting read onto whatever identity-mutation client a test built,
 * so a test that only cares about one method still gets a client that can
 * resolve. A test may override it by returning its own `resolveRegistrationConsent`.
 */
export function withRegistrationConsentResolution<T extends object>(identityMutations: T) {
  return {
    resolveRegistrationConsent: async () => SERVER_MINTED_REGISTRATION_CONSENT_RESOLUTION,
    ...identityMutations,
  };
}
