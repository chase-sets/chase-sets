import {
  accountEnforcementReasonCodes,
  accountEnforcementReversalReasonCodes,
  type AccountEnforcementData,
  type AccountEnforcementReasonCode,
  type AccountEnforcementReference,
  type AccountEnforcementReversalReasonCode,
  type AggregateDecider,
  type AggregateEvolver,
  type DomainEvent,
  type IdentityAccountClosedPayload,
  type IdentityAccountReactivatedPayload,
  type IdentityAccountSuspendedPayload,
} from "@chase-sets/event-core";
import { parseStrictTypedUlid, type AccountId, type EnforcementActionId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  normalizeLabel,
  normalizeEmail,
  type AccountStatus,
  type AccountType,
} from "../../../support/runtime-support/common";

export type AccountState = Readonly<{
  id: AccountId | null;
  name: string | null;
  accountType: AccountType | null;
  displayName: string;
  status: AccountStatus;
  badges: readonly AccountBadgeKey[];
  founderNumber: number | null;
  foundersWindow: Readonly<{ startedAt: string; endsAt: string }> | null;
  lastEnforcementAction: AccountEnforcementAction | null;
  openEnforcementActionId: EnforcementActionId | null;
  usedEnforcementActionIds: readonly EnforcementActionId[];
}>;

export type AccountEnforcementAction =
  | (Readonly<{ kind: "suspension" }> & AccountEnforcementData<AccountEnforcementReasonCode>)
  | (Readonly<{ kind: "reactivation" }> & AccountEnforcementData<AccountEnforcementReversalReasonCode>)
  | (Readonly<{ kind: "closure" }> & AccountEnforcementData<AccountEnforcementReasonCode>);

export const initialAccountState: AccountState = {
  id: null,
  name: null,
  accountType: null,
  displayName: "",
  status: "active",
  badges: [],
  founderNumber: null,
  foundersWindow: null,
  lastEnforcementAction: null,
  openEnforcementActionId: null,
  usedEnforcementActionIds: [],
};

export const accountBadgeKeys = ["founding-account", "manual-payout-review", "trusted-seller"] as const;
export type AccountBadgeKey = (typeof accountBadgeKeys)[number];

export type CreateAccountCommand = Readonly<{
  type: "CreateAccount";
  accountId: AccountId;
  name: string;
  accountType: AccountType;
  displayName?: string;
}>;

export type UpdateAccountProfileCommand = Readonly<{
  type: "UpdateAccountProfile";
  name: string;
  displayName?: string;
}>;

/**
 * The literal display name an Account created for guest checkout without any
 * contact details carries until its Guest Contact is bound.
 *
 * It is the precondition for convergence, not a decoration: an Account whose
 * committed display name is anything else has either already converged or was
 * never a contact-less guest, and this automation must never rename it.
 */
export const GUEST_ACCOUNT_PLACEHOLDER_DISPLAY_NAME = "Guest";

/**
 * Converge an unclaimed guest Account display name from the placeholder to the
 * name its Guest Contact bound.
 *
 * Narrow on purpose rather than a reuse of `UpdateAccountProfile`: the guards
 * belong here, where no caller can bypass them, and the general profile route
 * has to keep its current semantics. The command carries only the display
 * name, so the emitted `identity.account.profile-updated` re-publishes the
 * Account's own committed legal name rather than defaulting it from the
 * display name -- guest Accounts are created with an empty legal name, and a
 * convergence must not invent one.
 */
export type ConvergeGuestAccountDisplayNameCommand = Readonly<{
  type: "ConvergeGuestAccountDisplayName";
  displayName: string;
}>;

export type SuspendAccountCommand = Readonly<{
  type: "SuspendAccount";
  enforcement: AccountEnforcementData<AccountEnforcementReasonCode>;
}>;
export type ReactivateAccountCommand = Readonly<{
  type: "ReactivateAccount";
  enforcement: AccountEnforcementData<AccountEnforcementReversalReasonCode>;
}>;
export type CloseAccountCommand = Readonly<{
  type: "CloseAccount";
  enforcement: AccountEnforcementData<AccountEnforcementReasonCode>;
}>;
export type AssignAccountBadgeCommand = Readonly<{
  type: "AssignAccountBadge";
  badgeKey: AccountBadgeKey;
  founderNumber?: number;
}>;
export type OpenFoundersWindowCommand = Readonly<{
  type: "OpenFoundersWindow";
  betaAccessStartedAt: string;
  foundersWindowEndsAt: string;
  /** Grant-time address published for downstream access notifications; not Account profile state. */
  recipientEmail: string;
}>;
export type RemoveAccountBadgeCommand = Readonly<{
  type: "RemoveAccountBadge";
  badgeKey: AccountBadgeKey;
}>;

