import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PublicPolicyPublicationRecord } from "@chase-sets/public-docs";
import {
  consentBundleDeclarationFor,
  resolveConsentBundle,
  resolveConsentPolicyMember,
  resolveConsentPolicyMemberAgainstPublication,
  type ConsentActivationAuthorityReader,
  type ConsentBundleKey,
  type ConsentBundleMemberOutcome,
  type ConsentBundleRequirement,
  type ConsentBundleResolution,
  type ConsentBundleUnresolvedReason,
  type ConsentSubjectScope,
} from "../domain/consent-bundle";
import type { IdentityConsentPolicyKey } from "../domain/terms-of-service-policy";
import {
  findCurrentConsent,
  listSubjectExactCurrentConsents,
  type CurrentConsentRow,
  type SubjectExactConsentRow,
} from "./queries";

/**
 * Acceptance is aggregate state, never evidence of presence.
 *
 * A consent row existing for a subject and policy proves only that something
 * was recorded once. Satisfaction requires the CURRENT state of that
 * (subject, policy) pair to be `recorded` at the exact required version. A
 * withdrawn row, a superseded version, a row belonging to a different subject in
 * the same account, and a row under the legacy `terms` key are each present
 * evidence that must not satisfy anything -- so nothing below counts rows,
 * compares list lengths, or treats a non-empty result as completeness.
 *
 * An unresolved bundle is never satisfied. That is enforced by the result type:
 * the unresolved arm's `satisfied` is the literal `false`.
 */

export type ConsentMemberAcceptance = Readonly<{
  policyKey: IdentityConsentPolicyKey;
  /** Whether an activated authority makes this member a requirement right now. */
  required: boolean;
  /** The exact required version, or "" when the member is not currently required. */
  requiredVersion: string;
  satisfied: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  recordedStatus: "recorded" | "withdrawn" | null;
}>;

export type ConsentBundleAcceptance =
  | Readonly<{
      bundleKey: ConsentBundleKey;
      subjectScope: ConsentSubjectScope;
      subjectId: string;
      resolved: true;
      satisfied: boolean;
      /** One entry per declared member, ordered as declared. */
      members: readonly ConsentMemberAcceptance[];
    }>
  | Readonly<{
      bundleKey: ConsentBundleKey;
      subjectScope: ConsentSubjectScope;
      subjectId: string;
      resolved: false;
      satisfied: false;
      unresolvedPolicyKey: IdentityConsentPolicyKey;
      unresolvedReason: ConsentBundleUnresolvedReason;
    }>;

/** The frozen host/Settlement-facing per-policy shape. Field set and names are load-bearing. */
export type ConsentPolicyAcceptanceStatus = Readonly<{
  policyKey: string;
  requiredVersion: string;
  accepted: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
}>;

function currentStateFor(
  rows: readonly SubjectExactConsentRow[],
  policyKey: IdentityConsentPolicyKey,
): SubjectExactConsentRow | null {
  return rows.find((row) => row.policy_key === policyKey) ?? null;
}

function requirementFor(
  requirements: readonly ConsentBundleRequirement[],
  policyKey: IdentityConsentPolicyKey,
): ConsentBundleRequirement | null {
  return requirements.find((requirement) => requirement.policyKey === policyKey) ?? null;
}

/**
 * Evaluates a resolved bundle against one subject's current consent states.
 * Pure, so the subject x consent-state matrix is exercisable without a database
 * and the same rules are what the database-backed path runs.
 */
export function evaluateConsentBundleAcceptance(
  resolution: ConsentBundleResolution,
  subjectId: string,
  rows: readonly SubjectExactConsentRow[],
): ConsentBundleAcceptance {
  if (!resolution.resolved) {
    return {
      bundleKey: resolution.bundleKey,
      subjectScope: resolution.subjectScope,
      subjectId,
      resolved: false,
      satisfied: false,
      unresolvedPolicyKey: resolution.unresolvedPolicyKey,
      unresolvedReason: resolution.unresolvedReason,
    };
  }

  const declaration = consentBundleDeclarationFor(resolution.bundleKey);
  const members = declaration.members.map((policyKey): ConsentMemberAcceptance => {
    const requirement = requirementFor(resolution.requirements, policyKey);
    const current = currentStateFor(rows, policyKey);
    const requiredVersion = requirement?.version ?? "";

    return {
      policyKey,
      required: requirement !== null,
      requiredVersion,
      satisfied:
        requirement !== null && current?.status === "recorded" && current.policy_version === requirement.version,
      acceptedVersion: current?.policy_version ?? null,
      acceptedAt: current?.recorded_at ?? null,
      recordedStatus: current?.status ?? null,
    };
  });

  return {
    bundleKey: resolution.bundleKey,
    subjectScope: resolution.subjectScope,
    subjectId,
    resolved: true,
    // Every member that is currently required must be satisfied. A resolved
    // bundle that requires nothing has nothing unmet -- that is the honest
    // aggregate answer, and it is deliberately not spelled as a length test on
    // the requirement list, which is how an empty set turns into a disabled mode.
    satisfied: members.every((member) => !member.required || member.satisfied),
    members,
  };
}

