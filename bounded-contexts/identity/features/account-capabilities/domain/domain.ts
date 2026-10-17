import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import { assert, assertNever } from "../../../support/runtime-support/common";

/**
 * The only Account Capability Identity may grant. Platform Operations owns its
 * boolean, default-false declaration; declaring it grants nothing.
 */
export const SUPPORT_EVIDENCE_ANY_CASE_CAPABILITY_KEY = "support.evidence.any-case";
export const ASSIGNABLE_ACCOUNT_CAPABILITY_KEYS = [SUPPORT_EVIDENCE_ANY_CASE_CAPABILITY_KEY] as const;
export type AssignableAccountCapabilityKey = (typeof ASSIGNABLE_ACCOUNT_CAPABILITY_KEYS)[number];

export type AccountCapabilityAssignmentTarget = Readonly<{
  tenantId: string;
  accountId: string;
  capabilityKey: AssignableAccountCapabilityKey;
}>;

export type AccountCapabilityAssignmentStatus = "granted" | "revoked";

export type AccountCapabilityAssignmentState =
  | Readonly<{ status: "absent"; version: 0 }>
  | Readonly<
      AccountCapabilityAssignmentTarget & {
        status: AccountCapabilityAssignmentStatus;
        assignmentId: string;
        version: number;
      }
    >;

export const initialAccountCapabilityAssignmentState: AccountCapabilityAssignmentState = {
  status: "absent",
  version: 0,
};

export type GrantAccountCapabilityCommand = Readonly<
  AccountCapabilityAssignmentTarget & {
    type: "GrantAccountCapability";
    /** Used only by the first grant; the assignment keeps it across revoke and regrant. */
    assignmentId: string;
    /** The assignment version the administrator observed (0 when absent). */
    expectedVersion: number;
  }
>;

export type RevokeAccountCapabilityCommand = Readonly<
  AccountCapabilityAssignmentTarget & {
    type: "RevokeAccountCapability";
    expectedVersion: number;
  }
>;

export type AccountCapabilityAssignmentCommand = GrantAccountCapabilityCommand | RevokeAccountCapabilityCommand;

export type AccountCapabilityAssignmentEventData = Readonly<
  AccountCapabilityAssignmentTarget & {
    assignmentId: string;
    version: number;
  }
>;

export type AccountCapabilityGrantedEvent = DomainEvent<
  "identity.account-capability.granted",
  AccountCapabilityAssignmentEventData
>;
export type AccountCapabilityRevokedEvent = DomainEvent<
  "identity.account-capability.revoked",
  AccountCapabilityAssignmentEventData
>;
export type AccountCapabilityAssignmentEvent = AccountCapabilityGrantedEvent | AccountCapabilityRevokedEvent;

const ID_SEGMENT = /^[A-Za-z0-9_]+$/;

export function isAssignableAccountCapabilityKey(value: unknown): value is AssignableAccountCapabilityKey {
  return ASSIGNABLE_ACCOUNT_CAPABILITY_KEYS.some((key) => key === value);
}

export function assertAssignableAccountCapabilityKey(value: unknown): asserts value is AssignableAccountCapabilityKey {
  assert(
    isAssignableAccountCapabilityKey(value),
    `Only the ${SUPPORT_EVIDENCE_ANY_CASE_CAPABILITY_KEY} Account Capability can be granted or revoked.`,
  );
}

/** One stream per tenant, Account and key; id segments exclude "-" so two targets never share a stream. */
export function toAccountCapabilityAssignmentStreamId(target: AccountCapabilityAssignmentTarget): string {
  const parsed = parseTarget(target);
  return `identity.account-capability-${parsed.tenantId}-${parsed.accountId}-${parsed.capabilityKey}`;
}

export const decideAccountCapabilityAssignment: AggregateDecider<
  AccountCapabilityAssignmentState,
  AccountCapabilityAssignmentCommand,
  AccountCapabilityAssignmentEvent
