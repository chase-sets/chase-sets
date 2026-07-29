import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readConsentActivationAuthority } from "@chase-sets/platform-policy/consent-activation-authority";
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
 *
 * The required version is resolved from the Terms of Service Consent Activation
 * Authority's own event stream, which is why this factory now needs the
 * transactional pool rather than a bare queryable: the authority is
 * event-sourced, and reading it from the same pool keeps this port on exactly
 * the source Identity's own acceptance surface reads. It deliberately does NOT
 * build a `PolicyRuntime` -- a cached policy value beside an authority read is
 * the pairing this wiring exists to remove. The composition roots stay thin:
 * they pass the identity pool they already hold and nothing else.
 */
export function createIdentityTermsAcceptanceResolver(pool: PgTransactionalPool) {
  const eventStore = createPostgresEventStore({ pool });

  return {
    resolveTermsAcceptanceStatus: (subject: Readonly<{ accountId?: string | null; userId?: string | null }>) =>
      resolveTermsAcceptanceStatus(pool, (policyKey) => readConsentActivationAuthority(eventStore, policyKey), subject),
  };
}
