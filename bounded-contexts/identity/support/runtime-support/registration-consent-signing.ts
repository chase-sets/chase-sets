import {
  PLATFORM_INTERNAL_AUTH_SECRET_ENV,
  resolvePlatformInternalAuthSecret,
} from "@chase-sets/platform-runtime/http";
import { signCanonicalPayload, type SigningKeySet } from "@chase-sets/platform-runtime/signed-payload";

/** Optional dedicated signing key. Set it only to rotate registration consent independently. */
export const REGISTRATION_CONSENT_SIGNING_SECRET_ENV = "REGISTRATION_CONSENT_SIGNING_SECRET";

/** Optional comma-separated retired keys that must still verify during a rotation. */
export const REGISTRATION_CONSENT_PREVIOUS_SIGNING_SECRETS_ENV = "REGISTRATION_CONSENT_PREVIOUS_SIGNING_SECRETS";

/**
 * Domain separation label for the derived key. Changing it invalidates every
 * outstanding derived-key resolution, which is a rotation, not a refactor.
 */
const REGISTRATION_CONSENT_SIGNING_KEY_LABEL = "chase-sets:registration-consent-resolution:v1";

/**
 * The rotating key set that signs and verifies registration consent resolutions.
 *
 * Only Identity ever holds it: Identity mints, Identity verifies, and no key
 * material crosses a context boundary. With no dedicated secret configured the
 * key is derived from the platform internal auth secret -- the secret that
 * already guards the exact Auth-to-Identity boundary this resolution sits
 * behind -- through an HMAC over a domain-separation label, so the signing key
 * is never the header secret itself. Deriving rather than requiring a new
 * secret is what keeps this an operator no-op; `requireExplicitInProduction`
 * ensures a production deployment can never sign with the development default.
 */
export function resolveRegistrationConsentSigningKeys(): SigningKeySet {
  const configured = process.env[REGISTRATION_CONSENT_SIGNING_SECRET_ENV]?.trim();
  const previous = (process.env[REGISTRATION_CONSENT_PREVIOUS_SIGNING_SECRETS_ENV] ?? "")
    .split(",")
    .map((secret) => secret.trim())
    .filter(Boolean);
  const current = configured || deriveRegistrationConsentSigningSecret();

  return previous.length > 0 ? { current, previous } : current;
}

function deriveRegistrationConsentSigningSecret(): string {
  return signCanonicalPayload(
    REGISTRATION_CONSENT_SIGNING_KEY_LABEL,
    resolvePlatformInternalAuthSecret({
      requireExplicitInProduction: true,
      productionMissingSecretError:
        `${PLATFORM_INTERNAL_AUTH_SECRET_ENV} is required to sign registration consent resolutions in production. ` +
        `Set it, or set ${REGISTRATION_CONSENT_SIGNING_SECRET_ENV} to a dedicated signing key.`,
    }),
  );
}
