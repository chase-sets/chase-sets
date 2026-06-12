import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  normalizeRolloutEnvironment,
  normalizeSubjectList,
  type FeatureRolloutPolicy,
  type RolloutEnvironment,
} from "./rollout";

export type ReleaseLockPolicy = Readonly<{
  locked: boolean;
  reason: string;
  reference: string;
  changedAt: string | null;
  changedByUserId: string | null;
  changedByAccountId: string | null;
}>;

export type RolloutPolicyRecord = FeatureRolloutPolicy &
  Readonly<{
    reason: string;
    reference: string;
    updatedAt: string;
    updatedByUserId: string;
    updatedByAccountId: string;
  }>;

export type ReleaseControlsPolicyState = Readonly<{
  releaseLock: ReleaseLockPolicy;
  rolloutPolicies: Readonly<Record<string, RolloutPolicyRecord>>;
}>;

export type PolicyActor = Readonly<{
  userId: string;
  accountId: string;
}>;

export type SetReleaseLockPolicyCommand = Readonly<{
  type: "SetReleaseLockPolicy";
  locked: boolean;
  reason?: string | null;
  reference?: string | null;
  actor: PolicyActor;
  changedAt: string;
}>;

export type SetFeatureRolloutPolicyCommand = Readonly<{
  type: "SetFeatureRolloutPolicy";
  featureKey: string;
  environment: RolloutEnvironment;
  percentage: number;
  allowSubjects?: readonly string[] | string;
  optOutSubjects?: readonly string[] | string;
  killSwitchActive?: boolean;
  reason: string;
  reference: string;
  actor: PolicyActor;
  updatedAt: string;
}>;

export type ReleaseControlsPolicyCommand = SetReleaseLockPolicyCommand | SetFeatureRolloutPolicyCommand;

export type ReleaseLockPolicyChangedEvent = DomainEvent<
  "platform-operations.release-lock-policy.changed",
  Readonly<{
    before: ReleaseLockPolicy;
    after: ReleaseLockPolicy;
  }>
>;

export type FeatureRolloutPolicyChangedEvent = DomainEvent<
  "platform-operations.feature-rollout-policy.changed",
  Readonly<{
    featureKey: string;
    environment: RolloutEnvironment;
    before: RolloutPolicyRecord | null;
    after: RolloutPolicyRecord;
  }>
>;

export type ReleaseControlsPolicyEvent = ReleaseLockPolicyChangedEvent | FeatureRolloutPolicyChangedEvent;

export const initialReleaseControlsPolicyState: ReleaseControlsPolicyState = {
  releaseLock: {
    locked: false,
    reason: "",
    reference: "",
    changedAt: null,
    changedByUserId: null,
    changedByAccountId: null,
  },
  rolloutPolicies: {},
};

export const decideReleaseControlsPolicy: AggregateDecider<
  ReleaseControlsPolicyState,
  ReleaseControlsPolicyCommand,
  ReleaseControlsPolicyEvent
