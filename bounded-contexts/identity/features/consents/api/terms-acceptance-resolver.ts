import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import { resolveTermsAcceptanceStatus, type TermsAcceptanceStatus } from "../read-model/terms-acceptance";

export type { TermsAcceptanceStatus };

/**
 * Pool-only cross-context host port factory: builds a
 * `resolveTermsAcceptanceStatus` function backed directly by Identity's own
 * database pool, with no dependency on a running Identity services instance.
 * This mirrors `createSettlementBalanceCreditResolver` and
 * `createCommercialTermsResolver` -- every consuming context declares its
 * own minimal structural interface (see
 * `bounded-contexts/settlement/features/wallets/api/balance-credit-resolver.ts`
 * `TermsAcceptanceResolver`) and receives an object satisfying it via a host
 * port composed once in `deployables/platform-api/src/app.ts` /
 * `deployables/platform-worker/src/main.ts`, so no bounded context imports
 * another context's package to reach this.
 */
export function createIdentityTermsAcceptanceResolver(db: PgQueryable) {
  const policyResolver = createPolicyResolver({ db });

  return {
    resolveTermsAcceptanceStatus: (subject: Readonly<{ accountId?: string | null; userId?: string | null }>) =>
      resolveTermsAcceptanceStatus(db, { resolvePolicy: policyResolver.resolvePolicy }, subject),
  };
}
