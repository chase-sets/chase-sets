import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  normalizeLabel,
  type AccountStatus,
  type AccountType,
  type EmptyEventData,
} from "../common";

export type AccountState = Readonly<{
  id: AccountId | null;
  name: string | null;
  accountType: AccountType | null;
  displayName: string;
  status: AccountStatus;
}>;

export const initialAccountState: AccountState = {
  id: null,
  name: null,
  accountType: null,
  displayName: "",
  status: "active",
};

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

export type AccountCommand =
  | CreateAccountCommand
  | UpdateAccountProfileCommand
  | SuspendAccountCommand
  | ReactivateAccountCommand
  | CloseAccountCommand;

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

export type AccountSuspendedEvent = DomainEvent<
  "identity.account.suspended",
  EmptyEventData
>;
export type AccountReactivatedEvent = DomainEvent<
  "identity.account.reactivated",
  EmptyEventData
>;
export type AccountClosedEvent = DomainEvent<
  "identity.account.closed",
  EmptyEventData
>;

export type AccountEvent =
  | AccountCreatedEvent
  | AccountProfileUpdatedEvent
  | AccountSuspendedEvent
  | AccountReactivatedEvent
  | AccountClosedEvent;

export const decideAccount: AggregateDecider<
  AccountState,
  AccountCommand,
  AccountEvent
> = (state, command) => {
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
      assert(
        state.status === "suspended",
        "Only suspended accounts can be reactivated.",
      );
      return [{ type: "identity.account.reactivated", data: EMPTY_EVENT_DATA }];
    case "CloseAccount":
      requireCreatedAccount(state);
      assert(state.status !== "closed", "Account has already been closed.");
      return [{ type: "identity.account.closed", data: EMPTY_EVENT_DATA }];
    default:
      return assertNever(command);
  }
};

export const evolveAccount: AggregateEvolver<AccountState, AccountEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "identity.account.created":
      return {
        id: event.data.accountId,
        name: event.data.name,
        accountType: event.data.accountType,
        displayName: event.data.displayName,
        status: "active",
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
    default:
      return assertNever(event);
  }
};

function requireCreatedAccount(state: AccountState) {
  assert(state.id !== null, "Account must be created first.");
}