> = (state, command) => {
  const target = parseTarget(command);
  assert(
    Number.isSafeInteger(command.expectedVersion) && command.expectedVersion >= 0,
    "Account Capability expected version must be a non-negative integer.",
  );
  if (state.status !== "absent") {
    assert(
      isSameTarget(state, target),
      "Account Capability assignment belongs to another tenant, Account, or capability.",
    );
  }

  switch (command.type) {
    case "GrantAccountCapability": {
      if (state.status === "granted") {
        assertExactRetry(state, command.expectedVersion);
        return [];
      }
      assertObservedVersion(state, command.expectedVersion);
      const assignmentId = state.status === "absent" ? parseAssignmentId(command.assignmentId) : state.assignmentId;
      return [
        {
          type: "identity.account-capability.granted",
          data: { ...target, assignmentId, version: state.version + 1 },
        },
      ];
    }
    case "RevokeAccountCapability": {
      assert(state.status !== "absent", "Account Capability was never granted, so it cannot be revoked.");
      if (state.status === "revoked") {
        assertExactRetry(state, command.expectedVersion);
        return [];
      }
      assertObservedVersion(state, command.expectedVersion);
      return [
        {
          type: "identity.account-capability.revoked",
          data: { ...target, assignmentId: state.assignmentId, version: state.version + 1 },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

/**
 * Rehydrates only a coherent history. A skipped or repeated version, a changed
 * target or assignment id, another key, or an impossible transition is poison
 * and fails the load instead of being silently accepted.
 */
export const evolveAccountCapabilityAssignment: AggregateEvolver<
  AccountCapabilityAssignmentState,
  AccountCapabilityAssignmentEvent
> = (state, event) => {
  const data = parseEventData(event.data);
  assert(
    data.version === state.version + 1,
    `Account Capability history version ${String(data.version)} does not follow ${state.version}.`,
  );
  if (state.status !== "absent") {
    assert(
      isSameTarget(state, data) && state.assignmentId === data.assignmentId,
      "Account Capability history changes its tenant, Account, capability, or assignment.",
    );
  }

  switch (event.type) {
    case "identity.account-capability.granted":
      assert(state.status !== "granted", "Account Capability history grants an assignment that is already granted.");
      return { ...data, status: "granted" };
    case "identity.account-capability.revoked":
      assert(state.status === "granted", "Account Capability history revokes an assignment that is not granted.");
      return { ...data, status: "revoked" };
    default:
      return assertNever(event);
  }
};

function assertExactRetry(
  state: Extract<AccountCapabilityAssignmentState, { assignmentId: string }>,
  expected: number,
) {
  assert(
    expected === state.version - 1,
    `Account Capability assignment is already ${state.status} at version ${state.version}; expected version ${expected} is stale.`,
  );
}

function assertObservedVersion(state: AccountCapabilityAssignmentState, expected: number) {
  assert(
    expected === state.version,
    `Account Capability assignment is at version ${state.version}; expected version ${expected} is stale.`,
  );
}

function isSameTarget(left: AccountCapabilityAssignmentTarget, right: AccountCapabilityAssignmentTarget) {
  return (
    left.tenantId === right.tenantId && left.accountId === right.accountId && left.capabilityKey === right.capabilityKey
  );
}

function parseTarget(value: Readonly<Record<string, unknown>>): AccountCapabilityAssignmentTarget {
  assertAssignableAccountCapabilityKey(value.capabilityKey);
  return {
    tenantId: parseIdSegment(value.tenantId, "tenant"),
    accountId: parseIdSegment(value.accountId, "Account"),
    capabilityKey: value.capabilityKey,
  };
}

function parseAssignmentId(value: unknown): string {
  return parseIdSegment(value, "assignment");
}

function parseIdSegment(value: unknown, label: string): string {
  assert(
    typeof value === "string" && ID_SEGMENT.test(value),
    `Account Capability ${label} id must be a non-empty id of letters, digits, and underscores.`,
  );
  return value;
}

function parseEventData(value: Readonly<Record<string, unknown>>): AccountCapabilityAssignmentEventData {
  const target = parseTarget(value);
  assert(
    typeof value.version === "number" && Number.isSafeInteger(value.version),
    "Account Capability history version must be an integer.",
  );
  return { ...target, assignmentId: parseAssignmentId(value.assignmentId), version: value.version };
}
