import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  requireResolvedConsentBundle,
  resolveConsentBundleMember,
  type ConsentActivationAuthorityReader,
  type ConsentBundleKey,
  type ConsentBundleRequirement,
  type ConsentBundleResolution,
  type ConsentPublicationCorpus,
} from "../domain/consent-bundle";
import type { IdentityConsentPolicyKey } from "../domain/terms-of-service-policy";
import { findCurrentConsent, findSubjectConsentsForPolicies } from "./queries";

/**
 * Per-policy and per-bundle acceptance.
 *
 * Two rules run through everything below.
 *
 * SATISFACTION IS AGGREGATE STATE, NEVER PRESENCE. A requirement is satisfied
 * only when the current Consent for that exact subject and policy is `recorded`
 * AND carries the exact required version. A row that exists, a stream that
 * exists, a withdrawn record, and a superseded version are each unsatisfied --
 * the presence of a consent container says nothing about agreement.
 *
 * EXACTNESS. Acceptance requires an exact match on the canonical policy key and
 * the exact required version string, so a legacy-keyed fact (the history-only
 * `terms` alias, including its date-shaped versions) is readable consent history
 * and never satisfies anything. Nothing here aliases or migrates one to the
 * other.
 */

export type PolicyAcceptanceStatus = Readonly<{
  policyKey: string;
  requiredVersion: string;
  accepted: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
}>;

/**
 * The value `requiredVersion` carries when NO version is currently required --
 * because the artifact is not consent-activatable, because its Consent
 * Activation Authority does not report it active, or because the authority could
 * not be read at all.
 *
 * It is an explicit "there is nothing to accept", not a version. `accepted` is
 * always false alongside it, so every consumer that only reads `accepted` (the
 * Settlement wallet gate among them) fails closed without needing to know this
 * constant exists.
 */
export const NO_REQUIRED_CONSENT_VERSION = "";

/** True when the authority currently requires a specific version of this policy. */
export function isConsentVersionRequired(status: PolicyAcceptanceStatus): boolean {
  return status.requiredVersion !== NO_REQUIRED_CONSENT_VERSION;
}

/**
 * The generalized single-policy gate.
 *
 * THE REQUIRED VERSION COMES FROM THE CONSENT ACTIVATION AUTHORITY, from the
 * same single read `resolveConsentBundleMember` performs -- never from
 * `PolicyRuntime.resolvePolicy`. A cached policy document and the authority are
 * two independently-updated sources; trusting the cached one here is what let a
 * subject holding v1 read as "accepted" while the authority had already moved to
 * v2, and it is why no `resolvePolicy` seam is reachable from this module any
 * more.
 *
 * FAILS CLOSED. An artifact that is not consent-activatable, an authority that
 * is inactive or never activated, a malformed snapshot, and a failed read all
 * yield `NO_REQUIRED_CONSENT_VERSION` with `accepted: false`. The subject's
 * current Consent is still reported (`acceptedVersion`/`acceptedAt`) because
 * consent history stays readable regardless of what is currently required.
 *
 * This is the PRE-BUNDLE subject surface: it keeps `findCurrentConsent`'s
 * shipped user-or-account disjunction because that is the host port's contract.
 * The per-bundle path below uses the subject-exact read instead.
 */
export async function resolvePolicyAcceptanceStatus(
  db: PgQueryable,
  readAuthority: ConsentActivationAuthorityReader,
  consentPolicyKey: IdentityConsentPolicyKey,
  subject: Readonly<{ userId?: string | null; accountId?: string | null }>,
  corpus?: ConsentPublicationCorpus,
): Promise<PolicyAcceptanceStatus> {
  const member = await resolveConsentBundleMember(consentPolicyKey, readAuthority, corpus);
  const requiredVersion = member.requirement?.version ?? NO_REQUIRED_CONSENT_VERSION;
  const current = await findCurrentConsent(db, {
    userId: subject.userId ?? null,
    accountId: subject.accountId ?? null,
    policyKey: consentPolicyKey,
  });

  return {
    policyKey: consentPolicyKey,
    requiredVersion,
    accepted:
      requiredVersion !== NO_REQUIRED_CONSENT_VERSION &&
      current?.status === "recorded" &&
      current.policy_version === requiredVersion,
    acceptedVersion: current?.policy_version ?? null,
    acceptedAt: current?.recorded_at ?? null,
  };
}

export type ConsentBundleRequirementAcceptance = Readonly<{
  requirement: ConsentBundleRequirement;
  satisfied: boolean;
  /** The version currently recorded for this exact subject and key, if any. */
  acceptedVersion: string | null;
  acceptedAt: string | null;
  /** `recorded`, `withdrawn`, or null when no Consent exists for this exact subject and key. */
  status: "recorded" | "withdrawn" | null;
}>;

export type ConsentBundleAcceptance = Readonly<{
  bundleKey: ConsentBundleKey;
  subjectType: "user" | "account";
  subjectId: string;
  /** The ordered requirement set this acceptance was assessed against. */
  requirements: readonly ConsentBundleRequirementAcceptance[];
  /** True only when EVERY requirement is satisfied. An empty set is vacuously satisfied and still resolved. */
  satisfied: boolean;
  resolution: ConsentBundleResolution;
}>;

/**
 * Resolve a bundle and report whether one exact subject has satisfied it.
 *
 * `resolvePolicy` is never called on this path. State and version both come from
 * the bundle resolution, which derives them from one read of each member's
 * Consent Activation Authority; pairing a cached policy value with a separately
 * read stream revision is unrepresentable here because no cached value is read.
 *
 * An empty requirement set reports `satisfied: true` because nothing is
 * outstanding -- but the resolution itself still ran, still bound its guards,
 * and still fails closed on an unresolved member. Emptiness never short-circuits
 * the resolution, and no caller may read `requirements.length` to decide whether
 * the invariant applies.
 */
export async function resolveConsentBundleAcceptance(
  db: PgQueryable,
  readAuthority: ConsentActivationAuthorityReader,
  params: Readonly<{
    bundleKey: ConsentBundleKey;
    subjectId: string;
    corpus?: ConsentPublicationCorpus;
  }>,
): Promise<ConsentBundleAcceptance> {
  const resolution = await requireResolvedConsentBundle(params.bundleKey, readAuthority, params.corpus);
  const rows = await findSubjectConsentsForPolicies(db, {
    subjectType: resolution.subjectType,
    subjectId: params.subjectId,
    policyKeys: resolution.requirements.map((requirement) => requirement.policyKey),
  });
  const byPolicyKey = new Map(rows.map((row) => [row.policy_key, row]));

  const requirements = resolution.requirements.map((requirement) => {
    const row = byPolicyKey.get(requirement.policyKey) ?? null;
    return {
      requirement,
      satisfied: row?.status === "recorded" && row.policy_version === requirement.version,
      acceptedVersion: row?.policy_version ?? null,
      acceptedAt: row?.recorded_at ?? null,
      status: row?.status ?? null,
    } satisfies ConsentBundleRequirementAcceptance;
  });

  return {
    bundleKey: resolution.bundleKey,
    subjectType: resolution.subjectType,
    subjectId: params.subjectId,
    requirements,
    satisfied: requirements.every((entry) => entry.satisfied),
    resolution,
  };
}
