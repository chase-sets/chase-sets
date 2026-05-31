import {
  evaluateFeatureRollout,
  rolloutSubjectKey,
  type ReleaseControlPolicyDecision,
  type RolloutEnvironment,
  type RolloutSubject,
} from "@chase-sets/release-controls";
import {
  emptyRolloutPolicy,
  rolloutPolicyKey,
  type ReleaseControlsPolicyState,
  type ReleaseLockPolicy,
  type RolloutPolicyRecord,
} from "../domain/policy";

export type ReleaseControlsPolicySnapshot = Readonly<{
  releaseLock: ReleaseLockPolicy;
  rolloutPolicies: readonly RolloutPolicyRecord[];
}>;

export function buildReleaseControlsPolicySnapshot(state: ReleaseControlsPolicyState): ReleaseControlsPolicySnapshot {
  return {
    releaseLock: state.releaseLock,
    rolloutPolicies: Object.values(state.rolloutPolicies).sort((left, right) =>
      `${left.featureKey}:${left.environment}`.localeCompare(`${right.featureKey}:${right.environment}`),
    ),
  };
}

export function evaluateStoredRolloutPolicy(
  state: ReleaseControlsPolicyState,
  input: Readonly<{
    featureKey: string;
    environment: RolloutEnvironment;
    subject: RolloutSubject;
  }>,
): ReleaseControlPolicyDecision {
  const policy =
    state.rolloutPolicies[rolloutPolicyKey(input.featureKey, input.environment)] ??
    emptyRolloutPolicy(input.featureKey, input.environment);
  const decision = evaluateFeatureRollout(policy, input.subject);

  return {
    ...decision,
    featureKey: input.featureKey,
    environment: input.environment,
    subject: input.subject,
    cohortSize: new Set([...(policy.allowSubjects ?? []), ...(policy.optOutSubjects ?? [])]).size,
  };
}

export function canSubjectReadDecision(
  actor: Readonly<{ accountId: string; userId: string; permissions: readonly string[] }>,
  subject: RolloutSubject,
): boolean {
  if (actor.permissions.includes("security.manage")) {
    return true;
  }

  if (subject.subjectType === "account") {
    return subject.subjectId === actor.accountId;
  }

  if (subject.subjectType === "operator") {
    return subject.subjectId === actor.userId;
  }

  return subject.subjectType === "anonymous";
}

export function rolloutDecisionEvidence(decision: ReleaseControlPolicyDecision): string {
  return `${decision.featureKey}:${decision.environment}:${rolloutSubjectKey(decision.subject)}:${decision.reason}:${decision.bucket}`;
}
