import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { PublicPolicyVersion } from "@chase-sets/public-docs";
import { resolvePolicyAcceptanceStatus } from "./acceptance";

export type TermsAcceptanceStatus = Readonly<{
  policyKey: string;
  requiredVersion: PublicPolicyVersion;
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
  return resolvePolicyAcceptanceStatus(db, policies, {
    policyKey: "terms-of-service",
    // Preserve the shipped Terms host-port behavior: when both identifiers
    // are supplied, either matching subject can provide the current fact.
    // Consent Bundles always pass their explicit owned subject scope.
    subject,
  });
}
