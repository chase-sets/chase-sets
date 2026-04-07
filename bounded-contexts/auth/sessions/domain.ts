import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId, SessionId, UserId } from "@chase-sets/primitives/typed-ids";
import type { AuthMethod } from "../auth-support/auth-flow";

type SessionStatus = "active" | "revoked" | "expired";
type EmptyEventData = Readonly<Record<string, never>>;

const EMPTY_EVENT_DATA: EmptyEventData = {};

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

function toSortedUniqueList<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export type SessionState = Readonly<{
  id: SessionId | null;
  userId: UserId | null;
  accountId: AccountId | null;
  availableAccountIds: readonly string[];
  authenticationMethod: AuthMethod | null;
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
  authenticationMethod: AuthMethod;
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
  "auth.session.started",
  Readonly<{
    sessionId: SessionId;
    userId: UserId;
    accountId: AccountId;
    availableAccountIds: string[];
    authenticationMethod: AuthMethod;
    expiresAt: string;
  }>
>;

export type SessionAccountSwitchedEvent = DomainEvent<
  "auth.session.account-switched",
  Readonly<{ accountId: AccountId }>
>;
export type SessionRevokedEvent = DomainEvent<
  "auth.session.revoked",
  EmptyEventData
>;
export type SessionExpiredEvent = DomainEvent<
  "auth.session.expired",
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
          type: "auth.session.started",
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
          type: "auth.session.account-switched",
          data: { accountId: command.accountId },
        },
      ];
    case "RevokeSession":
      requireActiveSession(state);
      return [{ type: "auth.session.revoked", data: EMPTY_EVENT_DATA }];
    case "ExpireSession":
      requireActiveSession(state);
      return [{ type: "auth.session.expired", data: EMPTY_EVENT_DATA }];
    default:
      return assertNever(command);
  }
};

export const evolveSession: AggregateEvolver<SessionState, SessionEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "auth.session.started":
      return {
        id: event.data.sessionId,
        userId: event.data.userId,
        accountId: event.data.accountId,
        availableAccountIds: event.data.availableAccountIds,
        authenticationMethod: event.data.authenticationMethod,
        status: "active",
        expiresAt: event.data.expiresAt,
      };
    case "auth.session.account-switched":
      return { ...state, accountId: event.data.accountId };
    case "auth.session.revoked":
      return { ...state, status: "revoked" };
    case "auth.session.expired":
      return { ...state, status: "expired" };
    default:
      return assertNever(event);
  }
};

function requireActiveSession(state: SessionState) {
  assert(state.id !== null, "Session must be created first.");
  assert(state.status === "active", "Only active sessions can change.");
}
