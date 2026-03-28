import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId, SessionId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  EMPTY_EVENT_DATA,
  assert,
  assertNever,
  toSortedUniqueList,
  type AuthMethodKey,
  type EmptyEventData,
  type SessionStatus,
} from "../common";

export type SessionState = Readonly<{
  id: SessionId | null;
  userId: UserId | null;
  accountId: AccountId | null;
  availableAccountIds: readonly string[];
  authenticationMethod: AuthMethodKey | null;
  status: SessionStatus;
  expiresAt: string | null;
}>;

export const initialSessionState: SessionState = {
  id: null,
  userId: null,
  accountId: null,
  availableAccountIds: [],
  authenticationMethod: null,
  status: "active",
  expiresAt: null,
};

export type StartSessionCommand = Readonly<{
  type: "StartSession";
  sessionId: SessionId;
  userId: UserId;
  accountId: AccountId;
  availableAccountIds: string[];
  authenticationMethod: AuthMethodKey;
  expiresAt: string;
}>;

export type SwitchSessionAccountCommand = Readonly<{
  type: "SwitchSessionAccount";
  accountId: AccountId;
}>;

export type RevokeSessionCommand = Readonly<{ type: "RevokeSession" }>;
export type ExpireSessionCommand = Readonly<{ type: "ExpireSession" }>;

export type SessionCommand =
  | StartSessionCommand
  | SwitchSessionAccountCommand
  | RevokeSessionCommand
  | ExpireSessionCommand;

export type SessionStartedEvent = DomainEvent<
  "identity.session.started",
  Readonly<{
    sessionId: SessionId;
    userId: UserId;
    accountId: AccountId;
    availableAccountIds: string[];
    authenticationMethod: AuthMethodKey;
    expiresAt: string;
  }>
>;

export type SessionAccountSwitchedEvent = DomainEvent<
  "identity.session.account-switched",
  Readonly<{ accountId: AccountId }>
>;
export type SessionRevokedEvent = DomainEvent<
  "identity.session.revoked",
  EmptyEventData
>;
export type SessionExpiredEvent = DomainEvent<
  "identity.session.expired",
  EmptyEventData
>;

export type SessionEvent =
  | SessionStartedEvent
  | SessionAccountSwitchedEvent
  | SessionRevokedEvent
  | SessionExpiredEvent;

export const decideSession: AggregateDecider<
  SessionState,
  SessionCommand,
  SessionEvent
> = (state, command) => {
  switch (command.type) {
    case "StartSession":
      assert(state.id === null, "Session has already been started.");
      return [
        {
          type: "identity.session.started",
          data: {
            sessionId: command.sessionId,
            userId: command.userId,
            accountId: command.accountId,
            availableAccountIds: [...toSortedUniqueList(command.availableAccountIds)],
            authenticationMethod: command.authenticationMethod,
            expiresAt: command.expiresAt,
          },
        },
      ];
    case "SwitchSessionAccount":
      requireActiveSession(state);
      assert(
        state.availableAccountIds.includes(command.accountId),
        "Session cannot switch to an unavailable account.",
      );
      assert(state.accountId !== command.accountId, "Session is already active for that account.");
      return [
        {
          type: "identity.session.account-switched",
          data: { accountId: command.accountId },
        },
      ];
    case "RevokeSession":
      requireActiveSession(state);
      return [{ type: "identity.session.revoked", data: EMPTY_EVENT_DATA }];
    case "ExpireSession":
      requireActiveSession(state);
      return [{ type: "identity.session.expired", data: EMPTY_EVENT_DATA }];
    default:
      return assertNever(command);
  }
};

export const evolveSession: AggregateEvolver<SessionState, SessionEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "identity.session.started":
      return {
        id: event.data.sessionId,
        userId: event.data.userId,
        accountId: event.data.accountId,
        availableAccountIds: event.data.availableAccountIds,
        authenticationMethod: event.data.authenticationMethod,
        status: "active",
        expiresAt: event.data.expiresAt,
      };
    case "identity.session.account-switched":
      return { ...state, accountId: event.data.accountId };
    case "identity.session.revoked":
      return { ...state, status: "revoked" };
    case "identity.session.expired":
      return { ...state, status: "expired" };
    default:
      return assertNever(event);
  }
};

function requireActiveSession(state: SessionState) {
  assert(state.id !== null, "Session must be created first.");
  assert(state.status === "active", "Only active sessions can change.");
}
