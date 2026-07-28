import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  consentBundleAcceptanceSubject,
  resolveConsentBundle,
  type ConsentBundle,
  type ConsentBundleKey,
  type ConsentBundleRequirement,
  type ConsentBundleResolutionDeps,
  type ConsentBundleUnresolvedMember,
} from "../domain/consent-bundle";
import {
  findCurrentConsent,
  findCurrentConsentsForPolicyKeys,
  type CurrentConsentRow,
  type RequestedCurrentConsentRow,
} from "./queries";

/**
 * Whether a subject holds the exact required version of one policy.
 *
 * Acceptance requires an exact match on both the canonical policy key and the
 * exact required version string, and it is decided by the STATE of the Consent
 * aggregate the read model projects -- never by the presence of a consent row.
 * A container that exists but is withdrawn, or holds a superseded version, is
 * consent history, not acceptance. Fails closed: absent any matching fact,
 * `accepted` is false.
 */
export type PolicyAcceptanceStatus = Readonly<{
  policyKey: string;
  requiredVersion: string;
  accepted: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
}>;

function toAcceptanceStatus(
  policyKey: string,
  requiredVersion: string,
  current: Pick<CurrentConsentRow, "policy_version" | "status" | "recorded_at"> | null | undefined,
): PolicyAcceptanceStatus {
  return {
    policyKey,
    requiredVersion,
    accepted: current?.status === "recorded" && current.policy_version === requiredVersion,
    acceptedVersion: current?.policy_version ?? null,
    acceptedAt: current?.recorded_at ?? null,
  };
}

/** The single-policy acceptance rule, generalized over any policy key and required version. */
export async function resolvePolicyAcceptanceStatus(
  db: PgQueryable,
  subject: Readonly<{ userId?: string | null; accountId?: string | null }>,
  required: Readonly<{ policyKey: string; requiredVersion: string }>,
): Promise<PolicyAcceptanceStatus> {
  const current = await findCurrentConsent(db, {
    userId: subject.userId ?? null,
    accountId: subject.accountId ?? null,
    policyKey: required.policyKey,
  });

  return toAcceptanceStatus(required.policyKey, required.requiredVersion, current);
}

export type ConsentBundleMemberAcceptance = PolicyAcceptanceStatus &
  Readonly<{
    href: string;
    /** The current Consent aggregate's state, or null when the subject has no Consent for this policy at all. */
    consentStatus: "recorded" | "withdrawn" | null;
  }>;

export type ConsentBundleAcceptanceStatus = Readonly<{
  bundleKey: ConsentBundleKey;
  subjectType: ConsentBundle["subjectType"];
  /** The ordered requirement set this status was computed against. Empty is a value. */
  requirements: readonly ConsentBundleRequirement[];
  members: readonly ConsentBundleMemberAcceptance[];
  /**
   * True only when every requirement is held at its exact required version by a
   * Consent aggregate in the `recorded` state, and nothing about the bundle was
   * unresolved. An unresolved member can never read as satisfied.
   */
  satisfied: boolean;
  unresolved: readonly ConsentBundleUnresolvedMember[];
}>;

/**
 * Whether a subject has satisfied a Consent Bundle.
 *
 * The requirement set comes from the authority-backed bundle resolution, so a
 * member that is not consent-activatable or not activated is not something the
 * subject is asked to hold. Whether the subject holds what IS required is then
 * a read-model question, answered from the projected current-state rows in one
 * query.
 *
 * The split is deliberate: what is REQUIRED is decided from event streams,
 * because a projection that lags or is truncated by crash recovery must never
 * be able to shrink the requirement set. What has been ACCEPTED is a read-model
 * report, and reports fail closed -- a lagging projection can only make this
 * read say "not yet satisfied", never "satisfied".
 *
 * WHOSE acceptance is read is the bundle's to decide, not the caller's. The
 * caller hands over the identities it knows; the bundle's declared subject type
 * picks exactly one of them, and the read is keyed on that exact subject. A
 * user bundle is never answered by an account's facts and an account bundle is
 * never answered by a user's, so a second person in the same account can
 * neither satisfy nor be satisfied by the first. When the caller did not supply
 * the identity this bundle is about, nothing is read and every requirement
 * reads as unheld.
 */
export async function resolveConsentBundleAcceptance(
  db: PgQueryable,
  bundle: ConsentBundle,
  deps: ConsentBundleResolutionDeps,
  subject: Readonly<{ userId?: string | null; accountId?: string | null }>,
): Promise<ConsentBundleAcceptanceStatus> {
  const resolution = await resolveConsentBundle(bundle, deps);
  const acceptanceSubject = consentBundleAcceptanceSubject(bundle, subject);
  const rows = acceptanceSubject
    ? await findCurrentConsentsForPolicyKeys(db, {
        subjectType: acceptanceSubject.subjectType,
        subjectId: acceptanceSubject.subjectId,
        policyKeys: resolution.requirements.map((requirement) => requirement.policyKey),
      })
    : [];

  const members = resolution.requirements.map((requirement) => {
    const current = rows.find((row) => row.requested_policy_key === requirement.policyKey);
    return {
      ...toAcceptanceStatus(requirement.policyKey, requirement.version, current),
      href: requirement.href,
      consentStatus: current?.status ?? null,
    };
  });

  return {
    bundleKey: resolution.bundleKey,
    subjectType: resolution.subjectType,
    requirements: resolution.requirements,
    members,
    satisfied: resolution.unresolved.length === 0 && members.every((member) => member.accepted),
    unresolved: resolution.unresolved,
  };
}
