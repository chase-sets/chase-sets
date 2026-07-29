import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import {
  requireResolvedConsentBundle,
  type ConsentActivationAuthorityReader,
  type ConsentBundleKey,
  type ConsentBundleRequirement,
  type ConsentBundleResolution,
  type ConsentPublicationCorpus,
} from "../domain/consent-bundle";
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
 * The generalized single-policy gate. Resolves the required version from the
 * policy's own active-version document and compares it against the subject's
 * current Consent for that key.
 *
 * This is the PRE-BUNDLE surface: it keeps `findCurrentConsent`'s shipped
 * user-or-account disjunction because that is the host port's contract. The
 * bundle path below does not use it and does not read a policy document at all.
 */
export async function resolvePolicyAcceptanceStatus(
  db: PgQueryable,
  policies: Pick<PolicyRuntime, "resolvePolicy">,
  policy: PolicyDefinition<Readonly<{ version: string }>>,
  consentPolicyKey: string,
  subject: Readonly<{ userId?: string | null; accountId?: string | null }>,
): Promise<PolicyAcceptanceStatus> {
  const resolved = await policies.resolvePolicy(policy);
  const requiredVersion = resolved.value.version;
  const current = await findCurrentConsent(db, {
    userId: subject.userId ?? null,
    accountId: subject.accountId ?? null,
    policyKey: consentPolicyKey,
  });

  return {
    policyKey: consentPolicyKey,
    requiredVersion,
    accepted: current?.status === "recorded" && current.policy_version === requiredVersion,
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