/**
 * Resolves and evaluates one bundle for one subject.
 *
 * The subject read is always issued over the DECLARED member keys, so the
 * subject-exact query runs identically whether the corpus currently derives two
 * requirements or none. There is no arm that skips the read.
 */
export async function resolveConsentBundleAcceptance(
  db: PgQueryable,
  authority: ConsentActivationAuthorityReader,
  params: Readonly<{ bundleKey: ConsentBundleKey; subjectId: string }>,
): Promise<ConsentBundleAcceptance> {
  const declaration = consentBundleDeclarationFor(params.bundleKey);
  const resolution = await resolveConsentBundle(authority, params.bundleKey);
  const rows = await listSubjectExactCurrentConsents(db, {
    subjectType: declaration.subjectScope,
    subjectId: params.subjectId,
    policyKeys: declaration.members,
  });

  return evaluateConsentBundleAcceptance(resolution, params.subjectId, rows);
}

/**
 * Turns one member outcome plus one current consent state into the frozen
 * per-policy status shape. Pure and total over the closed outcome union, so
 * every non-required outcome is proven to fail closed rather than inferred to.
 *
 * When the policy is not currently required -- publication-ineligible, an
 * authority that is inactive or never activated, an activation that contradicts
 * its publication, or an authority that could not be validated -- the required
 * version is the empty string and acceptance is false. The recorded history
 * fields still report what exists, because consent history stays readable even
 * when it cannot satisfy anything.
 */
export function evaluateConsentPolicyAcceptance(
  policyKey: IdentityConsentPolicyKey,
  outcome: ConsentBundleMemberOutcome,
  current: CurrentConsentRow | null,
): ConsentPolicyAcceptanceStatus {
  const requiredVersion = outcome.kind === "required" ? outcome.requirement.version : "";

  return {
    policyKey,
    requiredVersion,
    accepted:
      outcome.kind === "required" && current?.status === "recorded" && current.policy_version === requiredVersion,
    acceptedVersion: current?.policy_version ?? null,
    acceptedAt: current?.recorded_at ?? null,
  };
}

/**
 * The consent read is the shipped host query with its user-OR-account
 * disjunction, unchanged: this is the Terms host contract and narrowing it here
 * would change a shipped cross-context answer. Only the bundle read above is
 * subject-exact.
 */
async function findHostConsentState(
  db: PgQueryable,
  policyKey: IdentityConsentPolicyKey,
  subject: Readonly<{ userId?: string | null; accountId?: string | null }>,
): Promise<CurrentConsentRow | null> {
  return findCurrentConsent(db, {
    userId: subject.userId ?? null,
    accountId: subject.accountId ?? null,
    policyKey,
  });
}

/**
 * Resolves per-policy acceptance against an explicitly supplied publication
 * record, so the publication x activation matrix is reachable at this layer.
 */
export async function resolveConsentPolicyAcceptanceStatusAgainstPublication(
  db: PgQueryable,
  authority: ConsentActivationAuthorityReader,
  params: Readonly<{
    policyKey: IdentityConsentPolicyKey;
    publication: PublicPolicyPublicationRecord;
    subject: Readonly<{ userId?: string | null; accountId?: string | null }>;
  }>,
): Promise<ConsentPolicyAcceptanceStatus> {
  const outcome = await resolveConsentPolicyMemberAgainstPublication(authority, params.policyKey, params.publication);
  const current = await findHostConsentState(db, params.policyKey, params.subject);
  return evaluateConsentPolicyAcceptance(params.policyKey, outcome, current);
}

/**
 * The production per-policy entry point: no corpus, no publication override, no
 * options. Fail-closed by construction -- the required version exists only when
 * a validated authority says the key is activated at its published version.
 */
export async function resolveConsentPolicyAcceptanceStatus(
  db: PgQueryable,
  authority: ConsentActivationAuthorityReader,
  params: Readonly<{
    policyKey: IdentityConsentPolicyKey;
    subject: Readonly<{ userId?: string | null; accountId?: string | null }>;
  }>,
): Promise<ConsentPolicyAcceptanceStatus> {
  const outcome = await resolveConsentPolicyMember(authority, params.policyKey);
  const current = await findHostConsentState(db, params.policyKey, params.subject);
  return evaluateConsentPolicyAcceptance(params.policyKey, outcome, current);
}
