// Auth-owned public event payloads.
import type { AccountId, SessionId, UserId } from "../../primitives/typed-ids";
import type { EmptyEventPayload } from "./event-core";

export type AuthSessionStartedPayload = Readonly<{
  sessionId: SessionId;
  userId: UserId;
  accountId: AccountId;
  availableAccountIds: readonly string[];
  authenticationMethod: string;
  expiresAt: string;
  /** The User Session Authority generation the Session started in. Absent on starts recorded before it existed, which mean 0. */
  sessionGeneration?: number;
}>;

export type AuthSessionAccountSwitchedPayload = Readonly<{
  accountId: AccountId;
}>;

export type AuthEventPayloads = Readonly<{
  "auth.session.started": AuthSessionStartedPayload;
  "auth.session.account-switched": AuthSessionAccountSwitchedPayload;
  "auth.session.revoked": EmptyEventPayload;
  "auth.session.expired": EmptyEventPayload;
}>;
