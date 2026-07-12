import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  normalizeLabel,
  type AccountStatus,
  type AccountType,
  type EmptyEventData,
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
}>;

export const initialAccountState: AccountState = {
  id: null,
  name: null,
  accountType: null,
  displayName: "",
  status: "active",
  badges: [],
  founderNumber: null,
  foundersWindow: null,
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

export type SuspendAccountCommand = Readonly<{ type: "SuspendAccount" }>;
export type ReactivateAccountCommand = Readonly<{ type: "ReactivateAccount" }>;
export type CloseAccountCommand = Readonly<{ type: "CloseAccount" }>;
export type AssignAccountBadgeCommand = Readonly<{
  type: "AssignAccountBadge";
  badgeKey: AccountBadgeKey;
  founderNumber?: number;
}>;
export type OpenFoundersWindowCommand = Readonly<{
  type: "OpenFoundersWindow";
  betaAccessStartedAt: string;
  foundersWindowEndsAt: string;
}>;
export type RemoveAccountBadgeCommand = Readonly<{
  type: "RemoveAccountBadge";
  badgeKey: AccountBadgeKey;
}>;

export type AccountCommand =
  | CreateAccountCommand
  | UpdateAccountProfileCommand
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

export type AccountSuspendedEvent = DomainEvent<"identity.account.suspended", EmptyEventData>;
export type AccountReactivatedEvent = DomainEvent<"identity.account.reactivated", EmptyEventData>;
export type AccountClosedEvent = DomainEvent<"identity.account.closed", EmptyEventData>;
export type AccountBadgeAssignedEvent = DomainEvent<
  "identity.account.badge-assigned",
  Readonly<{ badgeKey: AccountBadgeKey; founderNumber?: number }>
>;
export type FoundersWindowOpenedEvent = DomainEvent<
  "identity.account.founders-window-opened",
  Readonly<{ betaAccessStartedAt: string; foundersWindowEndsAt: string }>
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
    case "SuspendAccount":
      requireCreatedAccount(state);
      assert(state.status === "active", "Only active accounts can be suspended.");
      return [{ type: "identity.account.suspended", data: EMPTY_EVENT_DATA }];
    case "ReactivateAccount":
      requireCreatedAccount(state);
      assert(state.status === "suspended", "Only suspended accounts can be reactivated.");
      return [{ type: "identity.account.reactivated", data: EMPTY_EVENT_DATA }];
    case "CloseAccount":
      requireCreatedAccount(state);
      assert(state.status !== "closed", "Account has already been closed.");
      return [{ type: "identity.account.closed", data: EMPTY_EVENT_DATA }];
    case "OpenFoundersWindow": {
      requireCreatedAccount(state);
      if (state.foundersWindow) {
        return [];
      }
      const startedAt = normalizeIsoTimestamp(command.betaAccessStartedAt, "Beta access start");
      const endsAt = normalizeIsoTimestamp(command.foundersWindowEndsAt, "Founders window end");
      assert(Date.parse(endsAt) > Date.parse(startedAt), "Founders window must end after beta access starts.");
      return [
        {
          type: "identity.account.founders-window-opened",
          data: { betaAccessStartedAt: startedAt, foundersWindowEndsAt: endsAt },
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
      };
    case "identity.account.profile-updated":
      return {
        ...state,
        name: event.data.name,
        displayName: event.data.displayName,
      };
    case "identity.account.suspended":
      return { ...state, status: "suspended" };
    case "identity.account.reactivated":
      return { ...state, status: "active" };
    case "identity.account.closed":
      return { ...state, status: "closed" };
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