export type AccountCommand =
  | CreateAccountCommand
  | UpdateAccountProfileCommand
  | ConvergeGuestAccountDisplayNameCommand
  | SuspendAccountCommand
  | ReactivateAccountCommand
  | CloseAccountCommand
  | OpenFoundersWindowCommand
  | AssignAccountBadgeCommand
  | RemoveAccountBadgeCommand;

type AccountProfile = Readonly<{
  name: string;
  accountType: AccountType;
  displayName: string;
}>;

export type AccountCreatedEvent = DomainEvent<
  "identity.account.created",
  Readonly<{ accountId: AccountId }> & AccountProfile
>;

export type AccountProfileUpdatedEvent = DomainEvent<
  "identity.account.profile-updated",
  Readonly<{
    name: string;
    displayName: string;
  }>
>;

export type AccountSuspendedEvent = DomainEvent<"identity.account.suspended", IdentityAccountSuspendedPayload>;
export type AccountReactivatedEvent = DomainEvent<"identity.account.reactivated", IdentityAccountReactivatedPayload>;
export type AccountClosedEvent = DomainEvent<"identity.account.closed", IdentityAccountClosedPayload>;
export type AccountBadgeAssignedEvent = DomainEvent<
  "identity.account.badge-assigned",
  Readonly<{ badgeKey: AccountBadgeKey; founderNumber?: number }>
>;
export type FoundersWindowOpenedEvent = DomainEvent<
  "identity.account.founders-window-opened",
  Readonly<{ betaAccessStartedAt: string; foundersWindowEndsAt: string; recipientEmail?: string }>
>;
export type AccountBadgeRemovedEvent = DomainEvent<
  "identity.account.badge-removed",
  Readonly<{ badgeKey: AccountBadgeKey }>
>;

export type AccountEvent =
  | AccountCreatedEvent
  | AccountProfileUpdatedEvent
  | AccountSuspendedEvent
  | AccountReactivatedEvent
  | AccountClosedEvent
  | FoundersWindowOpenedEvent
  | AccountBadgeAssignedEvent
  | AccountBadgeRemovedEvent;

