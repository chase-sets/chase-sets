import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ConsentActivationAuthorityReader } from "../domain/consent-bundle";
import { TERMS_OF_SERVICE_CONSENT_POLICY_KEY } from "../domain/terms-of-service";
import { resolveConsentPolicyAcceptanceStatus, type ConsentPolicyAcceptanceStatus } from "./consent-bundle-acceptance";

/** The host/Settlement-facing acceptance shape. Unchanged field set and names. */
export type TermsAcceptanceStatus = ConsentPolicyAcceptanceStatus;

export type { ConsentActivationAuthorityReader };

/**
 * Resolves whether a subject (user and/or account) has accepted the currently
 * active Terms of Service version. This is the single source of truth both for
 * the authenticated acceptance-status route (`../api/terms-route.ts`) and for
 * the cross-context `TermsAcceptanceResolver` host port consumed by Settlement
 * to gate wallet-adjustment-enabled marketplace access (see
 * `bounded-contexts/settlement/features/wallets/api/balance-credit-resolver.ts`).
 *
 * A thin fail-closed wrapper over the generalized per-policy resolver: the
 * required version comes from one validated Consent Activation Authority read,
 * never from the cached policy-document value. The authority parameter is a
 * `Pick` of the real runtime interface with no `resolvePolicy` member, so the
 * cached resolver is not merely unused here -- it is unreachable from anything
 * this function is handed.
 *
 * Acceptance requires an exact match on both the canonical policy key and the
 * exact active version string; a legacy-keyed or superseded-version fact is
 * readable consent history but never satisfies this check. Fails closed: absent
 * an active authority or absent a matching fact, `requiredVersion` is "" and
 * `accepted` is false.
 */
export async function resolveTermsAcceptanceStatus(
  db: PgQueryable,
  authority: ConsentActivationAuthorityReader,
  subject: Readonly<{ userId?: string | null; accountId?: string | null }>,
): Promise<TermsAcceptanceStatus> {
  return resolveConsentPolicyAcceptanceStatus(db, authority, {
    policyKey: TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
    subject,
  });
}
