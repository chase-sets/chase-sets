import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { identityTermsOfServicePolicy } from "../domain/terms-of-service-policy";
import { TERMS_OF_SERVICE_CONSENT_POLICY_KEY } from "../domain/terms-of-service";
import { resolvePolicyAcceptanceStatus, type PolicyAcceptanceStatus } from "./consent-acceptance";

export type TermsAcceptanceStatus = PolicyAcceptanceStatus;

/**
 * Resolves whether a subject (user and/or account) has accepted the
 * currently active Terms of Service version. This is the single source of
 * truth both for the authenticated acceptance-status route
 * (`../api/terms-route.ts`) and for the cross-context
 * `TermsAcceptanceResolver` host port consumed by Settlement to gate
 * wallet-adjustment-enabled marketplace access (see
 * `bounded-contexts/settlement/features/wallets/api/balance-credit-resolver.ts`).
 *
 * A thin wrapper over the generalized per-policy rule in
 * `./consent-acceptance.ts`: it supplies the one policy this port is about and
 * the required version taken from Identity's Terms of Service active-version
 * policy document. Acceptance requires an exact match on both the canonical
 * policy key and the exact active version string -- a legacy-keyed or
 * superseded-version fact is readable consent history but never satisfies this
 * check. Fails closed: absent any matching fact, `accepted` is false.
 */
export async function resolveTermsAcceptanceStatus(
  db: PgQueryable,
  policies: Pick<PolicyRuntime, "resolvePolicy">,
  subject: Readonly<{ userId?: string | null; accountId?: string | null }>,
): Promise<TermsAcceptanceStatus> {
  const resolved = await policies.resolvePolicy(identityTermsOfServicePolicy);

  return resolvePolicyAcceptanceStatus(db, subject, {
    policyKey: TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
    requiredVersion: resolved.value.version,
  });
}