export const decideAccount: AggregateDecider<AccountState, AccountCommand, AccountEvent> = (state, command) => {
  switch (command.type) {
    case "CreateAccount":
      assert(state.id === null, "Account has already been created.");
      return [
        {
          type: "identity.account.created",
          data: {
            accountId: command.accountId,
            name: normalizeLabel(command.name),
            accountType: command.accountType,
            displayName: normalizeLabel(command.displayName ?? command.name),
          },
        },
      ];
    case "UpdateAccountProfile":
      requireCreatedAccount(state);
      assert(state.status !== "closed", "Closed accounts cannot be updated.");
      return [
        {
          type: "identity.account.profile-updated",
          data: {
            name: normalizeLabel(command.name),
            displayName: normalizeLabel(command.displayName ?? command.name),
          },
        },
      ];
    case "ConvergeGuestAccountDisplayName": {
      requireCreatedAccount(state);
      assert(state.status !== "closed", "Closed accounts cannot converge a guest display name.");
      const displayName = normalizeLabel(command.displayName);
      assert(displayName.length > 0, "A guest display-name convergence needs the bound contact name.");
      // Idempotency is the committed post-state, never the presence of a
      // reservation row or a token: the same Account already carrying the same
      // name is done, and a repeat appends nothing.
      if (state.displayName === displayName) {
        return [];
      }
      assert(
        state.displayName === GUEST_ACCOUNT_PLACEHOLDER_DISPLAY_NAME,
        "Only a guest Account still holding the placeholder display name can converge.",
      );
      return [
        {
          type: "identity.account.profile-updated",
          data: {
            // The Account's own committed legal name, re-published unchanged.
            // `evolveAccount` overwrites both fields from this payload, so
            // omitting or defaulting `name` here would rewrite the legal name.
            name: state.name ?? "",
            displayName,
          },
        },
      ];
    }
    case "SuspendAccount": {
      requireCreatedAccount(state);
      assert(state.status === "active", "Only active accounts can be suspended.");
      const enforcement = parseNewAccountEnforcementData(state, command.enforcement, accountEnforcementReasonCodes);
      return [
        {
          type: "identity.account.suspended",
          data: { enforcement },
        },
      ];
    }
    case "ReactivateAccount": {
      requireCreatedAccount(state);
      assert(state.status === "suspended", "Only suspended accounts can be reactivated.");
      const enforcement = parseNewAccountEnforcementData(
        state,
        command.enforcement,
        accountEnforcementReversalReasonCodes,
      );
      return [
        {
          type: "identity.account.reactivated",
          data: { enforcement },
        },
      ];
    }
    case "CloseAccount": {
      requireCreatedAccount(state);
      assert(state.status !== "closed", "Account has already been closed.");
      const enforcement = parseNewAccountEnforcementData(state, command.enforcement, accountEnforcementReasonCodes);
      return [
        {
          type: "identity.account.closed",
          data: { enforcement },
        },
      ];
    }
    case "OpenFoundersWindow": {
      requireCreatedAccount(state);
      if (state.foundersWindow) {
        return [];
      }
      const startedAt = normalizeIsoTimestamp(command.betaAccessStartedAt, "Beta access start");
      const endsAt = normalizeIsoTimestamp(command.foundersWindowEndsAt, "Founders window end");
      const recipientEmail = normalizeEmail(command.recipientEmail);
      assert(Date.parse(endsAt) > Date.parse(startedAt), "Founders window must end after beta access starts.");
      return [
        {
          type: "identity.account.founders-window-opened",
          data: { betaAccessStartedAt: startedAt, foundersWindowEndsAt: endsAt, recipientEmail },
        },
      ];
    }
    case "AssignAccountBadge":
      requireCreatedAccount(state);
      assert(state.status !== "closed", "Closed accounts cannot receive badges.");
      assertValidAccountBadge(command.badgeKey);
      if (command.badgeKey === "founding-account") {
        assert(
          Number.isInteger(command.founderNumber) && (command.founderNumber ?? 0) > 0,
          "Founding Account badges require a positive founder number.",
        );
      }
      if (state.badges.includes(command.badgeKey)) {
        return [];
      }
      return [
        {
          type: "identity.account.badge-assigned",
          data: {
            badgeKey: command.badgeKey,
            ...(command.badgeKey === "founding-account" ? { founderNumber: command.founderNumber } : {}),
          },
        },
      ];
    case "RemoveAccountBadge":
      requireCreatedAccount(state);
      assertValidAccountBadge(command.badgeKey);
      assert(command.badgeKey !== "founding-account", "Founding Account badges are permanent.");
      if (!state.badges.includes(command.badgeKey)) {
        return [];
      }
      return [
        {
          type: "identity.account.badge-removed",
          data: { badgeKey: command.badgeKey },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveAccount: AggregateEvolver<AccountState, AccountEvent> = (state, event) => {
  switch (event.type) {
    case "identity.account.created":
      return {
        id: event.data.accountId,
        name: event.data.name,
        accountType: event.data.accountType,
        displayName: event.data.displayName,
        status: "active",
        badges: [],
        founderNumber: null,
        foundersWindow: null,
        lastEnforcementAction: null,
        openEnforcementActionId: null,
        usedEnforcementActionIds: [],
      };
    case "identity.account.profile-updated":
      return {
        ...state,
        name: event.data.name,
        displayName: event.data.displayName,
      };
    case "identity.account.suspended":
      return evolveAccountEnforcement(state, event.data, "suspension", "suspended");
    case "identity.account.reactivated":
      return evolveAccountEnforcement(state, event.data, "reactivation", "active");
    case "identity.account.closed":
      return evolveAccountEnforcement(state, event.data, "closure", "closed");
    case "identity.account.founders-window-opened":
      return {
        ...state,
        foundersWindow: {
          startedAt: event.data.betaAccessStartedAt,
          endsAt: event.data.foundersWindowEndsAt,
        },
      };
    case "identity.account.badge-assigned":
      return {
        ...state,
        badges: sortAccountBadges([...state.badges, event.data.badgeKey]),
        founderNumber:
          event.data.badgeKey === "founding-account" && event.data.founderNumber !== undefined
            ? event.data.founderNumber
            : state.founderNumber,
      };
    case "identity.account.badge-removed":
      return {
        ...state,
        badges: state.badges.filter((badgeKey) => badgeKey !== event.data.badgeKey),
        founderNumber: event.data.badgeKey === "founding-account" ? null : state.founderNumber,
      };
    default:
      return assertNever(event);
  }
};

function requireCreatedAccount(state: AccountState) {
  assert(state.id !== null, "Account must be created first.");
}

export function parseAccountEnforcementData<Reason extends string>(
  value: unknown,
  allowedReasons: readonly Reason[],
): AccountEnforcementData<Reason> {
  assertPlainObjectWithKeys(
    value,
    ["version", "enforcementActionId", "reason", "reference"],
    "Account enforcement data is invalid.",
  );
  assert(value.version === 1, "Account enforcement version is not supported.");
  assert(typeof value.enforcementActionId === "string", "Account enforcement action id is invalid.");
  assert(
    typeof value.reason === "string" && allowedReasons.includes(value.reason as Reason),
    "Account enforcement reason is invalid.",
  );

  const reference = parseAccountEnforcementReference(value.reference);
  return {
    version: 1,
    enforcementActionId: parseStrictTypedUlid(value.enforcementActionId, "enf"),
    reason: value.reason as Reason,
    reference,
  };
}

export function parseAccountEnforcementEventData<Reason extends string>(
  value: unknown,
  allowedReasons: readonly Reason[],
): AccountEnforcementData<Reason> | null {
  assertRecord(value, "Account enforcement event data is invalid.");
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return null;
  }
  assert(keys.length === 1 && keys[0] === "enforcement", "Account enforcement event data is invalid.");
  return parseAccountEnforcementData(value.enforcement, allowedReasons);
}

function parseNewAccountEnforcementData<Reason extends string>(
  state: AccountState,
  value: unknown,
  allowedReasons: readonly Reason[],
) {
  const enforcement = parseAccountEnforcementData(value, allowedReasons);
  assert(
    !state.usedEnforcementActionIds.includes(enforcement.enforcementActionId),
    "Account enforcement action id has already been used.",
  );
  return enforcement;
}

function parseAccountEnforcementReference(value: unknown): AccountEnforcementReference | null {
  if (value === null) {
    return null;
  }
  assertPlainObjectWithKeys(value, ["kind", "supportRequestId"], "Account enforcement reference is invalid.");
  assert(value.kind === "support-request", "Account enforcement reference kind is invalid.");
  assert(typeof value.supportRequestId === "string", "Account enforcement support request id is invalid.");
  return {
    kind: "support-request",
    supportRequestId: parseStrictTypedUlid(value.supportRequestId, "sup"),
  };
}

function evolveAccountEnforcement(
  state: AccountState,
  eventData: unknown,
  kind: AccountEnforcementAction["kind"],
  status: AccountStatus,
): AccountState {
  const allowedReasons =
    kind === "reactivation" ? accountEnforcementReversalReasonCodes : accountEnforcementReasonCodes;
  const enforcement = parseAccountEnforcementEventData(eventData, allowedReasons);

  if (!enforcement) {
    return { ...state, status };
  }

  const action = { kind, ...enforcement } as AccountEnforcementAction;
  if (isSameAccountEnforcementAction(state.lastEnforcementAction, action)) {
    return state;
  }

  assert(
    !state.usedEnforcementActionIds.includes(enforcement.enforcementActionId),
    "Account enforcement action id has already been used.",
  );
  if (kind === "suspension") {
    assert(state.status === "active", "Stored account suspension is invalid for the current status.");
  } else if (kind === "reactivation") {
    assert(state.status === "suspended", "Stored account reactivation is invalid for the current status.");
  } else {
    assert(state.status !== "closed", "Stored account closure is invalid for the current status.");
  }

  return {
    ...state,
    status,
    lastEnforcementAction: action,
    openEnforcementActionId: kind === "reactivation" ? null : enforcement.enforcementActionId,
    usedEnforcementActionIds: [...state.usedEnforcementActionIds, enforcement.enforcementActionId],
  };
}

function isSameAccountEnforcementAction(current: AccountEnforcementAction | null, candidate: AccountEnforcementAction) {
  return (
    current?.kind === candidate.kind &&
    current.enforcementActionId === candidate.enforcementActionId &&
    current.reason === candidate.reason &&
    JSON.stringify(current.reference) === JSON.stringify(candidate.reference)
  );
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), message);
}

function assertPlainObjectWithKeys(
  value: unknown,
  expectedKeys: readonly string[],
  message: string,
): asserts value is Record<string, unknown> {
  assertRecord(value, message);
  const actualKeys = Object.keys(value).sort();
  assert(
    actualKeys.length === expectedKeys.length &&
      [...expectedKeys].sort().every((key, index) => actualKeys[index] === key),
    message,
  );
}

function normalizeIsoTimestamp(value: string, fieldName: string) {
  const normalized = value.trim();
  assert(Number.isFinite(Date.parse(normalized)), `${fieldName} must be an ISO timestamp.`);
  return new Date(normalized).toISOString();
}

function assertValidAccountBadge(badgeKey: string): asserts badgeKey is AccountBadgeKey {
  assert(accountBadgeKeys.includes(badgeKey as AccountBadgeKey), "Account badge is not supported.");
}

function sortAccountBadges(badgeKeys: readonly AccountBadgeKey[]) {
  return [...new Set(badgeKeys)].sort((left, right) => left.localeCompare(right));
}