> = (state, command) => {
  switch (command.type) {
    case "SetReleaseLockPolicy": {
      const reason = command.reason?.trim() ?? "";
      const reference = command.reference?.trim() ?? "";
      if (command.locked && !reason) {
        throw new Error("Release lock reason is required.");
      }
      if (state.releaseLock.locked && !command.locked && !reference) {
        throw new Error("Emergency release or release-lock clearance reference is required.");
      }

      const after: ReleaseLockPolicy = {
        locked: command.locked,
        reason: command.locked ? reason : "",
        reference,
        changedAt: requireIsoTimestamp(command.changedAt),
        changedByUserId: requireText(command.actor.userId, "Actor user ID is required."),
        changedByAccountId: requireText(command.actor.accountId, "Actor account ID is required."),
      };

      if (releaseLockPoliciesEqual(state.releaseLock, after)) {
        return [];
      }

      return [
        {
          type: "platform-operations.release-lock-policy.changed",
          data: {
            before: state.releaseLock,
            after,
          },
        },
      ];
    }
    case "SetFeatureRolloutPolicy": {
      const featureKey = requireText(command.featureKey, "Feature key is required.");
      const environment = normalizeRolloutEnvironment(command.environment);
      const policyKey = rolloutPolicyKey(featureKey, environment);
      const before = state.rolloutPolicies[policyKey] ?? null;
      const after: RolloutPolicyRecord = {
        featureKey,
        environment,
        percentage: normalizePercentage(command.percentage),
        allowSubjects: normalizeSubjectList(command.allowSubjects),
        optOutSubjects: normalizeSubjectList(command.optOutSubjects),
        killSwitchActive: Boolean(command.killSwitchActive),
        reason: requireText(command.reason, "Policy change reason is required."),
        reference: requireText(command.reference, "Policy change reference is required."),
        updatedAt: requireIsoTimestamp(command.updatedAt),
        updatedByUserId: requireText(command.actor.userId, "Actor user ID is required."),
        updatedByAccountId: requireText(command.actor.accountId, "Actor account ID is required."),
      };

      if (rolloutPoliciesEqual(before, after)) {
        return [];
      }

      return [
        {
          type: "platform-operations.feature-rollout-policy.changed",
          data: {
            featureKey,
            environment,
            before,
            after,
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveReleaseControlsPolicy: AggregateEvolver<ReleaseControlsPolicyState, ReleaseControlsPolicyEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "platform-operations.release-lock-policy.changed":
      return {
        ...state,
        releaseLock: event.data.after,
      };
    case "platform-operations.feature-rollout-policy.changed":
      return {
        ...state,
        rolloutPolicies: {
          ...state.rolloutPolicies,
          [rolloutPolicyKey(event.data.featureKey, event.data.environment)]: event.data.after,
        },
      };
    default:
      return assertNever(event);
  }
};

export function rolloutPolicyKey(featureKey: string, environment: RolloutEnvironment): string {
  return `${featureKey}:${environment}`;
}

export function emptyRolloutPolicy(featureKey: string, environment: RolloutEnvironment): FeatureRolloutPolicy {
  return {
    featureKey,
    environment,
    percentage: 0,
    allowSubjects: [],
    optOutSubjects: [],
    killSwitchActive: false,
  };
}

function releaseLockPoliciesEqual(left: ReleaseLockPolicy, right: ReleaseLockPolicy) {
  return (
    left.locked === right.locked &&
    left.reason === right.reason &&
    left.reference === right.reference &&
    left.changedAt === right.changedAt &&
    left.changedByUserId === right.changedByUserId &&
    left.changedByAccountId === right.changedByAccountId
  );
}

function rolloutPoliciesEqual(left: RolloutPolicyRecord | null, right: RolloutPolicyRecord) {
  return (
    left !== null &&
    left.percentage === right.percentage &&
    left.killSwitchActive === right.killSwitchActive &&
    left.reason === right.reason &&
    left.reference === right.reference &&
    left.updatedAt === right.updatedAt &&
    left.updatedByUserId === right.updatedByUserId &&
    left.updatedByAccountId === right.updatedByAccountId &&
    arrayEqual(left.allowSubjects ?? [], right.allowSubjects ?? []) &&
    arrayEqual(left.optOutSubjects ?? [], right.optOutSubjects ?? [])
  );
}

function arrayEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

function requireText(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function requireIsoTimestamp(value: string): string {
  const timestamp = requireText(value, "Timestamp is required.");
  if (Number.isNaN(new Date(timestamp).getTime())) {
    throw new Error("Timestamp must be a valid ISO date-time.");
  }
  return timestamp;
}

function normalizePercentage(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("Feature rollout percentage must be an integer between 0 and 100.");
  }
  return value;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected release control policy command or event: ${String(value)}`);
}
