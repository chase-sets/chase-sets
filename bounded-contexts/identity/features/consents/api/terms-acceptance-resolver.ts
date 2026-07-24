import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import type { PublicPolicyKey } from "@chase-sets/public-docs";
import type { ConsentSubjectType } from "../../../support/runtime-support/common";
import type { ConsentBundleKey } from "../domain/consent-bundle";
import {
  resolveConsentBundleAcceptanceStatus,
  resolvePolicyAcceptanceStatus,
  type ConsentBundleAcceptanceStatus,
  type PolicyAcceptanceStatus,
} from "../read-model/acceptance";
import { resolveTermsAcceptanceStatus, type TermsAcceptanceStatus } from "../read-model/terms-acceptance";

export type { ConsentBundleAcceptanceStatus, PolicyAcceptanceStatus, TermsAcceptanceStatus };

/**
 * Pool-only cross-context host port factory backed directly by Identity's
 * database. Consumers declare the minimal structural resolver interface they
 * need; deployable roots compose this implementation without exposing
 * Identity storage to another bounded context.
 */
export function createIdentityConsentAcceptanceResolver(db: PgQueryable) {
  const policyResolver = createPolicyResolver({ db });
  const policies = { resolvePolicy: policyResolver.resolvePolicy };

  return {
    resolvePolicyAcceptanceStatus: (
      policyKey: PublicPolicyKey,
      subject: Readonly<{
        subjectType: ConsentSubjectType;
        userId?: string | null;
        accountId?: string | null;
      }>,
    ) => resolvePolicyAcceptanceStatus(db, policies, { policyKey, subject }),
    resolveConsentBundleAcceptanceStatus: (
      bundleKey: ConsentBundleKey,
      subject: Readonly<{ accountId?: string | null; userId?: string | null }>,
    ) => resolveConsentBundleAcceptanceStatus(db, policies, bundleKey, subject),
    resolveTermsAcceptanceStatus: (subject: Readonly<{ accountId?: string | null; userId?: string | null }>) =>
      resolveTermsAcceptanceStatus(db, policies, subject),
  };
}

/** Compatibility wrapper preserving the existing Terms-only host port. */
export function createIdentityTermsAcceptanceResolver(db: PgQueryable) {
  const resolver = createIdentityConsentAcceptanceResolver(db);
  return {
    resolveTermsAcceptanceStatus: resolver.resolveTermsAcceptanceStatus,
  };
}
