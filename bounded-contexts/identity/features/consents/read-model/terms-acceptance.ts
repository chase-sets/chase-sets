import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { identityTermsOfServicePolicy } from "../domain/terms-of-service-policy";
import { TERMS_OF_SERVICE_CONSENT_POLICY_KEY } from "../domain/terms-of-service";
import { findCurrentConsent } from "./queries";

export type TermsAcceptanceStatus = Readonly<{
  policyKey: string;
  requiredVersion: string;
  accepted: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
}>;

/**
 * Resolves whether a subject (user and/or account) has accepted the
 * currently active Terms of Service version. This is the single source of
 * truth both for the authenticated acceptance-status route
 * (`../api/terms-route.ts`) and for the cross-context
 * `TermsAcceptanceResolver` host port consumed by Settlement to gate
 * wallet-adjustment-enabled marketplace access (see
 * `bounded-contexts/settlement/features/wallets/api/balance-credit-resolver.ts`).
 *
 * Acceptance requires an exact match on both the canonical policy key and
 * the exact active version string -- a legacy-keyed or superseded-version
 * fact is readable consent history but never satisfies this check. Fails
 * closed: absent any matching fact, `accepted` is false.
 */
export async function resolveTermsAcceptanceStatus(
  db: PgQueryable,
  policies: Pick<PolicyRuntime, "resolvePolicy">,
  subject: Readonly<{ userId?: string | null; accountId?: string | null }>,
): Promise<TermsAcceptanceStatus> {
  const resolved = await policies.resolvePolicy(identityTermsOfServicePolicy);
  const requiredVersion = resolved.value.version;
  const current = await findCurrentConsent(db, {
    userId: subject.userId ?? null,
    accountId: subject.accountId ?? null,
    policyKey: TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
  });

  return {
    policyKey: TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
    requiredVersion,
    accepted: current?.status === "recorded" && current.policy_version === requiredVersion,
    acceptedVersion: current?.policy_version ?? null,
    acceptedAt: current?.recorded_at ?? null,
  };
}
