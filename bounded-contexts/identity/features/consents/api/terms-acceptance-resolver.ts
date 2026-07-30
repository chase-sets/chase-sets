import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readConsentActivationAuthority } from "@chase-sets/platform-policy/consent-activation-authority";
import type { ConsentActivationAuthorityReader } from "../domain/consent-bundle";
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
 * The pool is transactional because the acceptance answer's required version
 * comes from replaying the Consent Activation Authority stream, not from the
 * cached policy-document projection. This port therefore builds an event store
 * over the same pool and no policy resolver at all: there is no cache to go
 * stale, and no cached value that could be paired with a separately read
 * authority revision. The reader below is annotated with the imported real
 * `ConsentActivationAuthorityReader` type, so a change to the owning context's
 * read signature is a compile error here rather than a runtime throw in a
 * deployable.
 */
export function createIdentityTermsAcceptanceResolver(pool: PgTransactionalPool) {
  const eventStore = createPostgresEventStore({ pool });
  const authority: ConsentActivationAuthorityReader = {
    read: (policyKey) => readConsentActivationAuthority(eventStore, policyKey),
  };

  return {
    resolveTermsAcceptanceStatus: (subject: Readonly<{ accountId?: string | null; userId?: string | null }>) =>
      resolveTermsAcceptanceStatus(pool, authority, subject),
  };
}
